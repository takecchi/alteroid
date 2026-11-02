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

// 機構が合成した知らせの「段2」（担当ごとの短い窓で束ねて配る部分）を、公開の口と runner の出来事だけで縛る。
// 段2を別のクラスへ切り出しても同じ試験が通ること。時計は偽の時計で、実時間の待ちは使わない。
const NOTICE_WINDOW_MS = 20;

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

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
}

async function setup(ids: readonly string[]): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  for (const id of ids) {
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
      liveBackgroundTasks: 0,
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
  });
  await pool.restore();
  await settle();
  // 立ち上げ（reattach）の知らせは数えない。
  inbox.length = 0;
  return { pool, stores, inbox, fake };
}

/** 偽の時計を進めて、積まれた非同期の処理を流す。 */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

type Message = Extract<InboxEvent, { type: 'manager_message' }>;

function messages(events: readonly InboxEvent[]): Message[] {
  return events.filter((event): event is Message => event.type === 'manager_message');
}

function turnFailed(fake: FakeRunner, managerId: string, text: string): void {
  fake.emit({
    type: 'report',
    managerId,
    text,
    status: 'running',
    failure: { code: 'crash', via: 'result_is_error' },
    synthesized: 'turn_failed',
  });
}

const X_BODY = '（このターンは応答を返さずに終わった: crash / X）';
const Y_BODY = '（このターンは応答を返さずに終わった: crash / Y）';

/** 窓を閉じるところまで時計を進める。戻り値は、その時点（＝窓が閉じて配られた時刻）の ISO。 */
async function queueAndClose(fake: FakeRunner, managerId: string, text: string): Promise<string> {
  turnFailed(fake, managerId, text);
  await settle();
  await settle(NOTICE_WINDOW_MS);
  return new Date().toISOString();
}

function realReport(fake: FakeRunner, managerId: string, text: string): void {
  fake.emit({ type: 'report', managerId, text, status: 'done' });
}

// 連（streak）の末尾の文。「配らなかった」件数と時刻、断り書きを1文字も変えない。
function streakFooter(bundles: number, arrived: number, first: string, last: string): string {
  return (
    `\n\n（この間に、直前と同じ本文の「機構が合成した知らせ」を ${String(bundles)} 束（通数 ${String(arrived)} 件）配っていない` +
    `（最初 ${first} / 最後 ${last}）。` +
    `**1件目は配ってあり、配らなかったのは2件目以降の完全な重複だけである。**` +
    `全文は日誌に在る（\`journal_read\`）。）`
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('畳めない出来事が来たときの配る順（#emit は先に全担当の窓を流してから本題を配る）', () => {
  it('2つの担当の知らせを同じ時刻に積んでから question が来ると、積んだ順に2通配ってから question が届き、窓のタイマーは残らない', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a', 'mgr-b']);

    turnFailed(fake, 'mgr-a', '（このターンは応答を返さずに終わった: crash / A）');
    turnFailed(fake, 'mgr-b', '（このターンは応答を返さずに終わった: crash / B）');
    // 出来事の処理は非同期なので、積み終えるまで時計を進めずに流す（窓はまだ閉じない）。
    await settle();
    expect(messages(inbox)).toHaveLength(0);
    fake.emit({
      type: 'ask',
      managerId: 'mgr-a',
      requestId: 'req-1',
      kind: 'question',
      summary: 'これでよいか',
      askedAt: '2026-10-01T00:00:00.000Z',
    });
    await settle();

    // 窓（20ms）が閉じる前に、question が積みを押し出している。
    expect(messages(inbox).map((m) => [m.managerId, m.kind])).toEqual([
      ['mgr-a', 'report'],
      ['mgr-b', 'report'],
      ['mgr-a', 'question'],
    ]);
    expect(messages(inbox)[0]?.text).toBe('（このターンは応答を返さずに終わった: crash / A）');
    expect(messages(inbox)[1]?.text).toBe('（このターンは応答を返さずに終わった: crash / B）');

    // 押し出された窓のタイマーは解いてある: 窓の長さを過ぎても、同じ知らせが二度配られない。
    await settle(NOTICE_WINDOW_MS * 5);
    expect(messages(inbox)).toHaveLength(3);
    await pool.stop();
    expect(messages(inbox)).toHaveLength(3);
  });
});

describe('担当を畳んだ（abort の #retire）あとの窓と連', () => {
  it('開いていた窓は畳んだ後も残って配られ、連だけが消える（同じ本文でも握りつぶされず1件目として届く）', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a']);
    await queueAndClose(fake, 'mgr-a', X_BODY);
    // 連が立っている担当の窓に、同文の知らせを積んだままにする。
    turnFailed(fake, 'mgr-a', X_BODY);
    await settle();
    expect(messages(inbox)).toHaveLength(1);

    const aborting = pool.abort('mgr-a', '人間が止めた');
    await settle();
    await aborting;
    const afterAbort = messages(inbox).length;

    await settle(NOTICE_WINDOW_MS);
    // 窓は消えていない（配られる）。連が残っていれば同文として握りつぶされて増えない。
    expect(messages(inbox)).toHaveLength(afterAbort + 1);
    expect(messages(inbox).at(-1)?.text).toBe(X_BODY);
    await pool.stop();
  });
});

