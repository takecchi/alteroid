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

/**
 * 「一枠落ち一合図」（`fix/one-quota-drop-one-signal`）——枠落ちが起きると、
 * `manager.ts` が組み立てる3種の合成文言（`rate_limit` / `usage_notice` /
 * `closed` の `status === 'failed'`）と、runner 自身の `failedReportText`
 * 経由の `report`（`synthesized` に族の名前が入る）が、同じ1つの出来事の
 * 別の顔として短い間隔（実測で1秒未満）でまとめて届き、クローンのターンを
 * その通数だけ焼く。この歯は、それらが合流窓の中で1件の `manager_message` へ
 * まとまることを固定する。
 *
 * **⚠️ 通数を歯に焼き込まない（依頼者の訂正 2026-09-08）。** 同じ1つの枠落ちでも
 * 届く種類は回によって違う——実測で**4通の回**（`rate_limit` を含む）と**3通の回**
 * （`rate_limit` が来ない）の両方が在る。**固定するのは「届いた種類が1つも
 * 失われないこと」であって、通数ではない。** 数を固定した歯は、種類が減った回に
 * 赤くなり、しかもそれは欠陥ではない。件数を記録に残すのは日誌の側の役目である。
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
  return inbox.filter((event) => event.type === 'manager_message' && event.kind === 'report') as {
    text: string;
  }[];
}

/**
 * `case 'report'` が「合流窓へ積む／即配る」を分ける**前**に必ず書く日誌の行
 * （`role: 'inbound'` の exchange）が書かれるのを待つ。
 *
 * **固定の待ち時間で待たない。** `#onEvent` は fire-and-forget（`void`）なので
 * 何かを待つ必要が在るが、時間で待つと器が混んだときに取りこぼす——そして
 * その取りこぼしは「畳まれた」と同じ観測（受信箱が空）になるので、**歯の赤が
 * 何を意味するのか分からなくなる。** この行は積む側・配る側のどちらへ倒れても
 * 書かれるので、待つ条件として使える（待ち時間の差が測定に混ざらない）。
 */
async function settledReport(stores: Stores, needle: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
      throw new Error(`report の日誌の行がまだ書かれていない: ${needle}`);
    }
  });
  // 日誌の `await` が解けた直後の継続（積む／配る）を走らせる。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * `#flushSynthesizedNoticeFor` が書く「まとめて配った」の日誌の行数。
 *
 * **1件だけを畳んだ場合、受信箱の本文では畳んだことが分からない**
 * （`mergeSynthesizedNoticeFragments` は1件のとき前置きを1文字も付けない）。
 * **合流窓を通ったかどうかを外から見分けられるのは、この日誌の行だけである。**
 */
async function mergedJournalCount(stores: Stores): Promise<number> {
  // flush の日誌は `void this.#journal(...)`（fire-and-forget）なので、
  // 書き込みの継続を1度走らせてから数える。
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
    // **届いた本文がすべて入っている（要約も間引きもしない）。**
    expect(text).toContain('枠から追い返された');
    expect(text).toContain("You've hit your individual spend limit for this account.");
    expect(text).toContain('失敗する前の本文');
    expect(text).toContain('マネージャーのセッションが落ちた: Error: 何か');
    // **複数件をまとめたことが分かる前置きが付く。件数そのものは撃たない**
    // ——同じ1つの枠落ちでも届く種類は回によって違う（依頼者の実測: 4通の
    // 回と3通の回が在る）。**数を固定した歯は、種類が減った回に赤くなり、
    // しかもそれは欠陥ではない。**
  });

  it('日誌に、畳んだ件数と内訳が残る', async () => {
    const { pool, stores, fake } = await runningManualSetup();

    // **この歯が注ぎ込む本数。** 期待値をこの値から作り、数を直に書かない
    // ——固定したいのは「届いた分と同じ数が記録に残る」ことであって、その数
    // がいくつかではない（依頼者の訂正 2026-09-08）。
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
    // 注ぎ込んだ本数（rate_limit / usage_notice / closed_failed）と内訳。
    expect(joined).toContain(`${String(injected.length)} 件`);
    expect(joined).toContain('枠の遷移');
    expect(joined).toContain('利用上限の通知');
    expect(joined).toContain('セッションが落ちた');

    // **既存の個別の exchange 行は消えていない**（rate_limit 自身の journal）。
    const rateLimitLine = entries.find((entry) =>
      JSON.stringify(entry).includes('枠から追い返された'),
    );
    expect(rateLimitLine).toBeDefined();
  });
});

