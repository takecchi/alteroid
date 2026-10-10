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

    // 【#4452】届く先が一覧（external）に変わったので、待つ対象も external にした（元は2本目の manager_message を待っていた）。
    await vi.waitFor(
      () => expect(fresh().filter((event) => event.type === 'external')).toHaveLength(1),
      WAIT,
    );
    // プール窓（2秒）が閉じた後まで待ち、一覧が出ないことと、2本目が1通のままであることを確かめる。
    // 【#4452 で反転】上の期待（2本目は担当ごとの1通・一覧は0件）は #4451 の時点の決めだった。クローンの決定（2026-10-11）で、
    // 枠で落ちた担当の `closed_withheld_flush` は `closed_failed` の枠の印を受け継ぎ、畳んでいた報告の本数と冒頭は一覧の行へ添える。
    // 保証は弱めていない: 畳んでいた報告は一覧に必ず載り（本数と冒頭）、1回しか配られないことを引き続き確かめる。
    await sleep(2_500);

    expect(messagesOf(fresh(), second.managerId)).toHaveLength(0);
    const externals = fresh().filter((event) => event.type === 'external');
    expect(externals).toHaveLength(1);
    const listText = (externals[0]?.payload as { text: string }).text;
    expect(listText).toContain('枠に当たって 2 本の担当が止まった');
    const secondLine = listText.split('\n').filter((line) => line.includes(second.managerId));
    expect(secondLine.length).toBeGreaterThan(0);
    expect(listText).toContain('畳んでいた報告 1 本');
    expect(listText).toContain(HELD_BODY);
    expect(listText).toContain('manager_report');
    expect(messagesOf(fresh(), first.managerId)).toHaveLength(1);

    await pool.stop();
  });
});

// ---------------------------------------------------------------------------
// Issue #4452: 枠で落ちた担当の `closed_withheld_flush` は枠の印を受け継ぎ、プール窓の一覧に入る。
// ---------------------------------------------------------------------------

const QUOTA_CLOSED_REASON = `マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${QUOTA_LIMIT}`;

interface PoolSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
  ids: string[];
  fresh(): InboxEvent[];
}

async function poolSetup(count: number, noticeWindowMs: number): Promise<PoolSetup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    tokenIdentity: () => ({ tokenId: 'tok-same', generation: 1 }),
    synthesizedNoticeWindowMs: noticeWindowMs,
    quotaStopWindowMs: 2_000,
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await pool.start({ request: `${String(i + 1)}本目` })).managerId);
  }
  const baseline = inbox.length;
  return { pool, stores, inbox, fake, ids, fresh: () => inbox.slice(baseline) };
}

