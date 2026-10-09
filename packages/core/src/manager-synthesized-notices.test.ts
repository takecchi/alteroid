import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, mergeSynthesizedNoticeFragments, type ManagerPool } from './manager.js';
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

// 通数を歯に焼き込まない: 同じ枠落ちでも届く種類は回によって違い（4通の回と3通の回）、数を固定すると欠陥でない回で赤くなる。固定するのは「届いた種類が1つも失われないこと」。

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: { failure?: { code: string; via: string }; synthesized?: string },
  ): void;
  ask(
    managerId: string,
    requestId: string,
    summary: string,
    kind?: 'question' | 'permission',
  ): void;
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
  options: {
    synthesizedNoticeWindowMs?: number;
    alsoRunning?: readonly string[];
    now?: () => number;
  } = {},
): Promise<ManualSetup> {
  const stores = createMemoryStores();
  const fake = manualRunner();
  for (const id of [managerId, ...(options.alsoRunning ?? [])]) {
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
      managerId: job.id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: job.sessionId,
    });
  }

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    synthesizedNoticeWindowMs: options.synthesizedNoticeWindowMs,
    now: options.now,
  });

  await pool.restore();
  // 走らせた本数ぶん待つ: 1本ぶんで先へ進むと、遅れた reattach の知らせが後続の `slice(before)` に混ざり別の理由で赤くなる。
  const started = 1 + (options.alsoRunning?.length ?? 0);
  await vi.waitFor(() => {
    if (inbox.length < started) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

function reportsOf(inbox: InboxEvent[]) {
  return inbox.filter((event) => event.type === 'manager_message' && event.kind === 'report') as {
    text: string;
  }[];
}

// 固定の待ち時間で待たない: 取りこぼしが「畳まれた」と同じ観測（受信箱が空）になり、赤の意味が分からなくなる。
async function settledReport(stores: Stores, needle: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
      throw new Error(`report の日誌の行がまだ書かれていない: ${needle}`);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mergedJournalCount(stores: Stores): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.filter((entry) => JSON.stringify(entry).includes('1件にまとめて配った')).length;
}

describe('機構合成の知らせが、合流窓の中で1件にまとまる', () => {
  it('rate_limit / usage_notice / report(synthesized) / closed(failed) が1件になり、全文がすべて入っている', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.usageNotice('mgr-quota', {
      kind: 'reached',
      text: "You've hit your individual spend limit for this account.",
    });
    fake.report(
      'mgr-quota',
      '（このターンは応答を返さずに終わった: 失敗した）失敗する前の本文',
      'done',
      {
        failure: { code: 'billing_error', via: 'result_is_error' },
        synthesized: 'turn_failed',
      },
    );
    fake.closed('mgr-quota', 'failed', 'マネージャーのセッションが落ちた: Error: 何か');

    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(1);
    const text = reports[0]?.text ?? '';
    expect(text).toContain('枠から追い返された');
    expect(text).toContain("You've hit your individual spend limit for this account.");
    expect(text).toContain('失敗する前の本文');
    expect(text).toContain('マネージャーのセッションが落ちた: Error: 何か');
  });

  it('🔴 合成された束には synthesized: true が付き、本人の報告には付かない', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.report(
      'mgr-quota',
      '（このターンは応答を返さずに終わった: success/429 / result_is_error）',
      'done',
      {
        failure: { code: 'success/429', via: 'result_is_error' },
        synthesized: 'turn_failed',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const synthesized = inbox
      .slice(before)
      .filter((event) => event.type === 'manager_message' && event.kind === 'report');
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]).toMatchObject({ synthesized: true });

    const own = await runningManualSetup();
    const ownBefore = own.inbox.length;
    own.fake.report('mgr-quota', '調べ終わった。結果はこれ', 'done');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await own.pool.stop();
    const ownReports = own.inbox
      .slice(ownBefore)
      .filter((event) => event.type === 'manager_message' && event.kind === 'report');
    expect(ownReports).toHaveLength(1);
    expect('synthesized' in (ownReports[0] ?? {})).toBe(false);
  });

  it('日誌に、畳んだ件数と内訳が残る', async () => {
    const { pool, stores, fake } = await runningManualSetup();

    const injected = ['rate_limit', 'usage_notice', 'closed_failed'];
    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.usageNotice('mgr-quota', { kind: 'reached', text: '上限に当たった' });
    fake.closed('mgr-quota', 'failed', '落ちた');
    expect(injected).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const merged = entries.find((entry) => JSON.stringify(entry).includes('1件にまとめて配った'));
    expect(merged).toBeDefined();
    const joined = JSON.stringify(merged);
    expect(joined).toContain('mgr-quota');
    expect(joined).toContain(`${String(injected.length)} 件`);
    expect(joined).toContain('枠の遷移');
    expect(joined).toContain('利用上限の通知');
    expect(joined).toContain('セッションが落ちた');

    const rateLimitLine = entries.find((entry) =>
      JSON.stringify(entry).includes('枠から追い返された'),
    );
    expect(rateLimitLine).toBeDefined();
  });
});

