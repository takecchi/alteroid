import type { SessionRegistry } from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { daemonState } from './schema.js';

const CLONE_SESSION_KEY = 'clone_session_id';

/**
 * クローンのセッション id の置き場。
 *
 * ここは同一性の置き場ではない（同一性は記憶に宿る）。コンテナが作り直されても
 * 記憶と日誌が同じなら同じクローンであり、この行はセッションを resume するための
 * 再開素材にすぎない。
 */
export class PgSessionRegistry implements SessionRegistry {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async getCloneSessionId(): Promise<string | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_SESSION_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  async setCloneSessionId(sessionId: string | null): Promise<void> {
    if (sessionId === null) {
      await this.#db.delete(daemonState).where(eq(daemonState.key, CLONE_SESSION_KEY));
      return;
    }
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_SESSION_KEY, value: sessionId })
      .onConflictDoUpdate({ target: daemonState.key, set: { value: sessionId } });
  }
}
