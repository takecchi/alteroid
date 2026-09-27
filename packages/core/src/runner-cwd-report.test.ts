import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerResumeCommand,
  type RunnerStartCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * runner が実際に開いた `cwd` を start / resume の応答で返し、デーモンが
 * それを表示・台帳へ反映すること（Issue #1814。前提は #1783 / PR #1807）。
 *
 * PR #1807 で runner の `Host#resolveCwd()` は、明示の `cwd` が実在しなければ
 * `workspacePath` へ倒すようになったが、倒れた事実を呼び出し元（デーモン）へ
 * 返す経路が無かった。ここでは、その経路（`RunnerClient.start` /
 * `RunnerClient.resume` の戻り値）を使う側（`manager.ts`）が、次の3通りを
 * 正しく扱うことを固定する:
 *
 * 1. 実際の値が返り、頼んだ値と同じ
 * 2. 実際の値が返り、頼んだ値と違う（倒れた）
 * 3. 応答が `cwd` を返さない（古い runner）——**このとき、頼んだ値を
 *    実際の値として名乗らないこと**を固定する（表示・台帳のどちらも）。
 *
 * `start()` は `manager_start` の応答（`ManagerSummary.cwd` /
 * `cwdConfirmed` / `requestedCwd`）で固定し、`resume()` は台帳
 * （`pool.list()` の `cwd`）・追加で送る一言（`runner.send()`）・日誌の3点で
 * 固定する。`resume()` 側は `manager-workspace-nudge.test.ts` の
 * `swappableRunner` / `runnerSwapNudge` と同じ「`restore()` → `swap()`」の
 * 形を使う——器の入れ替えで `#reattach` 経由の resume が実際に起きる、
 * この repo で唯一確立された手段だからである。
 */

/** `start` / `resume` の戻り値を、テストから1回ずつ差し替えられる偽 runner。 */
function fakeRunner(runnerId = 'runner-primary') {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const state = {
    alive: [] as RunnerManagerState[],
    startCalls: [] as RunnerStartCommand[],
    resumeCalls: [] as RunnerResumeCommand[],
    sendCalls: [] as { managerId: string; text: string }[],
    /**
     * 呼ばれるたびに先頭から1つ取り出す（尽きたら `{}`＝古い runner を模す）。
     * `start` は普段1回、`resume` は「restore() の分」「swap() 後の分」の
     * 2回を積んで使う。
     */
    startResults: [] as { cwd?: string }[],
    resumeResults: [] as { cwd?: string }[],
  };
  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command) {
      state.startCalls.push(command);
      const result = state.startResults.shift() ?? {};
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: result.cwd ?? command.cwd,
        request: command.request,
        waiting: [],
      });
      return result;
    },
    async resume(command) {
      state.resumeCalls.push(command);
      const result = state.resumeResults.shift() ?? {};
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: result.cwd ?? command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return result;
    },
    async send(managerId, text) {
      state.sendCalls.push({ managerId, text });
      return true;
    },
    async answer() {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [...state.alive];
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
      return { ok: true };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    state,
    /** 器を作り直す ＝ 中のセッションは消え、新しいストリームが名乗り直す。 */
    swap() {
      state.alive = [];
      emit?.({ type: 'hello', runnerId });
    },
  };
}

/** `manager-workspace-nudge.test.ts` の `setup` と同じ縮小版。 */
function setup(stores: ReturnType<typeof createMemoryStores>, runner: RunnerClient) {
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  return { pool, inbox };
}

/**
 * `JournalEntry` は discriminated union で、`Array#filter` の素の述語では
 * 絞った後の要素型が narrow されない（`type === 'exchange'` を確かめても、
 * 返る配列の要素型は union のまま）。`flatMap` + 型ガードで確実に絞る。
 */
function exchangeTexts(entries: readonly JournalEntry[]): string[] {
  return entries.flatMap((entry) => (entry.type === 'exchange' ? [entry.text] : []));
}

function jobWith(id: string, cwd: string): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd,
    sessionId: 'sess-before-swap',
    runnerId: 'runner-primary',
  };
}

