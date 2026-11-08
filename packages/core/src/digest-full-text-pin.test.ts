import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TZ = 'Asia/Tokyo';
});

import { buildActivityDigest, DIGEST_JOURNAL_SCAN_LIMIT, MAX_ITEMS } from './digest.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import type { ManagerAwaitingBackgroundMap, ManagerLiveness } from './digest.js';
import type { Job } from './schema.js';
import { UnreadableApprovalError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { usageDate } from './usage.js';

// B1（`buildActivityDigest` の節ごとの切り出し）の前に置く、要約の全文の固定。
// ⚠️ ここの期待の文字列は、仕様を先に書いたものではない。切り出しの前の作りの出力を
// `vitest run <path> -u` で生成し、目で読んで確かめたものである。切り出しで一字も変わってはならない。
// 既存の試験（digest*.test.ts）は `toContain` と節の一部の抜き出しが中心で、全文を固定していない。ここは全文を固定する。
// 時計は `Date` だけを止める（実時間の待ちは足さない）。窓の始まりは Asia/Tokyo の 2026-11-01 0:00、終わりは省略（止めた時計 +1ms）。

const NOW = '2026-11-01T09:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const SINCE = new Date('2026-10-31T15:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

const ago = (ms: number): string => new Date(NOW_MS - ms).toISOString();

type JournalInput = Parameters<Stores['journal']['append']>[0];

/** `ms` だけ前の時刻の行として日誌へ足す（記録の時刻はストアが `Date` から決める）。 */
async function journalAgo(stores: Stores, ms: number, entry: JournalInput): Promise<void> {
  vi.setSystemTime(new Date(NOW_MS - ms));
  await stores.journal.append(entry);
  vi.setSystemTime(new Date(NOW));
}

async function putJob(
  stores: Stores,
  id: string,
  status: Job['status'],
  extra: Partial<Omit<Job, 'id' | 'status'>> = {},
): Promise<void> {
  await stores.jobs.putJob({
    id,
    createdAt: ago(3 * DAY),
    updatedAt: ago(10 * MIN),
    status,
    summary: `${id} の要約`,
    request: `${id} の依頼`,
    ...extra,
  });
}

async function putSchedule(stores: Stores, kind: string, extra: { lastRunAt?: string } = {}) {
  await stores.schedules.put({
    kind,
    spec: { type: 'daily', at: '09:00' },
    request: `${kind} の依頼`,
    createdAt: ago(5 * DAY),
    updatedAt: ago(5 * DAY),
    ...extra,
  });
}

async function addTask(stores: Stores, id: string, status: 'queued' | 'waiting' = 'queued') {
  await stores.tasks.add({
    id,
    createdAt: ago(2 * DAY),
    updatedAt: ago(2 * DAY),
    status,
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
  });
}

const totals = (costUsd: number) => ({
  inputTokens: 1000,
  outputTokens: 2000,
  cacheReadInputTokens: 3000,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUsd,
});

async function spend(stores: Stores, model: string, costUsd: number, managerId = 'mgr-spend') {
  await stores.usage.record({
    layer: 'manager',
    site: 'session',
    accumulation: 'oneshot',
    managerId,
    date: usageDate(new Date(NOW)),
    at: NOW,
    snapshot: { models: { [model]: totals(costUsd) } },
  });
}

const digestOf = (
  stores: Stores,
  options?: Parameters<typeof buildActivityDigest>[4],
  liveness?: ManagerLiveness,
  awaiting?: ManagerAwaitingBackgroundMap,
): Promise<string> => buildActivityDigest(stores, { since: SINCE }, liveness, awaiting, options);

describe('B1 要約の全文の固定 — 何も無い・節ごとの最小', () => {
  it('何も無い（全文）。件数は 0 で、出る節は待ち行列の先頭と使った分だけ', async () => {
    const text = await digestOf(createMemoryStores());
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('何も無く、窓が日に揃っている（使った分に「日ぶんの合計」の添え書きが付かない。全文）', async () => {
    const text = await buildActivityDigest(createMemoryStores(), {
      since: SINCE,
      until: new Date('2026-11-01T15:00:00.000Z'),
    });
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T15:00:00.000Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 使った分
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('継続中の依頼だけ（一度も動いていない1件と、動いた1件。全文）', async () => {
    const stores = createMemoryStores();
    await putSchedule(stores, 'issue-round');
    await putSchedule(stores, 'daily-report', { lastRunAt: ago(3 * 60 * MIN) });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 2

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - daily-report（毎日 09:00（ローカル時刻））daily-report の依頼
        前回動いた時刻: 2026-11-01T06:00:00.000Z
      - issue-round（毎日 09:00（ローカル時刻））issue-round の依頼
        前回動いた時刻: （まだ一度も動いていない）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('マネージャーだけ（走行中の1本。liveness 省略は /セッション不明。全文）', async () => {
    const stores = createMemoryStores();
    await putJob(stores, 'mgr-run', 'running');
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）1 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## マネージャー（走行中・返事待ちから先に出す）
      - mgr-run [running/セッション不明] mgr-run の依頼

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('聞かずに決めたことだけ（1件の本文と、定型の1件の注記。全文）', async () => {
    const stores = createMemoryStores();
    await journalAgo(stores, 5 * MIN, {
      type: 'decision',
      decision: '小さな修正を委譲した',
      grounds: '記憶の「小さな修正は任せてよい」',
    });
    await journalAgo(stores, 4 * MIN, {
      type: 'decision',
      decision: '定型の記録',
      grounds: '機構',
      routine: true,
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 1 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 聞かずに決めたこと
      - 2026-11-01T08:55:00.000Z 小さな修正を委譲した（根拠: 記憶の「小さな修正は任せてよい」）
      （器の機構が定型で書いた記録 1 件は一覧に入れていない。\`journal_read\` の types=["decision"] で見える）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('聞かずに決めたことが定型の行だけ（節の見出しと注記だけが出る。全文）', async () => {
    const stores = createMemoryStores();
    await journalAgo(stores, 4 * MIN, {
      type: 'decision',
      decision: '定型の記録',
      grounds: '機構',
      routine: true,
    });
    await journalAgo(stores, 3 * MIN, {
      type: 'decision',
      decision: '定型の記録 2',
      grounds: '機構',
      routine: true,
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 聞かずに決めたこと
      （器の機構が定型で書いた記録 2 件は一覧に入れていない。\`journal_read\` の types=["decision"] で見える）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('人間の回答待ちだけ（マネージャー発の1件と、そうでない1件。全文）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: ago(30 * MIN),
      question: '本番へ流してよいか',
      jobId: 'mgr-1234',
    });
    await stores.jobs.putApproval({ id: 'ap-2', createdAt: ago(20 * MIN), question: '続けるか' });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 2 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - ap-1（2026-11-01T08:30:00.000Z）本番へ流してよいか [マネージャー mgr-1234]
      - ap-2（2026-11-01T08:40:00.000Z）続けるか

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('記憶の更新だけ（新形式と旧形式。全文）', async () => {
    const stores = createMemoryStores();
    await journalAgo(stores, 9 * MIN, {
      type: 'memory_update',
      slug: 'values',
      cause: 'distill',
      action: 'write',
      bytesBefore: 100,
      bytesAfter: 150,
      summary: '好みを追記',
    });
    await journalAgo(stores, 8 * MIN, {
      type: 'memory_update',
      slug: 'persona',
      cause: 'clone',
      summary: '古い形式の更新',
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 2 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 記憶の更新
      - persona（clone / 前後バイト数不明（旧形式））古い形式の更新
      - values（distill/write / 100→150 バイト）好みを追記

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('届いた外部イベントだけ（同じ本文の重複を含む。全文）', async () => {
    const stores = createMemoryStores();
    await journalAgo(stores, 9 * MIN, { type: 'external_event', source: 'ci', summary: '落ちた' });
    await journalAgo(stores, 8 * MIN, { type: 'external_event', source: 'ci', summary: '落ちた' });
    await journalAgo(stores, 7 * MIN, { type: 'external_event', source: 'ci', summary: '直った' });
    await journalAgo(stores, 6 * MIN, {
      type: 'external_event',
      source: 'runner',
      summary: '起動した',
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）4 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 届いた外部イベント
      この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を通さず直接書く行（source \`runner\` / \`boot-storage-footprint\` / \`boot-tool-search\`）も混ざる。
      - runner: 起動した
      - ci: 直った
      - ci: 落ちた
      - ci: 落ちた

      **発行元（source）別の件数（正確な総数。上限 \`DIGEST_SOURCE_TALLY_LIMIT\`=32 発行元まで追跡する）**
      - ci: 3 件
      - runner: 1 件

      **本文の形（保持した 4 件の標本。上の件数とは母数が違う）** —— 「本文の種類」は \`summary\` の完全一致で数える（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。
      - ci: 同じ本文は 2 種。最も多い1種が 2 件
      - runner: 同じ本文は 1 種。最も多い1種が 1 件

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('使った分（合計・モデル別・層別・場所別・高かった委譲・推定値の注記。全文）', async () => {
    const stores = createMemoryStores();
    await spend(stores, 'claude-opus-5', 2);
    await spend(stores, 'claude-sonnet-5', 0.5, 'mgr-small');
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      - 合計: $2.50
      - 出力トークン: 4,000 / 入力: 2,000 / キャッシュ読み: 6,000
      - モデル別: claude-opus-5 $2.00 / claude-sonnet-5 $0.5000
      - 層別（誰が）: manager $2.50
      - 場所別（どこで）: session $2.50
      - 高かった委譲:
        - mgr-spend: $2.00
        - mgr-small: $0.5000
      - 推定値（請求明細ではない。詳しくは \`usage_read\`）"
    `);
  });

  it('使った分の台帳を読めない（集計は出せない、の2行。全文）', async () => {
    const stores = createMemoryStores();
    stores.usage.aggregate = () => Promise.reject(new Error('台帳が壊れている'));
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 使った分
      （台帳を読めなかった。集計は出せない）"
    `);
  });
});

describe('B1 要約の全文の固定 — マネージャーの節の畳みと出し分け', () => {
  async function seedManagers(stores: Stores): Promise<void> {
    // 1本ずつ出る: 走行中・返事待ち・lost・窓の中で終端した failed・背景処理待ちの done
    await putJob(stores, 'mgr-run', 'running', {
      lastReport: '途中の報告',
      updatedAt: ago(5 * MIN),
    });
    await putJob(stores, 'mgr-wait', 'waiting_human', { updatedAt: ago(6 * MIN) });
    await putJob(stores, 'mgr-lost', 'lost', { updatedAt: ago(7 * MIN) });
    await putJob(stores, 'mgr-fresh-failed', 'failed', {
      updatedAt: ago(8 * MIN),
      lastFailure: { code: 'boom', via: 'sdk', at: ago(8 * MIN) },
      lastReport: '失敗の報告',
    });
    await putJob(stores, 'mgr-bg', 'done', { updatedAt: ago(9 * MIN) });
    // 手が止まっている done・stopped（畳む）
    await putJob(stores, 'mgr-done', 'done', { updatedAt: ago(11 * MIN) });
    await putJob(stores, 'mgr-stopped', 'stopped', { updatedAt: ago(12 * MIN) });
    // 窓より前に終端した failed（畳む）
    await putJob(stores, 'mgr-old-failed', 'failed', {
      updatedAt: ago(13 * MIN),
      lastFailure: { code: 'old', via: 'sdk', at: ago(14 * DAY) },
    });
  }

  const liveness: ManagerLiveness = new Map([
    ['mgr-run', true],
    ['mgr-wait', false],
  ]);
  const awaiting: ManagerAwaitingBackgroundMap = new Map([
    ['mgr-bg', { tasks: 2, withheldReports: 0, breakdown: 'x', since: ago(2 * 60 * MIN) }],
  ]);

  it('畳みの全部入り（liveness・背景処理待ち付き。全文）', async () => {
    const stores = createMemoryStores();
    await seedManagers(stores);
    expect(await digestOf(stores, undefined, liveness, awaiting)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）8 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## マネージャー（走行中・返事待ちから先に出す）
      - mgr-run [running] mgr-run の依頼
        直近の報告: 途中の報告
      - mgr-wait [waiting_human/セッション切断] mgr-wait の依頼
      - mgr-lost [lost/セッション不明] mgr-lost の依頼
      - mgr-fresh-failed [failed/セッション不明] mgr-fresh-failed の依頼
        直近の報告: 失敗の報告
        ⚠ 直近のターンは失敗で終わっている: boom（via: sdk, 2026-11-01T08:52:00.000Z）。全文と次の一手は \`manager_list\` / \`manager_report\` で見る。
      - mgr-bg [done/セッション不明/背景処理待ち×2（2026-11-01T07:00:00.000Z から）] mgr-bg の依頼
      - 手が止まっている担当（done・stopped）2 本: mgr-done, mgr-stopped
      依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。
      - 終端して窓より前の failed 1 本: mgr-old-failed
      失敗の中身と依頼・報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('trimHistory: false（窓より前の failed も1本ずつ出る。全文）', async () => {
    const stores = createMemoryStores();
    await seedManagers(stores);
    expect(await digestOf(stores, { trimHistory: false }, liveness, awaiting))
      .toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）8 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## マネージャー（走行中・返事待ちから先に出す）
      - mgr-run [running] mgr-run の依頼
        直近の報告: 途中の報告
      - mgr-wait [waiting_human/セッション切断] mgr-wait の依頼
      - mgr-lost [lost/セッション不明] mgr-lost の依頼
      - mgr-fresh-failed [failed/セッション不明] mgr-fresh-failed の依頼
        直近の報告: 失敗の報告
        ⚠ 直近のターンは失敗で終わっている: boom（via: sdk, 2026-11-01T08:52:00.000Z）。全文と次の一手は \`manager_list\` / \`manager_report\` で見る。
      - mgr-bg [done/セッション不明/背景処理待ち×2（2026-11-01T07:00:00.000Z から）] mgr-bg の依頼
      - mgr-old-failed [failed/セッション不明] mgr-old-failed の依頼
        ⚠ 直近のターンは失敗で終わっている: old（via: sdk, 2026-10-18T09:00:00.000Z）。全文と次の一手は \`manager_list\` / \`manager_report\` で見る。
      - 手が止まっている担当（done・stopped）2 本: mgr-done, mgr-stopped
      依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('読めない委譲の行だけが在る（マネージャーの節に断りだけが出る。全文）', async () => {
    const stores = createMemoryStores();
    stores.jobs.listUnreadableJobs = () =>
      Promise.resolve([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0
      - 読めない委譲（壊れた行。上の本数には入っていない）: 1 件

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## マネージャー（走行中・返事待ちから先に出す）
      - 読めない委譲が 1 件ある（id: mgr-bad）。壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });
});

describe('B1 要約の全文の固定 — エスカレーションの節の全分岐', () => {
  it('回答あり・取り下げ・キューに未回答・窓の外で回答/取り下げ・読めない・マネージャー発・判定できない（全文）', async () => {
    const stores = createMemoryStores();
    // 新しい順に並ぶ: 日誌の `at` の降順
    // 1) 窓の中で回答
    await journalAgo(stores, 1 * MIN, {
      type: 'escalation',
      question: '回答あり？',
      approvalId: 'ap-answered',
      answer: '進めてよい',
    });
    // 2) 窓の中で取り下げ
    await journalAgo(stores, 2 * MIN, {
      type: 'escalation',
      question: '取り下げ？',
      approvalId: 'ap-withdrawn',
      withdrawnAt: ago(2 * MIN),
      withdrawnReason: '前提が消えた',
    });
    // 3) キューに未回答
    await stores.jobs.putApproval({
      id: 'ap-pending',
      createdAt: ago(3 * MIN),
      question: '未回答？',
    });
    await journalAgo(stores, 3 * MIN, {
      type: 'escalation',
      question: '未回答？',
      approvalId: 'ap-pending',
    });
    // 4) 日誌には未回答の行だけで、キューでは窓の外で回答済み
    await stores.jobs.putApproval({
      id: 'ap-answered-later',
      createdAt: ago(4 * MIN),
      question: '後で回答？',
      answeredAt: ago(1 * MIN),
      answer: '後から答えた',
    });
    await journalAgo(stores, 4 * MIN, {
      type: 'escalation',
      question: '後で回答？',
      approvalId: 'ap-answered-later',
    });
    // 5) 回答の本文が無い記録
    await stores.jobs.putApproval({
      id: 'ap-no-answer-text',
      createdAt: ago(5 * MIN),
      question: '本文欠け？',
      answeredAt: ago(1 * MIN),
    });
    await journalAgo(stores, 5 * MIN, {
      type: 'escalation',
      question: '本文欠け？',
      approvalId: 'ap-no-answer-text',
    });
    // 6) 日誌には未回答の行だけで、キューでは窓の外で取り下げ済み
    await stores.jobs.putApproval({
      id: 'ap-withdrawn-later',
      createdAt: ago(6 * MIN),
      question: '後で取り下げ？',
      withdrawnAt: ago(1 * MIN),
      withdrawnReason: '要らなくなった',
    });
    await journalAgo(stores, 6 * MIN, {
      type: 'escalation',
      question: '後で取り下げ？',
      approvalId: 'ap-withdrawn-later',
    });
    // 7) キューの行が読めない
    const original = stores.jobs.getApproval.bind(stores.jobs);
    stores.jobs.getApproval = (id) =>
      id === 'ap-unreadable'
        ? Promise.reject(new UnreadableApprovalError({ id, reason: '壊れた行' }))
        : original(id);
    await journalAgo(stores, 7 * MIN, {
      type: 'escalation',
      question: '読めない？',
      approvalId: 'ap-unreadable',
    });
    // 8) マネージャー発（キューに無い）
    await journalAgo(stores, 8 * MIN, {
      type: 'escalation',
      question: 'マネージャー発？',
      approvalId: 'req-1',
      managerId: 'mgr-9',
    });
    // 9) 判定できない
    await journalAgo(stores, 9 * MIN, {
      type: 'escalation',
      question: '判定できない？',
      approvalId: 'ap-unknown',
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 1 / エスカレーション 9 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## エスカレーション
      - 回答あり？ → 回答: 進めてよい（id: ap-answered）
      - 取り下げ？ → 取り下げ: 前提が消えた（id: ap-withdrawn）
      - 未回答？ → 未回答（承認待ちキューに在る。下の「人間の回答待ち」に同じ id で出ている）（id: ap-pending）
      - 後で回答？ → この期間の日誌には未回答の行しか無いが、承認待ちキューでは既に回答済み（この期間の外で回答された）: 後から答えた（id: ap-answered-later）
      - 本文欠け？ → この期間の日誌には未回答の行しか無いが、承認待ちキューでは既に回答済み（この期間の外で回答された）: （回答の本文が無い記録——answeredAt はあるが answer が欠けている。台帳の破損の可能性がある）（id: ap-no-answer-text）
      - 後で取り下げ？ → この期間の日誌には取り下げ前の行しか無いが、承認待ちキューでは既に取り下げ済み（この期間の外で取り下げられた）: 要らなくなった（id: ap-withdrawn-later）
      - 読めない？ → 承認待ちキューに行は在るが読めない形で入っている（壊れた行。消されたのではない。回答済みかどうかも判定できない）（id: ap-unreadable）
      - マネージャー発？ → 未回答（マネージャー mgr-9 発の確認。承認待ちキューには載らない設計——欠落ではない）（requestId: req-1（マネージャー mgr-9 発。承認待ちキューの id ではない））
      - 判定できない？ → 判定できない（承認待ちキューに見つからず、マネージャー発でもない）（id: ap-unknown）

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - ap-pending（2026-11-01T08:57:00.000Z）未回答？

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });
});

/** 各節を ちょうど `n` 件にする。`n = MAX_ITEMS` なら省略の合図が出ず、`MAX_ITEMS + 1` なら全部の節で出る。 */
async function seedEverything(n: number, stores = createMemoryStores()): Promise<Stores> {
  const pad = (i: number): string => String(i).padStart(2, '0');
  for (let i = 0; i < n; i += 1) {
    await addTask(stores, `t-${pad(i)}`);
    await putSchedule(stores, `kind-${pad(i)}`);
    await putJob(stores, `run-${pad(i)}`, 'running', { updatedAt: ago((i + 1) * MIN) });
    await putJob(stores, `done-${pad(i)}`, 'done', { updatedAt: ago((i + 1) * MIN + 1) });
    await putJob(stores, `old-${pad(i)}`, 'failed', {
      updatedAt: ago((i + 1) * MIN + 2),
      lastFailure: { code: 'old', via: 'sdk', at: ago(14 * DAY) },
    });
    await stores.jobs.putApproval({
      id: `ap-${pad(i)}`,
      createdAt: ago((i + 1) * MIN),
      question: `確認 ${pad(i)}`,
    });
    await journalAgo(stores, (i + 1) * MIN, {
      type: 'decision',
      decision: `決めた ${pad(i)}`,
      grounds: '根拠',
    });
    await journalAgo(stores, (i + 1) * MIN + 1, {
      type: 'escalation',
      question: `聞いた ${pad(i)}`,
      approvalId: `esc-${pad(i)}`,
      answer: `答え ${pad(i)}`,
    });
    await journalAgo(stores, (i + 1) * MIN + 2, {
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: i,
      bytesAfter: i + 1,
      summary: `直した ${pad(i)}`,
    });
    await journalAgo(stores, (i + 1) * MIN + 3, {
      type: 'external_event',
      source: `src-${pad(i)}`,
      summary: `届いた ${pad(i)}`,
    });
    await spend(stores, `model-${pad(i)}`, 10 - i / 100, `mgr-spend-${pad(i)}`);
  }
  return stores;
}

describe('B1 要約の全文の固定 — 各節の上限の境目（全部の節を同時に）', () => {
  it(`どの節もちょうど MAX_ITEMS（${MAX_ITEMS}）件: 省略の合図が出るのは本文の形と待ち行列の先頭（先頭の上限が別）だけ（全文）`, async () => {
    const text = await digestOf(await seedEverything(MAX_ITEMS));
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 15 / エスカレーション 15 / 委譲（この期間に動いた）45 本 / 自分で決めたこと 15 / 記憶の更新 15 / 外部イベント（日誌の行数）15 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 15

      ## 待ち行列の先頭
      - 待ち行列: 開いている 15 件（queued 15 / waiting 0 / needs_decision 0）
      - t-00（状態: queued（待ち行列） / origin: self）title-t-00
      - t-01（状態: queued（待ち行列） / origin: self）title-t-01
      - t-02（状態: queued（待ち行列） / origin: self）title-t-02
      - …ほか 12 件（task_list で全部見える）
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - kind-00（毎日 09:00（ローカル時刻））kind-00 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-01（毎日 09:00（ローカル時刻））kind-01 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-02（毎日 09:00（ローカル時刻））kind-02 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-03（毎日 09:00（ローカル時刻））kind-03 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-04（毎日 09:00（ローカル時刻））kind-04 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-05（毎日 09:00（ローカル時刻））kind-05 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-06（毎日 09:00（ローカル時刻））kind-06 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-07（毎日 09:00（ローカル時刻））kind-07 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-08（毎日 09:00（ローカル時刻））kind-08 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-09（毎日 09:00（ローカル時刻））kind-09 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-10（毎日 09:00（ローカル時刻））kind-10 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-11（毎日 09:00（ローカル時刻））kind-11 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-12（毎日 09:00（ローカル時刻））kind-12 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-13（毎日 09:00（ローカル時刻））kind-13 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-14（毎日 09:00（ローカル時刻））kind-14 の依頼
        前回動いた時刻: （まだ一度も動いていない）

      ## マネージャー（走行中・返事待ちから先に出す）
      - run-00 [running/セッション不明] run-00 の依頼
      - run-01 [running/セッション不明] run-01 の依頼
      - run-02 [running/セッション不明] run-02 の依頼
      - run-03 [running/セッション不明] run-03 の依頼
      - run-04 [running/セッション不明] run-04 の依頼
      - run-05 [running/セッション不明] run-05 の依頼
      - run-06 [running/セッション不明] run-06 の依頼
      - run-07 [running/セッション不明] run-07 の依頼
      - run-08 [running/セッション不明] run-08 の依頼
      - run-09 [running/セッション不明] run-09 の依頼
      - run-10 [running/セッション不明] run-10 の依頼
      - run-11 [running/セッション不明] run-11 の依頼
      - run-12 [running/セッション不明] run-12 の依頼
      - run-13 [running/セッション不明] run-13 の依頼
      - run-14 [running/セッション不明] run-14 の依頼
      - 手が止まっている担当（done・stopped）15 本: done-00, done-01, done-02, done-03, done-04, done-05, done-06, done-07, done-08, done-09, done-10, done-11, done-12, done-13, done-14
      依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。
      - 終端して窓より前の failed 15 本: old-00, old-01, old-02, old-03, old-04, old-05, old-06, old-07, old-08, old-09, old-10, old-11, old-12, old-13, old-14
      失敗の中身と依頼・報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。

      ## 聞かずに決めたこと
      - 2026-11-01T08:45:00.000Z 決めた 14（根拠: 根拠）
      - 2026-11-01T08:46:00.000Z 決めた 13（根拠: 根拠）
      - 2026-11-01T08:47:00.000Z 決めた 12（根拠: 根拠）
      - 2026-11-01T08:48:00.000Z 決めた 11（根拠: 根拠）
      - 2026-11-01T08:49:00.000Z 決めた 10（根拠: 根拠）
      - 2026-11-01T08:50:00.000Z 決めた 09（根拠: 根拠）
      - 2026-11-01T08:51:00.000Z 決めた 08（根拠: 根拠）
      - 2026-11-01T08:52:00.000Z 決めた 07（根拠: 根拠）
      - 2026-11-01T08:53:00.000Z 決めた 06（根拠: 根拠）
      - 2026-11-01T08:54:00.000Z 決めた 05（根拠: 根拠）
      - 2026-11-01T08:55:00.000Z 決めた 04（根拠: 根拠）
      - 2026-11-01T08:56:00.000Z 決めた 03（根拠: 根拠）
      - 2026-11-01T08:57:00.000Z 決めた 02（根拠: 根拠）
      - 2026-11-01T08:58:00.000Z 決めた 01（根拠: 根拠）
      - 2026-11-01T08:59:00.000Z 決めた 00（根拠: 根拠）

      ## エスカレーション
      - 聞いた 00 → 回答: 答え 00（id: esc-00）
      - 聞いた 01 → 回答: 答え 01（id: esc-01）
      - 聞いた 02 → 回答: 答え 02（id: esc-02）
      - 聞いた 03 → 回答: 答え 03（id: esc-03）
      - 聞いた 04 → 回答: 答え 04（id: esc-04）
      - 聞いた 05 → 回答: 答え 05（id: esc-05）
      - 聞いた 06 → 回答: 答え 06（id: esc-06）
      - 聞いた 07 → 回答: 答え 07（id: esc-07）
      - 聞いた 08 → 回答: 答え 08（id: esc-08）
      - 聞いた 09 → 回答: 答え 09（id: esc-09）
      - 聞いた 10 → 回答: 答え 10（id: esc-10）
      - 聞いた 11 → 回答: 答え 11（id: esc-11）
      - 聞いた 12 → 回答: 答え 12（id: esc-12）
      - 聞いた 13 → 回答: 答え 13（id: esc-13）
      - 聞いた 14 → 回答: 答え 14（id: esc-14）

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - ap-00（2026-11-01T08:59:00.000Z）確認 00
      - ap-01（2026-11-01T08:58:00.000Z）確認 01
      - ap-02（2026-11-01T08:57:00.000Z）確認 02
      - ap-03（2026-11-01T08:56:00.000Z）確認 03
      - ap-04（2026-11-01T08:55:00.000Z）確認 04
      - ap-05（2026-11-01T08:54:00.000Z）確認 05
      - ap-06（2026-11-01T08:53:00.000Z）確認 06
      - ap-07（2026-11-01T08:52:00.000Z）確認 07
      - ap-08（2026-11-01T08:51:00.000Z）確認 08
      - ap-09（2026-11-01T08:50:00.000Z）確認 09
      - ap-10（2026-11-01T08:49:00.000Z）確認 10
      - ap-11（2026-11-01T08:48:00.000Z）確認 11
      - ap-12（2026-11-01T08:47:00.000Z）確認 12
      - ap-13（2026-11-01T08:46:00.000Z）確認 13
      - ap-14（2026-11-01T08:45:00.000Z）確認 14

      ## 記憶の更新
      - values（clone/write / 14→15 バイト）直した 14
      - values（clone/write / 13→14 バイト）直した 13
      - values（clone/write / 12→13 バイト）直した 12
      - values（clone/write / 11→12 バイト）直した 11
      - values（clone/write / 10→11 バイト）直した 10
      - values（clone/write / 9→10 バイト）直した 09
      - values（clone/write / 8→9 バイト）直した 08
      - values（clone/write / 7→8 バイト）直した 07
      - values（clone/write / 6→7 バイト）直した 06
      - values（clone/write / 5→6 バイト）直した 05
      - values（clone/write / 4→5 バイト）直した 04
      - values（clone/write / 3→4 バイト）直した 03
      - values（clone/write / 2→3 バイト）直した 02
      - values（clone/write / 1→2 バイト）直した 01
      - values（clone/write / 0→1 バイト）直した 00

      ## 届いた外部イベント
      この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を通さず直接書く行（source \`runner\` / \`boot-storage-footprint\` / \`boot-tool-search\`）も混ざる。
      - src-14: 届いた 14
      - src-13: 届いた 13
      - src-12: 届いた 12
      - src-11: 届いた 11
      - src-10: 届いた 10
      - src-09: 届いた 09
      - src-08: 届いた 08
      - src-07: 届いた 07
      - src-06: 届いた 06
      - src-05: 届いた 05
      - src-04: 届いた 04
      - src-03: 届いた 03
      - src-02: 届いた 02
      - src-01: 届いた 01
      - src-00: 届いた 00

      **発行元（source）別の件数（正確な総数。上限 \`DIGEST_SOURCE_TALLY_LIMIT\`=32 発行元まで追跡する）**
      - src-00: 1 件
      - src-01: 1 件
      - src-02: 1 件
      - src-03: 1 件
      - src-04: 1 件
      - src-05: 1 件
      - src-06: 1 件
      - src-07: 1 件
      - src-08: 1 件
      - src-09: 1 件
      - src-10: 1 件
      - src-11: 1 件
      - src-12: 1 件
      - src-13: 1 件
      - src-14: 1 件

      **本文の形（保持した 15 件の標本。上の件数とは母数が違う）** —— 「本文の種類」は \`summary\` の完全一致で数える（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。
      - src-00: 同じ本文は 1 種。最も多い1種が 1 件
      - src-01: 同じ本文は 1 種。最も多い1種が 1 件
      - src-02: 同じ本文は 1 種。最も多い1種が 1 件
      - src-03: 同じ本文は 1 種。最も多い1種が 1 件
      - src-04: 同じ本文は 1 種。最も多い1種が 1 件
      - …ほか 10 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る）（source では絞れない。読み出した行を自分で source ごとに数える。ここは保持した標本の中の発行元数であって、総数ではない））

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      - 合計: $148.95
      - 出力トークン: 30,000 / 入力: 15,000 / キャッシュ読み: 45,000
      - モデル別: model-00 $10.00 / model-01 $9.99 / model-02 $9.98 / model-03 $9.97 / model-04 $9.96 / model-05 $9.95 / model-06 $9.94 / model-07 $9.93 / model-08 $9.92 / model-09 $9.91 / model-10 $9.90 / model-11 $9.89 / model-12 $9.88 / model-13 $9.87 / model-14 $9.86
      - 層別（誰が）: manager $148.95
      - 場所別（どこで）: session $148.95
      - 高かった委譲:
        - mgr-spend-00: $10.00
        - mgr-spend-01: $9.99
        - mgr-spend-02: $9.98
        - mgr-spend-03: $9.97
        - mgr-spend-04: $9.96
        - mgr-spend-05: $9.95
        - mgr-spend-06: $9.94
        - mgr-spend-07: $9.93
        - mgr-spend-08: $9.92
        - mgr-spend-09: $9.91
        - mgr-spend-10: $9.90
        - mgr-spend-11: $9.89
        - mgr-spend-12: $9.88
        - mgr-spend-13: $9.87
        - mgr-spend-14: $9.86
      - 推定値（請求明細ではない。詳しくは \`usage_read\`）"
    `);
  });

  it(`どの節も MAX_ITEMS + 1 件: 全部の節で「…ほか」が出る（全文）`, async () => {
    const text = await digestOf(await seedEverything(MAX_ITEMS + 1));
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 16 / エスカレーション 16 / 委譲（この期間に動いた）48 本 / 自分で決めたこと 16 / 記憶の更新 16 / 外部イベント（日誌の行数）16 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 16

      ## 待ち行列の先頭
      - 待ち行列: 開いている 16 件（queued 16 / waiting 0 / needs_decision 0）
      - t-00（状態: queued（待ち行列） / origin: self）title-t-00
      - t-01（状態: queued（待ち行列） / origin: self）title-t-01
      - t-02（状態: queued（待ち行列） / origin: self）title-t-02
      - …ほか 13 件（task_list で全部見える）
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - kind-00（毎日 09:00（ローカル時刻））kind-00 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-01（毎日 09:00（ローカル時刻））kind-01 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-02（毎日 09:00（ローカル時刻））kind-02 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-03（毎日 09:00（ローカル時刻））kind-03 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-04（毎日 09:00（ローカル時刻））kind-04 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-05（毎日 09:00（ローカル時刻））kind-05 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-06（毎日 09:00（ローカル時刻））kind-06 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-07（毎日 09:00（ローカル時刻））kind-07 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-08（毎日 09:00（ローカル時刻））kind-08 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-09（毎日 09:00（ローカル時刻））kind-09 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-10（毎日 09:00（ローカル時刻））kind-10 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-11（毎日 09:00（ローカル時刻））kind-11 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-12（毎日 09:00（ローカル時刻））kind-12 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-13（毎日 09:00（ローカル時刻））kind-13 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-14（毎日 09:00（ローカル時刻））kind-14 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - …ほか 1 件（\`schedule_list\` で全部見える）

      ## マネージャー（走行中・返事待ちから先に出す）
      - run-00 [running/セッション不明] run-00 の依頼
      - run-01 [running/セッション不明] run-01 の依頼
      - run-02 [running/セッション不明] run-02 の依頼
      - run-03 [running/セッション不明] run-03 の依頼
      - run-04 [running/セッション不明] run-04 の依頼
      - run-05 [running/セッション不明] run-05 の依頼
      - run-06 [running/セッション不明] run-06 の依頼
      - run-07 [running/セッション不明] run-07 の依頼
      - run-08 [running/セッション不明] run-08 の依頼
      - run-09 [running/セッション不明] run-09 の依頼
      - run-10 [running/セッション不明] run-10 の依頼
      - run-11 [running/セッション不明] run-11 の依頼
      - run-12 [running/セッション不明] run-12 の依頼
      - run-13 [running/セッション不明] run-13 の依頼
      - run-14 [running/セッション不明] run-14 の依頼
      - …ほか 1 件（\`manager_list\` で状態を見る。あちらも入る分までで、残りの件数が本文に出る）
      - 手が止まっている担当（done・stopped）16 本: done-00, done-01, done-02, done-03, done-04, done-05, done-06, done-07, done-08, done-09, done-10, done-11, done-12, done-13, done-14 …ほか 1 件
      依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。
      - 終端して窓より前の failed 16 本: old-00, old-01, old-02, old-03, old-04, old-05, old-06, old-07, old-08, old-09, old-10, old-11, old-12, old-13, old-14 …ほか 1 件
      失敗の中身と依頼・報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。

      ## 聞かずに決めたこと
      - 2026-11-01T08:44:00.000Z 決めた 15（根拠: 根拠）
      - 2026-11-01T08:45:00.000Z 決めた 14（根拠: 根拠）
      - 2026-11-01T08:46:00.000Z 決めた 13（根拠: 根拠）
      - 2026-11-01T08:47:00.000Z 決めた 12（根拠: 根拠）
      - 2026-11-01T08:48:00.000Z 決めた 11（根拠: 根拠）
      - 2026-11-01T08:49:00.000Z 決めた 10（根拠: 根拠）
      - 2026-11-01T08:50:00.000Z 決めた 09（根拠: 根拠）
      - 2026-11-01T08:51:00.000Z 決めた 08（根拠: 根拠）
      - 2026-11-01T08:52:00.000Z 決めた 07（根拠: 根拠）
      - 2026-11-01T08:53:00.000Z 決めた 06（根拠: 根拠）
      - 2026-11-01T08:54:00.000Z 決めた 05（根拠: 根拠）
      - 2026-11-01T08:55:00.000Z 決めた 04（根拠: 根拠）
      - 2026-11-01T08:56:00.000Z 決めた 03（根拠: 根拠）
      - 2026-11-01T08:57:00.000Z 決めた 02（根拠: 根拠）
      - 2026-11-01T08:58:00.000Z 決めた 01（根拠: 根拠）
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["decision"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## エスカレーション
      - 聞いた 00 → 回答: 答え 00（id: esc-00）
      - 聞いた 01 → 回答: 答え 01（id: esc-01）
      - 聞いた 02 → 回答: 答え 02（id: esc-02）
      - 聞いた 03 → 回答: 答え 03（id: esc-03）
      - 聞いた 04 → 回答: 答え 04（id: esc-04）
      - 聞いた 05 → 回答: 答え 05（id: esc-05）
      - 聞いた 06 → 回答: 答え 06（id: esc-06）
      - 聞いた 07 → 回答: 答え 07（id: esc-07）
      - 聞いた 08 → 回答: 答え 08（id: esc-08）
      - 聞いた 09 → 回答: 答え 09（id: esc-09）
      - 聞いた 10 → 回答: 答え 10（id: esc-10）
      - 聞いた 11 → 回答: 答え 11（id: esc-11）
      - 聞いた 12 → 回答: 答え 12（id: esc-12）
      - 聞いた 13 → 回答: 答え 13（id: esc-13）
      - 聞いた 14 → 回答: 答え 14（id: esc-14）
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["escalation"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - ap-00（2026-11-01T08:59:00.000Z）確認 00
      - ap-01（2026-11-01T08:58:00.000Z）確認 01
      - ap-02（2026-11-01T08:57:00.000Z）確認 02
      - ap-03（2026-11-01T08:56:00.000Z）確認 03
      - ap-04（2026-11-01T08:55:00.000Z）確認 04
      - ap-05（2026-11-01T08:54:00.000Z）確認 05
      - ap-06（2026-11-01T08:53:00.000Z）確認 06
      - ap-07（2026-11-01T08:52:00.000Z）確認 07
      - ap-08（2026-11-01T08:51:00.000Z）確認 08
      - ap-09（2026-11-01T08:50:00.000Z）確認 09
      - ap-10（2026-11-01T08:49:00.000Z）確認 10
      - ap-11（2026-11-01T08:48:00.000Z）確認 11
      - ap-12（2026-11-01T08:47:00.000Z）確認 12
      - ap-13（2026-11-01T08:46:00.000Z）確認 13
      - ap-14（2026-11-01T08:45:00.000Z）確認 14
      - …ほか 1 件（\`approvals_list\` で全部見える）

      ## 記憶の更新
      - values（clone/write / 15→16 バイト）直した 15
      - values（clone/write / 14→15 バイト）直した 14
      - values（clone/write / 13→14 バイト）直した 13
      - values（clone/write / 12→13 バイト）直した 12
      - values（clone/write / 11→12 バイト）直した 11
      - values（clone/write / 10→11 バイト）直した 10
      - values（clone/write / 9→10 バイト）直した 09
      - values（clone/write / 8→9 バイト）直した 08
      - values（clone/write / 7→8 バイト）直した 07
      - values（clone/write / 6→7 バイト）直した 06
      - values（clone/write / 5→6 バイト）直した 05
      - values（clone/write / 4→5 バイト）直した 04
      - values（clone/write / 3→4 バイト）直した 03
      - values（clone/write / 2→3 バイト）直した 02
      - values（clone/write / 1→2 バイト）直した 01
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["memory_update"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## 届いた外部イベント
      この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を通さず直接書く行（source \`runner\` / \`boot-storage-footprint\` / \`boot-tool-search\`）も混ざる。
      - src-15: 届いた 15
      - src-14: 届いた 14
      - src-13: 届いた 13
      - src-12: 届いた 12
      - src-11: 届いた 11
      - src-10: 届いた 10
      - src-09: 届いた 09
      - src-08: 届いた 08
      - src-07: 届いた 07
      - src-06: 届いた 06
      - src-05: 届いた 05
      - src-04: 届いた 04
      - src-03: 届いた 03
      - src-02: 届いた 02
      - src-01: 届いた 01
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      **発行元（source）別の件数（正確な総数。上限 \`DIGEST_SOURCE_TALLY_LIMIT\`=32 発行元まで追跡する）**
      - src-00: 1 件
      - src-01: 1 件
      - src-02: 1 件
      - src-03: 1 件
      - src-04: 1 件
      - src-05: 1 件
      - src-06: 1 件
      - src-07: 1 件
      - src-08: 1 件
      - src-09: 1 件
      - src-10: 1 件
      - src-11: 1 件
      - src-12: 1 件
      - src-13: 1 件
      - src-14: 1 件
      - その他: 1 件（1 の発行元）

      **本文の形（保持した 16 件の標本。上の件数とは母数が違う）** —— 「本文の種類」は \`summary\` の完全一致で数える（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。
      - src-00: 同じ本文は 1 種。最も多い1種が 1 件
      - src-01: 同じ本文は 1 種。最も多い1種が 1 件
      - src-02: 同じ本文は 1 種。最も多い1種が 1 件
      - src-03: 同じ本文は 1 種。最も多い1種が 1 件
      - src-04: 同じ本文は 1 種。最も多い1種が 1 件
      - …ほか 11 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る）（source では絞れない。読み出した行を自分で source ごとに数える。ここは保持した標本の中の発行元数であって、総数ではない））

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      - 合計: $158.80
      - 出力トークン: 32,000 / 入力: 16,000 / キャッシュ読み: 48,000
      - モデル別: model-00 $10.00 / model-01 $9.99 / model-02 $9.98 / model-03 $9.97 / model-04 $9.96 / model-05 $9.95 / model-06 $9.94 / model-07 $9.93 / model-08 $9.92 / model-09 $9.91 / model-10 $9.90 / model-11 $9.89 / model-12 $9.88 / model-13 $9.87 / model-14 $9.86 / …ほか 1 件（\`usage_read\` に axis="model" を渡すと続きから辿れる）
      - 層別（誰が）: manager $158.80
      - 場所別（どこで）: session $158.80
      - 高かった委譲:
        - mgr-spend-00: $10.00
        - mgr-spend-01: $9.99
        - mgr-spend-02: $9.98
        - mgr-spend-03: $9.97
        - mgr-spend-04: $9.96
        - mgr-spend-05: $9.95
        - mgr-spend-06: $9.94
        - mgr-spend-07: $9.93
        - mgr-spend-08: $9.92
        - mgr-spend-09: $9.91
        - mgr-spend-10: $9.90
        - mgr-spend-11: $9.89
        - mgr-spend-12: $9.88
        - mgr-spend-13: $9.87
        - mgr-spend-14: $9.86
        - …ほか 1 本（\`usage_read\` に axis="manager" を渡すと続きから辿れる）
      - 推定値（請求明細ではない。詳しくは \`usage_read\`）"
    `);
  });

  it('同じ MAX_ITEMS + 1 件を trimHistory: false で（本文の形が MAX_ITEMS まで・窓より前の failed が1本ずつ。全文）', async () => {
    const text = await digestOf(await seedEverything(MAX_ITEMS + 1), { trimHistory: false });
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 16 / エスカレーション 16 / 委譲（この期間に動いた）48 本 / 自分で決めたこと 16 / 記憶の更新 16 / 外部イベント（日誌の行数）16 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 16

      ## 待ち行列の先頭
      - 待ち行列: 開いている 16 件（queued 16 / waiting 0 / needs_decision 0）
      - t-00（状態: queued（待ち行列） / origin: self）title-t-00
      - t-01（状態: queued（待ち行列） / origin: self）title-t-01
      - t-02（状態: queued（待ち行列） / origin: self）title-t-02
      - …ほか 13 件（task_list で全部見える）
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - kind-00（毎日 09:00（ローカル時刻））kind-00 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-01（毎日 09:00（ローカル時刻））kind-01 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-02（毎日 09:00（ローカル時刻））kind-02 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-03（毎日 09:00（ローカル時刻））kind-03 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-04（毎日 09:00（ローカル時刻））kind-04 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-05（毎日 09:00（ローカル時刻））kind-05 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-06（毎日 09:00（ローカル時刻））kind-06 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-07（毎日 09:00（ローカル時刻））kind-07 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-08（毎日 09:00（ローカル時刻））kind-08 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-09（毎日 09:00（ローカル時刻））kind-09 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-10（毎日 09:00（ローカル時刻））kind-10 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-11（毎日 09:00（ローカル時刻））kind-11 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-12（毎日 09:00（ローカル時刻））kind-12 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-13（毎日 09:00（ローカル時刻））kind-13 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - kind-14（毎日 09:00（ローカル時刻））kind-14 の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - …ほか 1 件（\`schedule_list\` で全部見える）

      ## マネージャー（走行中・返事待ちから先に出す）
      - run-00 [running/セッション不明] run-00 の依頼
      - run-01 [running/セッション不明] run-01 の依頼
      - run-02 [running/セッション不明] run-02 の依頼
      - run-03 [running/セッション不明] run-03 の依頼
      - run-04 [running/セッション不明] run-04 の依頼
      - run-05 [running/セッション不明] run-05 の依頼
      - run-06 [running/セッション不明] run-06 の依頼
      - run-07 [running/セッション不明] run-07 の依頼
      - run-08 [running/セッション不明] run-08 の依頼
      - run-09 [running/セッション不明] run-09 の依頼
      - run-10 [running/セッション不明] run-10 の依頼
      - run-11 [running/セッション不明] run-11 の依頼
      - run-12 [running/セッション不明] run-12 の依頼
      - run-13 [running/セッション不明] run-13 の依頼
      - run-14 [running/セッション不明] run-14 の依頼
      - …ほか 17 件（\`manager_list\` で状態を見る。あちらも入る分までで、残りの件数が本文に出る）
      - 手が止まっている担当（done・stopped）16 本: done-00, done-01, done-02, done-03, done-04, done-05, done-06, done-07, done-08, done-09, done-10, done-11, done-12, done-13, done-14 …ほか 1 件
      依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。

      ## 聞かずに決めたこと
      - 2026-11-01T08:44:00.000Z 決めた 15（根拠: 根拠）
      - 2026-11-01T08:45:00.000Z 決めた 14（根拠: 根拠）
      - 2026-11-01T08:46:00.000Z 決めた 13（根拠: 根拠）
      - 2026-11-01T08:47:00.000Z 決めた 12（根拠: 根拠）
      - 2026-11-01T08:48:00.000Z 決めた 11（根拠: 根拠）
      - 2026-11-01T08:49:00.000Z 決めた 10（根拠: 根拠）
      - 2026-11-01T08:50:00.000Z 決めた 09（根拠: 根拠）
      - 2026-11-01T08:51:00.000Z 決めた 08（根拠: 根拠）
      - 2026-11-01T08:52:00.000Z 決めた 07（根拠: 根拠）
      - 2026-11-01T08:53:00.000Z 決めた 06（根拠: 根拠）
      - 2026-11-01T08:54:00.000Z 決めた 05（根拠: 根拠）
      - 2026-11-01T08:55:00.000Z 決めた 04（根拠: 根拠）
      - 2026-11-01T08:56:00.000Z 決めた 03（根拠: 根拠）
      - 2026-11-01T08:57:00.000Z 決めた 02（根拠: 根拠）
      - 2026-11-01T08:58:00.000Z 決めた 01（根拠: 根拠）
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["decision"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## エスカレーション
      - 聞いた 00 → 回答: 答え 00（id: esc-00）
      - 聞いた 01 → 回答: 答え 01（id: esc-01）
      - 聞いた 02 → 回答: 答え 02（id: esc-02）
      - 聞いた 03 → 回答: 答え 03（id: esc-03）
      - 聞いた 04 → 回答: 答え 04（id: esc-04）
      - 聞いた 05 → 回答: 答え 05（id: esc-05）
      - 聞いた 06 → 回答: 答え 06（id: esc-06）
      - 聞いた 07 → 回答: 答え 07（id: esc-07）
      - 聞いた 08 → 回答: 答え 08（id: esc-08）
      - 聞いた 09 → 回答: 答え 09（id: esc-09）
      - 聞いた 10 → 回答: 答え 10（id: esc-10）
      - 聞いた 11 → 回答: 答え 11（id: esc-11）
      - 聞いた 12 → 回答: 答え 12（id: esc-12）
      - 聞いた 13 → 回答: 答え 13（id: esc-13）
      - 聞いた 14 → 回答: 答え 14（id: esc-14）
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["escalation"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - ap-00（2026-11-01T08:59:00.000Z）確認 00
      - ap-01（2026-11-01T08:58:00.000Z）確認 01
      - ap-02（2026-11-01T08:57:00.000Z）確認 02
      - ap-03（2026-11-01T08:56:00.000Z）確認 03
      - ap-04（2026-11-01T08:55:00.000Z）確認 04
      - ap-05（2026-11-01T08:54:00.000Z）確認 05
      - ap-06（2026-11-01T08:53:00.000Z）確認 06
      - ap-07（2026-11-01T08:52:00.000Z）確認 07
      - ap-08（2026-11-01T08:51:00.000Z）確認 08
      - ap-09（2026-11-01T08:50:00.000Z）確認 09
      - ap-10（2026-11-01T08:49:00.000Z）確認 10
      - ap-11（2026-11-01T08:48:00.000Z）確認 11
      - ap-12（2026-11-01T08:47:00.000Z）確認 12
      - ap-13（2026-11-01T08:46:00.000Z）確認 13
      - ap-14（2026-11-01T08:45:00.000Z）確認 14
      - …ほか 1 件（\`approvals_list\` で全部見える）

      ## 記憶の更新
      - values（clone/write / 15→16 バイト）直した 15
      - values（clone/write / 14→15 バイト）直した 14
      - values（clone/write / 13→14 バイト）直した 13
      - values（clone/write / 12→13 バイト）直した 12
      - values（clone/write / 11→12 バイト）直した 11
      - values（clone/write / 10→11 バイト）直した 10
      - values（clone/write / 9→10 バイト）直した 09
      - values（clone/write / 8→9 バイト）直した 08
      - values（clone/write / 7→8 バイト）直した 07
      - values（clone/write / 6→7 バイト）直した 06
      - values（clone/write / 5→6 バイト）直した 05
      - values（clone/write / 4→5 バイト）直した 04
      - values（clone/write / 3→4 バイト）直した 03
      - values（clone/write / 2→3 バイト）直した 02
      - values（clone/write / 1→2 バイト）直した 01
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["memory_update"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## 届いた外部イベント
      この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を通さず直接書く行（source \`runner\` / \`boot-storage-footprint\` / \`boot-tool-search\`）も混ざる。
      - src-15: 届いた 15
      - src-14: 届いた 14
      - src-13: 届いた 13
      - src-12: 届いた 12
      - src-11: 届いた 11
      - src-10: 届いた 10
      - src-09: 届いた 09
      - src-08: 届いた 08
      - src-07: 届いた 07
      - src-06: 届いた 06
      - src-05: 届いた 05
      - src-04: 届いた 04
      - src-03: 届いた 03
      - src-02: 届いた 02
      - src-01: 届いた 01
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      **発行元（source）別の件数（正確な総数。上限 \`DIGEST_SOURCE_TALLY_LIMIT\`=32 発行元まで追跡する）**
      - src-00: 1 件
      - src-01: 1 件
      - src-02: 1 件
      - src-03: 1 件
      - src-04: 1 件
      - src-05: 1 件
      - src-06: 1 件
      - src-07: 1 件
      - src-08: 1 件
      - src-09: 1 件
      - src-10: 1 件
      - src-11: 1 件
      - src-12: 1 件
      - src-13: 1 件
      - src-14: 1 件
      - その他: 1 件（1 の発行元）

      **本文の形（保持した 16 件の標本。上の件数とは母数が違う）** —— 「本文の種類」は \`summary\` の完全一致で数える（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。
      - src-00: 同じ本文は 1 種。最も多い1種が 1 件
      - src-01: 同じ本文は 1 種。最も多い1種が 1 件
      - src-02: 同じ本文は 1 種。最も多い1種が 1 件
      - src-03: 同じ本文は 1 種。最も多い1種が 1 件
      - src-04: 同じ本文は 1 種。最も多い1種が 1 件
      - src-05: 同じ本文は 1 種。最も多い1種が 1 件
      - src-06: 同じ本文は 1 種。最も多い1種が 1 件
      - src-07: 同じ本文は 1 種。最も多い1種が 1 件
      - src-08: 同じ本文は 1 種。最も多い1種が 1 件
      - src-09: 同じ本文は 1 種。最も多い1種が 1 件
      - src-10: 同じ本文は 1 種。最も多い1種が 1 件
      - src-11: 同じ本文は 1 種。最も多い1種が 1 件
      - src-12: 同じ本文は 1 種。最も多い1種が 1 件
      - src-13: 同じ本文は 1 種。最も多い1種が 1 件
      - src-14: 同じ本文は 1 種。最も多い1種が 1 件
      - …ほか 1 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る）（source では絞れない。読み出した行を自分で source ごとに数える。ここは保持した標本の中の発行元数であって、総数ではない））

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      - 合計: $158.80
      - 出力トークン: 32,000 / 入力: 16,000 / キャッシュ読み: 48,000
      - モデル別: model-00 $10.00 / model-01 $9.99 / model-02 $9.98 / model-03 $9.97 / model-04 $9.96 / model-05 $9.95 / model-06 $9.94 / model-07 $9.93 / model-08 $9.92 / model-09 $9.91 / model-10 $9.90 / model-11 $9.89 / model-12 $9.88 / model-13 $9.87 / model-14 $9.86 / …ほか 1 件（\`usage_read\` に axis="model" を渡すと続きから辿れる）
      - 層別（誰が）: manager $158.80
      - 場所別（どこで）: session $158.80
      - 高かった委譲:
        - mgr-spend-00: $10.00
        - mgr-spend-01: $9.99
        - mgr-spend-02: $9.98
        - mgr-spend-03: $9.97
        - mgr-spend-04: $9.96
        - mgr-spend-05: $9.95
        - mgr-spend-06: $9.94
        - mgr-spend-07: $9.93
        - mgr-spend-08: $9.92
        - mgr-spend-09: $9.91
        - mgr-spend-10: $9.90
        - mgr-spend-11: $9.89
        - mgr-spend-12: $9.88
        - mgr-spend-13: $9.87
        - mgr-spend-14: $9.86
        - …ほか 1 本（\`usage_read\` に axis="manager" を渡すと続きから辿れる）
      - 推定値（請求明細ではない。詳しくは \`usage_read\`）"
    `);
  });
});

describe('B1 要約の全文の固定 — 外部イベントの発行元の追跡上限', () => {
  it('発行元が DIGEST_SOURCE_TALLY_LIMIT を超える（超過の件数の行・その他・本文の形の省略。全文）', async () => {
    const stores = createMemoryStores();
    // 33 件: 追跡の上限（32）を超えて現れた発行元がちょうど 1 件
    for (let i = 0; i < 33; i += 1) {
      await journalAgo(stores, (i + 1) * 1000, {
        type: 'external_event',
        source: `src-${String(i).padStart(2, '0')}`,
        summary: `届いた ${String(i)}`,
      });
    }
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）33 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 届いた外部イベント
      この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を通さず直接書く行（source \`runner\` / \`boot-storage-footprint\` / \`boot-tool-search\`）も混ざる。
      - src-32: 届いた 32
      - src-31: 届いた 31
      - src-30: 届いた 30
      - src-29: 届いた 29
      - src-28: 届いた 28
      - src-27: 届いた 27
      - src-26: 届いた 26
      - src-25: 届いた 25
      - src-24: 届いた 24
      - src-23: 届いた 23
      - src-22: 届いた 22
      - src-21: 届いた 21
      - src-20: 届いた 20
      - src-19: 届いた 19
      - src-18: 届いた 18
      - …ほか 18 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      **発行元（source）別の件数（正確な総数。上限 \`DIGEST_SOURCE_TALLY_LIMIT\`=32 発行元まで追跡する）**
      - src-01: 1 件
      - src-02: 1 件
      - src-03: 1 件
      - src-04: 1 件
      - src-05: 1 件
      - src-06: 1 件
      - src-07: 1 件
      - src-08: 1 件
      - src-09: 1 件
      - src-10: 1 件
      - src-11: 1 件
      - src-12: 1 件
      - src-13: 1 件
      - src-14: 1 件
      - src-15: 1 件
      - その他: 17 件（17 の発行元）
      - 上限（\`DIGEST_SOURCE_TALLY_LIMIT\`）を超えて現れた発行元: 1 件（発行元の数は数えていない —— キー数に上限を置いている以上、数えるには上限を外すしかない）

      **本文の形（保持した 33 件の標本。上の件数とは母数が違う）** —— 「本文の種類」は \`summary\` の完全一致で数える（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。
      - src-00: 同じ本文は 1 種。最も多い1種が 1 件
      - src-01: 同じ本文は 1 種。最も多い1種が 1 件
      - src-02: 同じ本文は 1 種。最も多い1種が 1 件
      - src-03: 同じ本文は 1 種。最も多い1種が 1 件
      - src-04: 同じ本文は 1 種。最も多い1種が 1 件
      - …ほか 28 件（新しい側だけ出している。続きは \`journal_read\` に types=["external_event"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る）（source では絞れない。読み出した行を自分で source ごとに数える。ここは保持した標本の中の発行元数であって、総数ではない））

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });
});

describe('B1 要約の全文の固定 — 打ち切りの名乗りと保持の上限', () => {
  it('走査を DIGEST_JOURNAL_SCAN_LIMIT で打ち切った（名乗りが期間の次の行と、ツール実行の注記。全文）', async () => {
    const fake = createSyntheticJournalStore({
      total: DIGEST_JOURNAL_SCAN_LIMIT + 50,
      baseTimeMs: NOW_MS - MIN,
      entryAt: (index) => ({
        type: 'decision',
        decision: `decision-${String(index)}`,
        grounds: 'g',
      }),
    });
    const store = {
      ...fake.store,
      countToolUsesByActor: () =>
        Promise.resolve([
          { actor: 'clone', count: 7 },
          { actor: 'worker:mgr-1234abcd:worker', count: 123_456 },
        ]),
    };
    const text = await digestOf({ ...createMemoryStores(), journal: store });
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z
      ⚠ この期間の日誌が多く、走査を \`DIGEST_JOURNAL_SCAN_LIMIT\` 件で打ち切った。これより下の件数・一覧は、日誌の新しい側から読んだ範囲のものである（実際はもっと多い可能性がある）。新しい側から読んでいるので、新しいものは1件も落ちていない——足りないとすれば古い側である。ただし「ツール実行」の2つの件数は、この走査とは別に窓の全部を数えたもので、打ち切りの影響を受けない。

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 100000 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 123456 / 自分の手（委譲せず使った道具）7 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 聞かずに決めたこと
      - 2026-11-01T08:59:00.000Z decision-0（根拠: g）
      - 2026-11-01T08:58:59.999Z decision-1（根拠: g）
      - 2026-11-01T08:58:59.998Z decision-2（根拠: g）
      - 2026-11-01T08:58:59.997Z decision-3（根拠: g）
      - 2026-11-01T08:58:59.996Z decision-4（根拠: g）
      - 2026-11-01T08:58:59.995Z decision-5（根拠: g）
      - 2026-11-01T08:58:59.994Z decision-6（根拠: g）
      - 2026-11-01T08:58:59.993Z decision-7（根拠: g）
      - 2026-11-01T08:58:59.992Z decision-8（根拠: g）
      - 2026-11-01T08:58:59.991Z decision-9（根拠: g）
      - 2026-11-01T08:58:59.990Z decision-10（根拠: g）
      - 2026-11-01T08:58:59.989Z decision-11（根拠: g）
      - 2026-11-01T08:58:59.988Z decision-12（根拠: g）
      - 2026-11-01T08:58:59.987Z decision-13（根拠: g）
      - 2026-11-01T08:58:59.986Z decision-14（根拠: g）
      - …ほか 99985 件（新しい側だけ出している。続きは \`journal_read\` に types=["decision"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('エスカレーションが保持の上限に当たった（件数の行の次に注記が出る。全文）', async () => {
    const stores = createMemoryStores();
    // 201 件を別々の問いにする（保持の上限は 200）。切る側（MAX_ITEMS）の個別の問い合わせを減らすため、全部に回答を付ける
    const entries: JournalInput[] = [];
    for (let i = 0; i < 201; i += 1) {
      entries.push({
        type: 'escalation',
        question: `問い ${String(i)}`,
        approvalId: `esc-${String(i)}`,
        answer: `答え ${String(i)}`,
      });
    }
    const fake = createSyntheticJournalStore({
      total: entries.length,
      baseTimeMs: NOW_MS - MIN,
      entryAt: (index) => entries[index]!,
    });
    const text = await digestOf({
      ...stores,
      journal: {
        ...fake.store,
        countToolUsesByActor: () => Promise.resolve([]),
      },
    });
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 200 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0
      - ⚠ エスカレーションの件数は少なく出ている可能性がある（保持の上限に当たり、束ねた元の行を全部は読んでいない）

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## エスカレーション
      - 問い 0 → 回答: 答え 0（id: esc-0）
      - 問い 1 → 回答: 答え 1（id: esc-1）
      - 問い 2 → 回答: 答え 2（id: esc-2）
      - 問い 3 → 回答: 答え 3（id: esc-3）
      - 問い 4 → 回答: 答え 4（id: esc-4）
      - 問い 5 → 回答: 答え 5（id: esc-5）
      - 問い 6 → 回答: 答え 6（id: esc-6）
      - 問い 7 → 回答: 答え 7（id: esc-7）
      - 問い 8 → 回答: 答え 8（id: esc-8）
      - 問い 9 → 回答: 答え 9（id: esc-9）
      - 問い 10 → 回答: 答え 10（id: esc-10）
      - 問い 11 → 回答: 答え 11（id: esc-11）
      - 問い 12 → 回答: 答え 12（id: esc-12）
      - 問い 13 → 回答: 答え 13（id: esc-13）
      - 問い 14 → 回答: 答え 14（id: esc-14）
      - …ほか 185 件（新しい側だけ出している。続きは \`journal_read\` に types=["escalation"] と until を渡して掘る（あちらも予算で打ち切り、残りの件数が本文に出る））

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });
});

describe('B1 要約の全文の固定 — 件数の形（counts。定期の依頼の tick）', () => {
  it('何も無い（全文）', async () => {
    expect(await digestOf(createMemoryStores(), { shape: 'counts' })).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 回答待ち 0 / エスカレーション 0 / 聞かずに決めたこと 0 / 記憶の更新 0 / 外部イベント 0 / 人間からの発言 0
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）
      （#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— 待ち行列は \`task_list\`、回答待ちは \`approvals_list\`、決めたこと・エスカレーション・記憶の更新・外部イベントは \`journal_read\`、使った分は \`usage_read\`）"
    `);
  });

  it('全部入り（継続中の依頼・マネージャーの畳み・読めない行・打ち切りの名乗り。全文）', async () => {
    const stores = createMemoryStores();
    await putSchedule(stores, 'issue-round');
    await putJob(stores, 'mgr-run', 'running');
    await putJob(stores, 'mgr-done', 'done');
    await putJob(stores, 'mgr-old-failed', 'failed', {
      lastFailure: { code: 'old', via: 'sdk', at: ago(14 * DAY) },
    });
    await addTask(stores, 't-1');
    await addTask(stores, 't-2', 'waiting');
    // 各項目の件数を互いに違う値にする（件数の行の項目の取り違えを見つけるため）: 回答待ち 3 / エスカレーション 2 / 決めたこと 4 / 記憶 5 / 外部 6 / 人間の発言 7
    for (let i = 0; i < 3; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-${String(i)}`,
        createdAt: ago(MIN),
        question: '確認',
      });
    }
    for (let i = 0; i < 7; i += 1) {
      await journalAgo(stores, MIN, {
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `やあ ${String(i)}`,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      await journalAgo(stores, MIN, {
        type: 'decision',
        decision: `決めた ${String(i)}`,
        grounds: '根拠',
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await journalAgo(stores, MIN, {
        type: 'escalation',
        question: `聞いた ${String(i)}`,
        approvalId: `esc-${String(i)}`,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await journalAgo(stores, MIN, {
        type: 'memory_update',
        slug: 'values',
        cause: 'clone',
        summary: `直した ${String(i)}`,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      await journalAgo(stores, MIN, {
        type: 'external_event',
        source: 'ci',
        summary: `届いた ${String(i)}`,
      });
    }
    stores.jobs.listUnreadableJobs = () => Promise.resolve([{ id: 'mgr-bad', reason: '不正' }]);
    const original = stores.jobs.listApprovals.bind(stores.jobs);
    stores.jobs.listApprovals = async (options) => ({
      ...(await original(options)),
      unreadable: [{ id: 'ap-bad', reason: '不正な欄' }],
    });
    const originalTasks = stores.tasks.list.bind(stores.tasks);
    stores.tasks.list = async (options) => ({
      ...(await originalTasks(options)),
      unreadable: [{ id: 't-bad', reason: '不正な欄' }, { reason: '不正な行' }],
    });
    expect(await digestOf(stores, { shape: 'counts' })).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - issue-round（毎日 09:00（ローカル時刻））issue-round の依頼
        前回動いた時刻: （まだ一度も動いていない）

      ## マネージャー（走行中・返事待ちから先に出す）
      - mgr-run [running/セッション不明] mgr-run の依頼
      - 手が止まっている担当（done・stopped）1 本: mgr-done
      依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。
      - 終端して窓より前の failed 1 本: mgr-old-failed
      失敗の中身と依頼・報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。
      - 読めない委譲が 1 件ある（id: mgr-bad）。壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。

      - 回答待ち 3 / エスカレーション 2 / 聞かずに決めたこと 4 / 記憶の更新 5 / 外部イベント 6 / 人間からの発言 7
      - 待ち行列: 開いている 2 件（queued 1 / waiting 1 / needs_decision 0）
      - 読めない行（壊れた行。上の件数には入っていない）: 承認待ち 1 / 待ち行列の task 2
      （#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— 待ち行列は \`task_list\`、回答待ちは \`approvals_list\`、決めたこと・エスカレーション・記憶の更新・外部イベントは \`journal_read\`、使った分は \`usage_read\`）"
    `);
  });

  it('読めない行は承認待ちか待ち行列の片方だけ（読めない行の1行が「/」で繋がない。全文）', async () => {
    const stores = createMemoryStores();
    const original = stores.jobs.listApprovals.bind(stores.jobs);
    stores.jobs.listApprovals = async (options) => ({
      ...(await original(options)),
      unreadable: [{ id: 'ap-bad', reason: '不正な欄' }],
    });
    expect(await digestOf(stores, { shape: 'counts' })).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 回答待ち 0 / エスカレーション 0 / 聞かずに決めたこと 0 / 記憶の更新 0 / 外部イベント 0 / 人間からの発言 0
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）
      - 読めない行（壊れた行。上の件数には入っていない）: 承認待ち 1
      （#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— 待ち行列は \`task_list\`、回答待ちは \`approvals_list\`、決めたこと・エスカレーション・記憶の更新・外部イベントは \`journal_read\`、使った分は \`usage_read\`）"
    `);
  });
});

describe('B1 要約の全文の固定 — 長い本文の切り詰め・滞留の行・窓の境目', () => {
  const long = (label: string): string => `${label}${'あ'.repeat(300)}`;

  it('各欄の長い本文を切る（依頼・報告・失敗の code/via・決めたこと・根拠・問い・回答・記憶・外部イベント・継続中の依頼・回答待ち。全文）', async () => {
    const stores = createMemoryStores();
    await putSchedule(stores, 'long-kind');
    await stores.schedules.put({
      kind: 'long-schedule',
      spec: { type: 'daily', at: '09:00' },
      request: long('継続中の依頼'),
      createdAt: ago(5 * DAY),
      updatedAt: ago(5 * DAY),
    });
    await putJob(stores, 'mgr-long', 'failed', {
      request: long('依頼'),
      lastReport: long('報告'),
      lastFailure: { code: `code-${'c'.repeat(100)}`, via: `via-${'v'.repeat(100)}`, at: ago(MIN) },
    });
    await stores.jobs.putApproval({
      id: 'ap-long',
      createdAt: ago(2 * MIN),
      question: long('確認'),
    });
    await journalAgo(stores, 3 * MIN, {
      type: 'decision',
      decision: long('決めたこと'),
      grounds: long('根拠'),
    });
    await journalAgo(stores, 4 * MIN, {
      type: 'escalation',
      question: long('聞いたこと'),
      approvalId: 'esc-long',
      answer: long('答え'),
    });
    await journalAgo(stores, 5 * MIN, {
      type: 'escalation',
      question: long('取り下げた問い'),
      approvalId: 'esc-long-withdrawn',
      withdrawnAt: ago(5 * MIN),
      withdrawnReason: long('理由'),
    });
    await journalAgo(stores, 6 * MIN, {
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: 1,
      bytesAfter: 2,
      summary: long('記憶'),
    });
    await journalAgo(stores, 7 * MIN, {
      type: 'external_event',
      source: 'ci',
      summary: long('外部'),
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 1 / エスカレーション 2 / 委譲（この期間に動いた）1 本 / 自分で決めたこと 1 / 記憶の更新 1 / 外部イベント（日誌の行数）1 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 2

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - long-kind（毎日 09:00（ローカル時刻））long-kind の依頼
        前回動いた時刻: （まだ一度も動いていない）
      - long-schedule（毎日 09:00（ローカル時刻））継続中の依頼ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（106 文字省略。全 306 文字）
        前回動いた時刻: （まだ一度も動いていない）

      ## マネージャー（走行中・返事待ちから先に出す）
      - mgr-long [failed/セッション不明] 依頼ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（102 文字省略。全 302 文字）
        直近の報告: 報告ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（102 文字省略。全 302 文字）
        ⚠ 直近のターンは失敗で終わっている: code-ccccccccccccccccccccccccccccccccccccccccccccccccccccccc…（45 文字省略。全 105 文字）（via: via-vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv…（44 文字省略。全 104 文字）, 2026-11-01T08:59:00.000Z）。全文と次の一手は \`manager_list\` / \`manager_report\` で見る。

      ## 聞かずに決めたこと
      - 2026-11-01T08:57:00.000Z 決めたことあああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（105 文字省略。全 305 文字）（根拠: 根拠ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（222 文字省略。全 302 文字））

      ## エスカレーション
      - 聞いたことあああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（105 文字省略。全 305 文字） → 回答: 答えああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（222 文字省略。全 302 文字）（id: esc-long）
      - 取り下げた問いあああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（107 文字省略。全 307 文字） → 取り下げ: 理由ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（222 文字省略。全 302 文字）（id: esc-long-withdrawn）

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - ap-long（2026-11-01T08:58:00.000Z）確認ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（102 文字省略。全 302 文字）

      ## 記憶の更新
      - values（clone/write / 1→2 バイト）記憶ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（182 文字省略。全 302 文字）

      ## 届いた外部イベント
      この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を通さず直接書く行（source \`runner\` / \`boot-storage-footprint\` / \`boot-tool-search\`）も混ざる。
      - ci: 外部ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（182 文字省略。全 302 文字）

      **発行元（source）別の件数（正確な総数。上限 \`DIGEST_SOURCE_TALLY_LIMIT\`=32 発行元まで追跡する）**
      - ci: 1 件

      **本文の形（保持した 1 件の標本。上の件数とは母数が違う）** —— 「本文の種類」は \`summary\` の完全一致で数える（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。
      - ci: 同じ本文は 1 種。最も多い1種が 1 件

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('待ち行列の先頭: 決めてほしい（needs_decision）の古い1件で滞留の行が出る。時計は止めた値（全文）', async () => {
    const stores = createMemoryStores();
    await addTask(stores, 'q-1');
    await stores.tasks.add({
      id: 'n-1',
      createdAt: ago(9 * DAY),
      updatedAt: ago(4 * DAY + 5 * 60 * MIN),
      status: 'needs_decision',
      origin: 'human',
      title: 'title-n-1',
      body: 'body-n-1',
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 2 件（queued 1 / waiting 0 / needs_decision 1）
      - 滞留: needs_decision 1 件（最も古いのは 4日5時間前）
      - n-1（状態: needs_decision（決めてほしい） / origin: human）title-n-1
      - q-1（状態: queued（待ち行列） / origin: self）title-q-1
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('窓の境目: 終わり（含まない）・始まり・ツール実行の層分け・人間の発言（全文）', async () => {
    const stores = createMemoryStores();
    // 終わり（until = NOW）ちょうどの行は含めず、1ms 前は含める
    await journalAgo(stores, 0, { type: 'decision', decision: '終わりちょうど', grounds: 'g' });
    await journalAgo(stores, 1, { type: 'decision', decision: '終わりの1ms前', grounds: 'g' });
    await journalAgo(stores, 0, {
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '終わりちょうどの発言',
    });
    await journalAgo(stores, 1, {
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '終わりの1ms前の発言',
    });
    await journalAgo(stores, 2, {
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '返事（数えない）',
    });
    await journalAgo(stores, 3, {
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'マネージャーの発言（数えない）',
    });
    for (const actor of ['clone', 'clone:distill', 'manager:mgr-1', 'worker:mgr-1:worker']) {
      await journalAgo(stores, 5, { type: 'tool_use', actor, tool: 'Bash', input: {} });
    }
    // 終わりちょうどの tool_use は数えず、1ms 前は数える（口の until は含む側なので、1ms 引いて渡している）
    await journalAgo(stores, 0, { type: 'tool_use', actor: 'clone', tool: 'Edit', input: {} });
    await journalAgo(stores, 1, {
      type: 'tool_use',
      actor: 'manager:mgr-2',
      tool: 'Edit',
      input: {},
    });
    // 始まり（since）ちょうどと1ms 前
    await journalAgo(stores, NOW_MS - SINCE.getTime(), {
      type: 'decision',
      decision: '始まりちょうど',
      grounds: 'g',
    });
    await journalAgo(stores, NOW_MS - SINCE.getTime() + 1, {
      type: 'decision',
      decision: '始まりの1ms前',
      grounds: 'g',
    });
    // マネージャーの窓: 始まりちょうどの done は出る（畳まれる）、1ms 前の done は出ない、1ms 前でも走行中は出る
    await putJob(stores, 'mgr-at-since', 'done', { updatedAt: SINCE.toISOString() });
    await putJob(stores, 'mgr-before-since', 'done', {
      updatedAt: new Date(SINCE.getTime() - 1).toISOString(),
    });
    await putJob(stores, 'mgr-before-since-running', 'running', {
      updatedAt: new Date(SINCE.getTime() - 1).toISOString(),
    });
    expect(await buildActivityDigest(stores, { since: SINCE, until: new Date(NOW) }))
      .toMatchInlineSnapshot(`
        "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.000Z

        - 件数: 人間の発言 1 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）2 本 / 自分で決めたこと 2 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 3 / 自分の手（委譲せず使った道具）2 / 継続中の依頼 0

        ## 待ち行列の先頭
        - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

        ## マネージャー（走行中・返事待ちから先に出す）
        - mgr-before-since-running [running/セッション不明] mgr-before-since-running の依頼
        - 手が止まっている担当（done・stopped）1 本: mgr-at-since
        依頼と直近の報告は、ここには載せていない。\`manager_list\`（\`q\` で依頼文から探せる）/ \`manager_report\`（依頼文・報告の全文）で引ける。

        ## 聞かずに決めたこと
        - 2026-10-31T15:00:00.000Z 始まりちょうど（根拠: g）
        - 2026-11-01T08:59:59.999Z 終わりの1ms前（根拠: g）

        ## 使った分
        （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
        （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
      `);
  });
});

describe('B1 要約の全文の固定 — 1件だけの節と、counts の打ち切りの名乗り', () => {
  it('エスカレーションが束ねて1件だけ（見出しと1行。件数の境目の 0 / 1 / 2。全文）', async () => {
    const stores = createMemoryStores();
    await journalAgo(stores, 2 * MIN, {
      type: 'escalation',
      question: '聞いた',
      approvalId: 'esc-only',
    });
    await journalAgo(stores, MIN, {
      type: 'escalation',
      question: '聞いた',
      approvalId: 'esc-only',
      answer: '答え',
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 1 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## エスカレーション
      - 聞いた → 回答: 答え（id: esc-only）

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });

  it('counts の形でも走査を打ち切った名乗りが期間の次の行に出る（全文）', async () => {
    const fake = createSyntheticJournalStore({
      total: DIGEST_JOURNAL_SCAN_LIMIT + 50,
      baseTimeMs: NOW_MS - MIN,
      entryAt: (index) => ({
        type: 'decision',
        decision: `decision-${String(index)}`,
        grounds: 'g',
      }),
    });
    const text = await digestOf(
      {
        ...createMemoryStores(),
        journal: { ...fake.store, countToolUsesByActor: () => Promise.resolve([]) },
      },
      { shape: 'counts' },
    );
    expect(text).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z
      ⚠ この期間の日誌が多く、走査を \`DIGEST_JOURNAL_SCAN_LIMIT\` 件で打ち切った。これより下の件数・一覧は、日誌の新しい側から読んだ範囲のものである（実際はもっと多い可能性がある）。新しい側から読んでいるので、新しいものは1件も落ちていない——足りないとすれば古い側である。

      - 回答待ち 0 / エスカレーション 0 / 聞かずに決めたこと 100000 / 記憶の更新 0 / 外部イベント 0 / 人間からの発言 0
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）
      （#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— 待ち行列は \`task_list\`、回答待ちは \`approvals_list\`、決めたこと・エスカレーション・記憶の更新・外部イベントは \`journal_read\`、使った分は \`usage_read\`）"
    `);
  });
});

describe('B1 要約の全文の固定 — 全体の形で読めない行の断りだけが在る', () => {
  it('読めない承認待ち・継続中の依頼・委譲が1行ずつ（件数の行の下に3行、各節に断り。全文）', async () => {
    const stores = createMemoryStores();
    stores.jobs.listUnreadableJobs = () => Promise.resolve([{ id: 'mgr-bad', reason: '不正' }]);
    const original = stores.jobs.listApprovals.bind(stores.jobs);
    stores.jobs.listApprovals = async (options) => ({
      ...(await original(options)),
      unreadable: [{ id: 'ap-bad', reason: '不正な欄' }],
    });
    const originalSchedules = stores.schedules.list.bind(stores.schedules);
    stores.schedules.list = async () => ({
      ...(await originalSchedules()),
      unreadable: [{ kind: 'broken', reason: '不正な欄: spec' }],
    });
    expect(await digestOf(stores)).toMatchInlineSnapshot(`
      "期間: 2026-10-31T15:00:00.000Z 〜 2026-11-01T09:00:00.001Z

      - 件数: 人間の発言 0 / 回答待ち 0 / エスカレーション 0 / 委譲（この期間に動いた）0 本 / 自分で決めたこと 0 / 記憶の更新 0 / 外部イベント（日誌の行数）0 / 委譲側のツール実行 0 / 自分の手（委譲せず使った道具）0 / 継続中の依頼 0
      - 読めない委譲（壊れた行。上の本数には入っていない）: 1 件
      - 読めない承認待ち（壊れた行。上の件数には入っていない）: 1 件
      - 読めない継続中の依頼（壊れた行。上の件数には入っていない）: 1 件

      ## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）
      - 読めない継続中の依頼が 1 件ある（kind: broken）。壊れた行であって、消された依頼ではない。この一覧には載っていない。kind が分かるものは schedule_remove kind=<kind> で外せる。

      ## マネージャー（走行中・返事待ちから先に出す）
      - 読めない委譲が 1 件ある（id: mgr-bad）。壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。

      ## 人間の回答待ち（保留中。他の仕事は進めてよい）
      - 読めない承認待ちが 1 件ある（id: ap-bad）。壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。

      ## 使った分
      （台帳は日ごとに持つので、2026-11-01 の日ぶんの合計。上の期間より広い）
      （台帳にまだ記録が無い。この機能を入れる前の分は残っていない）"
    `);
  });
});
