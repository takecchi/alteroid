import type { LostSessionGrave, SessionRegistry, TranscriptGrave } from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { daemonState } from './schema.js';

const CLONE_SESSION_KEY = 'clone_session_id';
/**
 * 墓標は**別の key** に置く（`SessionRegistry` の doc）。
 *
 * ⚠️ pg 側は `setCloneSessionId(null)` が `clone_session_id` の行だけを消すので
 * 同居させても消えないが、**fs 側は丸ごと消える。** 器で振る舞いが変わるのは
 * それ自体が欠陥なので（M4 の要件）、両方とも別の欄に揃える。
 */
const CLONE_TRANSCRIPT_GRAVE_KEY = 'clone_transcript_grave';
/** resume 素材を捨てた回の墓標（`SessionRegistry` の doc。上の欄とは別物である）。 */
const CLONE_LOST_SESSION_KEY = 'clone_lost_session';

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

  async getTranscriptGrave(): Promise<TranscriptGrave | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_TRANSCRIPT_GRAVE_KEY))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw === null) return null;
    // **壊れた1行で起動を止めない。** ここは resume 素材と同じ族（消えても記憶から
    // 戻る）なので、読めなければ「無い」へ倒す。
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const archiveId = (parsed as { archiveId?: unknown }).archiveId;
      return typeof archiveId === 'string' && archiveId.length > 0 ? { archiveId } : null;
    } catch {
      return null;
    }
  }

  async setTranscriptGrave(grave: TranscriptGrave | null): Promise<void> {
    if (grave === null) {
      await this.#db.delete(daemonState).where(eq(daemonState.key, CLONE_TRANSCRIPT_GRAVE_KEY));
      return;
    }
    const value = JSON.stringify(grave);
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_TRANSCRIPT_GRAVE_KEY, value })
      .onConflictDoUpdate({ target: daemonState.key, set: { value } });
  }

  async getLostSessionGrave(): Promise<LostSessionGrave | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_LOST_SESSION_KEY))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw === null) return null;
    // **壊れた1行で起動を止めない**（`getTranscriptGrave` と同じ理由）。
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const { projectKey, sessionId } = parsed as {
        projectKey?: unknown;
        sessionId?: unknown;
      };
      if (typeof projectKey !== 'string' || projectKey.length === 0) return null;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      return { projectKey, sessionId };
    } catch {
      return null;
    }
  }

  async setLostSessionGrave(grave: LostSessionGrave | null): Promise<void> {
    if (grave === null) {
      await this.#db.delete(daemonState).where(eq(daemonState.key, CLONE_LOST_SESSION_KEY));
      return;
    }
    const value = JSON.stringify(grave);
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_LOST_SESSION_KEY, value })
      .onConflictDoUpdate({ target: daemonState.key, set: { value } });
  }
}
