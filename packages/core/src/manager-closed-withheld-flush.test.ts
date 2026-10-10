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

// 背景処理の完了待ちで畳んでいた報告を抱えた担当が `closed` で終わるとき、その知らせは担当の合流窓を通る（Issue #4449 (b)）。
// 窓が開いていれば窓の中の断片と1通になり、開いていなければ今までどおりすぐ1通で届く。
// 「届く」ことは `vi.waitFor` で条件を待つ。固定の実時間待ちは「余計な通が来ない」ことを確かめるときだけに使う。
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

const HELD_MARK = '背景処理の完了待ちで畳んだターンの報告を 1 本配っていない';
const CLOSED_NOTE = 'この委譲は終わった（status=failed）';
const HELD_BODY = '畳まれていた報告の本文ABC';
const AWAITING = { count: 1, breakdown: 'shell×1' };
const QUOTA_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
  fresh(): InboxEvent[];
}

async function setup(managerIds: readonly string[], noticeWindowMs: number): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  for (const id of managerIds) {
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
    fake.alive.push({
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: job.sessionId,
    });
  }
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    synthesizedNoticeWindowMs: noticeWindowMs,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length < managerIds.length) throw new Error('reattach の知らせがまだ届いていない');
  });
  const baseline = inbox.length;
  return { pool, stores, inbox, fake, fresh: () => inbox.slice(baseline) };
}

function messagesOf(events: readonly InboxEvent[], managerId: string) {
  return events.filter(
    (event) => event.type === 'manager_message' && event.managerId === managerId,
  ) as Extract<InboxEvent, { type: 'manager_message' }>[];
}

// 畳まれたことは日誌の decision で観測する（畳んだ時点で書かれる）。畳む前に `closed` を流すと別の経路になる。
async function waitWithheld(stores: Stores, needle: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['decision'] });
    if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
      throw new Error('畳んだ旨の日誌がまだ書かれていない');
    }
  }, WAIT);
}

function withhold(fake: FakeRunner, managerId: string, text: string): void {
  fake.emit({ type: 'report', managerId, text, status: 'done', awaitingBackground: AWAITING });
}

function crashedTurn(fake: FakeRunner, managerId: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text: '（このターンは応答を返さずに終わった: crash / result_is_error）',
    status: 'done',
    failure: { code: 'crash', via: 'result_is_error' },
    synthesized: 'turn_failed',
  });
}

