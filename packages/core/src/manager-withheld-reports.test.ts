import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createManagerPool,
  describeBackgroundWaitElapsed,
  withheldReportOverdue,
  type ManagerPool,
} from './manager.js';
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

// ---------------------------------------------------------------------------
// 足場1: manualRunner（manager.ts 単体の検証）
// ---------------------------------------------------------------------------

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: {
      failure?: { code: string; via: string };
      contentless?: true;
      awaitingBackground?: { count: number; breakdown: string };
      outwardActions?: string[];
      reportId?: string;
    },
  ): void;
  ask(
    managerId: string,
    requestId: string,
    summary: string,
    kind?: 'question' | 'permission',
  ): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
}

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
    // `alive` から外さない: `abort()` は `list()` に居ないことを確かめてから `stopped` を確定させるため。
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

async function runningManualSetup(
  managerId = 'mgr-withhold',
  options: { withheldReportFlushMs?: number; tokenSavingExcerpt?: boolean } = {},
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
    ...(options.tokenSavingExcerpt === undefined
      ? {}
      : { tokenSavingExcerpt: options.tokenSavingExcerpt }),
  });

  await pool.restore();
  // 待つ: `restore()` の知らせは fire-and-forget で、待たないと `before = inbox.length` の後に紛れ込む。
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
const WITHHELD_REPORT_FLUSH_MS = 30 * 60_000;

describe('manager が握り潰したとき（case "report" の awaitingBackground）', () => {
  it('受信箱（inbox）は増えない', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', '完了を待つ', 'done', { awaitingBackground: AWAITING });

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
    // 定型の行: 要約の一覧から外す印が付く
    expect(found).toMatchObject({ routine: true });
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

    // `.find` にしない: `restore()` 由来の kind: 'report' の知らせが先頭に居り、新着を待たずに当たる。
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

    // 本文に「配っていない」が含まれるまで待つ: `.at(-1)` だけだと `restore()` 由来の古い1件で誤って通る。
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

    fake.closed('mgr-withhold', 'done', 'runner 側は後から終わったと言ってきた');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(inbox.length).toBe(before);
    const entries = await stores.journal.list({ types: ['exchange'] });
    expect(entries.length).toBeGreaterThan(0);

    await pool.stop();
  });
});

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
      expect(result.detail).not.toContain('握り潰される回・秘密の本文');
    });

    expect(inbox.length).toBe(before);

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

// 台帳（`lastReport`）の更新を合図にしない: 在庫はその後で積まれ、先に時計を進めると `since` が進んだ時刻になる。
async function waitForWithheld(pool: ManagerPool, managerId: string, withheldReports: number) {
  return vi.waitFor(async () => {
    const summary = (await pool.list()).find((entry) => entry.managerId === managerId);
    if (summary?.awaitingBackground?.withheldReports !== withheldReports) {
      throw new Error('在庫がまだ積まれていない');
    }
    return summary;
  });
}

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
    expect(summary?.awaitingBackground).toEqual({
      tasks: 3,
      withheldReports: 1,
      breakdown: 'local_agent×3',
      since: '2026-09-01T00:00:00.000Z',
    });

    // status は動かさない: 動かすと、この欄が在ることと status の値が二重に同じことを言い始める。
    expect(summary?.status).toBe('done');

    await pool.stop();
  });

  it('2本目を積んでも since は最初の時刻のまま、握り潰した本数だけが増える', async () => {
    const { pool, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '1本目', 'done', { awaitingBackground: AWAITING });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    advance(5 * 60_000);
    fake.report('mgr-withhold', '2本目', 'done', { awaitingBackground: AWAITING });
    const summary = await waitForWithheld(pool, 'mgr-withhold', 2);
    expect(summary?.awaitingBackground?.withheldReports).toBe(2);
    expect(summary?.awaitingBackground?.tasks).toBe(1);
    expect(summary?.awaitingBackground?.since).toBe('2026-09-01T00:00:00.000Z');

    await pool.stop();
  });

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

  it('積みが配られた後は欄ごと消える', async () => {
    const { pool, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    // 先に欄が立つことを確かめる: 無いと下の `toBeUndefined()` は一度も立たない世界でも通る。
    expect((await waitForWithheld(pool, 'mgr-withhold', 1)).awaitingBackground).toBeDefined();

    fake.report('mgr-withhold', '本物の報告', 'done');
    const summary = await waitForNoWithheld(pool, 'mgr-withhold');
    expect(summary?.awaitingBackground).toBeUndefined();
    expect(summary?.status).toBe('done');

    await pool.stop();
  });

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
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.flushWithheldReports();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

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

    advance(10 * 60_000);
    await pool.flushWithheldReports();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(inbox.length).toBe(before);
    await pool.stop();
  });

  describe('withheldReportOverdue（lastAt が壊れている場合の判定）', () => {
    it('壊れた lastAt は期限切れとして扱う（配る側へ倒す）', () => {
      expect(
        withheldReportOverdue('これは日時ではない', Date.now(), WITHHELD_REPORT_FLUSH_MS),
      ).toBe(true);
      expect(withheldReportOverdue('', Date.now(), WITHHELD_REPORT_FLUSH_MS)).toBe(true);
    });

    it('読める lastAt は、これまでどおり経過時間で判定する（回帰）', () => {
      const now = Date.parse('2026-09-01T01:00:00.000Z');
      expect(withheldReportOverdue('2026-09-01T00:30:00.001Z', now, WITHHELD_REPORT_FLUSH_MS)).toBe(
        false,
      );
      expect(withheldReportOverdue('2026-09-01T00:30:00.000Z', now, WITHHELD_REPORT_FLUSH_MS)).toBe(
        true,
      );
    });
  });
});

