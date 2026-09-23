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
  options: { synthesizedNoticeWindowMs?: number; alsoRunning?: readonly string[] } = {},
): Promise<ManualSetup> {
  const stores = createMemoryStores();
  const fake = manualRunner();
  // **足したのは「同じプールにもう1本走らせる」口（`alsoRunning`）だけで、
  // 既存の呼び出し（1本だけ）の組み立ては1バイトも変えていない。** 窓をまたいだ
  // 畳み込みが**マネージャーごとに独立している**ことを撃つ歯が、1本の
  // プールに2本の委譲を要求するために要る（AGENTS.md「テストが書けない構造は、
  // テストが無いのと同じ」——出力・挙動は変わっていない）。
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
  });

  await pool.restore();
  // **`restore()` の知らせ（`#notifyRestored`）を fire-and-forget で待つ**
  // （`manager-withheld-reports.test.ts` の `runningManualSetup` と同じ理由）。
  // **走らせた本数ぶん待つ。** 1本だけの既存の呼び出しでは `>= 1` と同じで
  // 挙動は変わらないが、`alsoRunning` で2本にしたとき「1本ぶんだけ届いた時点」で
  // 先へ進むと、遅れて届いた reattach の知らせが後続の `slice(before)` に
  // 混ざって歯が測っているものとは別の理由で赤くなる。
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    // **到着を `vi.waitFor` で待たない。** flush が無いと question だけが先に
    // 届いて `length < 2` のまま止まり、**赤の出どころがヘルパの time out に
    // なる**——それは「順序が崩れた」を撃っていない。件数と並びをそのまま
    // アサーションで撃つ。
    const posted = inbox.slice(before);
    // **並べ替えない。** 積み（rate_limit）が先、question があと。
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 上の歯と同じ理由で `vi.waitFor` を使わない（赤の出どころをアサーションに置く）。
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

/**
 * **「完全な重複」と「別の種類」は扱いが違う（依頼者の要件 2026-09-08）。**
 *
 * | | 例 | 扱い |
 * | --- | --- | --- |
 * | **別の種類**（言っていることが違う） | 「ターンの結末」と「枠の理由」 | ⛔ **1つも捨てない。全文を並べる** |
 * | **完全な重複**（本文がバイト単位で同一） | 同文の `turn_failed` が3通 | ✅ **1つへ寄せて `×N` を添える** |
 *
 * **この2つを別々の歯で固定する。** 片方だけだと、いちばん危ない失敗——
 * **別のことを言っている合図が「重複」と見なされて消える**——が測れない。
 */
describe('完全な重複は1つへ寄せ、別の種類は1つも捨てない', () => {
  it('本文がバイト単位で同一の3通は1件へ寄り、通数（×3）が本文に残る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    // 依頼者の実測（`03:21:37.590Z` / `38.257Z` / `38.778Z`、幅1,188ms）と
    // 同じ形——**本文が完全に同一のものが3通**、同じ窓の中で届く。
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
    // **3通が3件の受信箱イベントにならない**（同一判定が無いと、同族2度目の
    // 枝へ落ちて3件になる）。
    expect(reports).toHaveLength(1);
    const text = reports[0]?.text ?? '';
    // **本文は1度だけ現れる**（重複を並べ直さない）。
    expect(text.split(same)).toHaveLength(2);
    // **通数は捨てない。**
    expect(text).toContain('×3');
    // 日誌にも届いた通数が残る（条件4。断片の本数=1ではなく通数=3）。
    const entries = await stores.journal.list({ types: ['exchange'] });
    const merged = entries.find((entry) => JSON.stringify(entry).includes('1件にまとめて配った'));
    expect(JSON.stringify(merged)).toContain('3 件');
    expect(JSON.stringify(merged)).toContain('×3');
  });

  it('本文が1文字でも違えば寄せない——両方の全文が読める', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    // 同じ族（`turn_failed`）で本文が違う ⟹ 別の出来事として扱われ、
    // 1本目は単独で flush される（寄せて片方を捨てることはしない）。
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
    // **どちらも消えていない。**
    expect(joined).toContain('本文A');
    expect(joined).toContain('本文B');
    // **重複として数だけ残す形にはなっていない。**
    expect(joined).not.toContain('×2');
  });

  it('mergeSynthesizedNoticeFragments（純関数）: 別の種類は全文が残り、重複は ×N になる', () => {
    const result = mergeSynthesizedNoticeFragments([
      { label: 'rate_limit', text: '枠の理由', count: 1 },
      { label: 'turn_failed', text: 'ターンの結末', count: 3 },
    ]);
    // 別の種類は両方そのまま。
    expect(result.text).toContain('枠の理由');
    expect(result.text).toContain('ターンの結末');
    // 重複は数だけ。届いた通数は 1 + 3 = 4。
    expect(result.arrived).toBe(4);
    expect(result.text).toContain('×3');
    expect(result.breakdown).toContain('×3');
    // 畳んだ重複の件数（4通 − 断片2本 = 2件）が前置きに出る。
    expect(result.text).toContain('同文の重複 2 件');
  });
});

