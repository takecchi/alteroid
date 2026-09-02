import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, withheldReportOverdue, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
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

/**
 * **マネージャーがバックグラウンド実行の完了を待つためだけに畳んだターンの
 * 報告は、クローンのターンを起こさない。**
 *
 * 確定済みの証拠（依頼者が生ログで実測）: `Bash` を `run_in_background: true`
 * で起動した直後の assistant メッセージが「完了を待つ」とだけ言って
 * `end_turn` で畳むと、その最後の発話がそのまま「報告」としてクローンへ
 * 配られ、クローンのターンが1本無駄に起きる。当日だけでこの形の配達が
 * 11本あった。
 *
 * `runner-contentless.test.ts`（`contentless`）と完全に同型の直しである
 * ——「中身の無い報告はクローンのターンを起こさない」を「背景処理の完了
 * 待ちで畳んだターンの報告は起こさない」へ広げた。
 *
 * ## この歯が使う2つの足場
 *
 * 1. **`manualRunner()`** —— `RunnerEvent` を直接組み立てて emit する
 *    （`manager.test.ts` の `swappableRunner` と同じ作法）。SDK 層を経由
 *    しないので、`manager.ts` の握り潰し・帳面・`#emit` の1行付与・
 *    `closed`/`flushWithheldReports` の逃げ道を単体で確かめられる。
 * 2. **`fakeSdk()` + `createLocalRunner`**（"通しの歯"）—— 偽の `queryFn`
 *    から `background_tasks_changed` → `assistant` → `result` を流し、
 *    `createRunnerHost`（`runner.ts`）→ `RunnerEvent` → `createManagerPool`
 *    の `post` まで実際に繋ぐ。**書く側と読む側をそれぞれ擬似物で差し替え
 *    ただけの歯ではない** —— `runner.ts` の実装（`#apply` の
 *    `case 'turn_ended'`）と `manager.ts` の実装（`case 'report'` /
 *    `#emit`）の両方を、実物のまま通す。
 */

// ---------------------------------------------------------------------------
// 足場1: manualRunner（manager.ts 単体の検証）
// ---------------------------------------------------------------------------

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  /** マネージャーの1ターンが終わって報告が上がる。 */
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: {
      failure?: { code: string; via: string };
      contentless?: true;
      awaitingBackground?: { count: number; breakdown: string };
      reportId?: string;
    },
  ): void;
  /** マネージャーが確認を上げる。 */
  ask(
    managerId: string,
    requestId: string,
    summary: string,
    kind?: 'question' | 'permission',
  ): void;
  /** runner 側でセッションが本当に閉じた。 */
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
}

/** `manager.test.ts` の `swappableRunner` と同じ最小実装（この歯専用に複製）。 */
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
    async start() {
      /* この検証では使わない */
    },
    async resume() {
      /* この検証では使わない */
    },
    async send() {
      /* この検証では使わない */
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    // **`abort()` の `#confirmStoppedAndReleaseLease` は `list()` に「もう
    // 居ない」ことを確かめてから `stopped` を確定させる**（`manager.ts` の
    // `#confirmStoppedAndReleaseLease` の doc）。ここで `alive` から外さない
    // と `sessionGone` が常に `false` になり、`abort()` が `stopped` を
    // 一度も確定できない。
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
    report(managerId, text, status, fields = {}) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    ask(managerId, requestId, summary, kind = 'permission') {
      emit?.({
        type: 'ask',
        managerId,
        requestId,
        kind,
        summary,
        askedAt: new Date().toISOString(),
      });
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  advance: (ms: number) => void;
}

/**
 * `job` を台帳へ先に置き、`restore()` で `manualRunner` を接続する
 * （`manager.test.ts` の「`report` の冪等化」describe が使うのと同じ手順）。
 * これで `fake.report(...)` / `fake.closed(...)` が `#onEvent` へ実際に届く
 * 状態を作る。
 */
async function runningManualSetup(managerId = 'mgr-withhold'): Promise<ManualSetup> {
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
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock,
  });

  await pool.restore();
  // **`restore()` の知らせ（`#notifyRestored`）を fire-and-forget で待つ**
  // （`manager.test.ts` の「report の冪等化」と同じ理由——ここを待たずに
  // `before = inbox.length` を取ると、この知らせが後から紛れ込む）。
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake, advance: (ms) => (clock += ms) };
}