describe('ManagerPoolOptions.withheldReportFlushMs（口が実際に効くこと）', () => {
  it('既定（30分）より短い値を渡すと、既定なら配られない時点で配られる', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup('mgr-withhold', {
      withheldReportFlushMs: 5 * 60_000,
    });
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

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

describe('flushWithheldReports はエピソードにつき1本だけ配る（Issue #1104）', () => {
  it('1回目は立つが、2回目以降は同じ在庫に対して合図を立て直さない', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();
    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('30分待っても届かなかった');
    const afterFirstFlush = inbox.length;

    // もう1本畳んで `count` を 0 から 1 へ戻す: `count === 0` の早期 continue と区別し、`flushedAt` の効果だけを見る。
    advance(60_000);
    fake.report('mgr-withhold', 'フラッシュ後も握り潰される回', 'done', {
      awaitingBackground: AWAITING,
    });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    advance(4 * 60 * 60_000);
    await pool.flushWithheldReports();
    await pool.flushWithheldReports();
    await pool.flushWithheldReports();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(afterFirstFlush);

    await pool.stop();
  });

  it('フラッシュを跨いでも since は最初に積んだ時刻のまま動かない', async () => {
    const { pool, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    const before = await waitForWithheld(pool, 'mgr-withhold', 1);
    expect(before?.awaitingBackground?.since).toBe('2026-09-01T00:00:00.000Z');

    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();
    const after = await waitForWithheld(pool, 'mgr-withhold', 0);
    expect(after?.awaitingBackground?.since).toBe('2026-09-01T00:00:00.000Z');
    expect(after?.status).toBe('done');

    await pool.stop();
  });

  it('本物の報告が配られたらエピソードが終わる（在庫が消え、次に積むと since が新しくなり、合図がまた立つ）', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '1エピソード目（握り潰し）', 'done', {
      awaitingBackground: AWAITING,
    });
    const summary1 = await waitForWithheld(pool, 'mgr-withhold', 1);
    const firstEpisodeSince = summary1?.awaitingBackground?.since;
    expect(firstEpisodeSince).toBe('2026-09-01T00:00:00.000Z');

    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();
    await waitForWithheld(pool, 'mgr-withhold', 0);

    fake.report('mgr-withhold', '本物の報告', 'done');
    await waitForNoWithheld(pool, 'mgr-withhold');

    advance(60_000);
    fake.report('mgr-withhold', '2エピソード目（握り潰し）', 'done', {
      awaitingBackground: AWAITING,
    });
    const summary2 = await waitForWithheld(pool, 'mgr-withhold', 1);
    expect(summary2?.awaitingBackground?.since).toBe('2026-09-01T00:31:00.001Z');
    expect(summary2?.awaitingBackground?.since).not.toBe(firstEpisodeSince);

    const beforeSecondFlush = inbox.length;
    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();
    const delivered2 = await vi.waitFor(() => {
      const found = inbox
        .slice(beforeSecondFlush)
        .find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered2.text).toContain('30分待っても届かなかった');

    await pool.stop();
  });

  it('フラッシュ後に積んだ報告が失われない（次の本物の報告に件数として乗る）', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '1本目（握り潰し）', 'done', { awaitingBackground: AWAITING });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();
    await waitForWithheld(pool, 'mgr-withhold', 0);

    fake.report('mgr-withhold', '2本目（握り潰し、フラッシュ後）', 'done', {
      awaitingBackground: AWAITING,
    });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    const before = inbox.length;
    fake.report('mgr-withhold', '本物の報告', 'done');
    const delivered = await vi.waitFor(() => {
      const found = inbox
        .slice(before)
        .find((event) => event.type === 'manager_message' && event.kind === 'report');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('背景処理の完了待ちで畳んだターンの報告を 1 本配っていない');

    await pool.stop();
  });

  it('陰性対照: フラッシュ直後（count === 0）に本物の報告が来ても「配っていない」は出ない', async () => {
    const { pool, inbox, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '握り潰される回', 'done', { awaitingBackground: AWAITING });
    await waitForWithheld(pool, 'mgr-withhold', 1);

    advance(30 * 60_000 + 1);
    await pool.flushWithheldReports();
    await waitForWithheld(pool, 'mgr-withhold', 0);

    const before = inbox.length;
    fake.report('mgr-withhold', '本物の報告', 'done');
    const delivered = await vi.waitFor(() => {
      const found = inbox
        .slice(before)
        .find((event) => event.type === 'manager_message' && event.kind === 'report');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toBe('本物の報告');
    expect(delivered.text).not.toContain('配っていない');

    await waitForNoWithheld(pool, 'mgr-withhold');

    await pool.stop();
  });
});

describe('describeBackgroundWaitElapsed（firstAt からの経過を文にする純関数）', () => {
  it('1時間以上は「N時間M分」で経過を言う', () => {
    const now = Date.parse('2026-09-01T02:15:30.000Z');
    expect(describeBackgroundWaitElapsed('2026-09-01T00:00:00.000Z', now)).toBe(
      'この委譲は2時間15分、背景処理待ちのまま（最初 2026-09-01T00:00:00.000Z）。',
    );
  });

  it('1時間未満は「N分」だけ（冗長な「0時間」を出さない）', () => {
    const now = Date.parse('2026-09-01T00:15:00.000Z');
    expect(describeBackgroundWaitElapsed('2026-09-01T00:00:00.000Z', now)).toBe(
      'この委譲は15分、背景処理待ちのまま（最初 2026-09-01T00:00:00.000Z）。',
    );
  });

  it('firstAt が読めないときは、経過を捏造せず読めないと書く', () => {
    const result = describeBackgroundWaitElapsed('これは日時ではない', Date.now());
    expect(result).toContain('経過時間は不明');
    expect(result).toContain('これは日時ではない');
    expect(result).not.toMatch(/\d+時間|\d+分/);
  });

  it('firstAt が未来（経過が負）のときも、経過を捏造せず読めないと書く', () => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    const result = describeBackgroundWaitElapsed('2026-09-01T00:00:01.000Z', now);
    expect(result).toContain('経過時間は不明');
    expect(result).not.toMatch(/\d+時間|\d+分/);
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

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.say('変異Bの pnpm test の完了を待って作業者を再開させる。');
    await session.finish('変異Bの pnpm test の完了を待って作業者を再開させる。');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(0);

    // 空を明示的に知らせる: REPLACE 意味論で、送らないと在り高が前のターンのまま残り2ターン目も握り潰される。
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
    expect(delivered.text).toContain('本物の報告。');
    expect(delivered.text).toContain('背景処理の完了待ちで畳んだターンの報告を 1 本配っていない');
    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(1);
  });
});

describe('畳んだ報告の冒頭は、配る知らせから消えない（最後の1本だけにしない）', () => {
  async function lastReportText(inbox: InboxEvent[], needle: string): Promise<string> {
    return vi.waitFor(() => {
      const found = inbox
        .filter((event) => event.type === 'manager_message' && event.kind === 'report')
        .map((event) => (event as { text: string }).text)
        .at(-1);
      if (found === undefined || !found.includes(needle)) throw new Error('まだ届いていない');
      return found;
    });
  }

  // 実時間で待たない（#2146）: 畳んだ回ごとに日誌へ1本書かれる decision の本数で、畳み終えたことを見る
  async function withheldDecisions(stores: Stores, expected: number): Promise<void> {
    await vi.waitFor(async () => {
      const entries = await stores.journal.list({ types: ['decision'] });
      const count = entries.filter((entry) =>
        JSON.stringify(entry).includes(
          '背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない',
        ),
      ).length;
      if (count < expected) throw new Error(`畳んだ報告がまだ ${String(count)} 本`);
    });
  }

  it('同じエピソードで2本畳んだ後の本物の報告に、1本目の冒頭も載る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '#1006 をマージした（6db19adf）', 'done', {
      awaitingBackground: AWAITING,
    });
    fake.report('mgr-withhold', '背景の CI を待っている', 'done', { awaitingBackground: AWAITING });
    await withheldDecisions(stores, 2);

    fake.report('mgr-withhold', '本物の報告', 'done');
    const text = await lastReportText(inbox, '本物の報告');
    expect(text).toContain('#1006 をマージした（6db19adf）');
    expect(text).toContain('背景の CI を待っている');
    expect(text).toContain('2 本配っていない');

    await pool.stop();
  });

  it('flush の知らせに、畳んだ報告の冒頭が載る。flush 後に積んだ分は次の本物の報告に載る', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();

    fake.report('mgr-withhold', '#1006 をマージした（6db19adf）', 'done', {
      awaitingBackground: AWAITING,
    });
    await withheldDecisions(stores, 1);

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();
    const flushed = await lastReportText(inbox, '待っても届かなかった');
    expect(flushed).toContain('#1006 をマージした（6db19adf）');

    fake.report('mgr-withhold', 'flush 後に畳んだ報告', 'done', { awaitingBackground: AWAITING });
    await withheldDecisions(stores, 2);
    fake.report('mgr-withhold', '次の本物', 'done');
    const next = await lastReportText(inbox, '次の本物');
    expect(next).toContain('flush 後に畳んだ報告');
    expect(next).not.toContain('#1006 をマージした');

    await pool.stop();
  });

  it('closed のまとめ配りにも、畳んだ報告の冒頭が載る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '#1006 をマージした（6db19adf）', 'done', {
      awaitingBackground: AWAITING,
    });
    await withheldDecisions(stores, 1);
    fake.closed('mgr-withhold', 'done', '終わった');
    const text = await lastReportText(inbox, 'この委譲は終わった');
    expect(text).toContain('#1006 をマージした（6db19adf）');

    await pool.stop();
  });

  it('字数の予算を超えたら、古い側が溢れ、溢れた本数と journal_read の案内が書かれる', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    for (let n = 1; n <= 12; n += 1) {
      fake.report('mgr-withhold', `報告${String(n).padStart(2, '0')} ${'あ'.repeat(300)}`, 'done', {
        awaitingBackground: AWAITING,
      });
    }
    await withheldDecisions(stores, 12);

    fake.report('mgr-withhold', '本物の報告', 'done');
    const text = await lastReportText(inbox, '本物の報告');
    expect(text).toContain('12 本配っていない');
    expect(text).toMatch(/古い \d+ 本の冒頭は字数の予算で省いた。全文は日誌に在る/);
    expect(text).toContain('報告12 ');
    expect(text).not.toContain('報告01 ');

    await pool.stop();
  });

  // トークン節約: 注記は直後の本報告と重なることが多いので、抜粋は新しい側の2本までに絞る
  it('240字超の報告を6本畳んでも、抜粋は新しい側の2本だけで、注記は900字を超えない。古い4本は1行に回る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    for (let n = 1; n <= 6; n += 1) {
      fake.report('mgr-withhold', `報告${String(n).padStart(2, '0')} ${'あ'.repeat(300)}`, 'done', {
        awaitingBackground: AWAITING,
      });
    }
    await withheldDecisions(stores, 6);

    fake.report('mgr-withhold', '本物の報告', 'done');
    const text = await lastReportText(inbox, '本物の報告');
    const note = text.slice(text.indexOf('（この間に'));
    expect(note.length).toBeLessThan(900);
    expect(note.split('\n').filter((line) => line.startsWith('- 20'))).toHaveLength(2);
    expect(note).toContain('報告06 ');
    expect(note).toContain('報告05 ');
    expect(note).not.toContain('報告04 ');
    expect(note).toContain('古い 4 本の冒頭は字数の予算で省いた');
    expect(note).toContain('6 本配っていない');

    // 落とした分の全文は日誌に在る（注記から引ける）
    const exchanged = await stores.journal.list({ types: ['exchange'] });
    expect(
      exchanged.some((entry) => JSON.stringify(entry).includes(`報告01 ${'あ'.repeat(300)}`)),
    ).toBe(true);

    await pool.stop();
  });

  // ALTEROID_TOKEN_SAVING_EXCERPT=0: 注記の字数の予算を節約の前（1,500字）へ戻す。同じ6本で、抜粋が2本を超えて載る
  it('⭐ 抜粋の系統を切ると、同じ240字超の6本でも注記の予算は 1,500 字になり、抜粋が2本を超えて載る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-withhold', {
      tokenSavingExcerpt: false,
    });

    for (let n = 1; n <= 6; n += 1) {
      fake.report('mgr-withhold', `報告${String(n).padStart(2, '0')} ${'あ'.repeat(300)}`, 'done', {
        awaitingBackground: AWAITING,
      });
    }
    await withheldDecisions(stores, 6);

    fake.report('mgr-withhold', '本物の報告', 'done');
    const text = await lastReportText(inbox, '本物の報告');
    const note = text.slice(text.indexOf('（この間に'));
    const excerptLines = note.split('\n').filter((line) => line.startsWith('- 20'));
    expect(excerptLines.length).toBeGreaterThan(2);
    expect(note).toContain('報告06 ');
    expect(note).toContain('報告05 ');
    expect(note).toContain('報告04 ');
    expect(note.length).toBeGreaterThan(900);
    expect(note).toContain('6 本配っていない');

    await pool.stop();
  });

  it('注記に、日誌を managerId と最初・最後の時刻で引く案内が載る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    fake.report('mgr-withhold', '畳んだ1本目', 'done', { awaitingBackground: AWAITING });
    await withheldDecisions(stores, 1);
    fake.report('mgr-withhold', '本物の報告', 'done');
    const text = await lastReportText(inbox, '本物の報告');
    expect(text).toContain('`journal_read q=mgr-withhold` since=最初の少し前 until=最後の少し後');

    await pool.stop();
  });
});

