import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

// 枠で一斉に止まった担当の知らせを、担当ごとではなくプール全体の1通にまとめる（Issue #4443 (a)）。
// 「届く」ことは固定の待ちではなく `vi.waitFor` で、条件が満ちるまで待つ（CI の負荷で実時間が伸びても結果が変わらない）。
// 「届かない」ことを確かめるのは、届くはずのものを待ち終えた直後（窓の中）か、窓が閉じた後の固定の待ち。
// プール窓は、負荷で数百 ms 遅れても「窓の中」のまま確かめられるよう、担当ごとの窓（20ms）の100倍にしてある。
const NOTICE_WINDOW_MS = 20;
const POOL_WINDOW_MS = 2_000;
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

const SESSION_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";
const OTHER_RESET_LIMIT =
  "You've hit your session limit · resets 3:00am (Asia/Tokyo) · /extra-usage to continue";

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
  /** 立ち上げ（reattach）の知らせより後の受信箱。 */
  fresh(): InboxEvent[];
}

async function setup(managerIds: readonly string[]): Promise<Setup> {
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
    synthesizedNoticeWindowMs: NOTICE_WINDOW_MS,
    quotaStopWindowMs: POOL_WINDOW_MS,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length < managerIds.length) throw new Error('reattach の知らせがまだ届いていない');
  });
  const baseline = inbox.length;
  return { pool, stores, inbox, fake, fresh: () => inbox.slice(baseline) };
}

function quotaTurnFailed(
  fake: FakeRunner,
  managerId: string,
  limitText: string,
  status: JobStatus = 'done',
  said?: string,
): void {
  fake.emit({
    type: 'report',
    managerId,
    text:
      `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${limitText}` +
      (said === undefined ? '' : `\n\n（失敗する前に出ていた本文）\n${said}`),
    status,
    failure: { code: 'success/429', via: 'result_is_error', status: 429 },
    synthesized: 'turn_failed',
  });
}

function quotaClosedFailed(fake: FakeRunner, managerId: string, limitText: string): void {
  const at = fake.alive.findIndex((entry) => entry.managerId === managerId);
  if (at !== -1) fake.alive.splice(at, 1);
  fake.emit({
    type: 'closed',
    managerId,
    status: 'failed',
    reason: `マネージャーのセッションが落ちた: Error: Claude Code returned an error result: ${limitText}`,
  });
}

function externals(events: readonly InboxEvent[]) {
  return events.filter((event) => event.type === 'external') as Extract<
    InboxEvent,
    { type: 'external' }
  >[];
}

function managerMessages(events: readonly InboxEvent[]) {
  return events.filter((event) => event.type === 'manager_message') as Extract<
    InboxEvent,
    { type: 'manager_message' }
  >[];
}

function textOf(event: Extract<InboxEvent, { type: 'external' }>): string {
  return (event.payload as { text: string }).text;
}

async function journalTexts(stores: Stores): Promise<string[]> {
  await sleep(0);
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.map((entry) => JSON.stringify(entry));
}

type Fresh = () => InboxEvent[];

async function waitForOwn(fresh: Fresh, ids: readonly string[]): Promise<void> {
  await vi.waitFor(
    () =>
      expect(
        managerMessages(fresh())
          .map((m) => m.managerId)
          .sort(),
      ).toEqual([...ids].sort()),
    WAIT,
  );
}

async function waitForExternals(fresh: Fresh, count: number): Promise<void> {
  await vi.waitFor(() => expect(externals(fresh())).toHaveLength(count), WAIT);
}

// 窓へ貯めたことは、日誌の「受信箱へ行かず」の行で観測する（積んだ時点で書かれる）。
async function waitForStored(stores: Stores, managerId: string): Promise<void> {
  await vi.waitFor(async () => {
    const lines = await journalTexts(stores);
    if (!lines.some((l) => l.includes(`[${managerId}]`) && l.includes('受信箱へ行かず'))) {
      throw new Error(`${managerId} がまだ窓へ貯まっていない`);
    }
  }, WAIT);
}

