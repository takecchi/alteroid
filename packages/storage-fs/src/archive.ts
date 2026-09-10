import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ArchiveRead, ArchiveRemoval, TranscriptArchive } from '@alteroid/core';

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * PreCompact フックで要約に潰される直前の全文をここへ落とす。人間が後から追う
 * ための用途にセッション本体を太らせ続けない（architecture.md「寿命モデル」）。
 *
 * **`remove()`（#698）は本体の `.jsonl` を消さない。** 空へ切り詰め、脇に
 * `<id>.removed` という印ファイルを置く——`list()` が `.jsonl` で絞っている
 * ので、印は別の拡張子にして一覧へ混ざらないようにしてある。**判定は印の
 * 有無だけで行う**（`read()` は印を先に見る）——本体が空文字であることを
 * 「消された」の根拠にしない（空の生ログは正当にありえる）。
 */
export class FsTranscriptArchive implements TranscriptArchive {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async archive(sessionId: string, transcript: string): Promise<string> {
    await mkdir(this.#dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${sanitize(sessionId)}-${stamp}.jsonl`;
    await writeFile(join(this.#dir, name), transcript, 'utf8');
    return name;
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.#dir))
        .filter((n) => n.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
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
   * 本文だけを落とす（tombstone）。**本体の `.jsonl` は消さず、空へ切り詰める。**
   *
   * **印ファイルを `wx`（既に在れば失敗）で作ることで、二重の `remove()` の
   * 競合を防ぐ。** 先に印が書けた側だけが「消した」（`removed`）を名乗り、
   * 遅れた側は `EEXIST` を見て印を読み直し `already` を返す——read-then-write
   * に割ると、2つの `remove()` が両方「消した」と名乗る窓ができる（pg 版の
   * `UPDATE ... WHERE removed_at IS NULL` と同じ理由）。
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
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