describe('外へ出した成果を含む報告は、背景処理の完了待ちでも畳まずに配る', () => {
  it('outwardActions が在れば受信箱へ回し、それまで畳んでいた報告の冒頭も添える。日誌に判断が残る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', 'CI を待っている', 'done', { awaitingBackground: AWAITING });
    await journalHasText(stores, '受信箱へは回さない');
    expect(inbox).toHaveLength(before);

    fake.report('mgr-withhold', '#1006 をマージした（6db19adf）', 'done', {
      awaitingBackground: AWAITING,
      outwardActions: ['gh pr merge'],
    });
    await vi.waitFor(() => {
      if (inbox.length === before) throw new Error('まだ配られていない');
    });
    const text = (inbox.at(-1) as { text: string }).text;
    expect(text).toContain('#1006 をマージした（6db19adf）');
    expect(text).toContain('CI を待っている');
    await journalHasText(stores, '外へ出した成果を含むので受信箱へ回す');
    await journalHasText(stores, 'outwardActions=gh pr merge');

    await pool.stop();
  });

  it('outwardActions が無ければ、これまでどおり畳む', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.report('mgr-withhold', 'CI を待っている', 'done', { awaitingBackground: AWAITING });
    await journalHasText(stores, '受信箱へは回さない');
    expect(inbox).toHaveLength(before);

    await pool.stop();
  });
});

