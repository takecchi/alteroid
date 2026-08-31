import type { LostSessionGrave, SessionTranscriptTail } from '@alteroid/core';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { sessionEntries, sessions } from './schema.js';

/**
 * SDK の SessionStore アダプタ（roadmap M4）。
 *
 * クローンもマネージャーも、セッションの生ログはローカルディスクにも書かれるが、
 * コンテナではそれが再起動で消える。**同じ PostgreSQL に載せておけば、器が作り
 * 直されても走行中だったセッションの続きへ戻れる。**
 *
 * 注意（SDK の契約）:
 * - `uuid` を持つ行は冪等キーとして扱う（再送・再取り込みで二重に積まない）
 * - `uuid` を持たない行（タイトル・タグ等）はそのまま積む
 * - 一度も書かれていない key には `null` を返す（空配列ではない）
 */
/**
 * `readTail` が末尾から見る行数の上限。
 *
 * **文字数で足りるまで積むが、1行の大きさは一定でない**（数十字のものも数 KB の
 * ものもある）。⟹ 行数の上限は**費用の天井**として置く —— 足りなければ短い末尾に
 * なるが、蒸留はそれで成立する（`clone.ts` の `tailOf` は、もともと末尾しか読まない）。
 */
const TAIL_SCAN_ROWS = 2_000;

export class PgSessionStore implements SessionStore, SessionTranscriptTail {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const subpath = key.subpath ?? '';

    // uuid 付きは冪等に、無いものはそのまま。まとめて1文にすると、片方の
    // 衝突指定が他方に効いてしまう（uuid 無しの行が黙って落ちる）。
    const idempotent = entries.filter((entry) => typeof entry.uuid === 'string');
    const plain = entries.filter((entry) => typeof entry.uuid !== 'string');

    if (idempotent.length > 0) {
      await this.#db
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
          // 部分ユニーク索引なので述語まで書く。書かないと索引が選ばれず、
          // 衝突が検出されないまま同じ行が二重に積まれる。
          where: sql`${sessionEntries.uuid} is not null`,
        });
    }

    if (plain.length > 0) {
      await this.#db.insert(sessionEntries).values(
        plain.map((entry) => ({
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath,
          uuid: null,
          entry: stripNulls(entry),
        })),
      );
    }

    // `listSessions` の mtime。索引を持たないと、どのセッションが新しいのか
    // 分からなくなる（SDK は mtime 降順で並べる前提で読む）。
    await this.#db
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
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = await this.#db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(this.#keyFilter(key))
      .orderBy(asc(sessionEntries.seq));
    if (rows.length === 0) return null;
    return rows.map((row) => row.entry as SessionStoreEntry);
  }

  /**
   * 末尾だけを返す（#564 E1b。`SessionTranscriptTail`）。
   *
   * **`load()` を使わない。** あちらは全件を戻すので、580 MB 級のセッションでは
   * SDK が `load()` に掛けている 60 秒の予算に当たりに行くことになる。
   *
   * **索引の並びをそのまま逆から読む** —— `session_entries_key_idx` は
   * `(project_key, session_id, subpath, seq)` なので、`desc(seq)` はソートを起こさない。
   */
  async readTail(key: LostSessionGrave, maxChars: number): Promise<string | null> {
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

    // **新しい方から積んで、足りたら止める。** 生ログは1行1レコードの JSONL なので、
    // ここで組み直したものは器の外に在るファイルと同じ形になる。
    const lines: string[] = [];
    let chars = 0;
    for (const row of rows) {
      const line = JSON.stringify(row.entry);
      lines.push(line);
      chars += line.length + 1;
      if (chars >= maxChars) break;
    }
    return lines.reverse().join('\n');
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    const rows = await this.#db
      .select({ sessionId: sessions.sessionId, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(and(eq(sessions.projectKey, projectKey), eq(sessions.subpath, '')));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      mtime: Math.floor(new Date(row.updatedAt).getTime()),
    }));
  }

  /** 作業者（サブエージェント）の生ログも resume 時に materialize させる。 */
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
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

  async delete(key: SessionKey): Promise<void> {
    await this.#db.delete(sessionEntries).where(this.#keyFilter(key));
    await this.#db
      .delete(sessions)
      .where(
        and(
          eq(sessions.projectKey, key.projectKey),
          eq(sessions.sessionId, key.sessionId),
          eq(sessions.subpath, key.subpath ?? ''),
        ),
      );
  }

  #keyFilter(key: SessionKey) {
    return and(
      eq(sessionEntries.projectKey, key.projectKey),
      eq(sessionEntries.sessionId, key.sessionId),
      eq(sessionEntries.subpath, key.subpath ?? ''),
    );
  }
}
