import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// 枠の窓（`QuotaStopWindow`）と取り戻した窓（`RestoredWindows`）の、窓を閉じて配る側の振る舞いを公開の口だけで縛る。
// 窓の実装を別のクラスへ切り出しても同じ試験が通ること。時計は偽の時計で、実時間の待ちは使わない。
const NOTICE_WINDOW_MS = 20;
const POOL_WINDOW_MS = 2_000;

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
  return { runner, alive, emit: (event) => emit?.(event) };
}

/** 台帳の一覧の読みの振る舞い。`gate` は呼ばれるたびに止め、`release` で1本ずつ放す。 */
interface LedgerControl {
  mode: 'pass' | 'gate' | 'fail';
  pending: (() => void)[];
  calls: number;
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
  ledger: LedgerControl;
}

// `aliveIds` は runner がセッションを持っている担当、`deadIds` は持っていない担当（restore が resume を指示し、取り戻した窓が開く）。
async function setup(aliveIds: readonly string[], deadIds: readonly string[] = []): Promise<Setup> {
  const stores = createMemoryStores();
  const ledger: LedgerControl = { mode: 'pass', pending: [], calls: 0 };
  const orig = stores.jobs.listJobs.bind(stores.jobs);
  stores.jobs.listJobs = async () => {
    ledger.calls += 1;
    if (ledger.mode === 'fail') throw new Error('台帳が読めない（試験用）');
    if (ledger.mode === 'gate') {
      await new Promise<void>((resolve) => ledger.pending.push(resolve));
    }
    return orig();
  };
  const fake = fakeRunner();
  for (const id of [...aliveIds, ...deadIds]) {
    const job: Job = {
      id,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-primary',
    };
    await stores.jobs.putJob(job);
  }
  for (const id of aliveIds) {
    fake.alive.push({
      liveBackgroundTasks: 0,
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: `sess-${id}`,
    });
  }
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    synthesizedNoticeWindowMs: NOTICE_WINDOW_MS,
    quotaStopWindowMs: POOL_WINDOW_MS,
  });
  await pool.restore();
  await settle();
  return { pool, stores, inbox, fake, ledger };
}