describe('畳んだ報告の在庫は台帳にも写り、デーモンの再起動を越えて配られる（#4626）', () => {
  // 同じ台帳と同じ runner の上で、デーモンを作り直す（夜の反映の再起動に当たる）
  async function restartOn(
    setup: ManualSetup,
  ): Promise<{ pool: ManagerPool; inbox: InboxEvent[] }> {
    await setup.pool.stop();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores: setup.stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([setup.fake.runner]),
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    });
    await pool.restore();
    return { pool, inbox };
  }

  async function reportTextIn(inbox: InboxEvent[], needle: string): Promise<string> {
    return vi.waitFor(() => {
      const found = inbox
        .filter((event) => event.type === 'manager_message' && event.kind === 'report')
        .map((event) => (event as { text: string }).text)
        .find((text) => text.includes(needle));
      if (found === undefined) throw new Error('まだ届いていない');
      return found;
    });
  }

  it('再起動の前に畳んだ報告の冒頭が、再起動の後の最初の報告に載る。配った後は台帳の写しが下りる', async () => {
    const setup = await runningManualSetup();
    setup.fake.report('mgr-withhold', '#1006 をマージした（6db19adf）', 'done', {
      awaitingBackground: AWAITING,
    });
    await vi.waitFor(async () => {
      const copy = (await jobOf(setup.stores, 'mgr-withhold'))?.withheldReports;
      if (copy?.count !== 1) throw new Error('台帳にまだ写っていない');
    });

    const restarted = await restartOn(setup);
    setup.fake.report('mgr-withhold', '再起動の後の報告', 'done');
    const text = await reportTextIn(restarted.inbox, '再起動の後の報告');
    expect(text).toContain('1 本配っていない');
    expect(text).toContain('#1006 をマージした（6db19adf）');
    await vi.waitFor(async () => {
      const copy = (await jobOf(setup.stores, 'mgr-withhold'))?.withheldReports;
      if (copy !== undefined) throw new Error('台帳の写しがまだ下りていない');
    });

    await restarted.pool.stop();
  });

  it('台帳の写しは予算の内に詰め、詰めて落とした本数も「古い N 本」として出す', async () => {
    const setup = await runningManualSetup();
    for (let n = 1; n <= 12; n += 1) {
      setup.fake.report(
        'mgr-withhold',
        `報告${String(n).padStart(2, '0')} ${'あ'.repeat(300)}`,
        'done',
        { awaitingBackground: AWAITING },
      );
    }
    const kept = await vi.waitFor(async () => {
      const copy = (await jobOf(setup.stores, 'mgr-withhold'))?.withheldReports;
      if (copy?.count !== 12) throw new Error('12本目がまだ写っていない');
      return copy.excerpts.length;
    });
    expect(kept).toBeLessThan(12);

    const restarted = await restartOn(setup);
    setup.fake.report('mgr-withhold', '再起動の後の報告', 'done');
    const text = await reportTextIn(restarted.inbox, '再起動の後の報告');
    expect(text).toContain('12 本配っていない');
    expect(text).toContain(`古い ${String(12 - kept)} 本の冒頭は字数の予算で省いた`);
    expect(text).toContain('報告12 ');
    expect(text).not.toContain('報告01 ');

    await restarted.pool.stop();
  });
});

