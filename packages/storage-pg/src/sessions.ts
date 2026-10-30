import {
  addGrave,
  assertNoNul,
  forgetDistillFailureCounts,
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
import { eq, inArray } from 'drizzle-orm';

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
// 畳みの控え。id と別の key に置く（fs と同じ）。行が無ければ「控え無し」なので、古い版のデータはそのまま読め、migrate は要らない
const CLONE_FOLD_STATE_KEY = 'clone_fold_state';
const CLONE_PROJECT_KEY = 'clone_project_key';
// 墓標の列（#4884）。別の key に置く（fs 側は同居させると丸ごと消えるため、器で振る舞いが変わらないよう揃える）。JSON 配列を1行に置く。行が無ければ空として読め、表の変更（migrate）は要らない。
// 墓標を1つだけ置いていた古い行（`clone_transcript_grave`・`clone_lost_session`）は読み書きしない: 読めなくても失われて困らない記録として捨てる（#5869）。
// `daemon_state` は key/value で落とす列も表も無く、残った行は `clear()` でも触らず放置する。
const CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY = 'clone_transcript_grave_queue';
const CLONE_LOST_SESSION_QUEUE_KEY = 'clone_lost_session_queue';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function parseArchiveGrave(raw: string): TranscriptGrave | null {
  return parseStoredJson(raw, '生ログの墓標（clone_transcript_grave_queue）', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const archiveId = (parsed as { archiveId?: unknown }).archiveId;
    return typeof archiveId === 'string' && archiveId.length > 0 ? { archiveId } : null;
  });
}

function parseLostGrave(raw: string): LostSessionGrave | null {
  return parseStoredJson(raw, '再開素材を捨てた回の墓標（clone_lost_session_queue）', (parsed) => {
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
  parseQueue(raw, '生ログの墓標の列', (v) => parseArchiveGrave(JSON.stringify(v)));
const parseLostQueue = (raw: string): LostSessionGrave[] =>
  parseQueue(raw, '再開素材を捨てた回の墓標の列', (v) => parseLostGrave(JSON.stringify(v)));

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
// 蒸留の失敗回数は墓標の列と別の key に置く（#4752）: 墓標の形に触れずに済ませるため。
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
      // 控えも同じ文で消す: id だけが消えて控えが残る窓を作らない
      await this.#db
        .delete(daemonState)
        .where(inArray(daemonState.key, [CLONE_SESSION_KEY, CLONE_FOLD_STATE_KEY]));
      return;
    }
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_SESSION_KEY, value: sessionId })
      .onConflictDoUpdate({ target: daemonState.key, set: { value: sessionId } });
  }

  // 中身を解釈しない（壊れていれば呼び出し側が捨てる）。`daemon_state` は key/value なので migrate は要らない
  async getFoldState(): Promise<string | null> {
    const rows = await this.#db
      .select({ value: daemonState.value })
      .from(daemonState)
      .where(eq(daemonState.key, CLONE_FOLD_STATE_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  async setFoldState(state: string | null): Promise<void> {
    if (state === null) {
      await this.#db.delete(daemonState).where(eq(daemonState.key, CLONE_FOLD_STATE_KEY));
      return;
    }
    assertNoNul('session.foldState', state);
    await this.#db
      .insert(daemonState)
      .values({ key: CLONE_FOLD_STATE_KEY, value: state })
      .onConflictDoUpdate({ target: daemonState.key, set: { value: state } });
  }

  // 列の行を `for update` でロックし、同じトランザクションの中で読んでから書く: 読みと書きが別々だと、足す回と下ろす回が互いの書き込みを消すため。
  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, parseArchiveQueue);
      const next = removeGrave(queue, (g) => g.archiveId === archiveId);
      if (!next.removed) return false;
      await writeQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, next.queue);
      await forgetDistillFailures(tx, 'transcript', [archiveId]);
      return true;
    });
  }

  async addTranscriptGrave(grave: TranscriptGrave): Promise<{ dropped: string[] }> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, parseArchiveQueue);
      const next = addGrave(queue, grave, (a, b) => a.archiveId === b.archiveId);
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
    return this.#db.transaction((tx) =>
      lockQueue(tx, CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY, parseArchiveQueue),
    );
  }

  async addLostSessionGrave(grave: LostSessionGrave): Promise<{ dropped: string[] }> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, parseLostQueue);
      const next = addGrave(queue, grave, (a, b) => a.sessionId === b.sessionId);
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
    return this.#db.transaction((tx) =>
      lockQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, parseLostQueue),
    );
  }

  // 列の行を先にロックする（足す回と同じ順）。
  async clearLostSessionGraveIf(sessionId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const queue = await lockQueue(tx, CLONE_LOST_SESSION_QUEUE_KEY, parseLostQueue);
      const next = removeGrave(queue, (g) => g.sessionId === sessionId);
      if (!next.removed) return false;
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
          CLONE_FOLD_STATE_KEY,
          CLONE_TRANSCRIPT_GRAVE_QUEUE_KEY,
          CLONE_LOST_SESSION_QUEUE_KEY,
          CLONE_PROJECT_KEY,
          DISTILL_FAILURES_KEYS.transcript,
          DISTILL_FAILURES_KEYS.lost_session,
        ]),
      )
      .returning({ key: daemonState.key });
    return removed.length;
  }
}
