import { describe, expect, it, vi } from 'vitest';

import {
  createManagerPool,
  mergeSynthesizedNoticeFragments,
  type ManagerPool,
} from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { Stores } from './store.js';

/**
 * 「一枠落ち一合図」（`fix/one-quota-drop-one-signal`）——枠落ちが起きると、
 * `manager.ts` が組み立てる3種の合成文言（`rate_limit` / `usage_notice` /
 * `closed` の `status === 'failed'`）と、runner 自身の `failedReportText`
 * 経由の `report`（`synthesized` に族の名前が入る）の計4通が、同じ1つの出来事の
 * 別の顔として短い間隔（実測で1秒未満）でまとめて届き、クローンのターンを
 * 3〜4回焼く。この歯は、その4通が合流窓の中で1件の `manager_message` へ
 * まとまることを固定する。
 *
 * `manager-withheld-reports.test.ts` の「足場1: manualRunner」と同じ作法——
 * `RunnerEvent` を直接組み立てて emit し、SDK 層を経由せずに `manager.ts` の
 * 実装（`#queueSynthesizedNotice` / `#emit` / `#flushSynthesizedNotices`）を
 * 単体で確かめる。**この歯専用に複製してある**（同ファイルの doc と同じ理由
 * ——duplicated on purpose）。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: { failure?: { code: string; via: string }; synthesized?: string },
  ): void;
  ask(managerId: string, requestId: string, summary: string, kind?: 'question' | 'permission'): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  rateLimit(managerId: string, facts: RateLimitFacts): void;
  usageNotice(managerId: string, notice: UsageLimitNotice): void;
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
    rateLimit(managerId, facts) {
      emit?.({ type: 'rate_limit', managerId, facts });
    },
    usageNotice(managerId, notice) {
      emit?.({ type: 'usage_notice', managerId, notice });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId = 'mgr-quota',
  options: { synthesizedNoticeWindowMs?: number } = {},
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
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    synthesizedNoticeWindowMs: options.synthesizedNoticeWindowMs,
  });

  await pool.restore();
  // **`restore()` の知らせ（`#notifyRestored`）を fire-and-forget で待つ**
  // （`manager-withheld-reports.test.ts` の `runningManualSetup` と同じ理由）。
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

function reportsOf(inbox: InboxEvent[]) {
  return inbox.filter(
    (event) => event.type === 'manager_message' && event.kind === 'report',
  ) as { text: string }[];
}

describe('4通の機構合成の知らせが、合流窓の中で1件にまとまる', () => {
  it('rate_limit / usage_notice / report(synthesized) / closed(failed) の4通が1件になり、全文がすべて入っている', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.usageNotice('mgr-quota', {
      kind: 'reached',
      text: "You've hit your individual spend limit for this account.",
    });
    fake.report('mgr-quota', '（このターンは応答を返さずに終わった: 失敗した）失敗する前の本文', 'done', {
      failure: { code: 'billing_error', via: 'result_is_error' },
      synthesized: 'turn_failed',
    });
    fake.closed('mgr-quota', 'failed', 'マネージャーのセッションが落ちた: Error: 何か');

    // **`#onEvent` は fire-and-forget（`void`）で走るので、4通が実際に積みへ
    // 反映されるまで少し待つ**（`manager-withheld-reports.test.ts` の
    // `runningManualSetup` と同じ理由）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // **窓の中でデーモンが落ちても失われないことは別の歯（stop()）が撃つ。**
    // ここでは通常の終わり方——`stop()` で flush する（既定3000msを待たない）。
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    // **受信箱イベントは1件だけ立つ。**
    expect(reports).toHaveLength(1);
    const text = reports[0]?.text ?? '';
    // **4つの本文がすべて入っている（要約も間引きもしない）。**
    expect(text).toContain('枠から追い返された');
    expect(text).toContain("You've hit your individual spend limit for this account.");
    expect(text).toContain('失敗する前の本文');
    expect(text).toContain('マネージャーのセッションが落ちた: Error: 何か');
    // **複数件をまとめたことが分かる前置きが付く。**
    expect(text).toContain('4 件');
  });

  it('日誌に、畳んだ件数と内訳が残る', async () => {
    const { pool, stores, fake } = await runningManualSetup();

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.usageNotice('mgr-quota', { kind: 'reached', text: '上限に当たった' });
    fake.closed('mgr-quota', 'failed', '落ちた');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const merged = entries.find((entry) =>
      JSON.stringify(entry).includes('1件にまとめて配った'),
    );
    expect(merged).toBeDefined();
    const joined = JSON.stringify(merged);
    expect(joined).toContain('mgr-quota');
    // 3件（rate_limit / usage_notice / closed_failed）まとめた内訳。
    expect(joined).toContain('3 件');
    expect(joined).toContain('枠の遷移');
    expect(joined).toContain('利用上限の通知');
    expect(joined).toContain('セッションが落ちた');

    // **既存の個別の exchange 行は消えていない**（rate_limit 自身の journal）。
    const rateLimitLine = entries.find((entry) => JSON.stringify(entry).includes('枠から追い返された'));
    expect(rateLimitLine).toBeDefined();
  });
});

/**
 * `#queueSynthesizedNotice` の同族判定（1つの出来事は各族を高々1回しか
 * 持たない、という前提の裏返し）。`usage-notice-redelivery.test.ts` が
 * 実際に踏んだ形——**内容の違う2件の `usage_notice` が短い間隔で届く**
 * ケースを、この歯専用の manualRunner でも単体で固定する。
 */
