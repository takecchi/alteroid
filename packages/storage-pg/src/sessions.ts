import {
  noteSessionMaterialUnreadable,
  type LostSessionGrave,
  type SessionRegistry,
  type TranscriptGrave,
} from '@alteroid/core';
import { and, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { daemonState } from './schema.js';

/**
 * 保存された JSON 文字列を読む。**行が無いのと違い、ここへ来るのは
 * 「行は在るのに読めなかった」場合だけである**（issue #1147）。
 *
 * `JSON.parse` が投げたときも、`parse` がスキーマ不一致で `null` を返した
 * ときも、`noteSessionMaterialUnreadable` で跡を残したうえで `null` を
 * 返す——**壊れた1行で起動を止めない**という判断（`getTranscriptGrave` /
 * `getLostSessionGrave` の doc）そのものは変えない。変えるのは「黙って倒すか、
 * 跡を残して倒すか」だけである。
 */
function parseStoredJson<T>(
  raw: string,
  what: string,
  parse: (value: unknown) => T | null,
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    noteSessionMaterialUnreadable(what, error);
    return null;
  }
  const result = parse(parsed);
  if (result === null) {
    noteSessionMaterialUnreadable(what, new Error('JSON としては読めたが、スキーマに合わない'));
  }
  return result;
}

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
/** SDK が生ログを預けるときの scope（`SessionRegistry.getProjectKey` の doc）。 */
const CLONE_PROJECT_KEY = 'clone_project_key';

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
    // 戻る）なので、読めなければ「無い」へ倒す。**ただし跡は残す**
    // （`parseStoredJson` の doc、issue #1147）。
    return parseStoredJson(raw, '生ログの墓標（clone_transcript_grave）', (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const archiveId = (parsed as { archiveId?: unknown }).archiveId;
      return typeof archiveId === 'string' && archiveId.length > 0 ? { archiveId } : null;
    });
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

  /**
   * `SessionRegistry.clearTranscriptGraveIf` の doc のとおり、**判定と削除を
   * 1文へ畳む。** `delete … where key = ? and value = ?` は DB の側で原子なので、
   * 読みと書きの間に別の書き手が入る窓そのものが存在しない——**ここが3実装の
   * 中でいちばん強い**（`PgCommitmentStore.open` と同じ理由）。
   *
   * **比べるのは保存してある生の文字列そのものである。** `setTranscriptGrave` が
   * `JSON.stringify(grave)` で書くので、同じ形を作って突き合わせる——
   * `TranscriptGrave` の欄は `archiveId` ひとつなので、これで一意に決まる
   * （欄が増えたらここも見直すこと）。
   */
  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    const removed = await this.#db
      .delete(daemonState)
      .where(
        and(
          eq(daemonState.key, CLONE_TRANSCRIPT_GRAVE_KEY),
          eq(daemonState.value, JSON.stringify({ archiveId })),
        ),
      )
      .returning({ key: daemonState.key });
    return removed.length > 0;
  }

  async getLostSessionGrave(): Promise<LostSessionGrave | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_LOST_SESSION_KEY))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw === null) return null;
    // **壊れた1行で起動を止めない**（`getTranscriptGrave` と同じ理由。
    // 跡を残すのも同じ、issue #1147）。
    return parseStoredJson(raw, '再開素材を捨てた回の墓標（clone_lost_session）', (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const { projectKey, sessionId } = parsed as {
        projectKey?: unknown;
        sessionId?: unknown;
      };
      if (typeof projectKey !== 'string' || projectKey.length === 0) return null;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      return { projectKey, sessionId };
    });
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

  /**
   * 形と理由は {@link PgSessionRegistry.clearTranscriptGraveIf} と同じである。
   *
   * ⚠️ **`LostSessionGrave` は欄が2つある**（`projectKey` / `sessionId`）ので、
   * 生の文字列では突き合わせられない——`projectKey` は呼び出し側が持っていない。
   * ⟹ ここだけは**読んでから条件付きで消す**が、**同じ1つのトランザクションの
   * 中で行う**ので、読みと削除の間に別の書き手は入らない。
   */
  async clearLostSessionGraveIf(sessionId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ value: daemonState.value })
        .from(daemonState)
        .where(eq(daemonState.key, CLONE_LOST_SESSION_KEY))
        .for('update')
        .limit(1);
      const raw = rows[0]?.value ?? null;
      if (raw === null) return false;
      const parsed = parseStoredJson(raw, '再開素材を捨てた回の墓標（clone_lost_session）', (v) => {
        if (typeof v !== 'object' || v === null) return null;
        const id = (v as { sessionId?: unknown }).sessionId;
        return typeof id === 'string' && id.length > 0 ? { sessionId: id } : null;
      });
      if (parsed?.sessionId !== sessionId) return false;
      await tx.delete(daemonState).where(eq(daemonState.key, CLONE_LOST_SESSION_KEY));
      return true;
    });
  }

  async getProjectKey(): Promise<string | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_PROJECT_KEY))
      .limit(1);
    // **ここは生の文字列で持つ**（JSON にしない）。`daemon_state` は key/value の
    // 器で、値そのものが1つなら包む理由が無い。
    return rows[0]?.value ?? null;
  }

  async setProjectKey(projectKey: string): Promise<void> {
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_PROJECT_KEY, value: projectKey })
      .onConflictDoUpdate({ target: daemonState.key, set: { value: projectKey } });
  }

  /**
   * 全件を消す（`SessionRegistry.clear` の doc）。**`daemon_state` テーブル全体
   * を消す** — 現時点でこのテーブルを使うのはこのクラスの4つの欄だけである
   * （`grep -rln daemonState packages/storage-pg/src` で確認できる）。将来
   * 別の用途がこのテーブルへ相乗りしたら、ここも見直すこと。
   */
  async clear(): Promise<number> {
    const removed = await this.#db.delete(daemonState).returning({ key: daemonState.key });
    return removed.length;
  }
}