describe('実測の標本: 1つのセッション上限から16ms差で届いた2通', () => {
  it('2通が1件にまとまり、両方の本文が全文そのまま読める', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    const resets = "You've hit your session limit · resets 3:50pm (Asia/Tokyo)";
    fake.report(
      'mgr-quota',
      `（このターンは応答を返さずに終わった: success/429 / result_is_error）${resets}`,
      'done',
      { failure: { code: 'rate_limit', via: 'result_is_error' }, synthesized: 'turn_failed' },
    );
    fake.usageNotice('mgr-quota', { kind: 'reached', text: resets });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(1);
    const text = reports[0]?.text ?? '';
    expect(text).toContain('このターンは応答を返さずに終わった: success/429 / result_is_error');
    expect(text).toContain('利用上限に当たった。この文言で仕事が止まっている');
    expect(text).toContain('resets 3:50pm (Asia/Tokyo)');
    expect(text).toContain('件の知らせをまとめた');
  });
});

describe('同じ族が窓の中で2度目に来たら、前の積みを先に flush する', () => {
  it('rate_limit が同じ窓で2度（違う内容）届くと、1本目は単独で配られ、2本目は新しい窓に積まれる', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.rateLimit('mgr-quota', { usingOverage: true, kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[0]?.text).not.toContain('まとめた');
    expect(reports[1]?.text).toContain('課金枠から引き始めた');
    expect(reports[1]?.text).not.toContain('まとめた');
  });
});

// 畳んだかの区別は `stop()` の後だと受信箱から消える（1件は前置きが付かず本文も同じ）。件数は `stop()` の前に数え、経路は mergedJournalCount() で撃つ。
describe('印を持っていても、窓の外なら畳まない（別の束として扱う）', () => {
  it('窓より離れて届いた2件の機構合成の知らせは、別々の manager_message になる', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    fake.usageNotice('mgr-quota', { kind: 'reached', text: '上限に当たった' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[0]?.text).not.toContain('まとめた');
    expect(reports[1]?.text).toContain('上限に当たった');
    expect(reports[1]?.text).not.toContain('まとめた');
  });
});

describe('本物の報告が積みの後に届いたら、積みを先に flush してから配る', () => {
  it('積み → 本物の報告 の順で届くと、受信箱もその順で並ぶ', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.report('mgr-quota', '数えた結果と設計判断', 'done');
    await settledReport(stores, '数えた結果と設計判断');

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[1]?.text).toBe('数えた結果と設計判断');

    await pool.stop();
  });
});