describe('manager_start: 実際の cwd の報告（Issue #1814）', () => {
  it('(1) 実際の値が返り、頼んだ値と同じ: cwdConfirmed は立つが requestedCwd は付かない', async () => {
    const stores = createMemoryStores();
    const fake = fakeRunner();
    fake.state.startResults.push({ cwd: '/work/project' });
    const { pool } = setup(stores, fake.runner);

    const started = await pool.start({ request: '調べて', cwd: '/work/project' });

    expect(started.cwd).toBe('/work/project');
    expect(started.cwdConfirmed).toBe(true);
    expect(started.requestedCwd).toBeUndefined();

    await pool.stop();
  });

  it('(2) 実際の値が返り、頼んだ値と違う（倒れた）: cwd は実際の値へ揃い、requestedCwd に頼んだ値が残る', async () => {
    const stores = createMemoryStores();
    const fake = fakeRunner();
    fake.state.startResults.push({ cwd: '/workspace' });
    const { pool } = setup(stores, fake.runner);

    const started = await pool.start({ request: '調べて', cwd: '/does-not-exist' });

    expect(started.cwd).toBe('/workspace');
    expect(started.cwdConfirmed).toBe(true);
    expect(started.requestedCwd).toBe('/does-not-exist');

    // **台帳（list()）も実際の値へ揃っている。** manager_list / Web UI が
    // 頼んだ値（倒れる前の値）を「実際の cwd」として名乗り続けない。
    const listed = await pool.list();
    expect(listed.find((m) => m.managerId === started.managerId)?.cwd).toBe('/workspace');

    await pool.stop();
  });

  it('(3) 応答が cwd を返さない（古い runner）: cwd は頼んだ値のまま、cwdConfirmed は立たない——頼んだ値を実際の値として名乗らない', async () => {
    const stores = createMemoryStores();
    const fake = fakeRunner();
    fake.state.startResults.push({});
    const { pool } = setup(stores, fake.runner);

    const started = await pool.start({ request: '調べて', cwd: '/work/project' });

    expect(started.cwd).toBe('/work/project');
    expect(started.cwdConfirmed).toBeUndefined();
    expect(started.requestedCwd).toBeUndefined();

    await pool.stop();
  });
});

describe('resume（移送・器の入れ替え）: 実際の cwd の報告（Issue #1814）', () => {
  it('(1) 実際の値が返り、頼んだ値と同じ: 台帳は変わらず、追加の一言も送らない', async () => {
    const stores = createMemoryStores();
    const job = jobWith('mgr-same', '/work/project');
    await stores.jobs.putJob(job);
    const fake = fakeRunner();
    fake.state.resumeResults.push({ cwd: '/work/project' }); // restore() の分
    fake.state.resumeResults.push({ cwd: '/work/project' }); // swap() 後の分
    const { pool } = setup(stores, fake.runner);

    await pool.restore();
    expect(fake.state.resumeCalls).toHaveLength(1);

    fake.swap();
    await expect.poll(() => fake.state.resumeCalls.length, { timeout: 2000 }).toBe(2);

    const listed = await pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-same')?.cwd).toBe('/work/project');
    expect(fake.state.sendCalls).toEqual([]);

    const texts = exchangeTexts(await stores.journal.list()).filter((text) =>
      text.includes('mgr-same'),
    );
    expect(texts.some((text) => text.includes('はこの器に無かったので'))).toBe(false);

    await pool.stop();
  });

  it('(2) 実際の値が返り、頼んだ値と違う（倒れた）: 台帳を実際の値へ揃え、追加の一言を送り、日誌にも残す', async () => {
    const stores = createMemoryStores();
    const job = jobWith('mgr-swap', '/work/project');
    await stores.jobs.putJob(job);
    const fake = fakeRunner();
    fake.state.resumeResults.push({ cwd: '/work/project' }); // restore() の分（倒れない）
    fake.state.resumeResults.push({ cwd: '/workspace' }); // swap() 後の分（倒れた）
    const { pool } = setup(stores, fake.runner);

    await pool.restore();
    fake.swap();
    await expect.poll(() => fake.state.resumeCalls.length, { timeout: 2000 }).toBe(2);

    const listed = await pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-swap')?.cwd).toBe('/workspace');

    expect(fake.state.sendCalls).toEqual([
      {
        managerId: 'mgr-swap',
        text: '[system] 元の cwd（/work/project）はこの器に無かったので、/workspace で開いた。',
      },
    ]);

    const texts = exchangeTexts(await stores.journal.list()).filter((text) =>
      text.includes('mgr-swap'),
    );
    expect(
      texts.some((text) =>
        text.includes('元の cwd（/work/project）はこの器に無かったので、/workspace で開いた。'),
      ),
    ).toBe(true);

    await pool.stop();
  });

  it('(3) 応答が cwd を返さない（古い runner）: 台帳は頼んだ値のまま、追加の一言も送らない——未確認を頼んだ値で埋めない', async () => {
    const stores = createMemoryStores();
    const job = jobWith('mgr-unconfirmed', '/work/project');
    await stores.jobs.putJob(job);
    const fake = fakeRunner();
    fake.state.resumeResults.push({ cwd: '/work/project' }); // restore() の分
    fake.state.resumeResults.push({}); // swap() 後、古い runner を模す
    const { pool } = setup(stores, fake.runner);

    await pool.restore();
    fake.swap();
    await expect.poll(() => fake.state.resumeCalls.length, { timeout: 2000 }).toBe(2);

    const listed = await pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-unconfirmed')?.cwd).toBe('/work/project');
    expect(fake.state.sendCalls).toEqual([]);

    const texts = exchangeTexts(await stores.journal.list()).filter((text) =>
      text.includes('mgr-unconfirmed'),
    );
    expect(texts.some((text) => text.includes('はこの器に無かったので'))).toBe(false);

    await pool.stop();
  });
});
