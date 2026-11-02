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
import type { Stores } from './store.js';

// `Pool#handleEvent` の `case 'report'` の早い return のうち、既存の試験が1本も縛っていなかったもの
// （畳む前の await の後の2本）を、外から見える結果だけで縛る。
// 後ろへ走ってしまうと起きること:
//   - 止めた委譲: 止めた後は受信箱へ回さない約束が破れ、報告が配られる
//   - 同じ担当の closed に追い越された委譲: 像の無い担当に畳んだ報告の在庫が積まれ、一覧に「配っていない報告」が残る

const FOLD_DECISION = '背景処理の完了待ちで畳んだターンの報告なので';
const OVERTAKEN_DECISION = '同じ担当の closed に追い越されたので、畳まずに受信箱へ配った';
const AWAITING = { count: 1, breakdown: 'shell×1' };

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(managerId: string, text: string): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
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
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
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

  return {
    runner,
    alive,
    report(managerId, text) {
      emit?.({
        type: 'report',
        managerId,
        text,
        status: 'done',
        awaitingBackground: AWAITING,
      });
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningSetup(managerId: string): Promise<Setup> {
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
    liveBackgroundTasks: 0,
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const inbox: InboxEvent[] = [];
  const clock = Date.parse('2026-09-01T00:00:00.000Z');
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    now: () => clock,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, stores, inbox, fake };
}

// 畳みの decision の日誌だけ、開けるまで止める（畳む前の `await` の中に報告を居させる）。
function gateFoldDecision(stores: Stores): {
  open: () => void;
  reached: Promise<void>;
  written: Promise<void>;
} {
  let open!: () => void;
  let markReached!: () => void;
  let markWritten!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const written = new Promise<void>((resolve) => {
    markWritten = resolve;
  });
  const original = stores.journal.append.bind(stores.journal);
  stores.journal.append = async (entry) => {
    if (!JSON.stringify(entry).includes(FOLD_DECISION)) return original(entry);
    markReached();
    await gate;
    const appended = await original(entry);
    markWritten();
    return appended;
  };
  return { open, reached, written };
}

// 書き終えた後の畳みの続きは microtask だけなので、macrotask を1つ挟めば走り切っている。
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function textsOf(inbox: InboxEvent[], from: number): string[] {
  return inbox.slice(from).map((event) => (event as { text?: string }).text ?? '');
}

async function decisionsText(stores: Stores): Promise<string> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

describe('report: 畳む前の await の後の早い return', () => {
  it('畳む間に abort した委譲の報告は、その場で受信箱へ配られない（止めた後は回さない）', async () => {
    const { pool, stores, inbox, fake } = await runningSetup('mgr-pin-stop');
    const { open, reached, written } = gateFoldDecision(stores);

    const before = inbox.length;
    fake.report('mgr-pin-stop', '止めた後に畳み終わる報告');
    await reached;

    const result = await pool.abort('mgr-pin-stop', '人間が止めた');
    expect(result.outcome).toBe('stopped');
    const afterAbort = inbox.length;

    open();
    await written;
    await settle();

    // abort が受信箱へ出した分は除き、報告の本文が配られていないことを見る
    expect(textsOf(inbox, afterAbort)).toEqual([]);
    expect(textsOf(inbox, before).join('\n')).not.toContain('止めた後に畳み終わる報告');
    expect(await decisionsText(stores)).not.toContain(OVERTAKEN_DECISION);

    await pool.stop();
  });

  it('同じ担当の closed に追い越されて配った報告は、像の無い担当へ「配っていない報告」の在庫を積まない', async () => {
    const { pool, stores, inbox, fake } = await runningSetup('mgr-pin-overtaken');
    const { open, reached, written } = gateFoldDecision(stores);

    const before = inbox.length;
    fake.report('mgr-pin-overtaken', '追い越される報告');
    await reached;

    fake.closed('mgr-pin-overtaken', 'done', '背景処理が終わって畳んだ');
    await settle();

    open();
    await written;
    await settle();

    expect(textsOf(inbox, before).filter((text) => text.includes('追い越される報告'))).toHaveLength(
      1,
    );
    expect(await decisionsText(stores)).toContain(OVERTAKEN_DECISION);
    const summary = (await pool.list()).find((entry) => entry.managerId === 'mgr-pin-overtaken');
    expect(summary?.awaitingBackground).toBeUndefined();

    await pool.stop();
  });
});
