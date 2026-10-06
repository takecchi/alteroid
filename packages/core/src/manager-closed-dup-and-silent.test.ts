import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **Issue #3187 — 同じ `closed(failed)` が二重に届くと、日誌・知らせ・器の失敗数が二重になる。**
 *
 * `closed` には冪等キーが無い（runner の SSE は再接続で同じ出来事を配り直しうる）。
 * 直し方はデーモンの中だけ: 台帳が既に `failed` の委譲へ `closed(failed)` が届いたら、
 * 日誌にだけ残し、知らせ（`closed_failed`）も `noteManagerFailed` も出さず、状態も動かさない。
 * `failed` の後に resume されて `running` へ戻った委譲への `closed(failed)` は、新しい失敗として
 * 従来どおり知らせる（最後の歯）。
 *
 * 足場（`manualRunner` / `runningManualSetup`）は `manager-closed-failed-journal.test.ts`
 * 系と同じものをこの歯専用に複製してある。実時間の待ちは使わない
 * （`scripts/wallclock-waits-ratchet.test.ts`、#2146）。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  raw(event: RunnerEvent): void;
  resumeFailed(managerId: string, sessionId: string, reason: string, recovered: boolean): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async send() {
      /* この検証では使わない */
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

  return {
    runner,
    alive,
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      // **daemon の境界（runnerEventSchema.safeParse）を実際に通す**
      // （`manager-closed-failed-system-error.test.ts` と同じ作法——スキーマに
      // 無い欄はここで黙って落ちるので、emit した中身だけを見ていると境界で
      // 消えたことに気づけない）。
      const raw: RunnerEvent = { type: 'closed', managerId, status, reason };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
    raw(event) {
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
    resumeFailed(managerId, sessionId, reason, recovered) {
      const raw: RunnerEvent = {
        type: 'resume_failed',
        managerId,
        sessionId,
        reason,
        recovered,
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId: string,
  options: { synthesizedNoticeWindowMs?: number } = {},
): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    // **既定 3000ms より大きく取る。** テストの実時間の中で窓が自然に閉じて
    // しまうと「flush させていない」状態を作れない——この歯が測りたいのは
    // 「flush 前でも本文が残る」ことなので、窓を意図して開けたままにする。
    synthesizedNoticeWindowMs: options.synthesizedNoticeWindowMs ?? 60_000,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

describe('closed(failed) の二重配達（SSE 再送。#3187）', () => {
  it('同じ closed(failed) が2回配られても、日誌の失敗行は1本', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-dup');
    const reason = 'マネージャーのセッションが落ちた: Error: boom';
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    // Last-Event-ID の再送を模す: 同じ closed がもう一度届く。
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    await pool.stop(); // 合流窓を flush する

    const entries = await stores.journal.list({ types: ['exchange'] });
    const failureLines = entries.filter((e) => JSON.stringify(e).includes(`[mgr-dup] ${reason}`));
    expect(failureLines).toHaveLength(1);
  });

  it('同じ closed(failed) が2回配られても、知らせは「×2」にならない', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-dup');
    const reason = 'マネージャーのセッションが落ちた: Error: boom';
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    // Last-Event-ID の再送を模す: 同じ closed がもう一度届く。
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    await pool.stop(); // 合流窓を flush する

    const notices = inbox.filter(
      (e) => e.type === 'manager_message' && JSON.stringify(e).includes('boom'),
    );
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain('×2');
  });

  it('同じ closed(failed) が2回配られても、器の失敗は1回しか数えない（noteManagerFailed）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id: 'mgr-n',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/project',
      sessionId: 'sess-mgr-n',
      runnerId: 'runner-primary',
    });
    const fake = manualRunner();
    fake.alive.push({
      managerId: 'mgr-n',
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-mgr-n',
    });
    const registry = createRunnerRegistry([fake.runner]);
    const noted: string[] = [];
    const original = registry.noteManagerFailed.bind(registry);
    registry.noteManagerFailed = (runnerId: string) => {
      noted.push(runnerId);
      original(runnerId);
    };
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
      synthesizedNoticeWindowMs: 60_000,
    });
    await pool.restore();
    await vi.waitFor(() => {
      if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    fake.closed('mgr-n', 'failed', 'x');
    await settle();
    fake.closed('mgr-n', 'failed', 'x');
    await settle();
    await pool.stop();
    expect(noted).toEqual(['runner-primary']);
  });

  it('failed の後に resume されて running へ戻った委譲に届いた closed(failed) は、新しい失敗として従来どおり知らせる', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-again');
    fake.closed('mgr-again', 'failed', '1回目の失敗: boom1');
    await settle();
    const sent = await pool.send('mgr-again', '続きを');
    expect(sent.outcome).toBe('delivered');
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-again');
    expect(job?.status).toBe('running');
    fake.closed('mgr-again', 'failed', '2回目の失敗: boom2');
    await settle();
    await pool.stop(); // 合流窓を flush する

    const text = JSON.stringify(inbox.filter((e) => e.type === 'manager_message'));
    expect(text).toContain('boom2');
  });

  it('failed の委譲を send が開き直している最中（台帳はまだ failed）に届いた closed(failed) は、重複と読まず新しい失敗として知らせる', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-inflight');
    fake.closed('mgr-inflight', 'failed', '1回目の失敗: boom1');
    await settle();
    // send の resume を止めておき、その間に新しいセッションがすぐ落ちた closed(failed) を流す。
    // `send()` は resume の**後**で台帳を `running` に書くので、この窓では台帳はまだ `failed` である。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.runner.resume = async () => {
      entered();
      await gate;
      return {};
    };
    const sending = pool.send('mgr-inflight', '続きを');
    await enteredResume;
    fake.closed('mgr-inflight', 'failed', '開き直した直後の失敗: boom-inflight');
    await settle();
    release();
    await sending;
    await settle();
    await pool.stop(); // 合流窓を flush する

    const text = JSON.stringify(inbox.filter((e) => e.type === 'manager_message'));
    expect(text).toContain('boom-inflight');
  });

  // 対照（緑のはず）: lost は runner が先に resume_failed(recovered=false) を出すので知らせが出る。
  // （report 無しの closed(done) が無音になる件 #3189 は方針待ちなので、ここには取り込んでいない。）
  it('対照: resume_failed(recovered=false) の後に closed(lost) が続く通常の lost は、受信箱に出る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-lost');
    const before = inbox.length;
    fake.resumeFailed('mgr-lost', 'sess-mgr-lost', '戻れない', false);
    await settle();
    fake.closed('mgr-lost', 'lost', '戻れない');
    await settle();
    await pool.stop();
    expect(inbox.slice(before)).not.toHaveLength(0);
  });
});
