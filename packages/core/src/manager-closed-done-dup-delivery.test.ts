import { describe, expect, it } from 'vitest';

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
 * **Issue #3189 — report が無いまま `closed(done)` だけが届くと、クローンの受信箱に何も出ない。**
 *
 * 直し方（人間の決定 2026-10-06、案 A）: `closed(done)` で、**このセッションで report を
 * 受け取った記録が無い**ときだけ、受信箱へ1本の知らせを出す（`closed_failed` と同じ合成の
 * 知らせ＝合流窓）。報告の後の idle としての `closed(done)` は今までどおり無音。
 *
 * 判定は `record.job.lastReportAt`（デーモンが report を受け取った時刻）と
 * `record.runnerSessionSince`（器がこの委譲を持ったと確かめた時刻）の前後で行う。
 * 3つの状態を持つ: 受け取った（無音）／一度も無い（知らせる）／判定できない（知らせる。
 * 黙って無音へ倒さない）。
 *
 * 足場（`manualRunner` / `runningManualSetup`）は `manager-closed-dup-and-silent.test.ts`
 * （枝 `hunt/core2-q-closed-dup`）と同じものをこの歯専用に複製してある。実時間の待ちは使わない
 * （`scripts/wallclock-waits-ratchet.test.ts`、#2146）。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  raw(event: RunnerEvent): void;
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

  const deliver = (raw: RunnerEvent): void => {
    // **daemon の境界（runnerEventSchema.safeParse）を実際に通す**（スキーマに無い欄は
    // ここで黙って落ちるので、emit した中身だけを見ていると境界で消えたことに気づけない）。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  };

  return {
    runner,
    alive,
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      deliver({ type: 'closed', managerId, status, reason });
    },
    raw: deliver,
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  clock: { now: number };
}

async function runningManualSetup(
  managerId: string,
  jobOverrides: Partial<Job> = {},
  existingStores?: Stores,
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
    ...jobOverrides,
  };
  const stores = existingStores ?? createMemoryStores();
  if (existingStores === undefined) await stores.jobs.putJob(job);

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
  // `runnerSessionSince` はこの時計で書かれる（`lastReportAt` は実時計）。時計を進めて
  // 「report より後にセッションが置かれた」を作る。
  const clock = { now: Date.now() };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock.now,
    // 既定 3000ms より大きく取る（テストの実時間の中で窓が自然に閉じないように。
    // 閉じるのは `pool.stop()` の flush だけ）。
    synthesizedNoticeWindowMs: 60_000,
  });

  await pool.restore();
  await settle();

  return { pool, stores, inbox, fake, clock };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

const SESSION_CLOSED = 'マネージャーのセッションが閉じた。';

function noticesAbout(inbox: readonly InboxEvent[], from: number, managerId: string): string[] {
  return inbox
    .slice(from)
    .filter((e) => e.type === 'manager_message' && e.managerId === managerId)
    .map((e) => JSON.stringify(e));
}

describe('同じ closed(done) の二重配達（#3199 の知らせ。#3187 は failed だけを塞いだ）', () => {
  it('report 無しの closed(done) が2回配られても、「report を出さないまま終わった」知らせは1本だけ', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-done-dup');
    const before = inbox.length;
    // runner の SSE が再接続の Last-Event-ID で同じ出来事を配り直す（closed に冪等キーは無い）。
    fake.closed('mgr-done-dup', 'done', SESSION_CLOSED);
    await settle();
    fake.closed('mgr-done-dup', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop(); // 合流窓を流し切る
    const joined = noticesAbout(inbox, before, 'mgr-done-dup').join('\n');
    // 比較の足場: 知らせ自体は届いている（空同士の比較にしない）。
    expect(joined).toContain('report を出さないまま終わった');
    // 二重配達は「×2」（1回しか終わっていないのに2回終わったと読める）にならない。
    expect(joined).not.toContain('×2');
  });

  // 歯（#3233 の直し。印は `Job.silentDoneNotifiedFor`）。
  async function decisionLines(setup: ManualSetup): Promise<string[]> {
    const entries = await setup.stores.journal.list({ types: ['exchange'] });
    return entries
      .map((e) => JSON.stringify(e))
      .filter((line) => line.includes('report 無しの closed(done)'));
  }

  it('(a) resume で新しいセッションになった後の report 無しの closed(done) は、新しい終わりとして知らせる', async () => {
    const setup = await runningManualSetup('mgr-done-again');
    const { pool, inbox, fake, clock } = setup;
    fake.closed('mgr-done-again', 'done', '1回目の終わり: first-end');
    await settle();
    // 新しいセッションが置かれる（`runnerSessionSince` が進む）。
    clock.now += 60 * 60 * 1000;
    const sent = await pool.send('mgr-done-again', '続きを');
    expect(sent.outcome).toBe('delivered');
    clock.now += 60 * 1000;
    fake.closed('mgr-done-again', 'done', '2回目の終わり: second-end');
    await settle();
    await pool.stop(); // 合流窓を流し切る
    const text = JSON.stringify(inbox.filter((e) => e.type === 'manager_message'));
    expect(text).toContain('second-end');
    // 2回とも知らせの判断の行が残り、「知らせ済み」で見送った行は無い。
    expect(await decisionLines(setup)).toHaveLength(2);
    expect((await decisionLines(setup)).join('\n')).not.toContain('知らせ済み');
  });

  it('(b) デーモンを作り直した後に同じ closed(done) が再び届いても、知らせない（印が台帳にある）', async () => {
    const first = await runningManualSetup('mgr-done-restart');
    first.fake.closed('mgr-done-restart', 'done', SESSION_CLOSED);
    await settle();
    await first.pool.stop();
    const persisted = (await first.stores.jobs.listJobs()).find((j) => j.id === 'mgr-done-restart');
    // 比較の足場: 印が台帳に書かれている。
    expect(persisted?.silentDoneNotifiedFor).toBe(persisted?.runnerSessionSince ?? '');
    expect(noticesAbout(first.inbox, 0, 'mgr-done-restart').join('')).toContain(
      'report を出さないまま終わった',
    );

    const second = await runningManualSetup('mgr-done-restart', {}, first.stores);
    const before = second.inbox.length;
    second.fake.closed('mgr-done-restart', 'done', SESSION_CLOSED);
    await settle();
    await second.pool.stop();
    expect(noticesAbout(second.inbox, before, 'mgr-done-restart')).toHaveLength(0);
    expect((await decisionLines(second)).join('\n')).toContain('知らせ済み');
  });
});