/** 偽の時計を進めて、積まれた非同期の処理を流す。 */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function quotaTurnFailed(fake: FakeRunner, managerId: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${SESSION_LIMIT}`,
    status: 'running',
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  });
}

// 畳まれて像から消える落ち方（窓を閉じるときに台帳を読みに行く）。
function quotaClosedFailed(fake: FakeRunner, managerId: string): void {
  const at = fake.alive.findIndex((entry) => entry.managerId === managerId);
  if (at !== -1) fake.alive.splice(at, 1);
  fake.emit({
    type: 'closed',
    managerId,
    status: 'failed',
    reason: `マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${SESSION_LIMIT}`,
  });
}

type External = Extract<InboxEvent, { type: 'external' }>;

function externals(events: readonly InboxEvent[]): External[] {
  return events.filter((event): event is External => event.type === 'external');
}

function quotaLists(events: readonly InboxEvent[]): External[] {
  return externals(events).filter((e) => (e.identity ?? '').startsWith('quota-stop:'));
}

function restoredLists(events: readonly InboxEvent[]): External[] {
  return externals(events).filter((e) => (e.identity ?? '').startsWith('restored:'));
}

function textOf(event: External): string {
  return (event.payload as { text: string }).text;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('枠の窓と取り戻した窓が両方開いているときの stop()', () => {
  // 枠の窓には mgr-a（窓を開ける）と mgr-b（畳まれて像から消える＝閉じるとき台帳を読む）、
  // 取り戻した窓には mgr-r1（窓を開ける）と mgr-r2（resume の後に畳まれて像から消える＝同じく台帳を読む）が居る。
  async function bothWindowsOpen(): Promise<Setup> {
    const s = await setup(['mgr-a', 'mgr-b'], ['mgr-r1', 'mgr-r2']);
    quotaTurnFailed(s.fake, 'mgr-a');
    await settle(NOTICE_WINDOW_MS + 10);
    quotaClosedFailed(s.fake, 'mgr-b');
    s.fake.emit({
      type: 'closed',
      managerId: 'mgr-r2',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: Error: spawn EAGAIN',
    });
    await settle(NOTICE_WINDOW_MS + 10);
    // 窓の中: どちらの一覧もまだ無い。
    expect(quotaLists(s.inbox)).toHaveLength(0);
    expect(restoredLists(s.inbox)).toHaveLength(0);
    return s;
  }

  it('stop() は枠の窓を配り終えてから取り戻した窓を配り、両方を配ってから返る', async () => {
    const s = await bothWindowsOpen();
    s.ledger.mode = 'gate';
    s.ledger.calls = 0;

    let stopped = false;
    const stopping = s.pool.stop().then(() => {
      stopped = true;
    });
    await settle();
    // 先に枠の窓が台帳を読んでいて、取り戻した窓はまだ読みに行っていない。
    expect(s.ledger.calls).toBe(1);
    expect(restoredLists(s.inbox)).toHaveLength(0);

    s.ledger.pending.shift()?.();
    await settle();
    // 枠の1通が出てから、取り戻した窓へ進む。
    expect(quotaLists(s.inbox)).toHaveLength(1);
    expect(restoredLists(s.inbox)).toHaveLength(0);
    expect(s.ledger.calls).toBe(2);
    expect(stopped).toBe(false);

    s.ledger.pending.shift()?.();
    await stopping;
    expect(restoredLists(s.inbox)).toHaveLength(1);
    expect(stopped).toBe(true);

    const order = externals(s.inbox)
      .map((e) => e.identity ?? '')
      .filter((id) => id.startsWith('quota-stop:') || id.startsWith('restored:'))
      .map((id) => id.split(':')[0]);
    expect(order).toEqual(['quota-stop', 'restored']);
  });

  it('2つの窓が同じ時計の進みで閉じて台帳を読んでいる最中の stop() は、どちらの配り終わりも待つ', async () => {
    const s = await bothWindowsOpen();
    s.ledger.mode = 'gate';
    s.ledger.calls = 0;

    // 取り戻した窓（開いてから 2000ms）と枠の窓（担当ごとの窓が閉じてから 2000ms）が、1回の時計の進みの中で続けて閉じる。
    await settle(POOL_WINDOW_MS + NOTICE_WINDOW_MS);
    expect(s.ledger.calls).toBe(2);
    expect(s.ledger.pending).toHaveLength(2);
    expect(quotaLists(s.inbox)).toHaveLength(0);
    expect(restoredLists(s.inbox)).toHaveLength(0);

    let stopped = false;
    const stopping = s.pool.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    // 片方だけ放しても、もう片方を配り終えるまで stop() は返らない（どちらを先に放しても同じ）。
    s.ledger.pending.pop()?.();
    await settle();
    expect(stopped).toBe(false);
    expect(quotaLists(s.inbox).length + restoredLists(s.inbox).length).toBe(1);

    s.ledger.pending.pop()?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(quotaLists(s.inbox)).toHaveLength(1);
    expect(restoredLists(s.inbox)).toHaveLength(1);
  });
});

describe('枠の窓が閉じて配る1通', () => {
  it('3本が同じ窓に入ると、窓を開けた担当を含む1通の文が1文字も変わらない', async () => {
    const s = await setup(['mgr-a', 'mgr-b', 'mgr-c']);
    quotaTurnFailed(s.fake, 'mgr-a');
    await settle(NOTICE_WINDOW_MS + 10);
    quotaClosedFailed(s.fake, 'mgr-b');
    quotaTurnFailed(s.fake, 'mgr-c');
    await settle(POOL_WINDOW_MS + NOTICE_WINDOW_MS);

    const sent = quotaLists(s.inbox);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.source).toBe('runner-registry');
    expect(textOf(sent[0]!)).toBe(
      [
        '枠に当たって 3 本の担当が止まった（resets 12:20am (Asia/Tokyo)）',
        '最初の1本は担当への報告として先に届けてあり、残りは担当ごとには配らずこの1通にまとめてある。',
        '',
        '- mgr-a: 状態 running（セッションは生きている） / 応答を返さずに終わった（最初の1本。担当への報告としては先に届けてある）',
        '- mgr-b: 状態 failed（セッションは落ちて、failed で畳まれた） / セッションが落ちた',
        '- mgr-c: 状態 running（セッションは生きている） / 応答を返さずに終わった',
        '',
        `SDK の原文（全体で1回だけ）: マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${SESSION_LIMIT}`,
        '',
        '各担当の知らせの全文は日誌にある。担当ごとの詳細は manager_report で読める。',
      ].join('\n'),
    );
    await s.pool.stop();
  });
});

describe('枠の窓の配りで台帳の一覧が読めなかったとき', () => {
  it('日誌に決定として残し、読めなかった担当の状態を「不明」として1通は配る', async () => {
    const s = await setup(['mgr-a', 'mgr-b']);
    quotaTurnFailed(s.fake, 'mgr-a');
    await settle(NOTICE_WINDOW_MS + 10);
    quotaClosedFailed(s.fake, 'mgr-b');
    await settle(NOTICE_WINDOW_MS + 10);
    s.ledger.mode = 'fail';
    await settle(POOL_WINDOW_MS);

    const sent = quotaLists(s.inbox);
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!)).toBe(
      [
        '枠に当たって 2 本の担当が止まった（resets 12:20am (Asia/Tokyo)）',
        '最初の1本は担当への報告として先に届けてあり、残りは担当ごとには配らずこの1通にまとめてある。',
        '',
        '- mgr-a: 状態 running（セッションは生きている） / 応答を返さずに終わった（最初の1本。担当への報告としては先に届けてある）',
        '- mgr-b: 状態 不明（台帳に見当たらない） / セッションが落ちた',
        '',
        `SDK の原文（全体で1回だけ）: マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${SESSION_LIMIT}`,
        '',
        '各担当の知らせの全文は日誌にある。担当ごとの詳細は manager_report で読める。',
      ].join('\n'),
    );

    const decisions = await s.stores.journal.list({ types: ['decision'] });
    const noted = decisions.filter((entry) =>
      JSON.stringify(entry).includes('枠の1通に載せる担当の状態を「不明」として配る'),
    );
    expect(noted).toHaveLength(1);
    expect(JSON.stringify(noted[0])).toContain('台帳が読めない（試験用）');
    await s.pool.stop();
  });
});
