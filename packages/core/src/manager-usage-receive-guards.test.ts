import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import type { UsageTotals } from './usage.js';

// 使用量を受ける case（usage / peer_usage / context_usage / usage_notice / rate_limit）を別のクラスへ切り出す前に、
// 既存の試験が縛っていなかった順番・同期の位置を固定する。実時間の待ちは使わず、日誌の書き込みを止める門と
// 微小タスクの空回し（settle）で順序を作る。

function jobOf(id: string): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    status: 'running',
    summary: '調べもの',
    request: '調べておいて',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-primary',
  };
}

function fakeRunner() {
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
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      alive.push({
        liveBackgroundTasks: 0,
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
  };
}

async function setup(
  managerIds: readonly string[],
  options: {
    now?: () => number;
    onUsageObservation?: (observation: unknown) => Promise<void>;
  } = {},
) {
  const stores = createMemoryStores();
  for (const id of managerIds) await stores.jobs.putJob(jobOf(id));
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool: ManagerPool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onUsageObservation === undefined
      ? {}
      : { onUsageObservation: options.onUsageObservation }),
  });
  await pool.restore();
  return { pool, fake, stores, inbox };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function totals(costUsd: number): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd,
  };
}

function usageEvent(managerId: string, costUsd: number): RunnerEvent {
  return {
    type: 'usage',
    managerId,
    sessionId: `sess-${managerId}`,
    models: { opus: totals(costUsd) },
  } as unknown as RunnerEvent;
}

async function costOf(stores: Stores): Promise<number> {
  const { rows } = await stores.usage.aggregate({});
  return rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
}

// 条件に合う日誌の書き込みだけを、開くまで止める。止めた書き込みは `open()` まで返らない。
function holdJournalAppends(stores: Stores, shouldHold: (entry: { type: string }) => boolean) {
  const real = stores.journal.append.bind(stores.journal);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  stores.journal.append = async (entry) => {
    if (shouldHold(entry)) {
      held += 1;
      await gate;
    }
    return real(entry);
  };
  return { open, held: () => held };
}

describe('usage の順番待ちの札は、日誌の書き込みを待たずに返る（#3015）', () => {
  it('⭐ 成功の経路: turn_usage の日誌が止まっていても、次の usage の記録が先へ進む', async () => {
    const s = await setup(['mgr-a']);
    const hold = holdJournalAppends(s.stores, (entry) => entry.type === 'turn_usage');

    s.fake.push(usageEvent('mgr-a', 5));
    await settle();
    expect(hold.held()).toBe(1);

    s.fake.push(usageEvent('mgr-a', 9));
    await settle();
    // 札が日誌の後ろまで握られていれば、2本目は番が回らず記録まで届かない（合計は 5 のまま）。
    expect(await costOf(s.stores)).toBe(9);

    hold.open();
    await settle();
    await s.pool.stop();
  });

  it('⭐ 記録の失敗の経路: 失敗を書く日誌が止まっていても、次の usage の記録が先へ進む', async () => {
    const s = await setup(['mgr-a']);
    const real = s.stores.usage.record.bind(s.stores.usage);
    let calls = 0;
    s.stores.usage.record = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('台帳が落ちた');
      return real(input);
    };
    const hold = holdJournalAppends(s.stores, (entry) => entry.type === 'exchange');

    s.fake.push(usageEvent('mgr-a', 2));
    await settle();
    expect(hold.held()).toBe(1);

    s.fake.push(usageEvent('mgr-a', 6));
    await settle();
    expect(await costOf(s.stores)).toBe(6);

    hold.open();
    await settle();
    await s.pool.stop();
  });
});

const REACHED_TEXT = "You've hit your session limit · resets 9:30am (Asia/Tokyo)";

function reached(managerId: string, text = REACHED_TEXT): RunnerEvent {
  return {
    type: 'usage_notice',
    managerId,
    notice: { kind: 'reached', text },
  } as RunnerEvent;
}

function okReport(managerId: string): RunnerEvent {
  return { type: 'report', managerId, text: '調べ終えた', status: 'done' } as RunnerEvent;
}

async function journalTexts(stores: Stores, fragment: string): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries
    .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
    .filter((text) => text.includes(fragment));
}

describe('usage_notice は同期の位置で印を立て、配達の可否を決める', () => {
  it('⭐ 同じターンの reached と成功の report が並行に届いても、report の下ろしが先に走って印が残ることはない', async () => {
    // 回し手への受け渡し（`await`）を長引かせる: 印をその後ろで立てる作りだと、間に report の下ろしが走り切る。
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const s = await setup(['mgr-a'], { onUsageObservation: () => gate });

    s.fake.push(reached('mgr-a'));
    s.fake.push(okReport('mgr-a'));
    await settle();
    open();
    await settle();

    // 印を `await` の後ろで立てると、report の下ろしが先に走り、自力で終えた委譲に印だけが残る。
    const job = (await s.stores.jobs.listJobs()).find((j) => j.id === 'mgr-a');
    expect(job?.usageStoppedAt).toBeUndefined();

    await s.pool.stop();
  });

  it('⭐ 同じ文言の知らせが同時に2本届いても、配るのは1本で、畳んだ1本は日誌に残る', async () => {
    const s = await setup(['mgr-a', 'mgr-b']);

    s.fake.push(reached('mgr-a'));
    s.fake.push(reached('mgr-b'));
    await settle();

    // 「配った」の記憶を `await` の後ろへ回すと、2本とも「まだ配っていない」と読む。
    expect(await journalTexts(s.stores, '配達済みの知らせなので受信箱へは回さない')).toHaveLength(1);
    const delivered = (await journalTexts(s.stores, REACHED_TEXT)).filter(
      (text) => !text.includes('配達済みの知らせなので'),
    );
    expect(delivered).toHaveLength(1);

    await s.pool.stop();
  });
});