async function jobOf(stores: Stores, managerId: string) {
  return (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
}

async function journalHasText(stores: Stores, needle: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange', 'decision'] });
    if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
      throw new Error('日誌にまだ載っていない');
    }
  });
}

const AWAITING = { count: 1, breakdown: 'shell×1' };
/** `flushWithheldReports` の期限（30分。`manager.ts` の同名の定数と同じ値）。 */
const WITHHELD_REPORT_FLUSH_MS = 30 * 60_000;

describe('manager が握り潰したとき（case "report" の awaitingBackground）', () => {
  it('受信箱（inbox）は増えない', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', '完了を待つ', 'done', { awaitingBackground: AWAITING });

    // **台帳の更新を「処理が終わった」の合図にする。** `#onEvent` は
    // fire-and-forget（`void`）で走るので、発火直後は書き込みがまだ
    // 終わっていないことがある（`manager.test.ts` の `jobOf` と同じ理由）。
    await vi.waitFor(async () => {
      const job = await jobOf(stores, 'mgr-withhold');
      if (job?.lastReport !== '完了を待つ') throw new Error('台帳がまだ更新されていない');
    });

    expect(inbox.length).toBe(before);
    await pool.stop();
  });

  it('decision の日誌が1件出る', async () => {
    const { pool, stores, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '完了を待つ', 'done', { awaitingBackground: AWAITING });

    await journalHasText(stores, '背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない');
    const entries = await stores.journal.list({ types: ['decision'] });
    const found = entries.find((entry) =>
      JSON.stringify(entry).includes(
        '背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない',
      ),
    );
    expect(found).toBeDefined();
    expect(JSON.stringify(found)).toContain('mgr-withhold');
    expect(JSON.stringify(found)).toContain('shell×1');
    expect(JSON.stringify(found)).toContain('完了を待つ');

    await pool.stop();
  });

  it('台帳（lastReport）と exchange の日誌には、これまでどおり残っている', async () => {
    const { pool, stores, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '完了を待つ本文', 'done', { awaitingBackground: AWAITING });

    await vi.waitFor(async () => {
      const job = await jobOf(stores, 'mgr-withhold');
      if (job?.lastReport !== '完了を待つ本文') throw new Error('台帳がまだ更新されていない');
    });
    const exchanged = await stores.journal.list({ types: ['exchange'] });
    expect(exchanged.some((entry) => JSON.stringify(entry).includes('完了を待つ本文'))).toBe(true);

    await pool.stop();
  });
});