describe('本人が書いた報告は畳まれない', () => {
  it('event.synthesized が無い（本人が書いた）report は即配られる', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report('mgr-quota', '本人が書いた報告', 'done');
    await settledReport(stores, '本人が書いた報告');

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe('本人が書いた報告');
    expect(delivered[0]?.text).not.toContain('まとめた');
    expect(await mergedJournalCount(stores)).toBe(0);

    await pool.stop();
  });

  it('旧 runner の形（synthesized 欄が無い failure 付き report）でも畳まれない——安全側', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report('mgr-quota', '失敗したが欄の無い旧 runner の報告', 'done', {
      failure: { code: 'billing_error', via: 'result_is_error' },
    });
    await settledReport(stores, '失敗したが欄の無い旧 runner の報告');

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe('失敗したが欄の無い旧 runner の報告');
    expect(await mergedJournalCount(stores)).toBe(0);

    await pool.stop();
  });
});

describe('畳めない出来事が挟まると、先に積みが flush されて到着順が保たれる', () => {
  it('積みの後に届いた question は、積みの後（＝到着順どおり）に受信箱へ入る', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = inbox.length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    fake.ask('mgr-quota', 'req-1', 'これでよいか確認したい', 'question');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // `vi.waitFor` で待たない: flush が無いと赤の出どころがヘルパの time out になり、順序の崩れを撃てない。
    const posted = inbox.slice(before);
    const kinds = posted
      .filter((event) => event.type === 'manager_message')
      .map((event) => (event as { kind: string }).kind);
    expect(kinds).toEqual(['report', 'question']);
    const reportText =
      (
        posted.find((e) => (e as { kind?: string }).kind === 'report') as
          { text: string } | undefined
      )?.text ?? '';
    expect(reportText).toContain('枠から追い返された');

    await pool.stop();
  });

  it('別の managerId の question でも、全 managerId の積みが先に flush される', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-quota');
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
    fake.ask('mgr-other', 'req-2', '別件の確認', 'question');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const posted = inbox.slice(before);
    expect(posted).toHaveLength(2);
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[0]?.text).toContain('上限に当たった');
  });
});