describe('枠だけが理由の束は、担当ごとに配らずプール全体で1通にまとまる', () => {
  it('3本の担当が枠で止まると、受信箱に1通だけ届く。各行に状態（failed と running）・抜粋・リセット時刻が載る', async () => {
    const { pool, inbox, fake, fresh, stores } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    // 1本目: すぐ担当ごとの manager_message で届き、プール全体の窓が開く。
    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT, 'running', '調査の途中経過: 3件目まで読んだ');
    await waitForOwn(fresh, ['mgr-a']);
    expect(externals(fresh())).toHaveLength(0);

    // 窓の中で止まった残りの2本は、担当ごとには届かない（貯まったことを見てから確かめる）。
    quotaClosedFailed(fake, 'mgr-b', SESSION_LIMIT);
    quotaTurnFailed(fake, 'mgr-c', SESSION_LIMIT, 'done');
    quotaClosedFailed(fake, 'mgr-c', SESSION_LIMIT);
    await waitForStored(stores, 'mgr-b');
    await waitForStored(stores, 'mgr-c');
    expect(managerMessages(fresh()).map((m) => m.managerId)).toEqual(['mgr-a']);
    expect(externals(fresh())).toHaveLength(0);

    // 窓が閉じたとき、窓を開けた担当も含めた3本の一覧が1通。
    await waitForExternals(fresh, 1);
    expect(managerMessages(fresh()).map((m) => m.managerId)).toEqual(['mgr-a']);
    const sent = externals(fresh());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.source).toBe('runner-registry');
    const text = textOf(sent[0]!);

    expect(text).toContain('枠に当たって 3 本の担当が止まった');
    expect(text).toContain('resets 12:20am (Asia/Tokyo)');
    // 台帳の状態が行ごとに分かる: A はセッションが生きている（running）、B は failed で畳まれた。
    const lineOf = (id: string) =>
      text.split('\n').find((line) => line.startsWith(`- ${id}:`)) ?? '';
    expect(lineOf('mgr-a')).toContain('running（セッションは生きている）');
    expect(lineOf('mgr-a')).toContain('応答を返さずに終わった');
    expect(lineOf('mgr-a')).toContain('最初の1本。担当への報告としては先に届けてある');
    expect(lineOf('mgr-b')).not.toContain('最初の1本');
    expect(lineOf('mgr-b')).toContain('failed（セッションは落ちて、failed で畳まれた）');
    expect(lineOf('mgr-b')).toContain('セッションが落ちた');
    expect(lineOf('mgr-c')).toContain('failed');
    // 失敗する前に出ていた本文の抜粋は、その行の下に付く。
    expect(text).toContain('失敗する前に出ていた本文: 調査の途中経過: 3件目まで読んだ');
    // SDK の原文は全体で1回だけ。
    expect(text.split("You've hit your session limit").length - 1).toBe(1);
    expect(text).toContain('各担当の知らせの全文は日誌にある');
    expect(text).toContain('manager_report');

    await pool.stop();
    expect(externals(inbox).filter((e) => textOf(e).includes('枠に当たって'))).toHaveLength(1);

    const journal = await journalTexts(stores);
    // まとめた側の行と、担当ごとの行（受信箱へは行かない旨）の両方が残る。
    expect(
      journal.filter(
        (line) => line.includes('[プール全体]') && line.includes('1件にまとめて配った'),
      ),
    ).toHaveLength(1);
    for (const id of ['mgr-b', 'mgr-c']) {
      expect(
        journal.some((line) => line.includes(`[${id}]`) && line.includes('受信箱へ行かず')),
        id,
      ).toBe(true);
    }
    // 1本目は担当ごとに配ったので、「受信箱へ行かず」の行は無い。
    expect(
      journal.some((line) => line.includes('[mgr-a]') && line.includes('受信箱へ行かず')),
    ).toBe(false);
  });

  it('担当1本だけが枠で止まると、今どおり manager_message がすぐ1通。窓が閉じても追加の知らせは無い', async () => {
    const { pool, fake, fresh, stores } = await setup(['mgr-a']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);

    // 窓が閉じた後まで待つ（遅れて来るなら、ここで見つかる）。
    await sleep(POOL_WINDOW_MS + 500);
    expect(managerMessages(fresh())).toHaveLength(1);
    expect(externals(fresh())).toHaveLength(0);
    const journal = await journalTexts(stores);
    expect(journal.some((line) => line.includes('[プール全体]'))).toBe(false);

    await pool.stop();
    expect(externals(fresh())).toHaveLength(0);
  });

  it('窓を開けた担当の後続の束は、窓には貯めず、すぐ担当ごとに届く', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);
    quotaClosedFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a', 'mgr-a']);

    const own = managerMessages(fresh());
    expect(own[1]?.text).toContain('セッションが落ちた');

    await sleep(POOL_WINDOW_MS + 500);
    expect(externals(fresh())).toHaveLength(0);

    await pool.stop();
  });

  it('枠以外の断片が混ざる担当は、今どおり担当ごとに配られ、枠の1通には載らない', async () => {
    const { pool, fake, fresh, stores } = await setup(['mgr-a', 'mgr-b', 'mgr-mixed']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);
    quotaClosedFailed(fake, 'mgr-b', SESSION_LIMIT);
    // 枠の印が付く断片と、枠と無関係の落ち方（印が付かない）が同じ束に入る担当。
    quotaTurnFailed(fake, 'mgr-mixed', SESSION_LIMIT);
    fake.emit({
      type: 'closed',
      managerId: 'mgr-mixed',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: Error: spawn EAGAIN',
    });

    await waitForStored(stores, 'mgr-b');
    await waitForOwn(fresh, ['mgr-a', 'mgr-mixed']);
    await waitForExternals(fresh, 1);

    const pooled = externals(fresh());
    expect(pooled).toHaveLength(1);
    expect(textOf(pooled[0]!)).toContain('枠に当たって 2 本の担当が止まった');
    expect(textOf(pooled[0]!)).not.toContain('mgr-mixed');

    // 担当ごとに届くのは、窓を開けた mgr-a（1本目）と、印の無い断片が混ざった mgr-mixed。
    const own = managerMessages(fresh());
    expect(own.map((m) => m.managerId)).toEqual(['mgr-a', 'mgr-mixed']);
    expect(own[1]?.text).toContain('spawn EAGAIN');
    expect(own[1]?.text).toContain(SESSION_LIMIT);

    await pool.stop();
  });

  it('リセット時刻が違う担当は、1通の中で節が分かれる', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b', OTHER_RESET_LIMIT);
    quotaTurnFailed(fake, 'mgr-c', SESSION_LIMIT);

    await waitForExternals(fresh, 1);

    const sent = externals(fresh());
    expect(sent).toHaveLength(1);
    const text = textOf(sent[0]!);
    expect(text).toContain('枠に当たって 3 本の担当が止まった（リセット時刻は 2 通り）');
    const first = text.indexOf('■ resets 12:20am (Asia/Tokyo)（2 本）');
    const second = text.indexOf('■ resets 3:00am (Asia/Tokyo)（1 本）');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    // 各担当は自分の節の中に居る。
    expect(text.indexOf('- mgr-a:')).toBeGreaterThan(first);
    expect(text.indexOf('- mgr-c:')).toBeGreaterThan(first);
    expect(text.indexOf('- mgr-b:')).toBeGreaterThan(second);
    expect(text.indexOf('- mgr-a:')).toBeLessThan(second);

    await pool.stop();
  });

  it('リセット時刻が読めない担当は「リセット時刻は分からない」と言う', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b']);

    quotaTurnFailed(fake, 'mgr-a', "You've hit your session limit");
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b', "You've hit your session limit");
    await waitForExternals(fresh, 1);

    const text = textOf(externals(fresh())[0]!);
    expect(text).toContain('枠に当たって 2 本の担当が止まった（リセット時刻は分からない）');

    await pool.stop();
  });

  it('窓が閉じた後に来た担当は新しい窓の1本目になり、すぐ担当ごとに届く', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b', SESSION_LIMIT);
    await waitForExternals(fresh, 1);

    quotaTurnFailed(fake, 'mgr-c', SESSION_LIMIT);
    // 新しい窓の1本目: 一覧を待たずに担当ごとに届く。
    await waitForOwn(fresh, ['mgr-a', 'mgr-c']);
    await sleep(POOL_WINDOW_MS + 500);
    // 貯めた担当が居ないので、窓が閉じても一覧は出ない。
    expect(externals(fresh())).toHaveLength(1);
    expect(textOf(externals(fresh())[0]!)).toContain('枠に当たって 2 本の担当が止まった');

    await pool.stop();
  });

  it('窓の途中で stop() すると、窓に貯めた分が1通として配られる', async () => {
    const { pool, fake, fresh, stores } = await setup(['mgr-a', 'mgr-b']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);
    quotaClosedFailed(fake, 'mgr-b', SESSION_LIMIT);
    // 担当ごとの窓は閉じ、プール全体の窓の中にいる時点で止める。
    await waitForStored(stores, 'mgr-b');
    expect(externals(fresh())).toHaveLength(0);

    await pool.stop();

    const sent = externals(fresh());
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!)).toContain('枠に当たって 2 本の担当が止まった');
  });

  it('担当ごとの窓の中で stop() しても、枠の分は落ちずに1通として配られる', async () => {
    const { pool, fake, fresh, stores } = await setup(['mgr-a', 'mgr-b']);

    quotaTurnFailed(fake, 'mgr-a', SESSION_LIMIT);
    await waitForOwn(fresh, ['mgr-a']);
    quotaTurnFailed(fake, 'mgr-b', SESSION_LIMIT);
    // 報告が日誌に書かれるのを待ってから止める。担当ごとの窓の中で止まっても、窓を閉じた後でも、結果は同じ（積んだ分は落ちない）。
    await vi.waitFor(async () => {
      const lines = await journalTexts(stores);
      if (!lines.some((l) => l.includes('mgr-b') && l.includes('[応答]'))) {
        throw new Error('mgr-b の報告がまだ日誌に書かれていない');
      }
    }, WAIT);
    // 日誌の後に積むまでの数 tick を待つ（積んだ後なら窓へ貯まっているだけで、結果は変わらない）。
    await sleep(100);
    await pool.stop();

    const sent = externals(fresh());
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!)).toContain('枠に当たって 2 本の担当が止まった');
    expect(managerMessages(fresh()).map((m) => m.managerId)).toEqual(['mgr-a']);
  });
});