describe('次に配るときに「N 本配っていない」の1行が付く', () => {
  it('次の本物の report で付き、帳面が空になる', async () => {
    const { pool, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '1回目（握り潰される）', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    fake.report('mgr-withhold', '2回目（本物）', 'done');

    // **`.find` ではなく `.at(-1)` で拾う。** `restore()` 由来の「知らせ」
    // （`#notifyRestored`。`#post` を直接呼ぶので `#emit` を経由しない）が
    // 既に kind: 'report' で1件入っているため、`.find` は先頭のそちらへ
    // 当たってしまい、新着を待たない。
    const delivered = await vi.waitFor(() => {
      const found = inbox
        .filter((event) => event.type === 'manager_message' && event.kind === 'report')
        .at(-1);
      if (!found || !(found as { text: string }).text.startsWith('2回目（本物）')) {
        throw new Error('まだ届いていない');
      }
      return found as { text: string };
    });
    expect(inbox.length).toBe(before + 1);
    expect(delivered.text).toContain('2回目（本物）');
    expect(delivered.text).toContain('背景処理の完了待ちで畳んだターンの報告を 1 本配っていない');
    expect(delivered.text).toContain('journal_read');

    // **帳面が空になる。** 3回目（握り潰しの無い回）には付かない。
    const beforeThird = inbox.length;
    fake.report('mgr-withhold', '3回目（普通の報告）', 'done');
    const third = await vi.waitFor(() => {
      const found = inbox
        .filter((event) => event.type === 'manager_message' && event.kind === 'report')
        .at(-1);
      if (!found || (found as { text: string }).text !== '3回目（普通の報告）') {
        throw new Error('まだ届いていない');
      }
      return found as { text: string };
    });
    expect(inbox.length).toBe(beforeThird + 1);
    expect(third.text).toBe('3回目（普通の報告）');
    expect(third.text).not.toContain('配っていない');

    await pool.stop();
  });

  it('question / permission で配るときにも同じ1行が付く', async () => {
    const { pool, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fake.ask('mgr-withhold', 'req-1', 'これでよいか確認したい', 'question');
    const question = await vi.waitFor(() => {
      const found = inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'question',
      );
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(question.text).toContain('これでよいか確認したい');
    expect(question.text).toContain('配っていない');

    await pool.stop();
  });
});

describe('closed で積みが配られる／stopped では配られない', () => {
  it('closed（done）で積みが配られる', async () => {
    const { pool, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    fake.closed('mgr-withhold', 'done', 'この委譲は終わった');

    // **`.at(-1)` だけでは足りない。** `restore()` 由来の「知らせ」が既に
    // 1件在るので、新着が来るまでは `.at(-1)` も同じ古い1件を返し続け、
    // 待たずに（誤って）「届いた」と判定してしまう——本文に「配っていない」
    // が含まれるまで待つ。
    const delivered = await vi.waitFor(() => {
      const found = inbox
        .filter((event) => event.type === 'manager_message' && event.kind === 'report')
        .at(-1);
      if (!found || !(found as { text: string }).text.includes('配っていない')) {
        throw new Error('まだ届いていない');
      }
      return found as { text: string };
    });
    expect(inbox.length).toBe(before + 1);
    expect(delivered.text).toContain('配っていない');

    await pool.stop();
  });

  it('abort() で止めた（stopped）後は、積みが在っても配らない——日誌だけ', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.abort('mgr-withhold', '人間が止めた');
    const before = inbox.length;

    // 止めた後に届く closed（R4 の想定経路）。
    fake.closed('mgr-withhold', 'done', 'runner 側は後から終わったと言ってきた');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(inbox.length).toBe(before);
    // 日誌には残っている（止めた事実そのものの exchange）。
    const entries = await stores.journal.list({ types: ['exchange'] });
    expect(entries.length).toBeGreaterThan(0);

    await pool.stop();
  });
});

describe('flushWithheldReports（時間で必ず配る逃げ道）', () => {
  it('期限を過ぎた積みを配る', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();
    // **`restore()` 由来の「知らせ」（`#notifyRestored`）が既に1件在る**ので、
    // 「何も届かない」は絶対数ではなく `before` からの増減で判定する。
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // まだ期限前 — 何も増えない。
    await pool.flushWithheldReports();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    // 30分経過。
    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();

    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('配っていない');

    await pool.stop();
  });

  it('過ぎていない積みは配らない', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(10 * 60_000); // 30分に満たない
    await pool.flushWithheldReports();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(inbox.length).toBe(before);
    await pool.stop();
  });

  /**
   * **`lastAt` が読めない（壊れている）ときは、期限切れとして配る側へ倒す。**
   *
   * `Pool#withheldReports` は真の private field（`#`）で、`#withholdBackgroundReport`
   * の1箇所（常に有効な ISO 文字列しか書かない）以外から書けないので、壊れた
   * `lastAt` を `Pool` 経由で注入する自然な経路が無い——`withheldReportOverdue`
   * （純関数として切り出してある）を直接呼んで確かめる（`manager.ts` の doc
   * 「テストが書けない構造は、テストが無いのと同じ」）。
   */
  describe('withheldReportOverdue（lastAt が壊れている場合の判定）', () => {
    it('壊れた lastAt は期限切れとして扱う（配る側へ倒す）', () => {
      expect(
        withheldReportOverdue('これは日時ではない', Date.now(), WITHHELD_REPORT_FLUSH_MS),
      ).toBe(true);
      expect(withheldReportOverdue('', Date.now(), WITHHELD_REPORT_FLUSH_MS)).toBe(true);
    });

    it('読める lastAt は、これまでどおり経過時間で判定する（回帰）', () => {
      const now = Date.parse('2026-09-01T01:00:00.000Z');
      // 期限ちょうど前 — まだ配らない。
      expect(withheldReportOverdue('2026-09-01T00:30:00.001Z', now, WITHHELD_REPORT_FLUSH_MS)).toBe(
        false,
      );
      // 期限ちょうど・それ以降 — 配る。
      expect(withheldReportOverdue('2026-09-01T00:30:00.000Z', now, WITHHELD_REPORT_FLUSH_MS)).toBe(
        true,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 足場2: fakeSdk + createLocalRunner（通しの歯）
// ---------------------------------------------------------------------------

interface FakeSession {
  backgroundTasksChanged(tasks: readonly { id: string; taskType: string }[]): Promise<void>;
  say(text: string): Promise<void>;
  finish(text: string): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
          })),
          session_id: 'sess-e2e',
          uuid: `uuid-bg-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-e2e',
          uuid: `uuid-say-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async finish(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-e2e',
          uuid: `uuid-result-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-e2e',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

interface E2eSetup {
  pool: ManagerPool;
  sessions: FakeSession[];
  inbox: InboxEvent[];
}

function e2eSetup(): E2eSetup {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });
  return { pool, sessions, inbox };
}

let e2ePools: ManagerPool[] = [];
afterEach(async () => {
  await Promise.all(e2ePools.map((pool) => pool.stop().catch(() => undefined)));
  e2ePools = [];
});

describe('通しの歯: 偽の queryFn → createRunnerHost → RunnerEvent → createManagerPool の post', () => {
  it('背景処理の完了待ちの回では受信箱に何も入らず、次の本物の報告に「配っていない」が付く', async () => {
    const s = e2eSetup();
    e2ePools.push(s.pool);
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    // 1ターン目: 背景タスクが在るまま、成功して done で終わる
    // （`Bash` を `run_in_background: true` で起こした直後に相当）。
    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.say('変異Bの pnpm test の完了を待って作業者を再開させる。');
    await session.finish('変異Bの pnpm test の完了を待って作業者を再開させる。');

    // **待ちのターンでは受信箱に何も入らない。**
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(0);

    // 2ターン目: 背景タスクが片付いたことを SDK が知らせてから、本物の報告が来る。
    // **REPLACE 意味論なので、片付いたことを明示的に知らせないと在り高が
    // 前のターンのまま残り続ける**（`agent-events.ts` の
    // `AgentBackgroundTasksEvent` の doc）——これを送らずに `finish` すると、
    // 2ターン目も「まだ背景処理を待っている」として握り潰され続ける。
    await session.backgroundTasksChanged([]);
    await session.say('本物の報告。');
    await session.finish('本物の報告。');

    const delivered = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    // **末尾に「1 本配っていない」が付く。**
    expect(delivered.text).toContain('本物の報告。');
    expect(delivered.text).toContain('背景処理の完了待ちで畳んだターンの報告を 1 本配っていない');
    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(1);
  });
});
