import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  classifyArchiveContinuity,
  fingerprintArchiveBody,
  type ArchiveContinuity,
  type ArchiveEntry,
  type ArchiveRead,
  type ArchiveRemoval,
  type ArchiveSessionSummary,
  type ArchiveWrite,
  type TranscriptArchive,
} from '@alteroid/core';

/**
 * `${sanitize(sessionId)}-${stamp}.jsonl` の `stamp` 部分（`at.toISOString()` の
 * `:` `.` を `-` に潰した形）と、**衝突したときだけ付く枝番**（#905）。
 *
 * **枝番は optional である。** 衝突していない id の形は1文字も変わっていない
 * ので、この正規表現も枝番の無い側を今までどおり拾う。`fallbackMeta()` は
 * マッチ全体（枝番を含む）の長さで `sessionId` を切り出すため、枝番が付いた
 * id でも `sessionId` / `at` が正しく戻る——**枝番を拾わない形へ戻すと、
 * `sessionId` にファイル名全体が入り `at` が epoch へ落ちる**（`index.test.ts`
 * の「枝番付きの id でもサイドカー無しから sessionId / at を復元できる」が
 * その歯）。
 */
const STAMP_SUFFIX_RE = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.jsonl$/;

/**
 * 同じミリ秒に同じセッションへ積まれたときに、枝番を試す上限（#905）。
 *
 * **超えたら例外を投げる。⛔ 黙って上書きへ落ちない。** 「捨てた」ことが
 * 観測できない形がこの Issue の欠陥そのものなので、塞ぎ方の側で同じ形を
 * 作らない。pg 側（`packages/storage-pg/src/archive.ts` の
 * `MAX_ARCHIVE_ID_ATTEMPTS`）と同じ値・同じ倒れ方である。
 */
const MAX_ARCHIVE_ID_ATTEMPTS = 1000;

/** `n` 回目の候補 id（1回目は枝番無し＝従来と同じ形）。 */
function archiveIdCandidate(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
}

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * PreCompact フックで要約に潰される直前の全文をここへ落とす。人間が後から追う
 * ための用途にセッション本体を太らせ続けない(architecture.md「寿命モデル」)。
 *
 * **`remove()`（#698）は本体の `.jsonl` を消さない。** 空へ切り詰め、脇に
 * `<id>.removed` という印ファイルを置く——`list()` が `.jsonl` で絞っている
 * ので、印は別の拡張子にして一覧へ混ざらないようにしてある。**判定は印の
 * 有無だけで行う**（`read()` は印を先に見る）——本体が空文字であることを
 * 「消された」の根拠にしない（空の生ログは正当にありえる）。
 *
 * **`list()` / `sessions()`（#698 の拡張）は、脇の `<id>.meta.json` から
 * `sessionId` / `at` を読む。** ファイル名にも同じ情報が入っている
 * (`${sanitize(sessionId)}-${stamp}.jsonl`) が、`sanitize()` は非可逆
 * （`[^A-Za-z0-9._-]` を `_` へ潰す）なので、ファイル名からは pg 版の
 * `session_id` 列と同じ生の値を復元できない。脇へ生の値を持つことで、
 * `sessionId` が3実装（インメモリ / fs / pg）のあいだで一致する
 * (`archive-contract.ts` が測る)。**この meta ファイルより前に作られた
 * アーカイブ（sidecar が無い）は、ファイル名から best-effort で復元する**
 * (`#fallbackMeta`)——`sanitize` 済みの近似値になるが、無いよりはよい。
 */
export class FsTranscriptArchive implements TranscriptArchive {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * **判定のために本体の `.jsonl` を読まない（#698）。** 直前の退避は
   * `#findPreviousArchiveForSession` が `.meta.json` サイドカーだけを見て
   * 探し、その `bodyChars` / `bodyMd5` と新しい本文の指紋を突き合わせる
   * だけで `classifyArchiveContinuity` が判定を終える。
   *
   * **id が衝突したら枝番を上げる（#905）。** `stamp` はミリ秒精度なので、
   * 同じセッションへ同じミリ秒に2回積むと id が衝突する。**排他フラグ無しの
   * `writeFile` はそれを黙って上書きしていた**——退避の回数が過少に数えられ、
   * 生ログが1本消えた。いまは `flag: 'wx'`（排他作成）で書き、`EEXIST` なら
   * `${base}-2.jsonl` → `${base}-3.jsonl` … と枝番を上げる。
   *
   * ⭐ **`remove()` は本体を消さず空へ切り詰めるだけ**なので、tombstone
   * 済みの id でも `wx` は正しく `EEXIST` になる（＝ 一度使った id は埋まった
   * まま）。この性質に依存している。
   *
   * **衝突していない id の形は1文字も変わらない**ので、既存の退避に移行は
   * 要らない。**先頭が `sanitize(sessionId)` である性質も保たれる**（id の
   * 前方一致が効く。#698 §6-5）。
   */
  async archive(sessionId: string, transcript: string): Promise<ArchiveWrite> {
    await mkdir(this.#dir, { recursive: true });
    const previous = await this.#findPreviousArchiveForSession(sessionId);
    const fingerprint = fingerprintArchiveBody(transcript);
    const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
    const at = new Date();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const base = `${sanitize(sessionId)}-${stamp}`;
    const name = await this.#writeBodyExclusively(base, transcript);
    // **本体より先に meta を書かない理由は無い**（`remove()` の
    // 「印を書いてから本体を切り詰める」とは違い、こちらは新規作成で
    // 競合が無い）。実測上の心配は要らないが、本体が読めればこの id は
    // 実在するので、meta を本体の後に書いても `list()` が拾えない窓は
    // `#fallbackMeta` が埋める。
    await this.#writeMeta(name, {
      sessionId,
      at: at.toISOString(),
      bodyChars: fingerprint.bodyChars,
      bodyMd5: fingerprint.bodyMd5,
      continuity,
    });
    return { id: name, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
  }

