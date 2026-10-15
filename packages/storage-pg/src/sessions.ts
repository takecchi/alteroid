import {
  addGrave,
  assertNoNul,
  forgetDistillFailureCounts,
  listGraves,
  noteSessionMaterialUnreadable,
  parseDistillFailureCounts,
  readDistillFailureCount,
  removeGrave,
  serializeDistillFailureCounts,
  type DistillFailureCounts,
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
// 枠の後ろの順番待ち（#4884）。JSON 配列を1行に置く。行が無ければ空として読めるので、古い版のデータはそのまま読め、表の変更（migrate）は要らない。
const CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY = 'clone_transcript_grave_queue';
const CLONE_LOST_SESSION_QUEUE_KEY = 'clone_lost_session_queue';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function parseArchiveGrave(raw: string): TranscriptGrave | null {
  return parseStoredJson(raw, '生ログの墓標（clone_transcript_grave）', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const archiveId = (parsed as { archiveId?: unknown }).archiveId;
    return typeof archiveId === 'string' && archiveId.length > 0 ? { archiveId } : null;
  });
}

function parseLostGrave(raw: string): LostSessionGrave | null {
  return parseStoredJson(raw, '再開素材を捨てた回の墓標（clone_lost_session）', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { projectKey, sessionId } = parsed as { projectKey?: unknown; sessionId?: unknown };
    if (typeof projectKey !== 'string' || projectKey.length === 0) return null;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    return { projectKey, sessionId };
  });
}

function parseQueue<T>(raw: string, what: string, one: (value: unknown) => T | null): T[] {
  return (
    parseStoredJson(raw, what, (parsed) => {
      if (!Array.isArray(parsed)) return null;
      return parsed.map(one).filter((item): item is T => item !== null);
    }) ?? []
  );
}

const parseArchiveQueue = (raw: string): TranscriptGrave[] =>
  parseQueue(raw, '生ログの墓標の順番待ち', (v) => parseArchiveGrave(JSON.stringify(v)));
const parseLostQueue = (raw: string): LostSessionGrave[] =>
  parseQueue(raw, '再開素材を捨てた回の墓標の順番待ち', (v) => parseLostGrave(JSON.stringify(v)));

// 行を先に作ってから `for update` で読む: 行が無いと、ロックの掛けようが無く同時の追加が同じ空の列から始まるため
async function lockQueue<T>(tx: Tx, key: string, parse: (raw: string) => T[]): Promise<T[]> {
  await tx.insert(daemonState).values({ key, value: '[]' }).onConflictDoNothing();
  const rows = await tx
    .select({ value: daemonState.value })
    .from(daemonState)
    .where(eq(daemonState.key, key))
    .for('update')
    .limit(1);
  const raw = rows[0]?.value ?? null;
  return raw === null ? [] : parse(raw);
}

async function writeQueue(tx: Tx, key: string, queue: unknown[]): Promise<void> {
  await tx
    .update(daemonState)
    .set({ value: JSON.stringify(queue) })
    .where(eq(daemonState.key, key));
}
// 蒸留の失敗回数は墓標の本体と別の key に置く（#4752）: `clearTranscriptGraveIf` が生の文字列で突き合わせるので、墓標の値へ相乗りさせると一致しなくなるため。
const DISTILL_FAILURES_KEYS = {
  transcript: 'clone_transcript_grave_distill_failures',
  lost_session: 'clone_lost_session_distill_failures',
} as const;

// 墓標ごとの回数（#4898）。古い形（1件だけの `{ graveId, failures }`）も読む。値の形を変えるだけなので migrate は要らない
function parseDistillFailures(raw: string, key: string): DistillFailureCounts | null {
  return parseStoredJson(raw, `墓標の蒸留失敗回数（${key}）`, parseDistillFailureCounts);
}

async function writeDistillFailures(
  tx: Tx,
  key: string,
  counts: DistillFailureCounts,
): Promise<void> {
  const value = serializeDistillFailureCounts(counts);
  await tx
    .insert(daemonState)
    .values({ key, value })
    .onConflictDoUpdate({ target: daemonState.key, set: { value } });
}