describe('同じ族が窓の中で2度目に来たら、前の積みを先に flush する', () => {
  it('rate_limit が同じ窓で2度（違う内容）届くと、1本目は単独で配られ、2本目は新しい窓に積まれる', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    // 1本目: 追い返された。2本目（同じ label='rate_limit'）: 課金枠へ入った。
    // 内容が違うので `#rateLimits` の遷移判定はどちらも通す——同族の2度目
    // として扱われ、1本目が単独で flush される。
    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.rateLimit('mgr-quota', { usingOverage: true, kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    // **2本とも別々の manager_message として届く**（1件に潰れない）。
    expect(reports).toHaveLength(2);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[0]?.text).not.toContain('まとめた');
    expect(reports[1]?.text).toContain('課金枠から引き始めた');
    expect(reports[1]?.text).not.toContain('まとめた');
  });
});

describe('本人が書いた報告は畳まれない', () => {
  it('event.synthesized が無い（本人が書いた）report は即配られる', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report('mgr-quota', '本人が書いた報告', 'done');

    const delivered = await vi.waitFor(() => {
      const found = reportsOf(inbox).slice(before)[0];
      if (found === undefined) throw new Error('まだ届いていない');
      return found;
    });
    expect(delivered.text).toBe('本人が書いた報告');
    // **前置きが付かない（1件だから、まとめてすらいない）。**
    expect(delivered.text).not.toContain('まとめた');

    await pool.stop();
  });

  it('旧 runner の形（synthesized 欄が無い failure 付き report）でも畳まれない——安全側', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    // 欄が無ければ「本人が書いた」として扱う。旧 runner はこの形で送ってくる。
    fake.report('mgr-quota', '失敗したが欄の無い旧 runner の報告', 'done', {
      failure: { code: 'billing_error', via: 'result_is_error' },
    });

    const delivered = await vi.waitFor(() => {
      const found = reportsOf(inbox).slice(before)[0];
      if (found === undefined) throw new Error('まだ届いていない');
      return found;
    });
    expect(delivered.text).toBe('失敗したが欄の無い旧 runner の報告');

    await pool.stop();
  });
});