describe('畳むまでの await の間に abort() が終わっても、止めた委譲の在庫を積み直さない（#5504）', () => {
  const FOLD_DECISION = '背景処理の完了待ちで畳んだターンの報告なので';

  // 畳みの decision の日誌だけ、開けるまで止める（`#fetchReportFiles` と並ぶ「畳む前の await」の代表）
  // `reached`: 書き込みが門に着いた（＝畳みの await の中に居る）。`written`: 門を開けて書き終えた。
  function gateFoldDecision(stores: Stores): {
    open: () => void;
    reached: Promise<void>;
    written: Promise<void>;
  } {
    let open!: () => void;
    let markReached!: () => void;
    let markWritten!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    const original = stores.journal.append.bind(stores.journal);
    stores.journal.append = async (entry) => {
      if (!JSON.stringify(entry).includes(FOLD_DECISION)) return original(entry);
      markReached();
      await gate;
      const appended = await original(entry);
      markWritten();
      return appended;
    };
    return { open, reached, written };
  }

  // 0ms の1周: 書き終えた後の畳みの続きは microtask だけなので、macrotask を1つ挟めば走り切っている。
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('畳む間に abort した委譲の報告は、期限の後に flushWithheldReports しても受信箱へ出ない', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    const { open, reached, written } = gateFoldDecision(stores);

    fake.report('mgr-withhold', '背景処理を待つ回', 'done', { awaitingBackground: AWAITING });
    await reached;

    const result = await pool.abort('mgr-withhold', '人間が止めた');
    expect(result.outcome).toBe('stopped');

    open();
    await written;
    await settle();

    const before = inbox.length;
    advance(WITHHELD_REPORT_FLUSH_MS + 60_000);
    await pool.flushWithheldReports();
    await settle();
    expect(inbox.slice(before).map((event) => (event as { text?: string }).text)).toEqual([]);

    await pool.stop();
  });

  it('対照: abort していない委譲の畳んだ報告は、同じ待ち方でも期限の後にまとめて配られる', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    const { open, reached, written } = gateFoldDecision(stores);

    fake.report('mgr-withhold', '背景処理を待つ回', 'done', { awaitingBackground: AWAITING });
    await reached;

    open();
    await written;
    await settle();

    const before = inbox.length;
    advance(WITHHELD_REPORT_FLUSH_MS + 60_000);
    await pool.flushWithheldReports();
    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('配っていない');

    await pool.stop();
  });
});