/**
 * **依頼者（クローン）の受信箱に実際に届いた2通を、そのまま歯にしたもの。**
 * 出所はクローンの受信箱で、こちらで数え直したものではない——
 * `mgr-5370a90d-89cb-4259-b460-707d2afbffd1` の1回のセッション上限から
 * `2026-09-08T03:21:16.926Z` と `…16.942Z`、**間隔16ms**。
 *
 * **この標本が撃っているのは「代表を選べない」ことである。** 両方に
 * `resets 3:50pm (Asia/Tokyo)` が在って同じ出来事だと外から分かるのに、
 * **本文は同じではない**——1通目は「ターンが応答を返さずに終わった」という
 * *ターンの結末*、2通目は「仕事が止まっている」という*委譲の状態*である。
 * どちらかを落とすと、クローンはその区別を失う。
 *
 * **同時に「鍵は本文ではない」ことの裏づけでもある。** この2通は本文が違うので、
 * 文字列を鍵にした畳みでは畳まれない。畳む鍵は「同じ出来事から出たか」
 * （`report.synthesized` の欄と合流窓）であって、同じ文字列かではない。
 */
describe('実測の標本: 1つのセッション上限から16ms差で届いた2通', () => {
  it('2通が1件にまとまり、両方の本文が全文そのまま読める', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    const resets = "You've hit your session limit · resets 3:50pm (Asia/Tokyo)";
    // 1通目（逐語）: runner の `failedReportText` 経由 ＝ `synthesized` が立つ。
    fake.report(
      'mgr-quota',
      `（このターンは応答を返さずに終わった: success/429 / result_is_error）${resets}`,
      'done',
      { failure: { code: 'rate_limit', via: 'result_is_error' }, synthesized: 'turn_failed' },
    );
    // 2通目（逐語）: `describeUsageNotice` が組み立てる合成文言。
    fake.usageNotice('mgr-quota', { kind: 'reached', text: resets });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    // **受信箱イベントは1件だけ立つ**（実測では2件立って、ターンが2本焼けた）。
    expect(reports).toHaveLength(1);
    const text = reports[0]?.text ?? '';
    // **2通は別のことを言っているので、どちらも捨てない。**
    expect(text).toContain('このターンは応答を返さずに終わった: success/429 / result_is_error');
    expect(text).toContain('利用上限に当たった。この文言で仕事が止まっている');
    // 2通に共通して在る reset 時刻は、まとめた1件でも読める。
    expect(text).toContain('resets 3:50pm (Asia/Tokyo)');
    // **まとめたことが分かる前置きは在る。件数は撃たない**（上の歯と同じ理由
    // ——この出来事で届いたのは実測3通で、`rate_limit` は来ていない）。
    expect(text).toContain('件の知らせをまとめた');
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

/**
 * **「欄が無ければ畳まない」を撃つ2本。** どちらも `stop()` より**前**に
 * 受信箱の件数を数える。
 *
 * **`stop()` の後に数えてはいけない。** 積まれた1件も `stop()` の flush で
 * 届くうえ、1件のときは前置きが付かないので本文も同じになる——**畳んだ／
 * 畳まなかったの区別が、受信箱からは消える。** だから区別が生きているうちに
 * 件数を撃ち、経路そのものは `mergedJournalCount()`（合流窓の日誌の行）で
 * もう一面から撃つ。
 */
/**
 * **印を持っていても、窓の外なら畳まない。** 依頼者の実測（2026-09-08。出所は
 * クローンの受信箱）に、`枠から追い返された（five_hour）` と
 * `（このターンは応答を返さずに終わった…）` が**40秒**離れて届いた列が在り、
 * **同じ束なのか2つの出来事なのかは外から決められなかった。** 決められないなら
 * 畳まない——畳めない損（ターンが焼ける）は、畳み間違いの損（無関係な出来事が
 * 1件に混ざる）より軽い。
 *
 * **つまり窓は「同じ束か」の補助であって、主たる判定ではない**（主たる判定は
 * `report.synthesized` の印のほう）。この歯はその補助が実際に効いていること
 * ——窓が閉じたら次は新しい束になり、**タイマーは延長されない**こと——を撃つ。
 */
describe('印を持っていても、窓の外なら畳まない（別の束として扱う）', () => {
  it('窓より離れて届いた2件の機構合成の知らせは、別々の manager_message になる', async () => {
    // **窓を 30ms に絞る。** 既定3000msを実時間で待つと歯が遅くなるだけで、
    // 測っているもの（窓の外か中か）は同じである。
    const { pool, inbox, fake } = await runningManualSetup('mgr-quota', {
      synthesizedNoticeWindowMs: 30,
    });
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    // 窓（30ms）が閉じ切るまで、十分に長く待つ。
    await new Promise((resolve) => setTimeout(resolve, 250));
    fake.usageNotice('mgr-quota', { kind: 'reached', text: '上限に当たった' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    // **族が違っても畳まれない**（族の違いではなく、窓の外であることが理由）。
    // ここで数を撃つのは「届いた通数」ではなく「畳まれなかったこと」である。
    expect(reports).toHaveLength(2);
    expect(reports[0]?.text).toContain('枠から追い返された');
    expect(reports[0]?.text).not.toContain('まとめた');
    expect(reports[1]?.text).toContain('上限に当たった');
    expect(reports[1]?.text).not.toContain('まとめた');
  });
});

/**
 * **本物の報告が同じ束に混ざりえる。** 依頼者の実測（2026-09-08。出所はクローンの
 * 受信箱）の列B——`mgr-148a3894` の1つの列に、`03:20:57.530Z` の
 * `枠から追い返された（five_hour）`、`03:21:37.020Z` の**中身の在る本物の報告**
 * （約1万8千字。数えた結果と設計判断）、`03:21:37.590Z` の
 * `（このターンは応答を返さずに終わった…）` が並んでいた。
 *
 * **本物の報告は畳めない**（本人が書いたものだから）。**だから積みが在るときに
 * 本物の報告が来たら、積みを先に配り切ってから本物を配る**——そうしないと、
 * 後から届いた本物のほうが先に受信箱へ入って**到着順が崩れる**
 * （`docs/architecture.md`「順序は並べ替えない」）。この歯はその flush を固定する。
 */
describe('本物の報告が積みの後に届いたら、積みを先に flush してから配る', () => {
  it('積み → 本物の報告 の順で届くと、受信箱もその順で並ぶ', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-quota', { status: 'rejected', kind: 'five_hour' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // **本物の報告（`synthesized` の欄が無い）。** 窓（既定3000ms）はまだ開いている。
    fake.report('mgr-quota', '数えた結果と設計判断', 'done');
    await settledReport(stores, '数えた結果と設計判断');

    // **`stop()` より前に、既に2件が到着順で入っていること。** flush が無いと
    // 本物だけが先に入り、積みは `stop()` まで残って順序が入れ替わる。
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

    // **`stop()` より前に、既に受信箱へ入っていること。** 畳まれていたら0件。
    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe('本人が書いた報告');
    // **前置きが付かない（1件だから、まとめてすらいない）。**
    expect(delivered[0]?.text).not.toContain('まとめた');
    // **合流窓を1度も通っていない。**
    expect(await mergedJournalCount(stores)).toBe(0);

    await pool.stop();
  });

  it('旧 runner の形（synthesized 欄が無い failure 付き report）でも畳まれない——安全側', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    // 欄が無ければ「本人が書いた」として扱う。旧 runner はこの形で送ってくる。
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
    const reportText = (
      posted.find((e) => (e as { kind?: string }).kind === 'report') as {
        text: string;
      }
    ).text;
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
    const fragments = [
      { label: 'report_failed', text: '1つ目' },
      { label: 'rate_limit', text: '2つ目' },
      { label: 'usage_notice', text: '3つ目' },
    ];
    const result = mergeSynthesizedNoticeFragments(fragments);
    // 数を直に書かず、渡した本数から作る（上の歯と同じ理由）。
    expect(result.text).toContain(`${String(fragments.length)} 件`);
    const indexOf1 = result.text.indexOf('1つ目');
    const indexOf2 = result.text.indexOf('2つ目');
    const indexOf3 = result.text.indexOf('3つ目');
    expect(indexOf1).toBeGreaterThan(-1);
    expect(indexOf2).toBeGreaterThan(indexOf1);
    expect(indexOf3).toBeGreaterThan(indexOf2);
  });
});