describe('完全な重複は1つへ寄せ、別の種類は1つも捨てない', () => {
  it('本文がバイト単位で同一の3通は1件へ寄り、通数（×3）が本文に残る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    const same = '（このターンは応答を返さずに終わった: success/429 / result_is_error）';
    for (let i = 0; i < 3; i += 1) {
      fake.report('mgr-quota', same, 'done', {
        failure: { code: 'rate_limit', via: 'result_is_error' },
        synthesized: 'turn_failed',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(1);
    const text = reports[0]?.text ?? '';
    expect(text.split(same)).toHaveLength(2);
    expect(text).toContain('×3');
    const entries = await stores.journal.list({ types: ['exchange'] });
    const merged = entries.find((entry) => JSON.stringify(entry).includes('1件にまとめて配った'));
    expect(JSON.stringify(merged)).toContain('3 件');
    expect(JSON.stringify(merged)).toContain('×3');
  });

  it('本文が1文字でも違えば寄せない——両方の全文が読める', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report('mgr-quota', '本文A', 'done', {
      failure: { code: 'rate_limit', via: 'result_is_error' },
      synthesized: 'turn_failed',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.report('mgr-quota', '本文B', 'done', {
      failure: { code: 'rate_limit', via: 'result_is_error' },
      synthesized: 'turn_failed',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const joined = reportsOf(inbox)
      .slice(before)
      .map((report) => report.text)
      .join('\n');
    expect(joined).toContain('本文A');
    expect(joined).toContain('本文B');
    expect(joined).not.toContain('×2');
  });

  it('mergeSynthesizedNoticeFragments（純関数）: 別の種類は全文が残り、重複は ×N になる', () => {
    const result = mergeSynthesizedNoticeFragments([
      { label: 'rate_limit', text: '枠の理由', count: 1 },
      { label: 'turn_failed', text: 'ターンの結末', count: 3 },
    ]);
    expect(result.text).toContain('枠の理由');
    expect(result.text).toContain('ターンの結末');
    expect(result.arrived).toBe(4);
    expect(result.text).toContain('×3');
    expect(result.breakdown).toContain('×3');
    expect(result.text).toContain('同文の重複 2 件');
  });
});

describe('実測の列B: 枠の理由 → 本物の報告 → 同文3通', () => {
  it('3件に落ち、どの本文も1つも消えない', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.report('mgr-quota', '数えた結果と設計判断（本物の報告）', 'done');
    await settledReport(stores, '数えた結果と設計判断（本物の報告）');
    const same = '（このターンは応答を返さずに終わった: success/429 / result_is_error）';
    for (let i = 0; i < 3; i += 1) {
      fake.report('mgr-quota', same, 'done', {
        failure: { code: 'rate_limit', via: 'result_is_error' },
        synthesized: 'turn_failed',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(3);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[1]?.text).toBe('数えた結果と設計判断（本物の報告）');
    expect(reports[2]?.text).toContain(same);
    expect(reports[2]?.text).toContain('×3');
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
    const result = mergeSynthesizedNoticeFragments([
      { label: 'rate_limit', text: '本文だけ', count: 1 },
    ]);
    expect(result.text).toBe('本文だけ');
    expect(result.text).not.toContain('まとめた');
  });

  it('mergeSynthesizedNoticeFragments（純関数）: 複数件なら前置きと区切りが付き、順序を保つ', () => {
    const fragments = [
      { label: 'report_failed', text: '1つ目', count: 1 },
      { label: 'rate_limit', text: '2つ目', count: 1 },
      { label: 'usage_notice', text: '3つ目', count: 1 },
    ];
    const result = mergeSynthesizedNoticeFragments(fragments);
    expect(result.text).toContain(`${String(fragments.length)} 件`);
    const indexOf1 = result.text.indexOf('1つ目');
    const indexOf2 = result.text.indexOf('2つ目');
    const indexOf3 = result.text.indexOf('3つ目');
    expect(indexOf1).toBeGreaterThan(-1);
    expect(indexOf2).toBeGreaterThan(indexOf1);
    expect(indexOf3).toBeGreaterThan(indexOf2);
  });
});

// 「畳まれること」と「1件目が消えないこと」を必ず対で置く: 検出する歯だけだと、1件目まで消す変更が緑のまま通る。
const QUOTA_TURN_FAILED_BODY =
  '（このターンは応答を返さずに終わった: success/429 / result_is_error）\n' +
  "You've hit your session limit · resets 6am (Asia/Tokyo)";

function emitQuotaTurnFailed(fake: ManualRunner, managerId: string, body: string): void {
  fake.report(managerId, body, 'running', {
    failure: { code: 'success/429', via: 'result_is_error' },
    synthesized: 'turn_failed',
  });
}

async function afterWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('窓をまたいだ同文の知らせは、2件目以降だけを畳む', () => {
  it('🔴 1件目は必ず配る（同文が1件しか来なくても消えない）', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
    await afterWindow();
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(
      reports,
      '赤の意味: 枠(429)で落ちた1件目の知らせが受信箱へ届いていない。これは' +
        '「うるさいから黙らせる」側へ倒れた状態で、クローンは委譲が枠で止まった' +
        'ことを知れず、拾い直す契機を失う。畳み込みは2件目以降にだけ掛けること。',
    ).toHaveLength(1);
    expect(reports[0]?.text).toContain('resets 6am');
  });

  it('窓より離れて届いた同文の2件目以降は、受信箱へ回さない', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    for (let i = 0; i < 5; i += 1) {
      emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
      await afterWindow();
    }
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(
      reports,
      '赤の意味: 同じ本文の「応答を返さずに終わった」報告が、窓が閉じるたびに' +
        '新しい受信箱イベントとして積み直されている（実測では1本の委譲から' +
        '10分で1,880件）。畳めるのは合流窓の中だけ、という状態へ戻っている。',
    ).toHaveLength(1);
  });

  it('配らなかった件数は、次に配る1件の末尾で必ずクローンへ届く', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    for (let i = 0; i < 3; i += 1) {
      emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
      await afterWindow();
    }
    fake.report('mgr-quota', '数えた結果と設計判断', 'done');
    await settledReport(stores, '数えた結果と設計判断');
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports).toHaveLength(2);
    const tail = reports[1]?.text ?? '';
    expect(
      tail,
      '赤の意味: 畳んだ件数がクローンへ届いていない。件数が消えると' +
        '「3件が1件に減ったのか、1回しか起きなかったのか」を後から区別できず、' +
        '機構の健康についての情報がそこで失われる。',
    ).toContain('2 束');
    expect(tail).toContain('通数 2 件');
    expect(
      tail,
      '赤の意味: 断り書きが「何を配って何を配らなかったか」を名乗っていない。' +
        '読む側が「1件目も消された」と読める形は、この直しの禁止事項そのものである。',
    ).toContain('1件目は配ってあり');
  });

  it('本文が1バイトでも違えば、2件目も配る（畳み間違いを作らない）', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
    await afterWindow();
    emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY.replace('6am', '9am'));
    await afterWindow();
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(
      reports,
      '赤の意味: 本文の違う2つの観測が1件に潰れている。クローンから見て' +
        '「2件目が来なかった」のと区別が付かなくなる。畳んでよいのは' +
        'バイト単位で完全に同一の場合だけである。',
    ).toHaveLength(2);
    expect(reports[1]?.text).toContain('resets 9am');
  });

  it('連鎖が途切れたら、次の同文はまた1件目として配る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
    await afterWindow();
    fake.report('mgr-quota', '途中経過', 'running');
    await settledReport(stores, '途中経過');
    emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
    await afterWindow();
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(
      reports,
      '赤の意味: 一度配った本文が永久に配られなくなっている。畳むのは' +
        '「連続するかぎり」であって以後ずっとではない —— 別のことが起きた' +
        'あとに同じ壁へ当たり直したなら、それは新しい事実である。',
    ).toHaveLength(3);
    expect(reports[2]?.text).toContain('resets 6am');
  });

  it('畳み込みはマネージャーごとに独立している（他の委譲の同文を消さない）', async () => {
    // Pool 全体で1つの鍵にしない: 別のマネージャーが同じ壁に当たった事実が畳み込みで消える。
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
      alsoRunning: ['mgr-other'],
    });
    const before = reportsOf(inbox).length;

    emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
    await afterWindow();
    emitQuotaTurnFailed(fake, 'mgr-other', QUOTA_TURN_FAILED_BODY);
    await afterWindow();
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(
      reports,
      '赤の意味: 別の委譲が枠で落ちた事実が、先に落ちた委譲の同文に吸われて' +
        '消えている。落ちた委譲は自動では再開しないので、消えた側はクローンから' +
        '永久に見えなくなる（#783 の「機構A」と同じ形）。',
    ).toHaveLength(2);
  });

  it('配らなかった束は、1束ごとに日誌へ1行残る', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });

    for (let i = 0; i < 3; i += 1) {
      emitQuotaTurnFailed(fake, 'mgr-quota', QUOTA_TURN_FAILED_BODY);
      await afterWindow();
    }
    await pool.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entries = await stores.journal.list({ types: ['exchange'] });
    const suppressed = entries.filter((entry) =>
      JSON.stringify(entry).includes('受信箱へは回さず数だけ残した'),
    );
    expect(
      suppressed,
      '赤の意味: 配らなかった束が記録のどこにも残っていない。受信箱は流れるので、' +
        '日誌に無ければ「何件畳んだのか」を後から復元できない。',
    ).toHaveLength(2);
  });
});