/**
 * **依頼者の実測の列B（`mgr-148a3894`）を丸ごと1本の歯にしたもの。**
 * 出所はクローンの受信箱で、こちらで数え直したものではない:
 *
 * | | 受信時刻 | 中身 |
 * | --- | --- | --- |
 * | 1 | `03:20:57.530Z` | `枠から追い返された（five_hour）…`（reset 時刻なし） |
 * | 2 | `03:21:37.020Z` | **本物の完了報告**（約1万8千字） |
 * | 3 | `03:21:37.590Z` | `（このターンは応答を返さずに終わった…）` |
 * | 4 | `03:21:38.257Z` | ↑と本文が完全に同一 |
 * | 5 | `03:21:38.778Z` | ↑と本文が完全に同一 |
 *
 * **3つの規則が同時に働く列である**——(1) 本物の報告は畳めないので、届いた
 * 時点で積み（1）を先に flush する (2) 本物の報告はそのまま単独で配る
 * (3) 同文の3通（3・4・5）は1件へ寄せて `×3` を添える。
 */
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
    // 5通が3件になる（畳めない本物の報告が境目を作る）。
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

/**
 * ============================================================================
 * **窓をまたいだ同文の畳み込み**（`SynthesizedNoticeStreak`）
 * ============================================================================
 *
 * **依頼者（クローン）が 2026-09-13T21:31:03Z に自分で数えた実測**: 台帳の未了
 * 5,349 件のうち **5,342 件**（99.9%）が `origin=manager` で本文が
 * `result_is_error`、積まれた時刻の幅は `17:23:31`〜`17:33:50` の**約10分**で、
 * **本文は全件が逐語で同一**。そのうち **1,880 件が1本のマネージャーから**届いた。
 * 受信箱の合図は8件ずつクローンへ配られるので、5,334 件は**約660ターン**にあたり、
 * 実際にクローンのセッションが文脈窓に当たって落ちた。
 *
 * **上の describe（合流窓）が畳めるのは、窓（既定3000ms）の中だけである。**
 * 窓が閉じると積みが消えるので、次に届いた同文は「新しい束」としてもう一度
 * 配られる —— ⟹ **同じ失敗が繰り返されるかぎり、受信箱は窓の数だけ増える。**
 * この節の歯は、その繰り返しが**2件目以降だけ**畳まれることを固定する。
 *
 * **⛔ この節は「畳まれること」と「1件目が消えないこと」を必ず対で置く。**
 * 検出する歯だけを置くと、**1件目まで消す「黙らせる」変更が緑のまま通る**——
 * 枠で落ちたことはクローンが知らなければならない事実である（落ちた委譲は
 * 自動では再開せず、クローンが `manager_send` で拾い直す必要がある）。
 */
const QUOTA_TURN_FAILED_BODY =
  '（このターンは応答を返さずに終わった: success/429 / result_is_error）\n' +
  "You've hit your session limit · resets 6am (Asia/Tokyo)";