describe('プール全体の窓は、トークンごとに別の出来事として持つ', () => {
  it('トークンが違う2本はどちらもすぐ担当ごとに届き一覧は出ない。同じトークンの3本目は、そのトークンの窓の一覧に載る', async () => {
    const stores = createMemoryStores();
    const fake = fakeRunner();
    const inbox: InboxEvent[] = [];
    let active = { tokenId: 'tok-old', generation: 1 };
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => active,
      synthesizedNoticeWindowMs: NOTICE_WINDOW_MS,
      quotaStopWindowMs: POOL_WINDOW_MS,
    });
    // 担当が抱えるトークンは起こした瞬間の現役で決まる: 古い鍵で2本、新しい鍵で1本起こす。
    const old1 = await pool.start({ request: '古い鍵の1本目' });
    const old2 = await pool.start({ request: '古い鍵の2本目' });
    active = { tokenId: 'tok-new', generation: 2 };
    const fresh1 = await pool.start({ request: '新しい鍵の1本目' });
    const baseline = inbox.length;
    const since = (): InboxEvent[] => inbox.slice(baseline);

    quotaTurnFailed(fake, old1.managerId, SESSION_LIMIT);
    await waitForOwn(since, [old1.managerId]);
    quotaTurnFailed(fake, fresh1.managerId, SESSION_LIMIT);

    // 別のトークンの枠は別の出来事: どちらも1本目としてすぐ届き、まだ一覧は無い。
    await waitForOwn(since, [old1.managerId, fresh1.managerId]);
    expect(externals(since())).toHaveLength(0);

    // 古い鍵の2本目は、古い鍵の窓に貯まる（担当ごとには届かない）。
    quotaTurnFailed(fake, old2.managerId, SESSION_LIMIT);
    await waitForStored(stores, old2.managerId);
    expect(managerMessages(since())).toHaveLength(2);

    await waitForExternals(since, 1);
    const sent = externals(since());
    // 一覧が出るのは古い鍵の窓だけ（2本）。新しい鍵は1本だけなので出ない。
    expect(sent).toHaveLength(1);
    const text = textOf(sent[0]!);
    expect(text).toContain('枠に当たって 2 本の担当が止まった');
    expect(text).toContain(old1.managerId);
    expect(text).toContain(old2.managerId);
    expect(text).not.toContain(fresh1.managerId);

    await pool.stop();
  });
});