describe('枠の知らせの畳み込みに関わったマネージャーの本数', () => {
  const KIND = 'reached' as const;
  const TEXT_A = 'テスト専用の壁の文言A（この節でしか使わない）';
  const TEXT_B = 'テスト専用の壁の文言B（この節でしか使わない・A とは別文言）';

  it('2本の異なるマネージャーが同じ (kind, text) の壁に当たると、次に配る本文に「2本」が出る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
      alsoRunning: ['mgr-other'],
    });
    const before = reportsOf(inbox).length;

    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    fake.usageNotice('mgr-other', { kind: KIND, text: TEXT_A });
    await afterWindow();
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_B });
    await afterWindow();

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    const delivered = reports.find((r) => r.text.includes(TEXT_B));
    expect(delivered, '赤の意味: TEXT_B を運ぶ報告が受信箱に届いていない。').toBeDefined();
    expect(delivered?.text).toContain('2 件畳んでいる');
    expect(
      delivered?.text,
      '赤の意味: 畳んだ回に mgr-other と mgr-quota の2本が関わっているのに、' +
        '次に配る本文が「2本」だと読み取れない——複数マネージャーが同じ壁に' +
        '当たっている「広がり」が受信箱から見えないままになっている。',
    ).toContain('2 本');
  });

  it('同じマネージャーが2回当たっても、関わった本数は「1本」のまま（件数ではなく集合）', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_B });
    await afterWindow();

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    const delivered = reports.find((r) => r.text.includes(TEXT_B));
    expect(delivered).toBeDefined();
    expect(delivered?.text).toContain('2 件畳んでいる');
    expect(
      delivered?.text,
      '赤の意味: 同じ mgr-quota が2回当たっただけなのに「2本」と出ている——' +
        '集合ではなく件数で数える変異が入っている。',
    ).not.toContain('2 本');
    expect(delivered?.text).toContain('1 本');
  });

  it('陽性対照: 畳みが一度も起きていないとき、本文にマネージャー数の文言は付かず、従来どおり1件だけ配られる', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports, '赤の意味: 畳みが一度も起きていないのに配達本数が変わっている。').toHaveLength(
      1,
    );
    expect(reports[0]?.text).toContain(TEXT_A);
    expect(reports[0]?.text).not.toContain('件畳んでいる');
    expect(reports[0]?.text).not.toContain('本の');
  });
});

