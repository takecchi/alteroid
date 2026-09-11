import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ArchiveEntry,
  ArchiveRead,
  ArchiveRemoval,
  ArchiveSessionSummary,
  TranscriptArchive,
} from '@alteroid/core';

/** `${sanitize(sessionId)}-${stamp}.jsonl` の `stamp` 部分（`at.toISOString()` の `:` `.` を `-` に潰した形）。 */
const STAMP_SUFFIX_RE = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.jsonl$/;

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

  async archive(sessionId: string, transcript: string): Promise<string> {
    await mkdir(this.#dir, { recursive: true });
    const at = new Date();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const name = `${sanitize(sessionId)}-${stamp}.jsonl`;
    await writeFile(join(this.#dir, name), transcript, 'utf8');
    // **本体より先に meta を書かない理由は無い**（`remove()` の
    // 「印を書いてから本体を切り詰める」とは違い、こちらは新規作成で
    // 競合が無い）。実測上の心配は要らないが、本体が読めればこの id は
    // 実在するので、meta を本体の後に書いても `list()` が拾えない窓は
    // `#fallbackMeta` が埋める。
    await this.#writeMeta(name, { sessionId, at: at.toISOString() });
    return name;
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

  async #writeMeta(id: string, meta: { sessionId: string; at: string }): Promise<void> {
    await writeFile(this.#metaPath(id), JSON.stringify(meta), 'utf8');
  }

  async #readMeta(id: string): Promise<{ sessionId: string; at: string } | null> {
    try {
      const raw = await readFile(this.#metaPath(id), 'utf8');
      return JSON.parse(raw) as { sessionId: string; at: string };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/**
 * `.meta.json` が無い(この拡張より前に作られた)アーカイブ向けの best-effort 復元。
 *
 * ファイル名の `stamp` 部分(`-YYYY-MM-DDTHH-MM-SS-mmmZ.jsonl`)を ISO 8601 へ
 * 戻し、残りを `sessionId` とする——**ただし `sanitize()` 済みの近似値**
 * （元の `sessionId` に `sanitize` が潰した文字が在れば、その情報は failsafe
 * では戻らない）。パターンに一致しない(壊れた・想定外の名前の)場合は、
 * ファイル名全体を `sessionId`、`epoch` を `at` として返す——`list()` /
 * `sessions()` を例外で落とさないことを優先する。
 */
function fallbackMeta(id: string): { sessionId: string; at: string } {
  const match = STAMP_SUFFIX_RE.exec(id);
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