  /**
   * 本体の `.jsonl` を**排他作成**で書き、実際に使えた名前を返す（#905）。
   *
   * `EEXIST` 以外の失敗はそのまま投げる（握り潰さない）。上限に達したら
   * 例外——**黙って上書きへ落ちない。**
   */
  async #writeBodyExclusively(base: string, transcript: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ARCHIVE_ID_ATTEMPTS; attempt += 1) {
      const name = archiveIdCandidate(base, attempt);
      try {
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

  /**
   * 「直前の退避」＝同じ `sessionId` の行のうち `at` が最大（同値なら `id`
   * が最大）のもの（#698）。**`removedAt`（印ファイルの有無）で絞らない**
   * ——tombstone された行の指紋も、`remove()` が起きた時点までは当時の本文を
   * 正しく表していた有効な情報である。`remove()` は本文を空へ切り詰める
   * だけで、サイドカーの `bodyChars` / `bodyMd5` は書き換えない（`remove()`
   * の実装を見よ）ので、消された行を除外する理由が無い。
   *
   * **`.jsonl` 本体には一切触れない**——`.meta.json` サイドカー（無ければ
   * `fallbackMeta` の best-effort 復元）だけを読む。サイドカーが無い、
   * または `bodyChars` / `bodyMd5` を持たない行は `bodyChars` / `bodyMd5`
   * が `undefined` のまま返り、`classifyArchiveContinuity` がそれを
   * `'unknown'` へ落とす。
   */
  async #findPreviousArchiveForSession(
    sessionId: string,
  ): Promise<{ id: string; bodyChars?: number; bodyMd5?: string } | null> {
    const ids = await this.#listIds();
    let best: { id: string; at: string; bodyChars?: number; bodyMd5?: string } | null = null;
    for (const id of ids) {
      const meta = (await this.#readMeta(id)) ?? fallbackMeta(id);
      if (meta.sessionId !== sessionId) continue;
      if (best === null || meta.at > best.at || (meta.at === best.at && id > best.id)) {
        best = { id, at: meta.at, bodyChars: meta.bodyChars, bodyMd5: meta.bodyMd5 };
      }
    }
    return best === null ? null : { id: best.id, bodyChars: best.bodyChars, bodyMd5: best.bodyMd5 };
  }

  /**
   * 新しい順（#698）。
   *
   * `storedBytes` は `stat().size`——**その置き場が実際に使っているバイト数**
   * であって、生ログの文字数ではない（`ArchiveEntry` interface の doc）。
   * 消された行は本体が `''` へ切り詰められているので、`storedBytes` は
   * 実質 `0` になる（pg の `pg_column_size('')` とは値が揃わない——
   * 「置き場をまたいで比較しない」が、ここでも成り立つ）。
   */
  async list(): Promise<ArchiveEntry[]> {
    const ids = await this.#listIds();
    const entries = await Promise.all(ids.map((id) => this.#readEntry(id)));
    return entries.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  /** `sessionId` ごとの集計(#698)。`list()` を1回読んで自分で畳む——fs は集計用の索引を持たない。 */
  async sessions(): Promise<ArchiveSessionSummary[]> {
    const bySession = new Map<string, ArchiveSessionSummary>();
    for (const entry of await this.list()) {
      const existing = bySession.get(entry.sessionId);
      if (existing === undefined) {
        bySession.set(entry.sessionId, {
          sessionId: entry.sessionId,
          rows: 1,
          storedBytes: entry.storedBytes,
          maxStoredBytes: entry.storedBytes,
          firstAt: entry.at,
          lastAt: entry.at,
        });
        continue;
      }
      bySession.set(entry.sessionId, {
        sessionId: entry.sessionId,
        rows: existing.rows + 1,
        storedBytes: existing.storedBytes + entry.storedBytes,
        maxStoredBytes: Math.max(existing.maxStoredBytes, entry.storedBytes),
        firstAt: entry.at < existing.firstAt ? entry.at : existing.firstAt,
        lastAt: entry.at > existing.lastAt ? entry.at : existing.lastAt,
      });
    }
    return [...bySession.values()].sort(
      (a, b) =>
        b.storedBytes - a.storedBytes ||
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
    );
  }

  async read(id: string): Promise<ArchiveRead> {
    if (sanitize(id) !== id) return { kind: 'missing' };
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

  /**
   * 本文だけを落とす(tombstone)。**本体の `.jsonl` は消さず、空へ切り詰める。**
   *
   * **印ファイルを `wx`（既に在れば失敗）で作ることで、二重の `remove()` の
   * 競合を防ぐ。** 先に印が書けた側だけが「消した」（`removed`）を名乗り、
   * 遅れた側は `EEXIST` を見て印を読み直し `already` を返す——read-then-write
   * に割ると、2つの `remove()` が両方「消した」と名乗る窓ができる(pg 版の
   * `UPDATE ... WHERE removed_at IS NULL` と同じ理由)。
   */
  async remove(id: string): Promise<ArchiveRemoval> {
    if (sanitize(id) !== id) return { kind: 'missing' };
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
      await writeFile(this.#markerPath(id), JSON.stringify({ removedAt, bytes: size }), {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // 競合: 別の呼び出しが先に印を置いた。その印を読み直して結果を合わせる。
        const marker = await this.#readMarker(id);
        if (marker !== null)
          return { kind: 'already', removedAt: marker.removedAt, bytes: marker.bytes };
      }
      throw error;
    }
    // **印を書いてから本体を切り詰める。** 逆順だと、本体が空になった直後・
    // 印を書く前に落ちた窓で「空の生ログなのに消された印が無い」という、
    // 判定してはいけない状態を自分で作る。
    await writeFile(filePath, '', 'utf8');
    return { kind: 'removed', bytes: size };
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

  async #readMarker(id: string): Promise<{ removedAt: string; bytes: number } | null> {
    try {
      const raw = await readFile(this.#markerPath(id), 'utf8');
      return JSON.parse(raw) as { removedAt: string; bytes: number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  #metaPath(id: string): string {
    return join(this.#dir, `${id}.meta.json`);
  }

  async #writeMeta(id: string, meta: ArchiveMeta): Promise<void> {
    await writeFile(this.#metaPath(id), JSON.stringify(meta), 'utf8');
  }

  /**
   * `bodyChars` / `bodyMd5` / `continuity` を持たないサイドカー（この機能
   * より前に積まれた行）でも例外を投げない——欠けたフィールドは `undefined`
   * のまま返り、`classifyArchiveContinuity` が `'unknown'` へ落とす（#698）。
   */
  async #readMeta(id: string): Promise<ArchiveMeta | null> {
    try {
      const raw = await readFile(this.#metaPath(id), 'utf8');
      return JSON.parse(raw) as ArchiveMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/** `.meta.json` サイドカーの中身（#698。`bodyChars`/`bodyMd5`/`continuity` は optional）。 */
interface ArchiveMeta {
  readonly sessionId: string;
  readonly at: string;
  readonly bodyChars?: number;
  readonly bodyMd5?: string;
  readonly continuity?: ArchiveContinuity;
}

/**
 * `.meta.json` が無い(この拡張より前に作られた)アーカイブ向けの best-effort 復元。
 *
 * ファイル名の `stamp` 部分(`-YYYY-MM-DDTHH-MM-SS-mmmZ.jsonl`。**衝突したときは
 * 枝番が付いて `-YYYY-MM-DDTHH-MM-SS-mmmZ-2.jsonl` になる**。#905)を ISO 8601 へ
 * 戻し、残りを `sessionId` とする——**ただし `sanitize()` 済みの近似値**
 * （元の `sessionId` に `sanitize` が潰した文字が在れば、その情報は failsafe
 * では戻らない）。パターンに一致しない(壊れた・想定外の名前の)場合は、
 * ファイル名全体を `sessionId`、`epoch` を `at` として返す——`list()` /
 * `sessions()` を例外で落とさないことを優先する。
 */
function fallbackMeta(id: string): ArchiveMeta {
  const match = STAMP_SUFFIX_RE.exec(id);
  // **`match[0]`（マッチ全体）で切る。** 枝番（#905）が付いた id では
  // `match[0]` にその枝番も入るので、`sessionId` 側へ枝番が漏れない。
  const suffix = match?.[0];
  const stamp = match?.[1];
  if (suffix === undefined || stamp === undefined) {
    return { sessionId: id, at: new Date(0).toISOString() };
  }
  const sessionId = id.slice(0, id.length - suffix.length);
  const at = stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  return { sessionId, at };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