describe('合流窓に続けて畳まれた合図の到着間隔を日誌へ残す（issue #1388、測るだけ）', () => {
  async function intervalGaugeLines(stores: Stores): Promise<string[]> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = await stores.journal.list({ types: ['exchange'] });
    return entries
      .map((entry) => JSON.stringify(entry))
      .filter((text) => text.includes('合流窓に続けて畳まれた合図'));
  }

  it('陽性: 3つの族が合流すると、件数と最大・最小の到着間隔が1行に残る', async () => {
    let clock = new Date('2026-09-24T00:00:00.000Z').getTime();
    const { pool, stores, fake } = await runningManualSetup('mgr-quota', {
      now: () => clock,
    });

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 400;
    fake.usageNotice('mgr-quota', { kind: 'reached', text: '上限に当たった' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 900;
    fake.closed('mgr-quota', 'failed', '落ちた');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    const lines = await intervalGaugeLines(stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('mgr-quota');
    expect(lines[0]).toContain('3 件');
    expect(lines[0]).toContain('最大 900ms');
    expect(lines[0]).toContain('最小 400ms');
    expect(lines[0]).toContain('窓の長さ 3000ms');
  });

  it('やりすぎの対照: 1件だけの窓では、合流しなかったので行が出ない', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-quota');

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await pool.stop();

    expect(await intervalGaugeLines(stores)).toHaveLength(0);
  });

  it('やりすぎの対照: 窓を越えて別々に配られた2件では、どちらの窓でも行が出ない', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await afterWindow();
    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await afterWindow();

    await pool.stop();

    expect(await intervalGaugeLines(stores)).toHaveLength(0);
  });
});
