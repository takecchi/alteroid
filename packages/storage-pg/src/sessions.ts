import {
  assertNoNul,
  noteSessionMaterialUnreadable,
  type LostSessionGrave,
  type SessionRegistry,
  type TranscriptGrave,
} from '@alteroid/core';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from './db.js';
import { daemonState } from './schema.js';

// 壊れた1行で起動を止めない: 読めなければ跡を残して `null` を返す。
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
// 墓標を別の key に置く: fs 側は同居させると丸ごと消えるため、器で振る舞いが変わらないよう両方とも別の欄に揃える。
const CLONE_TRANSCRIPT_GRAVE_KEY = 'clone_transcript_grave';
const CLONE_LOST_SESSION_KEY = 'clone_lost_session';
const CLONE_PROJECT_KEY = 'clone_project_key';
// 蒸留の失敗回数は墓標の本体と別の key に置く（#4752）: `clearTranscriptGraveIf` が生の文字列で突き合わせるので、墓標の値へ相乗りさせると一致しなくなるため。
const DISTILL_FAILURES_KEYS = {
  transcript: 'clone_transcript_grave_distill_failures',
  lost_session: 'clone_lost_session_distill_failures',
} as const;

function parseDistillFailures(
  raw: string,
  key: string,
): { graveId: string; failures: number } | null {
  return parseStoredJson(raw, `墓標の蒸留失敗回数（${key}）`, (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { graveId, failures } = parsed as { graveId?: unknown; failures?: unknown };
    if (typeof graveId !== 'string' || graveId.length === 0) return null;
    if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) return null;
    return { graveId, failures };
  });
}

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
    if (sessionId !== null) assertNoNul('session.cloneSessionId', sessionId);
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

  // 判定と削除を1文にする: 読みと書きの間に別の書き手が入る窓を作らないため。
  // 生の文字列で突き合わせる: `TranscriptGrave` の欄が `archiveId` ひとつだけなので一意に決まる。欄が増えたら見直すこと。
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

  // 生の文字列で突き合わせない: 欄が2つあり、`projectKey` を呼び出し側が持っていないため。同じトランザクションの中で読んでから消す。
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

  async graveDistillFailures(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<number> {
    const key = DISTILL_FAILURES_KEYS[kind];
    // 読めなければ 0: 数えられないだけで起動を止める理由が無いため
    try {
      const rows = await this.#db
        .select({ value: daemonState.value })
        .from(daemonState)
        .where(eq(daemonState.key, key))
        .limit(1);
      const raw = rows[0]?.value ?? null;
      if (raw === null) return 0;
      const stored = parseDistillFailures(raw, key);
      return stored?.graveId === graveId ? stored.failures : 0;
    } catch (error) {
      noteSessionMaterialUnreadable(`墓標の蒸留失敗回数（${key}）`, error);
      return 0;
    }
  }

  // 読んでから書くまでを1トランザクションにする: 別々だと2つの数え上げが同じ値から始まり、1回ぶん落ちるため
  async noteGraveDistillFailure(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<number> {
    const key = DISTILL_FAILURES_KEYS[kind];
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ value: daemonState.value })
        .from(daemonState)
        .where(eq(daemonState.key, key))
        .for('update')
        .limit(1);
      const raw = rows[0]?.value ?? null;
      const stored = raw === null ? null : parseDistillFailures(raw, key);
      const failures = stored?.graveId === graveId ? stored.failures + 1 : 1;
      const value = JSON.stringify({ graveId, failures });
      await tx
        .insert(daemonState)
        .values({ key, value })
        .onConflictDoUpdate({ target: daemonState.key, set: { value } });
      return failures;
    });
  }

  async getProjectKey(): Promise<string | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_PROJECT_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  async setProjectKey(projectKey: string): Promise<void> {
    assertNoNul('session.projectKey', projectKey);
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_PROJECT_KEY, value: projectKey })
      .onConflictDoUpdate({ target: daemonState.key, set: { value: projectKey } });
  }

  // `daemon_state` 全体を消さない: migrate が置く印も消えて次の起動で旧表を写し直し、返す件数にも印が混ざるため。欄が増えたら配列へ足すこと。
  async clear(): Promise<number> {
    const removed = await this.#db
      .delete(daemonState)
      .where(
        inArray(daemonState.key, [
          CLONE_SESSION_KEY,
          CLONE_TRANSCRIPT_GRAVE_KEY,
          CLONE_LOST_SESSION_KEY,
          CLONE_PROJECT_KEY,
        ]),
      )
      .returning({ key: daemonState.key });
    return removed.length;
  }
}
