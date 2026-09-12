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
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso, toNumber } from './db.js';
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

  /**
   * **指紋は `stripNulls` 後の値に対して取る**（#698）。`body` はストアに
   * 実際に入る値——`stripNulls` される前の `transcript` で指紋を取ると、
   * NUL を含む本文で「積んだ値」と「指紋が指す値」がずれる。
   *
   * ⚠️ **これは fs / インメモリ実装との非対称である。** あの2つは
   * `stripNulls` を行わないので、NUL を含む本文では3実装の連続性判定が
   * 揃わない可能性がある（`db.ts` の `stripNulls` は pg 固有の制約——
   * PostgreSQL の `text` / `jsonb` が NUL を受け付けないための変換であって、
   * fs / インメモリにはその制約が無い）。
   *
   * **直前の行を引くとき `body` 列に触れない**（`select` に含めない）。
   * 100MB 級の行がある `archive` で、判定のためだけに本文を読み直すと
   * Issue #698 の動機そのものを壊す（`list()` の doc と同じ理由）。
   *
   * **「直前を引く → 判定する → insert する」を1トランザクションに閉じる。**
   * 割ると、同じ `sessionId` への並行 `archive()` が同じ「直前」を見て
   * 同じ判定を出す競合が起きる（`PgUsageStore.record` と同じ理由）。
   */
  async archive(sessionId: string, transcript: string): Promise<ArchiveWrite> {
    const body = stripNulls(transcript);
    const at = new Date();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const id = `${sanitize(sessionId)}-${stamp}.jsonl`;
    const fingerprint = fingerprintArchiveBody(body);
    return this.#db.transaction(async (tx) => {
      const previousRows = await tx
        .select({ id: archive.id, bodyChars: archive.bodyChars, bodyMd5: archive.bodyMd5 })
        .from(archive)
        .where(eq(archive.sessionId, sessionId))
        .orderBy(desc(archive.at), desc(archive.id))
        .limit(1);
      const previous = previousRows[0] ?? null;
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, body);
      await tx
        .insert(archive)
        .values({
          id,
          sessionId,
          at,
          body,
          bodyChars: fingerprint.bodyChars,
          bodyMd5: fingerprint.bodyMd5,
          continuity,
        })
        .onConflictDoUpdate({
          target: archive.id,
          set: {
            body,
            bodyChars: fingerprint.bodyChars,
            bodyMd5: fingerprint.bodyMd5,
            continuity,
          },
        });
      return { id, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
    });
  }

  /**
   * 新しい順（#698）。
   *
   * **`storedBytes` は `pg_column_size(body)` で測る。`length(body)` /
   * `octet_length(body)` は使わない。** あの2つは TOAST を展開して本文を
   * 丸ごと読む——100MB 級の行がある `archive` で、一覧を取るためだけに毎行
   * それをやると Issue #698 の動機（本文を落とさずに大きさを知りたい）を
   * この関数自身が壊す。`pg_column_size` は行内に収まった TOAST ポインタの
   * サイズだけを見て、外部チャンクを取りに行かない——`body` に触れない
   * ぶん、この一覧は軽い。
   */
  async list(): Promise<ArchiveEntry[]> {
    const rows = await this.#db
      .select({
        id: archive.id,
        sessionId: archive.sessionId,
        at: archive.at,
        storedBytes: sql<number>`pg_column_size(${archive.body})`,
        removedAt: archive.removedAt,
        removedBytes: archive.removedBytes,
        continuity: archive.continuity,
      })
      .from(archive)
      .orderBy(desc(archive.at), desc(archive.id));
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      at: toIso(row.at),
      storedBytes: row.storedBytes,
      ...(row.continuity === null ? {} : { continuity: row.continuity as ArchiveContinuity }),
      ...(row.removedAt === null
        ? {}
        : { removedAt: toIso(row.removedAt), removedBytes: row.removedBytes ?? 0 }),
    }));
  }

  /**
   * `sessionId` ごとの集計（#698）。**1問い合わせ、`GROUP BY session_id`。**
   *
   * `body` には触れない（`pg_column_size` の理由は `list()` の doc と同じ）ので、
   * `archive` の heap 側だけを見る seq scan でも軽い——索引はいまも主キー
   * （`id`）だけで足りる。`rows` は tombstone 済みの行も数える（`list()` と
   * 同じく、消えるのは本文だけで行は残るため）。
   */
  async sessions(): Promise<ArchiveSessionSummary[]> {
    const rows = await this.#db
      .select({
        sessionId: archive.sessionId,
        rows: sql<number>`count(*)::int`,
        storedBytes: sql<number>`sum(pg_column_size(${archive.body}))`,
        maxStoredBytes: sql<number>`max(pg_column_size(${archive.body}))::int`,
        firstAt: sql<Date>`min(${archive.at})`,
        lastAt: sql<Date>`max(${archive.at})`,
      })
      .from(archive)
      .groupBy(archive.sessionId)
      .orderBy(sql`sum(pg_column_size(${archive.body})) desc`, archive.sessionId);
    return rows.map((row) => ({
      sessionId: row.sessionId,
      rows: row.rows,
      // sum(...) は bigint で返るので、素通しにすると文字列のまま漏れうる
      // （db.ts の toNumber の doc）。
      storedBytes: toNumber(row.storedBytes),
      maxStoredBytes: row.maxStoredBytes,
      firstAt: toIso(row.firstAt),
      lastAt: toIso(row.lastAt),
    }));
  }

  async read(id: string): Promise<ArchiveRead> {
    const rows = await this.#db
      .select({
        body: archive.body,
        removedAt: archive.removedAt,
        removedBytes: archive.removedBytes,
      })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { kind: 'missing' };
    // **判定は `removedAt` だけで行う。** `row.body === ''` を見ない——空の
    // 生ログ（PreCompact が呼ばれた時点で本文が空だった、等）を「消された」と
    // 誤判定しないため（`ArchiveRead` interface doc）。
    if (row.removedAt !== null) {
      return {
        kind: 'removed',
        removedAt: row.removedAt.toISOString(),
        bytes: row.removedBytes ?? 0,
      };
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