describe('配る文は、引数の組み合わせごとに1文字も変わらない（全文で固定）', () => {
  it('合成の単発（連も在庫も無い）は本文そのままで、末尾に何も足さない', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a']);
    await queueAndClose(fake, 'mgr-a', X_BODY);
    expect(messages(inbox).map((m) => m.text)).toEqual([X_BODY]);
    await pool.stop();
  });

  it('連で配らなかった束は、次の本物の報告の末尾に件数・時刻・断り書きとして付き、その後の報告には付かない', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a']);
    await queueAndClose(fake, 'mgr-a', X_BODY);
    await settle(100);
    const first = await queueAndClose(fake, 'mgr-a', X_BODY);
    const last = await queueAndClose(fake, 'mgr-a', X_BODY);
    expect(messages(inbox)).toHaveLength(1);

    realReport(fake, 'mgr-a', 'R1');
    await settle();
    realReport(fake, 'mgr-a', 'R2');
    await settle();
    expect(messages(inbox).map((m) => m.text)).toEqual([
      X_BODY,
      `R1${streakFooter(2, 2, first, last)}`,
      'R2',
    ]);
    await pool.stop();
  });

  it('畳んでいた報告の在庫の文が先、連の文が後に付く（在庫の末尾の文 → 連の件数の順）', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a']);
    await queueAndClose(fake, 'mgr-a', X_BODY);
    await settle(100);
    const suppressedAt = await queueAndClose(fake, 'mgr-a', X_BODY);
    await settle(10);
    const heldAt = new Date().toISOString();
    fake.emit({
      type: 'report',
      managerId: 'mgr-a',
      text: 'HELD',
      status: 'done',
      awaitingBackground: { count: 1, breakdown: 'shell×1' },
    });
    await settle();
    expect(messages(inbox)).toHaveLength(1);
    await settle(10);
    realReport(fake, 'mgr-a', 'R');
    await settle();

    expect(messages(inbox)[1]?.text).toBe(
      'R' +
        `\n\n（この間に、背景処理の完了待ちで畳んだターンの報告を 1 本配っていない（最初 ${heldAt} / 最後 ${heldAt}）。` +
        '全文は日誌に在る（`journal_read q=mgr-a` since=最初の少し前 until=最後の少し後）。\n' +
        `畳んだ報告の冒頭（古い順）:\n- ${heldAt} HELD\n）` +
        streakFooter(1, 1, suppressedAt, suppressedAt),
    );
    await pool.stop();
  });

  it('連を運んでから新しい連を登録する: 別の本文の知らせは前の連の件数を末尾に運び、その本文での新しい連が立つ', async () => {
    const { pool, fake, inbox } = await setup(['mgr-a']);
    await queueAndClose(fake, 'mgr-a', X_BODY);
    await settle(100);
    const xSuppressed = await queueAndClose(fake, 'mgr-a', X_BODY);
    expect(messages(inbox)).toHaveLength(1);

    // Y は別の本文なので配られ、X の連の件数（1束・1通）がこの1通の末尾へ運ばれる。
    await queueAndClose(fake, 'mgr-a', Y_BODY);
    expect(messages(inbox)).toHaveLength(2);
    expect(messages(inbox)[1]?.text).toBe(
      `${Y_BODY}${streakFooter(1, 1, xSuppressed, xSuppressed)}`,
    );

    // 運んだ後は Y の連が立っている: 同じ Y は握りつぶされ、X の件数は重ねて運ばれない。
    await settle(100);
    const ySuppressed = await queueAndClose(fake, 'mgr-a', Y_BODY);
    expect(messages(inbox)).toHaveLength(2);
    realReport(fake, 'mgr-a', 'R');
    await settle();
    expect(messages(inbox)[2]?.text).toBe(`R${streakFooter(1, 1, ySuppressed, ySuppressed)}`);
    await pool.stop();
  });
});