// 墓標が下りた・上限で落ちたら、その回数も消す（#4898）。墓標を書くのと同じトランザクションの中で呼ぶ
async function forgetDistillFailures(
  tx: Tx,
  kind: 'transcript' | 'lost_session',
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const key = DISTILL_FAILURES_KEYS[kind];
  const rows = await tx
    .select({ value: daemonState.value })
    .from(daemonState)
    .where(eq(daemonState.key, key))
    .for('update')
    .limit(1);
  const raw = rows[0]?.value ?? null;
  const stored = raw === null ? null : parseDistillFailures(raw, key);
  if (stored === null) return;
  const next = forgetDistillFailureCounts(stored, ids);
  if (Object.keys(next).length === Object.keys(stored).length) return;
  if (Object.keys(next).length === 0) await tx.delete(daemonState).where(eq(daemonState.key, key));
  else await writeDistillFailures(tx, key, next);
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

  // 順番待ちの行を先にロックし（足す回と同じ順）、同じトランザクションの中で読んでから下ろす: 枠と列を別々に書くと、足す回と下ろす回が互いの書き込みを消すため。
  // 枠を下ろしたら列の先頭を枠へ昇格させる（#4898）
  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, parseArchiveQueue);
      const primary = await this.#readTranscriptPrimary(tx);
      const next = removeGrave({ primary, queue }, (g) => g.archiveId === archiveId);
      if (!next.removed) {
        // 読めない枠の行は、同じ id の生の文字列に当たるときだけ下ろす（今までどおり）
        const raw = await tx
          .delete(daemonState)
          .where(
            and(
              eq(daemonState.key, CLONE_TRANSCRIPT_GRAVE_KEY),
              eq(daemonState.value, JSON.stringify({ archiveId })),
            ),
          )
          .returning({ key: daemonState.key });
        if (raw.length > 0) await forgetDistillFailures(tx, 'transcript', [archiveId]);
        return raw.length > 0;
      }
      await this.#writeTranscriptPrimary(tx, next.primary);
      await writeQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, next.queue);
      await forgetDistillFailures(tx, 'transcript', [archiveId]);
      return true;
    });
  }

  async #writeTranscriptPrimary(tx: Tx, primary: TranscriptGrave | null): Promise<void> {
    if (primary === null) {
      await tx.delete(daemonState).where(eq(daemonState.key, CLONE_TRANSCRIPT_GRAVE_KEY));
      return;
    }
    const value = JSON.stringify(primary);
    await tx
      .insert(daemonState)
      .values({ key: CLONE_TRANSCRIPT_GRAVE_KEY, value })
      .onConflictDoUpdate({ target: daemonState.key, set: { value } });
  }

  async #readTranscriptPrimary(tx: Tx): Promise<TranscriptGrave | null> {
    const rows = await tx
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_TRANSCRIPT_GRAVE_KEY))
      .for('update')
      .limit(1);
    const raw = rows[0]?.value ?? null;
    return raw === null ? null : parseArchiveGrave(raw);
  }

  async addTranscriptGrave(grave: TranscriptGrave): Promise<{ dropped: string[] }> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, parseArchiveQueue);
      const primary = await this.#readTranscriptPrimary(tx);
      const next = addGrave({ primary, queue }, grave, (a, b) => a.archiveId === b.archiveId);
      if (next.primary !== null && next.primary.archiveId !== primary?.archiveId) {
        const value = JSON.stringify(next.primary);
        await tx
          .insert(daemonState)
          .values({ key: CLONE_TRANSCRIPT_GRAVE_KEY, value })
          .onConflictDoUpdate({ target: daemonState.key, set: { value } });
      }
      await writeQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, next.queue);
      await forgetDistillFailures(
        tx,
        'transcript',
        next.dropped.map((g) => g.archiveId),
      );
      return { dropped: next.dropped.map((g) => g.archiveId) };
    });
  }

  async listTranscriptGraves(): Promise<TranscriptGrave[]> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, parseArchiveQueue);
      return listGraves({ primary: await this.#readTranscriptPrimary(tx), queue });
    });
  }

  async #readLostPrimary(tx: Tx): Promise<LostSessionGrave | null> {
    const rows = await tx
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_LOST_SESSION_KEY))
      .for('update')
      .limit(1);
    const raw = rows[0]?.value ?? null;
    return raw === null ? null : parseLostGrave(raw);
  }

  async addLostSessionGrave(grave: LostSessionGrave): Promise<{ dropped: string[] }> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, parseLostQueue);
      const primary = await this.#readLostPrimary(tx);
      const next = addGrave({ primary, queue }, grave, (a, b) => a.sessionId === b.sessionId);
      if (next.primary !== null && next.primary.sessionId !== primary?.sessionId) {
        const value = JSON.stringify(next.primary);
        await tx
          .insert(daemonState)
          .values({ key: CLONE_LOST_SESSION_KEY, value })
          .onConflictDoUpdate({ target: daemonState.key, set: { value } });
      }
      await writeQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, next.queue);
      await forgetDistillFailures(
        tx,
        'lost_session',
        next.dropped.map((g) => g.sessionId),
      );
      return { dropped: next.dropped.map((g) => g.sessionId) };
    });
  }

  async listLostSessionGraves(): Promise<LostSessionGrave[]> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, parseLostQueue);
      return listGraves({ primary: await this.#readLostPrimary(tx), queue });
    });
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
  // 順番待ちの行を先にロックする（足す回と同じ順）。枠を下ろしたら列の先頭を枠へ昇格させる（#4898）
  async clearLostSessionGraveIf(sessionId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, parseLostQueue);
      const primary = await this.#readLostPrimary(tx);
      const next = removeGrave({ primary, queue }, (g) => g.sessionId === sessionId);
      if (!next.removed) return false;
      if (next.primary === null) {
        await tx.delete(daemonState).where(eq(daemonState.key, CLONE_LOST_SESSION_KEY));
      } else if (next.primary.sessionId !== primary?.sessionId) {
        const value = JSON.stringify(next.primary);
        await tx
          .insert(daemonState)
          .values({ key: CLONE_LOST_SESSION_KEY, value })
          .onConflictDoUpdate({ target: daemonState.key, set: { value } });
      }
      await writeQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, next.queue);
      await forgetDistillFailures(tx, 'lost_session', [sessionId]);
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
      return readDistillFailureCount(stored, graveId);
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
      const failures = readDistillFailureCount(stored, graveId) + 1;
      await writeDistillFailures(tx, key, { ...stored, [graveId]: failures });
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
          CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY,
          CLONE_LOST_SESSION_QUEUE_KEY,
          CLONE_PROJECT_KEY,
        ]),
      )
      .returning({ key: daemonState.key });
    return removed.length;
  }
}
