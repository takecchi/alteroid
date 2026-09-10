import type { ArchiveRead, ArchiveRemoval, TranscriptArchive } from '@alteroid/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { archive } from './schema.js';

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * fs 版がファイル名で持っていた識別子を、そのまま主キーとして使う。ジョブ台帳の
 * `archiveIds` は fs / pg のどちらでも同じ形で残るので、manager_id から生ログへ
 * 降りる経路はドライバを替えても切れない。
 */
export class PgTranscriptArchive implements TranscriptArchive {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async archive(sessionId: string, transcript: string): Promise<string> {
    const body = stripNulls(transcript);
    const at = new Date();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const id = `${sanitize(sessionId)}-${stamp}.jsonl`;
    await this.#db
      .insert(archive)
      .values({ id, sessionId, at, body })
      .onConflictDoUpdate({ target: archive.id, set: { body } });
    return id;
  }

  /** 新しい順。 */
  async list(): Promise<string[]> {
    const rows = await this.#db
      .select({ id: archive.id })
      .from(archive)
      .orderBy(desc(archive.at), desc(archive.id));
    return rows.map((row) => row.id);
  }

  async read(id: string): Promise<ArchiveRead> {
    const rows = await this.#db
      .select({ body: archive.body, removedAt: archive.removedAt, removedBytes: archive.removedBytes })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { kind: 'missing' };
    // **判定は `removedAt` だけで行う。** `row.body === ''` を見ない——空の
    // 生ログ（PreCompact が呼ばれた時点で本文が空だった、等）を「消された」と
    // 誤判定しないため（`ArchiveRead` interface doc）。
    if (row.removedAt !== null) {
      return { kind: 'removed', removedAt: row.removedAt.toISOString(), bytes: row.removedBytes ?? 0 };
    }
    return { kind: 'body', body: row.body };
  }

  /**
   * 本文だけを落とす（tombstone）。**`DELETE` を打たない。** 行は残る——
   * `body = ''` へ切り詰め、`removed_at` / `removed_bytes` を立てるだけの
   * `UPDATE` である。
   *
   * **1本の `UPDATE ... WHERE id = ? AND removed_at IS NULL RETURNING ...`
   * で「まだ消えていない行」だけを狙い撃つ。** 二重の `remove()` が競合しても
   * 片方だけがこの `UPDATE` を通り（`removed`）、もう片方は0行更新に終わって
   * 下の `SELECT` で `already` を見る——read-then-write に割ると、2つの
   * `remove()` が両方「消した」と名乗る窓ができる。
   *
   * `removed_bytes = octet_length(body)` は同じ `UPDATE` 文の中で計算する
   * （PostgreSQL の `SET` は同じ文の中では更新前の行を見るので、`body` を
   * `''` へ書き換える式と同居させても `octet_length` は書き換え前の値を
   * 測る）。
   */
  async remove(id: string): Promise<ArchiveRemoval> {
    const updated = await this.#db
      .update(archive)
      .set({
        body: '',
        removedAt: sql`now()`,
        removedBytes: sql`octet_length(${archive.body})`,
      })
      .where(and(eq(archive.id, id), isNull(archive.removedAt)))
      .returning({ removedBytes: archive.removedBytes });
    const row = updated[0];
    if (row !== undefined) return { kind: 'removed', bytes: row.removedBytes ?? 0 };

    // 0行更新 ＝ id が無いか、既に消されていたかのどちらか。引き直して判定する。
    const existing = await this.#db
      .select({ removedAt: archive.removedAt, removedBytes: archive.removedBytes })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) return { kind: 'missing' };
    if (existingRow.removedAt === null) {
      // **ここへは実務上来ないはずである。** 上の UPDATE が
      // `removed_at IS NULL` を条件に0行だったのに、直後の SELECT で
      // `removed_at IS NULL` の行が見つかった——両方が同じトランザクション
      // 内・単純な逐次呼び出しの範囲では起こらない状態遷移である。黙って
      // `missing` 扱いにはしない（判定できない状態を隠さない）。
      throw new Error(`archive.remove(${id}): 競合が判定できない状態になった`);
    }
    return {
      kind: 'already',
      removedAt: existingRow.removedAt.toISOString(),
      bytes: existingRow.removedBytes ?? 0,
    };
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
