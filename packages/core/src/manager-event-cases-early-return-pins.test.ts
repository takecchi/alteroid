import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Pool#handleEvent` の `case 'permission_denied'` / `case 'resume_failed'`（と `case 'note'`）の早い return のうち、
// 既存の試験が「結果が出るまで待って確かめる」形では縛っていなかったものを、外から見える結果
// （日誌・受信箱への知らせ・台帳の行・`pool.list()` の値）だけで縛る。
// 段（非公開メソッド）へ分けるときに早い return を取り違えると落ちる。
//   - permission_denied: 止めた委譲の拒否は受信箱へ回さない / 2件目以降の拒否は受信箱へ回さない
//   - resume_failed: runner-id 不一致の古い runner の出来事は、日誌に残すだけで台帳を動かさない
// `case 'note'` には、末尾の return 以外の return が無い（縛る対象なし）。
// 「何も起きない」ことは、結果の日誌が現れてから macrotask を1周流して見る（マイクロタスクの数には頼らない）。

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

interface Fake {
  client: RunnerClient;
  emit: (event: RunnerEvent) => void;
}

function fakeRunner(runnerId: string): Fake {
  const holder: { emit?: (event: RunnerEvent) => void } = {};
  return {
    emit: (event) => {
      if (holder.emit === undefined) throw new Error('まだ接続されていない');
      holder.emit(event);
    },
    client: {
      runnerId,
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent) {
        holder.emit = onEvent;
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
      async stop() {},
      async list() {
        return [];
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
        /* この検証では使わない。 */
      },
    },
  };
}

function entryOf(runnerId: string): RunnerEntry {
  return {
    label: runnerId,
    state: 'connected',
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  runners: Map<string, Fake>;
}

async function build(job: Job, runnerIds: string[]): Promise<Env> {
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const runners = new Map(runnerIds.map((id) => [id, fakeRunner(id)]));
  const registry = fakeRunnerRegistry({
    async list() {
      return [...runners.values()].map((fake) => fake.client);
    },
    async get(runnerId) {
      return runners.get(runnerId)?.client ?? null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
    async register() {
      /* この検証では使わない。 */
    },
    async unregister() {
      /* この検証では使わない。 */
    },
    vacate() {
      /* この検証では使わない。 */
    },
    entries() {
      return runnerIds.map((id) => entryOf(id));
    },
    noteManagerFailed() {
      /* この検証では使わない。 */
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => CLOCK,
  });
  // 存在しない managerId の abort で connect だけを踏ませる: pool に SSE を張らせる経路がこれしか無く、張らないと emit が得られないため。
  await pool.abort('mgr-does-not-exist');
  return { pool, stores, inbox, runners };
}

function jobOf(overrides: Partial<Job> = {}): Job {
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '走行中の委譲',
    request: '続きをやって',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-a',
    ...overrides,
  };
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.map((entry) => (entry.type === 'exchange' ? entry.text : ''));
}

async function waitForExchange(stores: Stores, needle: string): Promise<void> {
  await vi.waitFor(async () => {
    if (!(await exchangeTexts(stores)).some((text) => text.includes(needle))) {
      throw new Error(`日誌にまだ現れていない: ${needle}`);
    }
  });
}

/** 非同期の続きを macrotask 1周ぶん流しきる（メモリの台帳・日誌は実時間を使わない）。 */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function reportTexts(inbox: InboxEvent[]): string[] {
  return inbox.flatMap((event) =>
    event.type === 'manager_message' && event.kind === 'report' ? [event.text] : [],
  );
}

function denied(toolUseId: string): RunnerEvent {
  return {
    type: 'permission_denied',
    managerId: 'mgr-1',
    toolUseId,
    tool: 'Bash',
    input: {},
    via: 'live',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('permission_denied: 受信箱へ回さない早い return', () => {
  it('止めた委譲の拒否は、日誌には全文で残すが、受信箱へ報告を積まない', async () => {
    const env = await build(jobOf({ status: 'stopped' }), ['runner-a']);

    env.runners.get('runner-a')?.emit(denied('tu-1'));
    await waitForExchange(
      env.stores,
      '[判断] [mgr-1] Bash の実行が確認へ上がらずに止められた' +
        '（どちらの層か不明 / このマネージャーのこの組で 1 件目 / 走行中の合図）: ',
    );
    await drain();

    expect(reportTexts(env.inbox)).toEqual([]);
    await env.pool.stop();
  });

  it('同じ道具の2件目の拒否は、日誌には2件目として残すが、受信箱へは出さない（1件目だけが出る）', async () => {
    const env = await build(jobOf(), ['runner-a']);
    const runnerA = env.runners.get('runner-a');

    runnerA?.emit(denied('tu-1'));
    await vi.waitFor(() => {
      if (reportTexts(env.inbox).length !== 1) throw new Error('1件目の知らせがまだ届いていない');
    });
    expect(reportTexts(env.inbox)[0]).toContain(
      '`Bash` の実行が確認へ上がらずに止められた' +
        '（どちらの層か不明 / このマネージャーで 1 件目・道具ごとの合計）。',
    );

    runnerA?.emit(denied('tu-2'));
    await waitForExchange(
      env.stores,
      '[判断] [mgr-1] Bash の実行が確認へ上がらずに止められた' +
        '（どちらの層か不明 / このマネージャーのこの組で 2 件目 / 走行中の合図）: ',
    );
    await drain();

    expect(reportTexts(env.inbox)).toHaveLength(1);
    await env.pool.stop();
  });
});

describe('resume_failed: runner-id 不一致の早い return', () => {
  it('移った先（runner-b）の委譲に古い runner-a から届いた resume_failed は、日誌に1行だけ残し、台帳も像も動かさない', async () => {
    const env = await build(jobOf({ runnerId: 'runner-b' }), ['runner-a', 'runner-b']);

    env.runners.get('runner-a')?.emit({
      type: 'resume_failed',
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      reason: '会話が見つからなかった',
      recovered: false,
    });
    await waitForExchange(
      env.stores,
      '[障害] [mgr-1] （runner-id 不一致のため無視。いまの宛先は runner-b、この出来事は runner-a から）' +
        '前のセッション（sess-1）を開き直せなかった: 会話が見つからなかった',
    );
    await drain();

    // 早い return を外すと、続けて「開き直せなかった」の日誌をもう1行書き、台帳を lost へ落として像を畳む。
    const failureLines = (await exchangeTexts(env.stores)).filter((text) =>
      text.includes('を開き直せなかった'),
    );
    expect(failureLines).toHaveLength(1);
    const row = await env.stores.jobs.getJob('mgr-1');
    expect(row?.status).toBe('running');
    expect(row?.runnerId).toBe('runner-b');
    const listed = (await env.pool.list()).find((summary) => summary.managerId === 'mgr-1');
    expect(listed?.status).toBe('running');
    expect(reportTexts(env.inbox)).toEqual([]);
    await env.pool.stop();
  });
});