/** 枠(429)で落ちたターンの報告を1件、`synthesized` の印つきで流す。 */
function emitQuotaTurnFailed(fake: ManualRunner, managerId: string, body: string): void {
  fake.report(managerId, body, 'running', {
    failure: { code: 'success/429', via: 'result_is_error' },
    synthesized: 'turn_failed',
  });
}

/** 窓（この節では 30ms に絞ってある）が確実に閉じ切るまで待つ。 */
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

    // **5回とも別々の窓で届かせる。** 窓の中の畳み込みは上の describe が既に
    // 撃っているので、ここが測るのは「窓が閉じたあと」だけである。
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
    // 連鎖を断ち切る「別のもの」＝マネージャー本人が書いた報告。
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
    // **reset 時刻だけが違う。** 実測でも、同じ族で文言だけ違う2通が届く
    // （`usage-notice-redelivery.test.ts`）。
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
    // **#783 が記録した「機構A」の失敗形を作り直さないための歯。** 枠の事実の
    // 畳み込み（`#rateLimits` / `#usageNotices`）は Pool 全体で1つの鍵を持つため、
    // **別のマネージャーが同じ壁に当たった事実がそこで消える**（実測の日誌で
    // 連番が3本の managerId を跨いで進んでいる）。ここは同じ形へ倒れていない
    // ことを撃つ。
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

/**
 * ============================================================================
 * **枠の知らせ（`usage_notice`）の畳み込みに関わった managerId の本数**
 * （#1397 の c15-3。出所は #916 issuecomment-5649544167 の置き換えコメント §3）
 * ============================================================================
 *
 * **畳み鍵（`kind, text`）は変えない。** `case 'usage_notice'` 冒頭の doc が
 * 逐語で言っているとおり、`usage_notice` / `rate_limit` が運ぶのはアカウント
 * 単位の枠の事実であり、`event.managerId` はどのターンでそれに気づいたかの
 * 印にすぎない——「同じアカウントの同じ事実なのだから、1回配れば十分」という
 * 設計は正しい。**欠陥は、畳んだ結果「何本の異なるマネージャーが同じ壁に
 * 当たっているか」が受信箱からもクローンからも読めなくなることだけである。**
 *
 * `UsageNoticeMemory.folded` は素の件数（`number`）で、同じ managerId が
 * 何度当たっても・複数の managerId が当たっても同じ増え方をする——**「件数」と
 * 「関わった managerId の集合の大きさ」は別の軸である。** この節はその区別を
 * 固定する。
 */
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

    // 1件目: mgr-quota が TEXT_A を初めて踏む（畳まれず配達される）。
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    // 2件目: mgr-other が同じ TEXT_A を踏む（配達済みなので畳まれる）。
    fake.usageNotice('mgr-other', { kind: KIND, text: TEXT_A });
    await afterWindow();
    // 3件目: mgr-quota がもう一度同じ TEXT_A を踏む（これも畳まれる）。
    // ⟹ ここまでで畳んだ回に関わった managerId は {mgr-other, mgr-quota} の2本。
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();
    // 4件目: 別文言 TEXT_B が届き、畳んだ件数と関わった本数を乗せて配達される。
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
    // mgr-quota が同じ TEXT_A を2回畳ませる——関わった managerId は
    // {mgr-quota} の1本だけである（何度当たっても集合は増えない）。
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
    // **畳んだ件数そのものは変わらない**（この節が触っているのは本数の表示で
    // あって、既存の件数保証ではない）。
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

    // 1回きりの到達——畳みは一度も起きない。
    fake.usageNotice('mgr-quota', { kind: KIND, text: TEXT_A });
    await afterWindow();

    await pool.stop();

    const reports = reportsOf(inbox).slice(before);
    expect(reports, '赤の意味: 畳みが一度も起きていないのに配達本数が変わっている。').toHaveLength(
      1,
    );
    expect(reports[0]?.text).toContain(TEXT_A);
    // **本数の文言が新たに付いていないこと**——畳んだことが無いのに「◯本」が
    // 出ると、従来この分岐を通っていた回の本文が変わってしまう。
    expect(reports[0]?.text).not.toContain('件畳んでいる');
    expect(reports[0]?.text).not.toContain('本の');
  });
});
