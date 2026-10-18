import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 担当が戻っていればクローンが畳んでよい印（`manager_message.foldWhenBack`。#5048）が、どの知らせに付き、どれに付かないかを外から観測する。
// 組み方は manager-quota-session-window-marks.test.ts と同じ。
const NOTICE_WINDOW_MS = 20;
const POOL_WINDOW_MS = 2_000;
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

const SESSION_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";

interface FakeRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  emit(event: RunnerEvent): void;
}

function fakeRunner(): FakeRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return { runner, alive, emit: (event) => emit?.(event) };
}

interface Setup {
  pool: ManagerPool;
  fake: FakeRunner;
  /** 立ち上げ（reattach）の知らせより後の受信箱。 */
  fresh(): InboxEvent[];
}

async function setup(managerId: string): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  const job: Job = {
    id: managerId,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  await stores.jobs.putJob(job);
  fake.alive.push({
    managerId,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    tokenIdentity: () => ({ tokenId: 'tok-7', generation: 7 }),
    synthesizedNoticeWindowMs: NOTICE_WINDOW_MS,
    quotaStopWindowMs: POOL_WINDOW_MS,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length < 1) throw new Error('reattach の知らせがまだ届いていない');
  });
  const baseline = inbox.length;
  return { pool, fake, fresh: () => inbox.slice(baseline) };
}

function managerMessages(events: readonly InboxEvent[]) {
  return events.filter((event) => event.type === 'manager_message') as Extract<
    InboxEvent,
    { type: 'manager_message' }
  >[];
}

async function firstMessage(fresh: () => InboxEvent[]) {
  await vi.waitFor(() => expect(managerMessages(fresh()).length).toBeGreaterThan(0), WAIT);
  return managerMessages(fresh())[0]!;
}

describe('担当が戻っていれば畳んでよい印（#5048）', () => {
  it('⭐ セッションが落ちた（closed failed・枠と無関係）の知らせには foldWhenBack が付く（世代の条件なし）', async () => {
    const { pool, fake, fresh } = await setup('mgr-a');

    fake.emit({
      type: 'closed',
      managerId: 'mgr-a',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: Error: Claude Code process exited with code 1',
    } as RunnerEvent);
    const own = await firstMessage(fresh);

    expect(own.text).toContain('exited with code 1');
    expect(own.foldWhenBack).toEqual({});

    await pool.stop();
  });

  it('⭐ 作業者の落ちの note（notifyClone・workerLimit）には、積んだ時点の担当の鍵の世代が付く', async () => {
    const { pool, fake, fresh } = await setup('mgr-a');
    // 開き直しの note で、デーモンにこの担当の鍵の世代を覚えさせる（再起動で引き取っただけの担当は覚えていない）
    fake.emit({
      type: 'note',
      managerId: 'mgr-a',
      text: '開き直した',
      tokenRotation: true,
    } as RunnerEvent);

    fake.emit({
      type: 'note',
      managerId: 'mgr-a',
      text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
      notifyClone: true,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: true },
    } as RunnerEvent);
    const own = await firstMessage(fresh);

    expect(own.text).toContain('だけが利用上限で落ちた');
    expect(own.foldWhenBack).toEqual({ movedFromGeneration: 7 });

    await pool.stop();
  });

  it('作業者の落ちでも、担当の鍵の世代をデーモンが覚えていなければ付けない（移ったかを比べられないため）', async () => {
    const { pool, fake, fresh } = await setup('mgr-a');

    fake.emit({
      type: 'note',
      managerId: 'mgr-a',
      text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
      notifyClone: true,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: false },
    } as RunnerEvent);
    const own = await firstMessage(fresh);

    expect('foldWhenBack' in own).toBe(false);

    await pool.stop();
  });

  it('作業者の落ちでない notifyClone の note には付かない', async () => {
    const { pool, fake, fresh } = await setup('mgr-a');

    fake.emit({
      type: 'note',
      managerId: 'mgr-a',
      text: '退避から漏れた作業ツリーがある',
      notifyClone: true,
    } as RunnerEvent);
    const own = await firstMessage(fresh);

    expect('foldWhenBack' in own).toBe(false);

    await pool.stop();
  });

  it('枠の知らせの束（5時間枠でも）には付かない（#4499 の判定に任せる）', async () => {
    const { pool, fake, fresh } = await setup('mgr-a');

    fake.emit({
      type: 'report',
      managerId: 'mgr-a',
      text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${SESSION_LIMIT}`,
      status: 'done',
      failure: { code: 'success/429', via: 'result_is_error', status: 429 },
      synthesized: 'turn_failed',
    });
    const own = await firstMessage(fresh);

    expect(own.quotaStop).toBe(true);
    expect('foldWhenBack' in own).toBe(false);

    await pool.stop();
  });

  it('枠と無関係に応答を返さずに終わったターン（turn_failed）には付かない', async () => {
    const { pool, fake, fresh } = await setup('mgr-a');

    fake.emit({
      type: 'report',
      managerId: 'mgr-a',
      text: '（このターンは応答を返さずに終わった: error_during_execution）',
      status: 'done',
      failure: { code: 'error_during_execution', via: 'result' },
      synthesized: 'turn_failed',
    } as RunnerEvent);
    const own = await firstMessage(fresh);

    expect('foldWhenBack' in own).toBe(false);

    await pool.stop();
  });
});
