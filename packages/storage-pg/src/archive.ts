import {
  archiveIdBranch,
  assertArchivableSessionId,
  hasNul,
  classifyArchiveContinuity,
  compareArchiveEntriesNewestFirst,
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
import { byteOrder, stripNulls, toIso, toNumber } from './db.js';
import { archive } from './schema.js';

// 超えたら黙って上書きへ落とさず例外を投げる。
const MAX_ARCHIVE_ID_ATTEMPTS = 1000;

// 別の advisory lock を足すなら別の名前空間文字列を選ぶ: 鍵空間が衝突するため。
const ARCHIVE_SESSION_LOCK_NAMESPACE = 'alteroid.archive.session';

function archiveIdCandidate(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
}

export class PgTranscriptArchive implements TranscriptArchive {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // 指紋を `stripNulls` の後の値で取らない: NUL の位置だけが違う本文を pg だけが「続いている」と判定し、fs / インメモリと割れるため。
  // 直前の行を引くとき `body` 列に触れない: 100MB 級の行を判定のためだけに読み直さないため。
  // トランザクションに閉じるだけにしない: READ COMMITTED では並行する `archive()` が同じ「直前」を読んで同じ判定を出し、`continuity` が欺かれて他に残っていない本文が削除対象になるため。`sessionId` ごとの advisory lock で直列化する。
  // 「直前」の tie-break を SQL の `desc(archive.id)` に任せない: 照合順に依存し、`id` の字面順は積んだ順と一致しないため。
  // `onConflictDoUpdate` にしない: 同じミリ秒の2回目が黙って上書きされ、生ログが1本消えるため。
  async archive(sessionId: string, transcript: string): Promise<ArchiveWrite> {
    assertArchivableSessionId(sessionId);
    const body = stripNulls(transcript);
    const fingerprint = fingerprintArchiveBody(transcript);
    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${ARCHIVE_SESSION_LOCK_NAMESPACE}), hashtext(${sessionId}))`,
      );
      // `at` をロックの前で決めない: ロック待ちの順と `at` の順がずれ、`comparedTo` の鎖が `at` の並びと一致しなくなるため。
      const at = new Date();
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      const base = `${sanitize(sessionId)}-${stamp}`;
      const candidateRows = await tx
        .select({
          id: archive.id,
          at: archive.at,
          bodyChars: archive.bodyChars,
          bodyMd5: archive.bodyMd5,
        })
        .from(archive)
        .where(
          and(
            eq(archive.sessionId, sessionId),
            sql`${archive.at} = (select max(${archive.at}) from ${archive} where ${archive.sessionId} = ${sessionId})`,
          ),
        );
      const previous = candidateRows.reduce<(typeof candidateRows)[number] | null>((best, row) => {
        if (best === null) return row;
        return archiveIdBranch(row.id) > archiveIdBranch(best.id) ? row : best;
      }, null);
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
      for (let attempt = 1; attempt <= MAX_ARCHIVE_ID_ATTEMPTS; attempt += 1) {
        const id = archiveIdCandidate(base, attempt);
        const inserted = await tx
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
          .onConflictDoNothing({ target: archive.id })
          .returning({ id: archive.id });
        if (inserted.length > 0) {
          return { id, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
        }
      }
      throw new Error(
        `archive(): id の衝突が ${MAX_ARCHIVE_ID_ATTEMPTS} 回続いたので退避を中止した（base=${base}）`,
      );
    });
  }

  // `length(body)` / `octet_length(body)` を使わない: TOAST を展開して本文を丸ごと読み、100MB 級の行で一覧が重くなるため。
  // 同着の tie-break を SQL の `desc(archive.id)` に任せない: 照合順に依存し、`id` の字面順は積んだ順と一致しないため。
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
      .orderBy(desc(archive.at));
    const entries: ArchiveEntry[] = rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      at: toIso(row.at),
      storedBytes: row.storedBytes,
      ...(row.continuity === null ? {} : { continuity: row.continuity as ArchiveContinuity }),
      ...(row.removedAt === null
        ? {}
        : { removedAt: toIso(row.removedAt), removedBytes: row.removedBytes ?? 0 }),
    }));
    return entries.sort(compareArchiveEntriesNewestFirst);
  }

  // 行を JS 側へ引き上げない: 内訳まで SQL 側で数える。
  async sessions(): Promise<ArchiveSessionSummary[]> {
    const rows = await this.#db
      .select({
        sessionId: archive.sessionId,
        rows: sql<number>`count(*)::int`,
        storedBytes: sql<number>`sum(pg_column_size(${archive.body}))`,
        maxStoredBytes: sql<number>`max(pg_column_size(${archive.body}))::int`,
        firstAt: sql<Date>`min(${archive.at})`,
        lastAt: sql<Date>`max(${archive.at})`,
        continuityFirst: sql<number>`count(*) filter (where ${archive.continuity} = 'first')::int`,
        continuityContinues: sql<number>`count(*) filter (where ${archive.continuity} = 'continues')::int`,
        continuityDiverged: sql<number>`count(*) filter (where ${archive.continuity} = 'diverged')::int`,
        continuityUnknown: sql<number>`count(*) filter (where ${archive.continuity} = 'unknown')::int`,
        continuityAbsent: sql<number>`count(*) filter (where ${archive.continuity} is null)::int`,
      })
      .from(archive)
      .groupBy(archive.sessionId)
      .orderBy(sql`sum(pg_column_size(${archive.body})) desc`, byteOrder(archive.sessionId));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      rows: row.rows,
      storedBytes: toNumber(row.storedBytes),
      maxStoredBytes: row.maxStoredBytes,
      firstAt: toIso(row.firstAt),
      lastAt: toIso(row.lastAt),
      continuity: {
        first: row.continuityFirst,
        continues: row.continuityContinues,
        diverged: row.continuityDiverged,
        unknown: row.continuityUnknown,
        absent: row.continuityAbsent,
      },
    }));
  }

  async read(id: string): Promise<ArchiveRead> {
    if (hasNul(id)) return { kind: 'missing' };
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
    // `row.body === ''` で判定しない: 空の生ログを「消された」と誤判定するため。
    if (row.removedAt !== null) {
      return {
        kind: 'removed',
        removedAt: row.removedAt.toISOString(),
        bytes: row.removedBytes ?? 0,
      };
    }
    return { kind: 'body', body: row.body };
  }

  // `body` 列をそのまま `select` しない: 100MB 級の行で切る前に本文の全体が Node へ渡り、OOM を起こすため。`right()` で PostgreSQL 側に切らせる。
  // `maxChars + 1` を `maxChars` にしない: 返す量が `maxChars` を厳密に上回る契約を満たすため。
  async readTail(id: string, maxChars: number): Promise<ArchiveRead> {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error(
        `archive.readTail(): maxChars は正の整数でなければならない（渡された値: ${String(maxChars)}）`,
      );
    }
    if (hasNul(id)) return { kind: 'missing' };
    const rows = await this.#db
      .select({
        tail: sql<string>`right(${archive.body}, ${maxChars + 1})`,
        removedAt: archive.removedAt,
        removedBytes: archive.removedBytes,
      })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { kind: 'missing' };
    if (row.removedAt !== null) {
      return {
        kind: 'removed',
        removedAt: row.removedAt.toISOString(),
        bytes: row.removedBytes ?? 0,
      };
    }
    return { kind: 'body', body: row.tail };
  }

  // `DELETE` を打たない: 行は残し、`body = ''` へ切り詰めて tombstone にする。
  // read-then-write に割らない: 2つの `remove()` が両方「消した」と名乗る窓ができるため。
  async remove(id: string): Promise<ArchiveRemoval> {
    if (hasNul(id)) return { kind: 'missing' };
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

    const existing = await this.#db
      .select({ removedAt: archive.removedAt, removedBytes: archive.removedBytes })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) return { kind: 'missing' };
    if (existingRow.removedAt === null) {
      // `missing` 扱いにしない: 判定できない状態を隠さないため。
      throw new Error(`archive.remove(${id}): 競合が判定できない状態になった`);
    }
    return {
      kind: 'already',
      removedAt: existingRow.removedAt.toISOString(),
      bytes: existingRow.removedBytes ?? 0,
    };
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(archive).returning({ id: archive.id });
    return removed.length;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