describe('畳めない出来事が挟まると、先に積みが flush されて到着順が保たれる', () => {
  it('積みの後に届いた question は、積みの後（＝到着順どおり）に受信箱へ入る', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.ask('mgr-quota', 'req-1', 'これでよいか確認したい', 'question');

    const posted = await vi.waitFor(() => {
      const found = inbox.slice(before);
      if (found.length < 2) throw new Error('まだ2件届いていない');
      return found;
    });
    // **並べ替えない。** 積み（rate_limit）が先、question があと。
    const kinds = posted
      .filter((event) => event.type === 'manager_message')
      .map((event) => (event as { kind: string }).kind);
    expect(kinds).toEqual(['report', 'question']);
    const reportText = (posted.find((e) => (e as { kind?: string }).kind === 'report') as {
      text: string;
    }).text;
    expect(reportText).toContain('枠から追い返された');

    await pool.stop();
  });

  it('別の managerId の question でも、全 managerId の積みが先に flush される', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-quota');
    // 2本目のマネージャーを同じ pool・同じ runner の名簿に足す
    // （`#onEvent` は台帳（`#load`）から像を作るので、台帳にも置く）。
    const job2: Job = {
      id: 'mgr-other',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '別件',
      request: '別件を調べて',
      cwd: '/work/project',
      sessionId: 'sess-mgr-other',
      runnerId: 'runner-primary',
    };
    await stores.jobs.putJob(job2);
    // 同じ manualRunner を使い回す（同じ emit 口を共有する）。
    fake.alive.push({
      managerId: job2.id,
      status: 'running',
      cwd: '/work/project',
      request: '別件を調べて',
      waiting: [],
      sessionId: job2.sessionId,
    });

    const before = inbox.length;
    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // mgr-other には積みが無いが、mgr-quota の積みは mgr-other の question より
    // 先に flush されるべき（到着順）。
    fake.ask('mgr-other', 'req-2', '別件の確認', 'question');

    const posted = await vi.waitFor(() => {
      const found = inbox.slice(before);
      if (found.length < 2) throw new Error('まだ2件届いていない');
      return found;
    });
    expect(posted[0]).toMatchObject({ managerId: 'mgr-quota', kind: 'report' });
    expect(posted[1]).toMatchObject({ managerId: 'mgr-other', kind: 'question' });

    await pool.stop();
  });
});

describe('窓の中で stop() を呼ぶと1件も失われない', () => {
  it('積んだ直後に stop() しても、積んだ知らせがすべて post される', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      // 既定3000msでも stop() は待たずに flush できることを、既定のまま確かめる。
    });
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.usageNotice('mgr-quota', { kind: 'reached', text: '上限に当たった' });
    // **`#onEvent` の非同期処理が積みへ反映されるのだけを待つ**（20ms。窓の
    // 既定3000msにはまだ遠く届かない——「窓の中で」を保ったまま stop() する）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // **窓（既定3000ms）がまだ閉じていないうちに stop() を呼ぶ。**
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[0]?.text).toContain('上限に当たった');
  });
});

describe('1件だけのときは、まとめた前置きが1文字も載らない', () => {
  it('rate_limit が1件だけなら前置きが付かない', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).not.toContain('まとめた');
    expect(reports[0]?.text).not.toContain('件');
  });

  it('mergeSynthesizedNoticeFragments（純関数）: 1件なら本文そのまま', () => {
    const result = mergeSynthesizedNoticeFragments([{ label: 'rate_limit', text: '本文だけ' }]);
    expect(result.text).toBe('本文だけ');
    expect(result.text).not.toContain('まとめた');
  });

  it('mergeSynthesizedNoticeFragments（純関数）: 複数件なら前置きと区切りが付き、順序を保つ', () => {
    const result = mergeSynthesizedNoticeFragments([
      { label: 'report_failed', text: '1つ目' },
      { label: 'rate_limit', text: '2つ目' },
      { label: 'usage_notice', text: '3つ目' },
    ]);
    expect(result.text).toContain('3 件');
    const indexOf1 = result.text.indexOf('1つ目');
    const indexOf2 = result.text.indexOf('2つ目');
    const indexOf3 = result.text.indexOf('3つ目');
    expect(indexOf1).toBeGreaterThan(-1);
    expect(indexOf2).toBeGreaterThan(indexOf1);
    expect(indexOf3).toBeGreaterThan(indexOf2);
  });
});
