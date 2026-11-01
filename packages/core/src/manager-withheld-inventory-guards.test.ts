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

// 畳んだ報告の在庫（`Pool` の在庫の欄と台帳の写し）が、終わり方ごとに正しく下り、再起動で組み直されず、窓の中で順を守ることを、
// 公開の口（`list()` / `abort()` / `restore()` / `stop()`）と runner の出来事だけで縛る。実時間の待ちは使わず、条件を `vi.waitFor` で待つ。
// 窓は `pool.stop()` の吐き出しで閉じる（窓の長さを変える検証ではない）。
vi.setConfig({ testTimeout: 30_000 });

const MANAGER_ID = 'mgr-inv';
const AWAITING = { count: 1, breakdown: 'shell×1' };
const FIRST_BODY = '最初に畳んだ報告ABC';
const SECOND_BODY = 'あとから畳んだ報告XYZ';
const HELD_MARK = '背景処理の完了待ちで畳んだターンの報告を 1 本配っていない';

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
    // `abort()` は `list()` に居ないことを確かめてから `stopped` を確定させる。
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
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
}

async function setup(noticeWindowMs?: number): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  const job: Job = {
    id: MANAGER_ID,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${MANAGER_ID}`,
    runnerId: 'runner-primary',
  };
  await stores.jobs.putJob(job);
  fake.alive.push({
    liveBackgroundTasks: 0,
    managerId: MANAGER_ID,
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
    ...(noticeWindowMs === undefined ? {} : { synthesizedNoticeWindowMs: noticeWindowMs }),
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, stores, inbox, fake };
}

// 同じ台帳と同じ runner の上で、デーモンを作り直す（夜の反映の再起動に当たる）
async function restartOn(previous: Setup): Promise<{ pool: ManagerPool; inbox: InboxEvent[] }> {
  await previous.pool.stop();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: previous.stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([previous.fake.runner]),
  });
  await pool.restore();
  return { pool, inbox };
}

async function ledgerCopyOf(stores: Stores) {
  return (await stores.jobs.listJobs()).find((entry) => entry.id === MANAGER_ID);
}

async function waitLedgerCopyCount(stores: Stores, count: number): Promise<void> {
  await vi.waitFor(async () => {
    if ((await ledgerCopyOf(stores))?.withheldReports?.count !== count) {
      throw new Error('台帳の写しがまだ揃っていない');
    }
  });
}

async function waitLedgerCopyGone(stores: Stores): Promise<void> {
  await vi.waitFor(async () => {
    if ((await ledgerCopyOf(stores))?.withheldReports !== undefined) {
      throw new Error('台帳の写しがまだ下りていない');
    }
  });
}

async function waitJournalHas(stores: Stores, needle: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['decision'] });
    if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
      throw new Error('畳んだ旨の日誌がまだ書かれていない');
    }
  });
}

function withhold(fake: FakeRunner, text: string): void {
  fake.emit({
    type: 'report',
    managerId: MANAGER_ID,
    text,
    status: 'done',
    awaitingBackground: AWAITING,
  });
}

function messageTexts(inbox: readonly InboxEvent[]): string[] {
  return inbox
    .filter((event) => event.type === 'manager_message')
    .map((event) => (event as { text: string }).text);
}

async function awaitingOf(pool: ManagerPool) {
  return (await pool.list()).find((entry) => entry.managerId === MANAGER_ID)?.awaitingBackground;
}

describe('終わった委譲の在庫は台帳の写しごと下り、再起動の組み直しで蘇らない（#4626）', () => {
  it('abort() で止めた委譲: 台帳の写しが下り、デーモンを作り直して restore() しても在庫は組み直されない', async () => {
    const first = await setup();
    withhold(first.fake, FIRST_BODY);
    await waitLedgerCopyCount(first.stores, 1);

    await first.pool.abort(MANAGER_ID, '人間が止めた');
    await vi.waitFor(async () => {
      if ((await ledgerCopyOf(first.stores))?.status !== 'stopped') {
        throw new Error('stopped がまだ台帳に書かれていない');
      }
    });
    await waitLedgerCopyGone(first.stores);

    const restarted = await restartOn(first);
    expect((await restarted.pool.list()).some((entry) => entry.managerId === MANAGER_ID)).toBe(
      true,
    );
    expect(await awaitingOf(restarted.pool)).toBeUndefined();

    await restarted.pool.stop();
  });

  it('closed(done) で配り終えた委譲: 台帳の写しが下り、restore() で組み直されず、次の報告に「配っていない」が付かない', async () => {
    const first = await setup();
    withhold(first.fake, FIRST_BODY);
    await waitLedgerCopyCount(first.stores, 1);

    const at = first.fake.alive.findIndex((entry) => entry.managerId === MANAGER_ID);
    first.fake.alive.splice(at, 1);
    first.fake.emit({ type: 'closed', managerId: MANAGER_ID, status: 'done', reason: '終わった' });
    await vi.waitFor(() => {
      if (!messageTexts(first.inbox).some((text) => text.includes(HELD_MARK))) {
        throw new Error('まとめ配りがまだ届いていない');
      }
    });
    await waitLedgerCopyGone(first.stores);

    const restarted = await restartOn(first);
    expect(await awaitingOf(restarted.pool)).toBeUndefined();

    first.fake.alive.push({
      liveBackgroundTasks: 0,
      managerId: MANAGER_ID,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: `sess-${MANAGER_ID}`,
    });
    first.fake.emit({
      type: 'report',
      managerId: MANAGER_ID,
      text: '再起動の後の報告',
      status: 'done',
    });
    const delivered = await vi.waitFor(() => {
      const found = messageTexts(restarted.inbox).find((text) => text.includes('再起動の後の報告'));
      if (found === undefined) throw new Error('まだ届いていない');
      return found;
    });
    expect(delivered).toBe('再起動の後の報告');

    await restarted.pool.stop();
  });
});

describe('窓へ持ち越した在庫と、窓の後に積み直した通常の在庫が両方あるとき、通常を先にする', () => {
  it('closed(failed) が窓へ運んだ後に別の畳みが積まれると、窓の flush が配るのは通常の在庫（持ち越しは重ねない）', async () => {
    // 窓は `pool.stop()` の吐き出しまで開いたままにしてある
    const { pool, stores, inbox, fake } = await setup(600_000);

    withhold(fake, FIRST_BODY);
    await waitJournalHas(stores, FIRST_BODY);

    fake.emit({
      type: 'report',
      managerId: MANAGER_ID,
      text: '（このターンは応答を返さずに終わった: crash / result_is_error）',
      status: 'done',
      failure: { code: 'crash', via: 'result_is_error' },
      synthesized: 'turn_failed',
    });
    const at = fake.alive.findIndex((entry) => entry.managerId === MANAGER_ID);
    fake.alive.splice(at, 1);
    fake.emit({
      type: 'closed',
      managerId: MANAGER_ID,
      status: 'failed',
      reason: 'セッションが落ちた',
    });
    // closed が在庫を窓へ運び終えた（通常の在庫は空）: 一覧に畳みの印が無い
    await vi.waitFor(async () => {
      if ((await awaitingOf(pool)) !== undefined)
        throw new Error('closed がまだ在庫を運んでいない');
    });

    // 窓が閉じる前に、像を台帳から作り直して新しい畳みが積まれる
    withhold(fake, SECOND_BODY);
    await waitJournalHas(stores, SECOND_BODY);

    await pool.stop();

    const texts = messageTexts(inbox).filter((text) => text.includes('応答を返さずに終わった'));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(HELD_MARK);
    expect(texts[0]).toContain(SECOND_BODY);
    expect(texts[0]).not.toContain(FIRST_BODY);
  });
});
