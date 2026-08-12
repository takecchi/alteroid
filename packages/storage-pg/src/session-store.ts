import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import type { Db } from './db.js';
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
export class PgSessionStore implements SessionStore {
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
            entry,
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
          entry,
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
