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
import { captureStderr, createMemoryStores } from './testing.js';
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
async function runningManualSetup(
  managerId = 'mgr-withhold',
  options: { withheldReportFlushMs?: number } = {},
): Promise<ManualSetup> {
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
    withheldReportFlushMs: options.withheldReportFlushMs,
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

/**
 * **止めた委譲が握り潰した報告を抱えたまま終わったことを、依頼者（クローン）が
 * 知る手段が無い、という穴を塞ぐ。**
 *
 * 直上の describe が固定しているのは「積みの**本文**は abort() 後には配らない
 * （R4）」であって、「積みが在ったという**事実**も一切出さない」ではない——
 * この2つを混同すると、握り潰したまま終わったことに気づく引き金が無くなる。
 *
 * ここで固定するのは3つ:
 * 1. クローン発（`by: 'clone'`）は `ManagerAbortResult.detail`（`manager_stop`
 *    の戻り値の元）に件数・時刻・`journal_read` の案内が乗り、**本文
 *    （`lastText`）は乗らない**——**受信箱（inbox）は増えない**（R4 は破って
 *    いない。クローンへの配達は同期の戻り値のみ）。
 * 2. 人間発（`by` 省略＝`'human'`）は、既存の停止メッセージ1本の中に同じ
 *    案内が乗る——**受信箱はちょうど1件しか増えない**（新しいターンを
 *    起こしていない）。
 * 3. 陰性対照: 積みが無いときは detail にもメッセージにも何も足さない
 *    （回帰。何もしていないことを確かめる歯が無いと、足す条件が壊れて
 *    常に足すようになっても気づけない）。
 *
 * 加えて、`#retire()` が stderr へ残す跡（`noteWithheldReportsDiscarded`）も
 * ここで一緒に確かめる——abort() の中でも `#retire()` は必ず呼ばれるので、
 * 積みが在れば同じ呼び出しの中でこの跡も出る（`manager.ts` の `#retire()` の
 * doc「呼び出し元がどれであっても同じ1行が漏れなく残る」）。
 */
describe('abort() で止めた委譲が握り潰した積みを抱えていた場合、事実が依頼者へ届く', () => {
  it('クローン発: detail に件数・時刻・journal_read の案内が乗り、本文は乗らない。受信箱は増えない', async () => {
    const { pool, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回・秘密の本文', 'done', {
      awaitingBackground: AWAITING,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    const lines = await captureStderr(async () => {
      const result = await pool.abort('mgr-withhold', '理由', 'clone');
      expect(result.outcome).toBe('stopped');
      expect(result.detail).toContain('背景処理の完了待ちで畳んだ報告を 1 本抱えたまま止まった');
      expect(result.detail).toContain('journal_read');
      // **本文（lastText）は乗らない（R4）。**
      expect(result.detail).not.toContain('握り潰される回・秘密の本文');
    });

    // **`by: 'clone'` は #post しない（Issue #320）——ここでも増やしていない。**
    expect(inbox.length).toBe(before);

    // `#retire()` の stderr の跡（本文は乗らない）。
    const joined = lines.join('');
    expect(joined).toContain('握り潰した報告を配らずに捨てました');
    expect(joined).toContain('managerId=mgr-withhold');
    expect(joined).not.toContain('握り潰される回・秘密の本文');

    await pool.stop();
  });

  it('人間発: 既存の停止メッセージ1本の中に案内が乗る（新しいターンを増やさない）', async () => {
    const { pool, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    const result = await pool.abort('mgr-withhold', '人間が止めた');
    expect(result.outcome).toBe('stopped');

    // **ちょうど1件しか増えない**（新しいターンを起こしていない）。
    expect(inbox.length).toBe(before + 1);
    const posted = inbox.at(-1) as { text: string };
    expect(posted.text).toContain('を人間が停止させました');
    expect(posted.text).toContain('背景処理の完了待ちで畳んだ報告を 1 本抱えたまま止まった');
    expect(posted.text).toContain('journal_read');

    await pool.stop();
  });

  it('陰性対照: 積みが無いときは detail にもメッセージにも何も足さない（stderr の跡も出ない）', async () => {
    const { pool, inbox } = await runningManualSetup();
    const before = inbox.length;

    const lines = await captureStderr(async () => {
      const result = await pool.abort('mgr-withhold', '積みなしで止めた');
      expect(result.outcome).toBe('stopped');
      expect(result.detail).not.toContain('抱えたまま止まった');
      expect(result.detail).not.toContain('journal_read');
    });

    expect(inbox.length).toBe(before + 1);
    const posted = inbox.at(-1) as { text: string };
    expect(posted.text).not.toContain('抱えたまま止まった');
    expect(lines.join('')).not.toContain('握り潰した報告を配らずに捨てました');

    await pool.stop();
  });
});

/**
 * **握り潰しが一覧から見えること**（#621 / #643 の続き）。
 *
 * 直す前、この在庫（`#withheldReports`）は日誌と private な帳面にしか残らず、
 * `ManagerSummary` にも `job.status` にも1文字も写らなかった。**`case 'report'`
 * は `record.job.status = event.status;` を握り潰しの分岐より前に実行するので、
 * `status` は必ず `'done'` へ潰れる**——読む側からは「手が空いた」と区別が
 * つかない。実測（2026-09-05）で `runner_list` の47本が全部 `[done]` に見えた
 * のがこの潰れ方である。
 */
/**
 * **在庫（`#withheldReports`）が積まれるまで待つ。**
 *
 * ⚠️ **台帳（`lastReport`）の更新を合図にしないこと。** `case 'report'` は
 * `#persist` → 日誌 → `#withholdBackgroundReport` の順で走るので、台帳が
 * 更新された時点では在庫はまだ積まれていない。実際にそれで踏んだ——
 * 台帳を合図にして時計を進めたら、**時計を進めた後で1本目が積まれ**、
 * `since`（最初に積んだ時刻）が進んだ時刻に化けた。
 *
 * **在庫そのものを外から読める口（`list()`）で待つ。** 待ち切れは
 * `vi.waitFor` の時間切れとして出るが、**判定は `expect` に撃たせる**
 * （呼び出し側で改めて中身を見る。`.claude/skills/mutation-testing/`）。
 */
async function waitForWithheld(pool: ManagerPool, managerId: string, withheldReports: number) {
  return vi.waitFor(async () => {
    const summary = (await pool.list()).find((entry) => entry.managerId === managerId);
    if (summary?.awaitingBackground?.withheldReports !== withheldReports) {
      throw new Error('在庫がまだ積まれていない');
    }
    return summary;
  });
}

/** 在庫が空になるまで待つ（`waitForWithheld` の対。理由は同じ doc）。 */
async function waitForNoWithheld(pool: ManagerPool, managerId: string) {
  return vi.waitFor(async () => {
    const summary = (await pool.list()).find((entry) => entry.managerId === managerId);
    if (summary?.awaitingBackground !== undefined) throw new Error('在庫がまだ残っている');
    return summary;
  });
}

describe('握り潰しは一覧（ManagerSummary / RunnerManagerEntry）から見える', () => {
  it('list() の要約に tasks / withheldReports / breakdown / since が載る', async () => {
    const { pool, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '完了を待つ', 'done', {
      awaitingBackground: { count: 3, breakdown: 'local_agent×3' },
    });
    const summary = await waitForWithheld(pool, 'mgr-withhold', 1);
    // **在り高（tasks）と握り潰した本数（withheldReports）は別の観測である。**
    // ここでは背景タスクが3つ、握り潰した報告は1本——1つに畳んでいたら、
    // どちらかの数がもう片方に化ける。
    expect(summary?.awaitingBackground).toEqual({
      tasks: 3,
      withheldReports: 1,
      breakdown: 'local_agent×3',
      // 時計は `runningManualSetup` が固定している（`now: () => clock`）。
      since: '2026-09-01T00:00:00.000Z',
    });

    // **`status` は動かさない**（`runnerLostSince` / `ManagerDenial` と同じ作法）。
    // 動かすと、この欄が在ることと status の値が二重に同じことを言い始める。
    expect(summary?.status).toBe('done');

    await pool.stop();
  });

  /**
   * **`since` は `firstAt`（最初に積んだ時刻）であって `lastAt` ではない。**
   * 読む側が知りたいのは「いつから待っているか」で、期限の判定
   * （`flushWithheldReports()`）が見る `lastAt` とは別の問いである。
   */
  it('2本目を積んでも since は最初の時刻のまま、握り潰した本数だけが増える', async () => {
    const { pool, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '1本目', 'done', { awaitingBackground: AWAITING });
    // **1本目が積まれてから時計を進める**（真上の `waitForWithheld` の doc）。
    await waitForWithheld(pool, 'mgr-withhold', 1);

    advance(5 * 60_000);
    fake.report('mgr-withhold', '2本目', 'done', { awaitingBackground: AWAITING });
    const summary = await waitForWithheld(pool, 'mgr-withhold', 2);
    // **握り潰した本数だけが増え、在り高（`AWAITING.count` = 1）は上書きである。**
    expect(summary?.awaitingBackground?.withheldReports).toBe(2);
    expect(summary?.awaitingBackground?.tasks).toBe(1);
    expect(summary?.awaitingBackground?.since).toBe('2026-09-01T00:00:00.000Z');

    await pool.stop();
  });

  /**
   * **一覧を開いても在庫は動かない。** `list()` が配る側の副作用を持つと、
   * `manager_list` を呼ぶたびに受信箱が動く（クローンの opt-in を踏み潰す形。
   * north_star 禁止2）。
   */
  it('list() を何度呼んでも在庫は配られない（受信箱も増えない）', async () => {
    const { pool, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '完了を待つ', 'done', { awaitingBackground: AWAITING });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    const before = inbox.length;
    const first = (await pool.list()).find((entry) => entry.managerId === 'mgr-withhold');
    const second = (await pool.list()).find((entry) => entry.managerId === 'mgr-withhold');
    expect(first?.awaitingBackground).toEqual(second?.awaitingBackground);
    expect(first?.awaitingBackground?.withheldReports).toBe(1);
    expect(inbox.length).toBe(before);

    await pool.stop();
  });

  /**
   * **配ったら欄ごと消える。** 残ると、もう配り終えた委譲がいつまでも
   * 「背景処理待ち」に見える——「手が空いている」を数える側がそのぶん減る。
   */
  it('積みが配られた後は欄ごと消える', async () => {
    const { pool, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    // **先に、欄が立つことを確かめる。** これが無いと下の `toBeUndefined()` は
    // 空振りで真になる（一度も立たない世界でも通ってしまう）。
    expect((await waitForWithheld(pool, 'mgr-withhold', 1)).awaitingBackground).toBeDefined();

    fake.report('mgr-withhold', '本物の報告', 'done');
    const summary = await waitForNoWithheld(pool, 'mgr-withhold');
    expect(summary?.awaitingBackground).toBeUndefined();
    expect(summary?.status).toBe('done');

    await pool.stop();
  });

  /**
   * **`runner_list` の器ごとの内訳にも運ぶ。** 運ばないと、`manager_list` が
   * 区別している2つが `runner_list` の側でだけ潰れる（`RunnerManagerEntry` の
   * doc が `live` について言っているのと同じ潰れ方）。
   */
  it('runners() の器ごとの内訳にも載る', async () => {
    const { pool, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '完了を待つ', 'done', {
      awaitingBackground: { count: 2, breakdown: 'local_agent×2' },
    });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    const overview = await pool.runners();
    const entry = overview.runners
      .flatMap((runner) => runner.managers)
      .find((manager) => manager.managerId === 'mgr-withhold');
    expect(entry?.awaitingBackground?.tasks).toBe(2);
    expect(entry?.awaitingBackground?.withheldReports).toBe(1);
    expect(entry?.awaitingBackground?.breakdown).toBe('local_agent×2');
    // 陰性対照: 握り潰しが無ければ欄は立たない。
    fake.report('mgr-withhold', '本物の報告', 'done');
    await waitForNoWithheld(pool, 'mgr-withhold');
    const after = (await pool.runners()).runners
      .flatMap((runner) => runner.managers)
      .find((manager) => manager.managerId === 'mgr-withhold');
    expect(after?.awaitingBackground).toBeUndefined();

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

/**
 * `ManagerPoolOptions.withheldReportFlushMs`（`ALTEROID_WITHHELD_REPORT_FLUSH_MS`
 * を解いた値を渡す口）が、`flushWithheldReports()` の期限判定と、配られる
 * 文言の両方に実際に効くことを固定する。
 *
 * env 自体の解決（`resolveWithheldReportFlushMs`）は
 * `withheld-report-flush-ms.test.ts` が持つ。ここで確かめるのは「解いた値が
 * `Pool` の判定まで届くか」——口を開けただけで配線し忘れる形を捕まえる。
 */
describe('ManagerPoolOptions.withheldReportFlushMs（口が実際に効くこと）', () => {
  it('既定（30分）より短い値を渡すと、既定なら配られない時点で配られる', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup('mgr-withhold', {
      withheldReportFlushMs: 5 * 60_000,
    });
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 10分——既定30分ならまだ配られないはずの時点。
    advance(10 * 60_000);
    await pool.flushWithheldReports();

    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('配っていない');

    await pool.stop();
  });

  it('配られる文言の「N分待っても届かなかった」が、渡した値に追随する', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup('mgr-withhold', {
      withheldReportFlushMs: 5 * 60_000,
    });
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(5 * 60_000 + 1);
    await pool.flushWithheldReports();

    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('5分待っても届かなかった。');
    expect(delivered.text).not.toContain('30分待っても届かなかった。');

    await pool.stop();
  });

  it('陰性対照: option も env も無いときは、これまでどおり既定30分（文言も「30分」）', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();

    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('30分待っても届かなかった。');

    await pool.stop();
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