function quotaTurn(fake: FakeRunner, managerId: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${QUOTA_LIMIT}`,
    status: 'done',
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  });
}

function externalsOf(events: readonly InboxEvent[]) {
  return events.filter((event) => event.type === 'external') as Extract<
    InboxEvent,
    { type: 'external' }
  >[];
}

function everyText(events: readonly InboxEvent[]): string {
  return events
    .map((event) => {
      if (event.type === 'manager_message') return event.text;
      if (event.type === 'external') return (event.payload as { text: string }).text;
      return '';
    })
    .join('\n----\n');
}

// 2本目以降が窓へ積まれたことを日誌の失敗行で観測する（積む直前に書かれる）。そのあとの同期の積みを1回の譲りで待つ。
async function waitClosedJournal(stores: Stores, managerId: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    if (
      !entries.some(
        (entry) =>
          JSON.stringify(entry).includes(`[${managerId}]`) &&
          JSON.stringify(entry).includes('セッションが落ちた'),
      )
    ) {
      throw new Error('closed の日誌がまだ書かれていない');
    }
  }, WAIT);
  await sleep(0);
}

describe('枠で落ちた担当の畳んでいた報告は、プール窓の一覧の行へ運ばれる（#4452）', () => {
  it('同じトークンで3本が枠で落ち、2本目が報告を抱える: 1本目はすぐ1通、残りは一覧1通に3本とも載り、2本目の行に畳んでいた報告が付く', async () => {
    const { pool, stores, inbox, fake, ids, fresh } = await poolSetup(3, 400);
    const [a, b, c] = ids as [string, string, string];

    quotaTurn(fake, a);
    await vi.waitFor(() => expect(messagesOf(fresh(), a).length).toBeGreaterThan(0), WAIT);

    withhold(fake, b, HELD_BODY);
    await waitWithheld(stores, HELD_BODY);
    quotaTurn(fake, b);
    closedFailed(fake, b, QUOTA_CLOSED_REASON);
    quotaTurn(fake, c);
    closedFailed(fake, c, QUOTA_CLOSED_REASON);

    await vi.waitFor(() => expect(externalsOf(fresh())).toHaveLength(1), WAIT);
    await sleep(500);

    expect(messagesOf(fresh(), a)).toHaveLength(1);
    expect(messagesOf(fresh(), b)).toHaveLength(0);
    expect(messagesOf(fresh(), c)).toHaveLength(0);
    const list = (externalsOf(fresh())[0]?.payload as { text: string }).text;
    expect(list).toContain('枠に当たって 3 本の担当が止まった');
    const lines = list.split('\n');
    const at = lines.findIndex((line) => line.startsWith(`- ${b}:`));
    expect(at).toBeGreaterThanOrEqual(0);
    // 2本目の行の下に、畳んでいた報告の本数と冒頭が1行で付く。
    const note = lines.slice(at + 1, at + 3).find((line) => line.includes('畳んでいた報告')) ?? '';
    expect(note).toContain('畳んでいた報告 1 本');
    expect(note).toContain(HELD_BODY);
    expect(note).toContain('manager_report');
    // 3本目と1本目の行には付かない。
    expect(list.split('畳んでいた報告 ').length - 1).toBe(1);

    await pool.stop();
    // 畳んでいた報告の中身は、全部の manager_message と external を通して1回だけ。
    const all = everyText(inbox);
    expect(countOf(all, HELD_BODY)).toBe(1);
    expect(countOf(all, HELD_MARK)).toBe(0);
  });

  it('枠ではない理由で落ちた担当（closed_failed に印が無い）が報告を抱える: 印を付けず、今までどおり担当ごとの1通', async () => {
    const { pool, stores, inbox, fake, ids, fresh } = await poolSetup(2, 400);
    const [a, b] = ids as [string, string];

    quotaTurn(fake, a);
    await vi.waitFor(() => expect(messagesOf(fresh(), a).length).toBeGreaterThan(0), WAIT);

    withhold(fake, b, HELD_BODY);
    await waitWithheld(stores, HELD_BODY);
    crashedTurn(fake, b);
    closedFailed(fake, b, 'マネージャーのセッションが落ちた: Error: boom');

    await vi.waitFor(() => expect(messagesOf(fresh(), b).length).toBeGreaterThan(0), WAIT);
    await sleep(2_500);

    const own = messagesOf(fresh(), b);
    expect(own).toHaveLength(1);
    expect(own[0]?.text).toContain(CLOSED_NOTE);
    expect(own[0]?.text).toContain(HELD_MARK);
    expect(externalsOf(fresh())).toHaveLength(0);

    await pool.stop();
    expect(countOf(everyText(inbox), HELD_BODY)).toBe(1);
  });

  it('窓を開けた1本目が報告を抱える: 担当ごとにすぐ1通で在庫はそこで運ばれ、一覧には最初の1本として載るが注記は重ならない', async () => {
    const { pool, stores, inbox, fake, ids, fresh } = await poolSetup(2, 400);
    const [a, b] = ids as [string, string];

    withhold(fake, a, HELD_BODY);
    await waitWithheld(stores, HELD_BODY);
    quotaTurn(fake, a);
    closedFailed(fake, a, QUOTA_CLOSED_REASON);
    await vi.waitFor(() => expect(messagesOf(fresh(), a).length).toBeGreaterThan(0), WAIT);

    quotaTurn(fake, b);
    closedFailed(fake, b, QUOTA_CLOSED_REASON);
    await vi.waitFor(() => expect(externalsOf(fresh())).toHaveLength(1), WAIT);
    await sleep(500);

    const own = messagesOf(fresh(), a);
    expect(own).toHaveLength(1);
    expect(own[0]?.text).toContain(HELD_MARK);
    expect(own[0]?.text).toContain(HELD_BODY);
    const list = (externalsOf(fresh())[0]?.payload as { text: string }).text;
    expect(list).toContain('最初の1本');
    expect(list).not.toContain('畳んでいた報告');
    expect(list).not.toContain(HELD_BODY);

    await pool.stop();
    expect(countOf(everyText(inbox), HELD_BODY)).toBe(1);
  });

  it('stop() で窓の途中を閉じても、貯めた担当の畳んでいた報告は一覧の行で1回だけ運ばれる', async () => {
    // 担当ごとの窓を長めにして、2本目の積みが窓の中のまま stop() に入りやすくする（満了で配られても結果は同じ）。
    const { pool, stores, inbox, fake, ids, fresh } = await poolSetup(2, 1_500);
    const [a, b] = ids as [string, string];

    quotaTurn(fake, a);
    await vi.waitFor(() => expect(messagesOf(fresh(), a).length).toBeGreaterThan(0), WAIT);

    withhold(fake, b, HELD_BODY);
    await waitWithheld(stores, HELD_BODY);
    quotaTurn(fake, b);
    closedFailed(fake, b, QUOTA_CLOSED_REASON);
    await waitClosedJournal(stores, b);

    await pool.stop();

    expect(messagesOf(fresh(), b)).toHaveLength(0);
    const sent = externalsOf(fresh());
    expect(sent).toHaveLength(1);
    const list = (sent[0]?.payload as { text: string }).text;
    expect(list).toContain(`- ${b}:`);
    expect(list).toContain('畳んでいた報告 1 本');
    expect(countOf(everyText(inbox), HELD_BODY)).toBe(1);
  });
});
