import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  MAX_UTF8_BYTES_PER_CODE_POINT,
  archiveIdBranch,
  assertArchivableSessionId,
  hasNul,
  stripNul,
  classifyArchiveContinuity,
  compareArchiveEntriesNewestFirst,
  createUnreadableRowOnce,
  fingerprintArchiveBody,
  matchArchiveIdStamp,
  tailByCodePoints,
  tallyArchiveContinuity,
  type ArchiveContinuity,
  type ArchiveEntry,
  type ArchiveRead,
  type ArchiveRemoval,
  type ArchiveSessionSummary,
  type ArchiveWrite,
  type TranscriptArchive,
  type UnreadableRowOnce,
} from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 上限を超えたら黙って上書きへ落ちず投げる: 「捨てた」ことが観測できない形を作らないため
const MAX_ARCHIVE_ID_ATTEMPTS = 1000;

function archiveIdCandidate(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
}

// `remove()` は本体を消さず空へ切り詰め、印ファイル（`<id>.removed`）の有無だけで判定する: 空の生ログは正当にありえ、空文字を「消された」の根拠にできないため
// `sessionId` / `at` は脇の `<id>.meta.json` から読む: `sanitize()` は非可逆で、ファイル名からは pg 版と同じ生の値を復元できないため
export class FsTranscriptArchive implements TranscriptArchive {
  readonly #dir: string;
  // 壊れた sidecar の知らせは1本につき1回に絞る: 絞ると、同じ行が呼び出しの回数だけ stderr に積もり、他の合図を埋めるため
  readonly #unreadableOnce: UnreadableRowOnce = createUnreadableRowOnce();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async archive(sessionId: string, transcript: string): Promise<ArchiveWrite> {
    assertArchivableSessionId(sessionId);
    // `sessionId` ごとの `withPathLock` で直列化する: 並行 `archive()` が同じ「直前」を見て同じ判定を出すため
    return withPathLock(this.#sessionLockPath(sessionId), async () => {
      // `mkdir` はロックの内側に置く: 呼ぶ前に await を挟むと、到達順が mkdir の完了順にずれて FIFO が乱れるため
      await mkdir(this.#dir, { recursive: true });
      // `at` はロックを取った後で決める: 外で取ると `list()` の並びと実際の読み書きの順がずれ、`comparedTo` の鎖が並びと一致しなくなるため
      const at = new Date();
      const previous = await this.#findPreviousArchiveForSession(sessionId);
      const fingerprint = fingerprintArchiveBody(transcript);
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      const base = `${sanitize(sessionId)}-${stamp}`;
      // 指紋と連続性は生の本文で取る: pg と同じにするため
      const name = await this.#writeBodyExclusively(base, stripNul(transcript));
      await this.#writeMeta(name, {
        sessionId,
        at: at.toISOString(),
        bodyChars: fingerprint.bodyChars,
        bodyMd5: fingerprint.bodyMd5,
        continuity,
      });
      return { id: name, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
    });
  }

  // `.jsonl` / `.meta.json` / `.removed` と拡張子を被らせない: `#listIds()` や `#readMeta` 系に紛れ込むため
  #sessionLockPath(sessionId: string): string {
    return join(this.#dir, `${sanitize(sessionId)}.session-lock`);
  }

  async #writeBodyExclusively(base: string, transcript: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ARCHIVE_ID_ATTEMPTS; attempt += 1) {
      const name = archiveIdCandidate(base, attempt);
      try {
        // `wx`（排他作成）で書いて衝突したら枝番を上げる: 同じミリ秒に同じセッションへ積むと id が衝突し、排他無しだと黙って上書きして生ログが1本消えるため
        await writeFile(join(this.#dir, name), transcript, { encoding: 'utf8', flag: 'wx' });
        return name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error(
      `archive(): id の衝突が ${MAX_ARCHIVE_ID_ATTEMPTS} 回続いたので退避を中止した（base=${base}）`,
    );
  }

  async #findPreviousArchiveForSession(
    sessionId: string,
  ): Promise<{ id: string; bodyChars?: number; bodyMd5?: string } | null> {
    const ids = await this.#listIds();
    let best: { id: string; at: string; bodyChars?: number; bodyMd5?: string } | null = null;
    for (const id of ids) {
      const meta = (await this.#readMeta(id)) ?? fallbackMeta(id);
      if (meta.sessionId !== sessionId) continue;
      // `removedAt` で絞らない: tombstone された行の指紋も、`remove()` までは当時の本文を正しく表しているため
      // 同着は `id` の字面順でなく枝番（`archiveIdBranch`）で選ぶ: 字面では枝番の無い1本目が最大になり、3本目以降が1本目を「直前」と誤認するため
      if (
        best === null ||
        meta.at > best.at ||
        (meta.at === best.at && archiveIdBranch(id) > archiveIdBranch(best.id))
      ) {
        best = { id, at: meta.at, bodyChars: meta.bodyChars, bodyMd5: meta.bodyMd5 };
      }
    }
    return best === null ? null : { id: best.id, bodyChars: best.bodyChars, bodyMd5: best.bodyMd5 };
  }

  async list(): Promise<ArchiveEntry[]> {
    const ids = await this.#listIds();
    // 壊れた印の行だけを一覧から外す: 1本の壊れた印で、無関係な全行を落とさないため
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.#readEntry(id);
        } catch (error) {
          if (error instanceof UnreadableArchiveSidecarError) {
            if (this.#unreadableOnce.sawUnreadable(`${error.sidecar}:${error.id}`)) {
              process.stderr.write(`${describeUnreadableSidecar(error)}（一覧から外した）\n`);
            }
            return undefined;
          }
          throw error;
        }
      }),
    );
    return entries
      .filter((entry): entry is ArchiveEntry => entry !== undefined)
      .sort(compareArchiveEntriesNewestFirst);
  }

  async sessions(): Promise<ArchiveSessionSummary[]> {
    const bySessionId = new Map<string, ArchiveEntry[]>();
    for (const entry of await this.list()) {
      const group = bySessionId.get(entry.sessionId);
      if (group === undefined) bySessionId.set(entry.sessionId, [entry]);
      else group.push(entry);
    }
    const summaries = [...bySessionId.entries()].map(([sessionId, entries]) => {
      const storedBytesList = entries.map((e) => e.storedBytes);
      const atList = entries.map((e) => e.at);
      return {
        sessionId,
        rows: entries.length,
        storedBytes: storedBytesList.reduce((sum, n) => sum + n, 0),
        maxStoredBytes: Math.max(...storedBytesList),
        firstAt: atList.reduce((min, at) => (at < min ? at : min)),
        lastAt: atList.reduce((max, at) => (at > max ? at : max)),
        continuity: tallyArchiveContinuity(entries.map((e) => e.continuity)),
      };
    });
    return summaries.sort(
      (a, b) =>
        b.storedBytes - a.storedBytes ||
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
    );
  }

  async read(id: string): Promise<ArchiveRead> {
    // NUL を含む id は「無い」と答える: fs の呼び出しに渡すと投げるため
    if (hasNul(id) || !isWithinArchiveDir(this.#dir, id)) return { kind: 'missing' };
    const marker = await this.#readMarker(id);
    if (marker !== null)
      return { kind: 'removed', removedAt: marker.removedAt, bytes: marker.bytes };
    try {
      const body = await readFile(join(this.#dir, id), 'utf8');
      return { kind: 'body', body };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  async readTail(id: string, maxChars: number): Promise<ArchiveRead> {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error(
        `archive.readTail(): maxChars は正の整数でなければならない（渡された値: ${String(maxChars)}）`,
      );
    }
    // NUL を含む id は「無い」と答える: fs の呼び出しに渡すと投げるため
    if (hasNul(id) || !isWithinArchiveDir(this.#dir, id)) return { kind: 'missing' };
    const marker = await this.#readMarker(id);
    if (marker !== null)
      return { kind: 'removed', removedAt: marker.removedAt, bytes: marker.bytes };

    // file handle で末尾だけ読む: `readFile()` で全文を文字列にしてから切ると、切る前に本文の全体がメモリへ載り OOM になるため
    let handle;
    try {
      handle = await open(join(this.#dir, id), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
    try {
      const { size } = await handle.stat();
      // `maxChars` ではなく `maxChars + 1` を掛ける: ちょうど `maxChars` だと、呼び出し側が切り詰め済みの窓を「本文がもとから短かった」と誤読するため
      const window = (maxChars + 1) * MAX_UTF8_BYTES_PER_CODE_POINT;
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      // `bytesRead` で切る: `handle.read()` は要求より短く返しうるので、`buffer` ごと文字列にすると末尾に NUL が並ぶため
      const decoded = buffer.subarray(0, bytesRead).toString('utf8');
      return { kind: 'body', body: tailByCodePoints(decoded, maxChars + 1) };
    } finally {
      await handle.close();
    }
  }

  async remove(id: string): Promise<ArchiveRemoval> {
    // NUL を含む id は「無い」と答える: fs の呼び出しに渡すと投げるため
    if (hasNul(id) || !isWithinArchiveDir(this.#dir, id)) return { kind: 'missing' };
    const existingMarker = await this.#readMarker(id);
    if (existingMarker !== null) {
      return { kind: 'already', removedAt: existingMarker.removedAt, bytes: existingMarker.bytes };
    }

    const filePath = join(this.#dir, id);
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }

    const removedAt = new Date().toISOString();
    try {
      // 印は `wx` で作る: read-then-write に割ると、2つの `remove()` が両方「消した」と名乗る窓ができるため
      await writeFile(this.#markerPath(id), JSON.stringify({ removedAt, bytes: size }), {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const marker = await this.#readMarker(id);
        if (marker !== null)
          return { kind: 'already', removedAt: marker.removedAt, bytes: marker.bytes };
      }
      throw error;
    }
    // 印を書いてから本体を切り詰める: 逆順だと、本体が空になった直後に落ちた窓で「空の生ログなのに印が無い」状態を作るため
    await writeFile(filePath, '', 'utf8');
    return { kind: 'removed', bytes: size };
  }

  async clear(): Promise<number> {
    const ids = await this.#listIds();
    for (const id of ids) {
      await rm(join(this.#dir, id), { force: true });
      await rm(this.#metaPath(id), { force: true });
      await rm(this.#markerPath(id), { force: true });
    }
    return ids.length;
  }

  async #listIds(): Promise<string[]> {
    try {
      return (await readdir(this.#dir)).filter((n) => n.endsWith('.jsonl'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async #readEntry(id: string): Promise<ArchiveEntry> {
    const [marker, meta, storedBytes] = await Promise.all([
      this.#readMarker(id),
      this.#readMeta(id),
      this.#statSize(id),
    ]);
    const resolvedMeta = meta ?? fallbackMeta(id);
    return {
      id,
      sessionId: resolvedMeta.sessionId,
      at: resolvedMeta.at,
      storedBytes,
      ...(marker === null ? {} : { removedAt: marker.removedAt, removedBytes: marker.bytes }),
      ...(resolvedMeta.continuity === undefined ? {} : { continuity: resolvedMeta.continuity }),
    };
  }

  async #statSize(id: string): Promise<number> {
    try {
      return (await stat(join(this.#dir, id))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  #markerPath(id: string): string {
    return join(this.#dir, `${id}.removed`);
  }

  // 読めない印は投げる: 印が在る（消されたかもしれない）行の本体を、読めないまま「在る」と返さないため
  async #readMarker(id: string): Promise<{ removedAt: string; bytes: number } | null> {
    let raw: string;
    try {
      raw = await readFile(this.#markerPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#unreadableOnce.sawReadable(`.removed:${id}`);
        return null;
      }
      throw error;
    }
    try {
      const marker = JSON.parse(raw) as { removedAt: string; bytes: number };
      this.#unreadableOnce.sawReadable(`.removed:${id}`);
      return marker;
    } catch {
      throw new UnreadableArchiveSidecarError(id, '.removed');
    }
  }

  #metaPath(id: string): string {
    return join(this.#dir, `${id}.meta.json`);
  }

  // 素の `writeFile` ではなく `writeFileAtomic` で書く: 途中で落ちると半端な JSON が残り、読めない sidecar になるため
  async #writeMeta(id: string, meta: ArchiveMeta): Promise<void> {
    await writeFileAtomic(this.#metaPath(id), JSON.stringify(meta));
  }

  async #readMeta(id: string): Promise<ArchiveMeta | null> {
    let raw: string;
    try {
      raw = await readFile(this.#metaPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#unreadableOnce.sawReadable(`.meta.json:${id}`);
        return null;
      }
      throw error;
    }
    try {
      const meta = JSON.parse(raw) as ArchiveMeta;
      this.#unreadableOnce.sawReadable(`.meta.json:${id}`);
      return meta;
    } catch {
      // 読めない sidecar は「無い」と同じに扱う: 呼び手が `fallbackMeta(id)` に倒すので、行は一覧に残るため
      if (this.#unreadableOnce.sawUnreadable(`.meta.json:${id}`)) {
        process.stderr.write(
          `${describeUnreadableSidecar(new UnreadableArchiveSidecarError(id, '.meta.json'))}（id から sessionId と時刻を取った）\n`,
        );
      }
      return null;
    }
  }
}

// メッセージに中身を載せない: `JSON.parse` の `SyntaxError` の文言は、壊れた中身の一部を含むため
class UnreadableArchiveSidecarError extends Error {
  constructor(
    readonly id: string,
    readonly sidecar: '.meta.json' | '.removed',
  ) {
    super(`アーカイブの ${sidecar} が JSON として読めない（id=${JSON.stringify(id)}）`);
    this.name = 'UnreadableArchiveSidecarError';
  }
}

function describeUnreadableSidecar(error: UnreadableArchiveSidecarError): string {
  return `alteroid: ${error.message}`;
}

interface ArchiveMeta {
  readonly sessionId: string;
  readonly at: string;
  readonly bodyChars?: number;
  readonly bodyMd5?: string;
  readonly continuity?: ArchiveContinuity;
}

// 解析は `matchArchiveIdStamp` に委ねる: 枝番の tie-break（`archiveIdBranch`）と同じ正規表現を2箇所に書かないため
function fallbackMeta(id: string): ArchiveMeta {
  const match = matchArchiveIdStamp(id);
  if (match === undefined) {
    return { sessionId: id, at: new Date(0).toISOString() };
  }
  // `suffix`（マッチ全体）で切る: 枝番が `sessionId` 側へ漏れないため
  const sessionId = id.slice(0, id.length - match.suffix.length);
  const at = match.stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  return { sessionId, at };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

// `sanitize()` の文字クラスで境界を判定しない: `'.'` / `'..'` が素通りするため
// 「配下」ではなく「直下」を比べる: 配下を通すと `'<既存の名前>/x'` が境界を通り、`readFile()` が `ENOTDIR` を投げて 404 のはずが 500 になるため
function isWithinArchiveDir(dir: string, id: string): boolean {
  let resolvedPath: string;
  try {
    resolvedPath = resolve(dir, id);
  } catch {
    return false;
  }
  const resolvedDir = resolve(dir);
  return resolvedPath !== resolvedDir && dirname(resolvedPath) === resolvedDir;
}