function closedFailed(fake: FakeRunner, managerId: string, reason: string): void {
  const at = fake.alive.findIndex((entry) => entry.managerId === managerId);
  if (at !== -1) fake.alive.splice(at, 1);
  fake.emit({ type: 'closed', managerId, status: 'failed', reason });
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('背景待ちの報告を抱えた担当の closed は、開いている合流窓へ積まれて1通になる', () => {
  it('turn_failed と closed(failed) が窓に落ちると manager_message は1通だけで、畳んでいた報告の件数と中身も載る', async () => {
    // 窓は、イベントの処理が負荷で多少遅れても同じ窓に収まる長さにしてある（長さを変える検証ではない）。
    const { pool, stores, inbox, fake, fresh } = await setup(['mgr-w'], 500);

    withhold(fake, 'mgr-w', HELD_BODY);
    await waitWithheld(stores, HELD_BODY);

    crashedTurn(fake, 'mgr-w');
    closedFailed(fake, 'mgr-w', 'マネージャーのセッションが落ちた: Error: boom');

    await vi.waitFor(() => expect(messagesOf(fresh(), 'mgr-w').length).toBeGreaterThan(0), WAIT);
    // 余計な通が続かないことを、窓が閉じた後まで見る。
    await sleep(800);

    const messages = messagesOf(fresh(), 'mgr-w');
    expect(messages).toHaveLength(1);
    const text = messages[0]?.text ?? '';
    expect(text).toContain('応答を返さずに終わった');
    expect(text).toContain('セッションが落ちた');
    expect(text).toContain(CLOSED_NOTE);
    expect(text).toContain('背景処理の完了待ちで畳んでいた報告をまとめて配る');
    expect(text).toContain(HELD_MARK);
    expect(text).toContain(HELD_BODY);

    // 3. 畳んでいた報告は、全部の manager_message を通して1回だけ配られる（停止時の flush を経ても増えない）。
    await pool.stop();
    const all = inbox
      .filter((event) => event.type === 'manager_message')
      .map((event) => (event as { text: string }).text)
      .join('\n----\n');
    expect(countOf(all, HELD_MARK)).toBe(1);
    expect(countOf(all, HELD_BODY)).toBe(1);
  });

  it('窓が開いていない closed は、窓を開けず遅らせず、今までどおりすぐ1通で届く（配る荷も二重にならない）', async () => {
    // 窓を10秒にしてある: もし窓へ積まれていれば、既定の待ち（waitFor の1秒）では届かず赤くなる。
    const { pool, stores, inbox, fake, fresh } = await setup(['mgr-w'], 10_000);

    withhold(fake, 'mgr-w', HELD_BODY);
    await waitWithheld(stores, HELD_BODY);

    fake.emit({ type: 'closed', managerId: 'mgr-w', status: 'done', reason: '終わった' });

    const delivered = await vi.waitFor(() => {
      const found = messagesOf(fresh(), 'mgr-w');
      if (found.length === 0) throw new Error('まだ届いていない');
      return found;
    });
    expect(delivered).toHaveLength(1);
    const text = delivered[0]?.text ?? '';
    expect(text).toContain('この委譲は終わった（status=done）');
    expect(text).toContain(HELD_MARK);
    expect(text).toContain(HELD_BODY);
    // 窓を経由していない: 合成の印は付かない。
    expect('synthesized' in (delivered[0] ?? {})).toBe(false);

    await pool.stop();
    const all = inbox
      .filter((event) => event.type === 'manager_message')
      .map((event) => (event as { text: string }).text)
      .join('\n----\n');
    expect(countOf(all, HELD_MARK)).toBe(1);
    expect(countOf(all, HELD_BODY)).toBe(1);
  });
});

describe('背景待ちの報告を抱えた担当は、枠の束のプール窓に入らず担当ごとの1通になる', () => {
  it('同じトークンで枠落ちした2本のうち、報告を抱えた2本目は担当ごとに1通届く。1本目はいまどおり', async () => {
    const stores = createMemoryStores();
    const fake = fakeRunner();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => ({ tokenId: 'tok-same', generation: 1 }),
      synthesizedNoticeWindowMs: 400,
      quotaStopWindowMs: 2_000,
    });
    const first = await pool.start({ request: '1本目' });
    const second = await pool.start({ request: '2本目' });
    const baseline = inbox.length;
    const fresh = (): InboxEvent[] => inbox.slice(baseline);

    // 1本目は枠で落ちる（担当ごとにすぐ届き、プール窓を開ける）。
    fake.emit({
      type: 'report',
      managerId: first.managerId,
      text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${QUOTA_LIMIT}`,
      status: 'done',
      failure: { code: 'success/429', via: 'result_is_error', status: 429 },
      synthesized: 'turn_failed',
    });
    await vi.waitFor(
      () => expect(messagesOf(fresh(), first.managerId).length).toBeGreaterThan(0),
      WAIT,
    );

    // 2本目は背景待ちの報告を抱えたまま、同じ枠で落ちる。
    withhold(fake, second.managerId, HELD_BODY);
    await waitWithheld(stores, HELD_BODY);
    fake.emit({
      type: 'report',
      managerId: second.managerId,
      text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${QUOTA_LIMIT}`,
      status: 'done',
      failure: { code: 'success/429', via: 'result_is_error', status: 429 },
      synthesized: 'turn_failed',
    });
    closedFailed(
      fake,
      second.managerId,
      `マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${QUOTA_LIMIT}`,
    );

    await vi.waitFor(
      () => expect(messagesOf(fresh(), second.managerId).length).toBeGreaterThan(0),
      WAIT,
    );
    // プール窓（2秒）が閉じた後まで待ち、一覧が出ないことと、2本目が1通のままであることを確かめる。
    await sleep(2_500);

    const secondMessages = messagesOf(fresh(), second.managerId);
    expect(secondMessages).toHaveLength(1);
    const text = secondMessages[0]?.text ?? '';
    expect(text).toContain(CLOSED_NOTE);
    expect(text).toContain(HELD_MARK);
    expect(text).toContain(HELD_BODY);
    expect(text).toContain('セッションが落ちた');

    const externals = fresh().filter((event) => event.type === 'external');
    expect(externals).toHaveLength(0);
    expect(messagesOf(fresh(), first.managerId)).toHaveLength(1);

    await pool.stop();
  });
});