describe('枠の印が無い束は、今どおり担当ごとに配る', () => {
  it('枠の印が無い turn_failed だけの担当は manager_message で届き、窓をまたぐ同文の連鎖も今どおり立つ', async () => {
    const { pool, fake, fresh, stores } = await setup(['mgr-a']);
    // `failure.status` の無い report（旧 runner）や枠と無関係の失敗は、枠とは言い切れない。
    const unmarked = (): void =>
      fake.emit({
        type: 'report',
        managerId: 'mgr-a',
        text: '（このターンは応答を返さずに終わった: error_during_execution / result_subtype）\n内部エラー',
        status: 'done',
        failure: { code: 'error_during_execution', via: 'result_subtype' },
        synthesized: 'turn_failed',
      });

    unmarked();
    await waitForOwn(fresh, ['mgr-a']);
    unmarked();
    // 2通目は今までどおり、窓をまたぐ同文として数だけ残して畳まれる（日誌の行で観測する）。
    await vi.waitFor(async () => {
      const lines = await journalTexts(stores);
      if (!lines.some((line) => line.includes('受信箱へは回さず数だけ残した'))) {
        throw new Error('2通目がまだ畳まれていない');
      }
    }, WAIT);

    expect(externals(fresh())).toHaveLength(0);
    const own = managerMessages(fresh());
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ managerId: 'mgr-a', synthesized: true });
    expect(own[0]?.text).toContain('内部エラー');

    await pool.stop();
  });

  it('古い runner（failure.status を送らない版）の 429 の失敗は、枠と言い切れないので今どおり担当ごとに配る', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a', 'mgr-b']);

    for (const id of ['mgr-a', 'mgr-b']) {
      fake.emit({
        type: 'report',
        managerId: id,
        text: `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${SESSION_LIMIT}`,
        status: 'done',
        failure: { code: 'success/429', via: 'result_is_error' },
        synthesized: 'turn_failed',
      });
    }
    await waitForOwn(fresh, ['mgr-a', 'mgr-b']);
    // 窓が閉じた後まで待っても、一覧は出ない（枠と言い切れないので窓が開かない）。
    await sleep(POOL_WINDOW_MS + 500);
    expect(externals(fresh())).toHaveLength(0);

    await pool.stop();
  });

  it('枠の判定は failure.status（構造化された値）で行い、本文に「429」と書いてあるだけでは枠にしない', async () => {
    const { pool, fake, fresh } = await setup(['mgr-a']);

    fake.emit({
      type: 'report',
      managerId: 'mgr-a',
      text: `（このターンは応答を返さずに終わった: success/500 / result_is_error）\nHTTP 429 と書いてあるが 500 だった ${SESSION_LIMIT}`,
      status: 'done',
      failure: { code: 'success/500', via: 'result_is_error', status: 500 },
      synthesized: 'turn_failed',
    });
    await waitForOwn(fresh, ['mgr-a']);

    expect(externals(fresh())).toHaveLength(0);

    await pool.stop();
  });
});
