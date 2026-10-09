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
