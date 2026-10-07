import { assertNoNul, countCodePoints, hasNul } from '@alteroid/core';
import type { LostSessionGrave, SessionTranscriptTail } from '@alteroid/core';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toNumber } from './db.js';
import { STATEMENT_TIMEOUT_MS, withStatementTimeout } from './footprint.js';
import { sessionEntries, sessions } from './schema.js';

// 行数の上限を外さない: 1行の大きさが一定でないので、費用の天井になるため。
const TAIL_SCAN_ROWS = 2_000;

function hasKeyNul(key: { projectKey: string; sessionId: string; subpath?: string }): boolean {
  return (
    hasNul(key.projectKey) ||
    hasNul(key.sessionId) ||
    (key.subpath !== undefined && hasNul(key.subpath))
  );
}

export class PgSessionStore implements SessionStore, SessionTranscriptTail {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // 1つのトランザクションで束ねる: 途中で落ちると索引の `sessions` が古いままになり、uuid の無い行は呼び直しで二重に積まれるため。
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const subpath = key.subpath ?? '';
    assertNoNul('sessionStore.projectKey', key.projectKey);
    assertNoNul('sessionStore.sessionId', key.sessionId);
    assertNoNul('sessionStore.subpath', subpath);
    for (const entry of entries) {
      if (typeof entry.uuid === 'string') assertNoNul('sessionStore.entry.uuid', entry.uuid);
    }

    // 1文にまとめない: 片方の衝突指定が他方に効いて、uuid 無しの行が黙って落ちるため。
    const idempotent = entries.filter((entry) => typeof entry.uuid === 'string');
    const plain = entries.filter((entry) => typeof entry.uuid !== 'string');

    await this.#db.transaction(async (tx) => {
      if (idempotent.length > 0) {
        await tx
          .insert(sessionEntries)
          .values(
            idempotent.map((entry) => ({
              projectKey: key.projectKey,
              sessionId: key.sessionId,
              subpath,
              uuid: entry.uuid ?? null,
              entry: stripNulls(entry),
            })),
          )
          .onConflictDoNothing({
            target: [
              sessionEntries.projectKey,
              sessionEntries.sessionId,
              sessionEntries.subpath,
              sessionEntries.uuid,
            ],
            // 述語を省かない: 部分ユニーク索引が選ばれず、同じ行が二重に積まれるため。
            where: sql`${sessionEntries.uuid} is not null`,
          });
      }

      if (plain.length > 0) {
        await tx.insert(sessionEntries).values(
          plain.map((entry) => ({
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            subpath,
            uuid: null,
            entry: stripNulls(entry),
          })),
        );
      }

      await tx
        .insert(sessions)
        .values({
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [sessions.projectKey, sessions.sessionId, sessions.subpath],
          set: { updatedAt: new Date() },
        });
    });
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (hasKeyNul(key)) return null;
    const rows = await this.#db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(this.#keyFilter(key))
      .orderBy(asc(sessionEntries.seq));
    if (rows.length === 0) return null;
    return rows.map((row) => row.entry as SessionStoreEntry);
  }

  // `load()` を使わない: 全件を戻すので、巨大なセッションでは SDK が `load()` に掛けている 60 秒の予算に当たるため。
  // `.length` で数えない: 補助面の文字が境目に絡むと、返す量が `maxChars` を上回る契約を破って古い行を静かに落とすため。
  async readTail(key: LostSessionGrave, maxChars: number): Promise<string | null> {
    if (hasKeyNul(key)) return null;
    const rows = await this.#db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(
        and(
          eq(sessionEntries.projectKey, key.projectKey),
          eq(sessionEntries.sessionId, key.sessionId),
          eq(sessionEntries.subpath, ''),
        ),
      )
      .orderBy(desc(sessionEntries.seq))
      .limit(TAIL_SCAN_ROWS);
    if (rows.length === 0) return null;

    // `chars >= maxChars` で止めない: 返す長さは `chars - 1` なので、`maxChars` を下回るため。
    const lines: string[] = [];
    let chars = 0;
    for (const row of rows) {
      const line = JSON.stringify(row.entry);
      lines.push(line);
      chars += countCodePoints(line) + 1;
      if (chars > maxChars + 1) break;
    }
    return lines.reverse().join('\n');
  }

  // `pg_column_size` で測らない: 圧縮後の格納バイトで、予算（実テキスト基準）と比べると圧縮の効くセッションを小さく見積もるため。
  // 測れなかったら `0` にしない: `null` を返す。
  async measureSize(key: LostSessionGrave): Promise<number | null> {
    if (hasKeyNul(key)) return null;
    try {
      return await withStatementTimeout(this.#db, STATEMENT_TIMEOUT_MS, async (tx) => {
        const [row] = await tx
          .select({
            textBytes: sql<
              number | string | null
            >`sum(octet_length(${sessionEntries.entry}::text))`,
          })
          .from(sessionEntries)
          .where(
            and(
              eq(sessionEntries.projectKey, key.projectKey),
              eq(sessionEntries.sessionId, key.sessionId),
              eq(sessionEntries.subpath, ''),
            ),
          );
        if (row === undefined || row.textBytes === null) return 0;
        return toNumber(row.textBytes);
      });
    } catch {
      return null;
    }
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    if (hasNul(projectKey)) return [];
    const rows = await this.#db
      .select({ sessionId: sessions.sessionId, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(and(eq(sessions.projectKey, projectKey), eq(sessions.subpath, '')));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      mtime: Math.floor(new Date(row.updatedAt).getTime()),
    }));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    if (hasKeyNul(key)) return [];
    const rows = await this.#db
      .select({ subpath: sessions.subpath })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectKey, key.projectKey),
          eq(sessions.sessionId, key.sessionId),
          ne(sessions.subpath, ''),
        ),
      );
    return rows.map((row) => row.subpath);
  }

  // 1つのトランザクションで束ねる: 2文目が落ちると `sessions` の行だけが残り、中身の無いセッションが一覧に出続けるため。
  async delete(key: SessionKey): Promise<void> {
    if (hasKeyNul(key)) return;
    await this.#db.transaction(async (tx) => {
      await tx.delete(sessionEntries).where(this.#keyFilter(key));
      await tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.projectKey, key.projectKey),
            eq(sessions.sessionId, key.sessionId),
            eq(sessions.subpath, key.subpath ?? ''),
          ),
        );
    });
  }

  #keyFilter(key: SessionKey) {
    return and(
      eq(sessionEntries.projectKey, key.projectKey),
      eq(sessionEntries.sessionId, key.sessionId),
      eq(sessionEntries.subpath, key.subpath ?? ''),
    );
  }

  // SDK の `SessionStore` interface にこのメソッドを足さない: fs 構成では SDK 自身がローカルディスクへ直接書き、触れる預け先が無いため。
  // 1つのトランザクションで束ねる: 2文目が落ちると `sessions` の行だけが残るため。
  async clearAll(): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const removedEntries = await tx.delete(sessionEntries).returning({ seq: sessionEntries.seq });
      await tx.delete(sessions);
      return removedEntries.length;
    });
  }
}
