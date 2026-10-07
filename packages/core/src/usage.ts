import { z } from 'zod';

import {
  CLONE_ACTOR_ID,
  USAGE_DATE_PATTERN,
  USAGE_ESTIMATE_NOTICE,
  USAGE_LAYERS,
  USAGE_SITES,
  USAGE_UNREADABLE_FIELDS,
  ZERO_USAGE,
  isRealUsageDate,
} from './usage-format.js';
import type {
  UnreadableUsageRow,
  UsageUnreadableCounts,
  UsageUnreadableField,
} from './usage-format.js';
import { settleWithin } from './usage-probe.js';

// 台帳（自分で数えた推定値）とアカウント全体の残り枠・支出上限（向こうが言っている値、`usage-snapshot.ts`）を足したり混ぜたりしない: 一致する保証がないため
// 出所は `modelUsage` で `usage` ではない: **「MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer modelUsage for token/cost accounting」** [sdk-verbatim SDKResultSuccess.usage] で、`usage` を採ると委譲の末端である作業者の消費が丸ごと落ちるため
// 累積値を足さず差分を取る: **「cumulative across turns in streaming-input sessions — each result carries the running total so far, so read the latest result rather than summing across results」** [sdk-verbatim SDKResultSuccess.total_cost_usd] で、足すと二重計上になるため
// 減少は数え直しとして扱う（resume と /clear で累積が 0 から始まりうる）:
// - 「a resumed or forked session continues from the total its transcript saved, when it has one」 [sdk-verbatim SDKResultSuccess.total_cost_usd]
// - 「a mid-session /clear resets the running total」 [sdk-verbatim SDKResultSuccess.total_cost_usd]
// 成功した `result` の値しか台帳へ入れない: **「Crash/startup-error results may carry zeroed values」** [sdk-verbatim SDKResultSuccess.total_cost_usd] で、ゼロを累積が 0 になったと採ると記録済みの消費が消えるため
// 推定値の一文を落とさない: **「An estimate, not a billing statement」** [sdk-verbatim SDKResultSuccess.total_cost_usd] と明記されており、数字を見せる口は {@link USAGE_ESTIMATE_NOTICE} を運ぶ
export {
  ACCOUNT_USAGE_TITLE,
  CLONE_ACTOR_ID,
  USAGE_DATE_PATTERN,
  USAGE_ESTIMATE_NOTICE,
  USAGE_UNREADABLE_FIELDS,
  isRealUsageDate,
  ZERO_USAGE,
  addUnreadableCounts,
  describeAccountUsage,
  describeUnmeteredUsage,
  describeUnreadableUsage,
  describeUnreadableUsageRows,
  describeUnrecordedManagers,
  describeUsageDateOrder,
  describeWebSearchRequests,
  findUnrecordedManagers,
  formatUsd,
  isDelegationActorId,
  sumUsageRows,
  summarizeUsage,
  usageDate,
  type UnreadableUsageRow,
  type UnrecordedManager,
  type UnrecordedManagerCandidate,
  type UsageUnreadableCounts,
  type UsageUnreadableField,
} from './usage-format.js';

const isoDateTime = z.string().datetime({ offset: true });

export const usageDateSchema = z
  .string()
  .regex(USAGE_DATE_PATTERN, 'YYYY-MM-DD で書く')
  .refine(isRealUsageDate, '実在する日付（YYYY-MM-DD）で書く');

// 全欄 optional: 欄が無いのは「数えていない」であって 0 ではなく、同じ値で表すと取れない軸に 0 の行を作る壊れ方になるため
export const usageUnreadableCountsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    webSearchRequests: z.number().int().nonnegative(),
    costUsd: z.number().int().nonnegative(),
  })
  .partial() satisfies z.ZodType<UsageUnreadableCounts>;

// `contextWindow` / `maxOutputTokens` を持たない: モデルの仕様であって消費量ではなく、台帳に混ぜると集計で足されうるため
export const usageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  webSearchRequests: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  // 必ず optional: runner とデーモンの版が一時的にずれても、この欄を知らない側の schema が落ちないため。欄が無いのは「読めなかった区切りが無い」ではなく「数えていない」
  unreadable: usageUnreadableCountsSchema.optional(),
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

// モデル名を層の代わりに使わない: 既定でクローンとマネージャーはどちらも opus で、台帳上で同じ `model` に並ぶため
// `worker` という値を作らない: 作業者の消費はマネージャーの `result.modelUsage` に合算されて降りてくる（「every model call made through the query pipeline during this query() call — main loop, Task subagents, sidechains, and internal calls such as compaction」 [sdk-verbatim SDKResultSuccess.modelUsage]）。分けて出す口が無く、0 を積むと「作業者は使っていない」と読めるため
export const usageLayerSchema = z.enum(USAGE_LAYERS);

export type UsageLayer = z.infer<typeof usageLayerSchema>;

// `compaction` という値を作らない: 「internal calls such as compaction」 [sdk-verbatim SDKResultSuccess.modelUsage] が `modelUsage` に含まれ、分けて出す口が無く、合図の側にトークン単価も費用も載っていないため
// `distill` を要約そのものの費用と読み替えない: 蒸留は記憶へ移すための独立したターンで、混ぜると取れていないものを取れたことにするため
// `pre_tokens` に単価を掛けて推定しない: SDK が推定と言っている計算を二重に推定し直すことになるため
// 台帳の合計は alteroid が使った分の全部ではない: 「Internal helper calls outside the query pipeline (e.g. the permission classifier, token-count probes) are excluded」 [sdk-verbatim SDKResultSuccess.modelUsage]
export const usageSiteSchema = z.enum(USAGE_SITES);

export type UsageSite = z.infer<typeof usageSiteSchema>;

// `clone:sub:<agent>` として区別する: 分けないと「自分でやったのか委ねたのか」の問いに嘘の数が返るため
export const CLONE_SUB_ACTOR_PREFIX = `${CLONE_ACTOR_ID}:sub:`;

// 蒸留は別の SDK セッションなので分けて名乗る: 混ぜると「会話の中で自分で動いた」と「記憶へ移すために動いた」が同じ数になるため
export const CLONE_DISTILL_ACTOR_ID = `${CLONE_ACTOR_ID}:distill`;

// `=== CLONE_ACTOR_ID` で書かない: 増えた枝が「委譲した量」の側へ落ちて、委譲の判断に使う数が静かにずれるため
export function isCloneActor(actor: string): boolean {
  return actor === CLONE_ACTOR_ID || actor.startsWith(`${CLONE_ACTOR_ID}:`);
}

// `site` から導出しない: 累積は `query()` 呼び出しの寿命で閉じる（「Per-model totals for every model call made through the query pipeline during this query() call」 [sdk-verbatim SDKResultSuccess.modelUsage]）ので、同じ `site` でも寿命の違う呼び出しがありうるため
export const usageAccumulationSchema = z.enum(['cumulative', 'oneshot']);

export type UsageAccumulation = z.infer<typeof usageAccumulationSchema>;

// 差分を runner で作らない: イベントが再送されたときに二重計上になるため。累積値なら同じものが2回届いても増分が 0 になるだけで済む
export const usageSnapshotSchema = z.object({
  // これで数え直しを判定しない: resume は同じ session id のまま累積を 0 に戻すため
  sessionId: z.string().optional(),
  models: z.record(z.string(), usageTotalsSchema),
});

export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

// 基準の鍵を「層 × actor」にする: actor の id だけだと、層をまたいで同じ id が来たときに別の累積が1つの基準を共有し、差分がまるごと嘘になるため
export const usageBaselineSchema = z.object({
  layer: usageLayerSchema,
  managerId: z.string(),
  sessionId: z.string().optional(),
  models: z.record(z.string(), usageTotalsSchema),
  updatedAt: isoDateTime,
  resets: z.number().int().nonnegative(),
  lastResetAt: isoDateTime.optional(),
  // 古い runner の累積を `models`（現役の runner の高さ）へ畳まない: 小さい基準に対する大きい累積が全量の数え直しになり、記録済みの分を二重に数えるため。無い（`undefined`）のは「覚えていない」で、積まない側に倒す
  byRunner: z.record(z.string(), z.record(z.string(), usageTotalsSchema)).optional(),
});

export type UsageBaseline = z.infer<typeof usageBaselineSchema>;

// 黙って数え直さない: 後から「なぜ集計が飛んでいるか」が分からなくなるため
export const usageResetSchema = z.object({
  at: isoDateTime,
  fromCostUsd: z.number().nonnegative(),
  toCostUsd: z.number().nonnegative(),
  fromSessionId: z.string().optional(),
  toSessionId: z.string().optional(),
});

export type UsageReset = z.infer<typeof usageResetSchema>;

export interface UsageFold {
  delta: Record<string, UsageTotals>;
  baseline: UsageBaseline | null;
  reset?: UsageReset;
  skipped?:
    { reason: 'unknown-runner' } | { reason: 'decreased'; fromCostUsd: number; toCostUsd: number };
}

export interface UsageRecordRunner {
  readonly id: string;
  readonly superseded: boolean;
}

function sumCostUsd(models: Record<string, UsageTotals>): number {
  return Object.values(models).reduce((sum, m) => sum + m.costUsd, 0);
}

// session id は見ない: resume は同じ id のまま 0 に戻るため
function detectReset(
  prev: Record<string, UsageTotals>,
  next: Record<string, UsageTotals>,
): boolean {
  for (const [model, before] of Object.entries(prev)) {
    const after = next[model];
    if (after === undefined) return true;
    if (
      after.inputTokens < before.inputTokens ||
      after.outputTokens < before.outputTokens ||
      after.cacheReadInputTokens < before.cacheReadInputTokens ||
      after.cacheCreationInputTokens < before.cacheCreationInputTokens ||
      after.webSearchRequests < before.webSearchRequests ||
      after.costUsd < before.costUsd
    ) {
      return true;
    }
  }
  return false;
}

function subtract(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadInputTokens: Math.max(0, after.cacheReadInputTokens - before.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(
      0,
      after.cacheCreationInputTokens - before.cacheCreationInputTokens,
    ),
    webSearchRequests: Math.max(0, after.webSearchRequests - before.webSearchRequests),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
    // `unreadable` の差分を取らず今回の読みをそのまま渡す: 「この読み取りで読めたか」は毎回独立の観測で、差分を取ると2回目の読めなかった事実が消えるため
    ...(after.unreadable === undefined ? {} : { unreadable: after.unreadable }),
  };
}

function hasUnreadable(totals: UsageTotals): boolean {
  const counts = totals.unreadable;
  if (counts === undefined) return false;
  return USAGE_UNREADABLE_FIELDS.some((field) => (counts[field] ?? 0) > 0);
}

// `unreadable` も見る: 見ないと「トークンは全部0だが web 検索の欄だけ読めなかった」行が delta から消え、読めなかった観測そのものが消えるため
function isZero(totals: UsageTotals): boolean {
  return isNumericZero(totals) && !hasUnreadable(totals);
}

function isNumericZero(totals: UsageTotals): boolean {
  return (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.cacheReadInputTokens === 0 &&
    totals.cacheCreationInputTokens === 0 &&
    totals.webSearchRequests === 0 &&
    totals.costUsd === 0
  );
}

function withoutUnreadable(totals: UsageTotals): UsageTotals {
  const copy: UsageTotals = { ...totals };
  delete copy.unreadable;
  return copy;
}

// 述語を書き写さない: 台帳へ畳む側と runner（`#flushUsage`）の2か所が読み、片方だけ直すとゼロの扱いが層で食い違うため
export function hasAnyUsage(models: Record<string, UsageTotals>): boolean {
  return Object.values(models).some((totals) => !isZero(totals));
}

// 数え直しの増分を 0 にせず全量にする: 新しい累積は 0 から始まっており、載っている分はまだ台帳に無い消費で、0 にすると resume 後の1ターンぶんが黙って消えるため
// 全部ゼロのスナップショットは情報なしとして捨てる（基準を持っているとき）: 「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd] で、数え直しとして採ると基準が 0 まで下がり、次の本物の累積がまるごと増分になって二重計上になるため。累積値なので捨てても取りこぼさない
export function foldUsageSnapshot(
  baseline: UsageBaseline | null,
  snapshot: UsageSnapshot,
  at: string,
): UsageFold {
  const prev = baseline?.models ?? {};
  const next = snapshot.models;

  if (baseline !== null && hasAnyUsage(prev) && !hasAnyUsage(next)) {
    return { delta: {}, baseline };
  }

  const reset = baseline !== null && detectReset(prev, next);

  const delta: Record<string, UsageTotals> = {};
  for (const [model, totals] of Object.entries(next)) {
    const raw = reset ? totals : subtract(totals, prev[model] ?? ZERO_USAGE);
    // 再送と区別できない読みでは `unreadable` を数えない: 同じ累積をもう一度送ると `unreadable` だけが増分に残り、トークンが 0 で「読めなかった」だけの行がもう1本積まれるため
    const increment =
      !reset && prev[model] !== undefined && isNumericZero(raw) ? withoutUnreadable(raw) : raw;
    if (!isZero(increment)) delta[model] = increment;
  }

  return {
    delta,
    baseline: {
      // 層を純関数の側で推測しない: 推測させると「どの層の基準か」が2か所で決まるため。呼び出し側が後から入れる
      layer: baseline?.layer ?? 'manager',
      managerId: baseline?.managerId ?? '',
      sessionId: snapshot.sessionId ?? baseline?.sessionId,
      models: next,
      updatedAt: at,
      resets: (baseline?.resets ?? 0) + (reset ? 1 : 0),
      lastResetAt: reset ? at : baseline?.lastResetAt,
    },
    reset: reset
      ? {
          at,
          fromCostUsd: sumCostUsd(prev),
          toCostUsd: sumCostUsd(next),
          fromSessionId: baseline?.sessionId,
          toSessionId: snapshot.sessionId,
        }
      : undefined,
  };
}

export interface UsageRecordTicket {
  turn(): Promise<void>;
  release(): void;
}

// 札はイベントを受けた時点で同期的に（最初の `await` より前に）取る: `await` の後で取ると取る順が届いた順でなくなり、逆順に届いた累積を過大に数える
// `release` は `finally` に置く: 置かないとその札より後ろの `record` が永久に止まる。キーが違えば待たない: 無関係な manager 同士を直列にしないため
export class UsageRecordOrder {
  readonly #tails = new Map<string, Promise<void>>();

  ticket(key: string): UsageRecordTicket {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((resolve) => {
      open = resolve;
    });
    const tail = previous.then(() => mine);
    this.#tails.set(key, tail);
    let released = false;
    return {
      turn: () => previous,
      release: () => {
        if (released) return;
        released = true;
        open();
        void tail.then(() => {
          if (this.#tails.get(key) === tail) this.#tails.delete(key);
        });
      },
    };
  }
}

// 3実装（インメモリ / fs / pg）が同じ関数を通す: 差分の計算と runner ごとの控えの扱いを実装ごとに書き写さないため
// 控えが無い・累積が減っていた古い runner は積まない（`skipped`）: 積めば過大、積まなければ取りこぼしの恐れがあるので過大にしない側に倒し、呼び出し側が日誌に残す
export function foldRecordForStore(
  baseline: UsageBaseline | null,
  input: {
    layer: UsageLayer;
    managerId: string;
    snapshot: UsageSnapshot;
    at: string;
    accumulation: UsageAccumulation;
    runner?: UsageRecordRunner;
  },
): { fold: UsageFold; nextBaseline: UsageBaseline | null } {
  if (input.accumulation === 'oneshot') {
    return { fold: foldOneshotUsage(input.snapshot), nextBaseline: null };
  }
  const withRunnerMemory = (base: UsageBaseline, runnerId: string | undefined): UsageBaseline => {
    const carried = baseline?.byRunner;
    const next =
      runnerId === undefined || !hasAnyUsage(input.snapshot.models)
        ? carried
        : { ...carried, [runnerId]: input.snapshot.models };
    const rest: UsageBaseline = { ...base };
    delete rest.byRunner;
    return next === undefined ? rest : { ...rest, byRunner: next };
  };
  const identity = { layer: input.layer, managerId: input.managerId };

  if (input.runner?.superseded === true) {
    if (baseline === null) {
      return {
        fold: { delta: {}, baseline: null, skipped: { reason: 'unknown-runner' } },
        nextBaseline: null,
      };
    }
    const previous = baseline.byRunner?.[input.runner.id];
    const keep = (skipped?: UsageFold['skipped'], delta: UsageFold['delta'] = {}) => {
      const nextBaseline = withRunnerMemory(baseline, input.runner?.id);
      return {
        fold: {
          delta,
          baseline: nextBaseline,
          ...(skipped === undefined ? {} : { skipped }),
        } satisfies UsageFold,
        nextBaseline,
      };
    };
    if (previous === undefined) return keep({ reason: 'unknown-runner' });
    const own = foldUsageSnapshot(
      { ...identity, models: previous, updatedAt: input.at, resets: 0 },
      input.snapshot,
      input.at,
    );
    if (own.reset !== undefined) {
      return keep({
        reason: 'decreased',
        fromCostUsd: own.reset.fromCostUsd,
        toCostUsd: own.reset.toCostUsd,
      });
    }
    return keep(undefined, own.delta);
  }

  const fold = foldUsageSnapshot(baseline, input.snapshot, input.at);
  if (fold.baseline === null) return { fold, nextBaseline: null };
  const nextBaseline = withRunnerMemory({ ...fold.baseline, ...identity }, input.runner?.id);
  return { fold, nextBaseline };
}

// 基準を持たせない: 累積の器は「during this query() call」 [sdk-verbatim SDKResultSuccess.modelUsage] で閉じ、`result` はその1回の総量そのものなので、持たせると前回より高い回は差だけ（目減り）、安い回は数え直しの全量が積まれ、高くついた回だけが黙って縮むため
// ゼロの `result`（「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd]）は 0 の行を作らずに落とす
export function foldOneshotUsage(snapshot: UsageSnapshot): UsageFold {
  const delta: Record<string, UsageTotals> = {};
  for (const [model, totals] of Object.entries(snapshot.models)) {
    if (!isZero(totals)) delta[model] = totals;
  }
  return { delta, baseline: null };
}

// `>= 0` にする（`> 0` ではない）: 0 は正当に読めた値で、数でない・有限でない・負の値だけを「読めない」とするため
function isReadableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function tokenCount(value: unknown): number {
  return isReadableNumber(value) ? Math.floor(value) : 0;
}

function usdAmount(value: unknown): number {
  return isReadableNumber(value) ? value : 0;
}

// 台帳へ通すのは成功した result だけ: 「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd] で、ゼロを累積が 0 になったとして通すと基準が下がり記録済みの分がもう一度積まれるため。値は累積なので絞っても取りこぼさない
export function isSuccessResult(message: unknown): boolean {
  return (message as { subtype?: unknown }).subtype === 'success';
}

// `result.usage` を使わない: `modelUsage` が **「The correct field for token/cost accounting」** [sdk-verbatim SDKResultSuccess.modelUsage] で、`usage` を採ると作業者の消費が丸ごと落ちるため
// クローンとマネージャーが同じこれを呼ぶ: 層ごとに写し取りを書くと、片方が `costUSD` の綴りを取り違えて 0 が積まれ「その層は安い」と読めるため
export function modelUsageOf(message: unknown): Record<string, UsageTotals> | undefined {
  return toModelTotals((message as { modelUsage?: unknown }).modelUsage);
}

export function sessionModelUsageOf(response: unknown): Record<string, UsageTotals> | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const session = (response as { session?: unknown }).session;
  if (typeof session !== 'object' || session === null) return undefined;
  return toModelTotals((session as { model_usage?: unknown }).model_usage);
}

// 省略可能にする: 実験的な口は SDK 側で改名・削除されうるので、必須として呼ぶと SDK が1つ改名した瞬間に畳む経路が落ちるため
export interface SessionUsageReader {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
}

// 締め切りを短くする: 観測であって仕事ではないうえ、もう畳むと決まった後で、runner 全体の猶予をセッション全部で分け合うため
export const SESSION_USAGE_READ_TIMEOUT_MS = 5_000;

// 層が2つとも同じこれを呼ぶ（片方を消さない）: `result` を出さずに死んだセッションの末尾は二度と積まれず、片方だけ直っていると直っていない側の欠落が「使っていない」と読めるため
// 全部ゼロなら `undefined` を返す: 「記録が無い」が「$0.00 使った」に化けないため。`close()` より先に呼ぶ: 閉じた後の control channel からは何も取れないため
export async function readSessionUsage(
  handle: unknown,
): Promise<Record<string, UsageTotals> | undefined> {
  const reader = handle as SessionUsageReader | null;
  const read = reader?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (reader === null || reader === undefined || typeof read !== 'function') return undefined;
  let answer: Promise<unknown>;
  try {
    answer = read.call(reader);
  } catch {
    return undefined;
  }
  const models = sessionModelUsageOf(await settleWithin(answer, SESSION_USAGE_READ_TIMEOUT_MS));
  if (models === undefined || !hasAnyUsage(models)) return undefined;
  return models;
}

// 入口が2つ（`result.modelUsage` と `session.model_usage`）あるので写しを1つに寄せる: 書き写すと片方だけ `costUSD` の綴りを直してもう片方が黙って 0 を積むため
const USAGE_UNREADABLE_SOURCE_KEYS: Readonly<Record<UsageUnreadableField, string>> = {
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  cacheReadInputTokens: 'cacheReadInputTokens',
  cacheCreationInputTokens: 'cacheCreationInputTokens',
  webSearchRequests: 'webSearchRequests',
  costUsd: 'costUSD',
};

function toModelTotals(raw: unknown): Record<string, UsageTotals> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const models: Record<string, UsageTotals> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const usage = value as Record<string, unknown>;

    // 読めなかった欄だけを1として数える: 0 は読めた値で、ここは1区切りの観測なので既存の値を上書きも積み増しもしない
    const unreadable: UsageUnreadableCounts = {};
    for (const field of USAGE_UNREADABLE_FIELDS) {
      if (!isReadableNumber(usage[USAGE_UNREADABLE_SOURCE_KEYS[field]])) unreadable[field] = 1;
    }

    models[model] = {
      inputTokens: tokenCount(usage.inputTokens),
      outputTokens: tokenCount(usage.outputTokens),
      cacheReadInputTokens: tokenCount(usage.cacheReadInputTokens),
      cacheCreationInputTokens: tokenCount(usage.cacheCreationInputTokens),
      webSearchRequests: tokenCount(usage.webSearchRequests),
      // SDK 側の綴りは `costUSD`（他と違って大文字）
      costUsd: usdAmount(usage.costUSD),
      ...(Object.keys(unreadable).length > 0 ? { unreadable } : {}),
    };
  }
  return models;
}

// 層と場所を鍵から外さない: `(date, managerId, model)` だけだと同じ鍵に別の意味の行が2つ立ち、増分が先にある行へ足し込まれて黙った誤帰属になるため
export const usageRowSchema = z.object({
  date: usageDateSchema,
  managerId: z.string(),
  model: z.string(),
  layer: usageLayerSchema,
  site: usageSiteSchema,
  // 省略可能にする: プールを使っていない器では現役の指名が無く、埋めると「そのトークンで使った」というしていない観測を作るため
  tokenId: z.string().min(1).optional(),
  totals: usageTotalsSchema,
  updatedAt: isoDateTime,
});

export type UsageRow = z.infer<typeof usageRowSchema>;

// `model` を鍵に持たない: 回数をモデルの鍵で持つと、1ターンで2モデルが動いた回が「2ターン」に数えられ、合計が「ターン×モデル数」になるため
// `turns` は `positive()`: 増分が空の `record` は「起きた」に数えず、0 の行を作ると取っていない観測を出力が語るため
export const usageTurnRowSchema = z.object({
  date: usageDateSchema,
  managerId: z.string(),
  layer: usageLayerSchema,
  site: usageSiteSchema,
  tokenId: z.string().min(1).optional(),
  turns: z.number().int().positive(),
  updatedAt: isoDateTime,
});

export type UsageTurnRow = z.infer<typeof usageTurnRowSchema>;

// `usage_daily` に 0 で積まず回数だけ数える別の行にする: 0 で積むとその層が「安い」と読め、何も数えないと動いたこと自体が消えるため。合計には足さない
// 起こす条件は `capabilities.usage === false` であって `usage` が無いことではない: Claude の失敗した result は報告できなかっただけで無報告ではないため
export const usageUnmeteredRowSchema = z.object({
  date: usageDateSchema,
  managerId: z.string(),
  layer: usageLayerSchema,
  site: usageSiteSchema,
  provider: z.string().min(1),
  tokenId: z.string().min(1).optional(),
  turns: z.number().int().positive(),
  updatedAt: isoDateTime,
});

export type UsageUnmeteredRow = z.infer<typeof usageUnmeteredRowSchema>;

export const usageQuerySchema = z.object({
  from: usageDateSchema.optional(),
  to: usageDateSchema.optional(),
  managerId: z.string().optional(),
  layer: usageLayerSchema.optional(),
  site: usageSiteSchema.optional(),
  // 帰属が無い行を引く手を作らない: 「トークン軸が空の行だけ」を絞れる形にすると、その集合が「そのトークンで使った分」と並んで1つの選択肢に見えるため。取れていない分は絞らずに引いて `byToken` の `null` を見る
  tokenId: z.string().min(1).optional(),
});

export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const unreadableUsageRowSchema = z.object({
  table: z.enum(['usage_daily', 'usage_turns']),
  date: usageDateSchema.optional(),
  fields: z.array(z.string()),
}) satisfies z.ZodType<UnreadableUsageRow>;

// `since` を必ず添える・始点を黙って隠さない: 台帳が始まる前を照会されたら 0 ではなく「記録が無い」と言えるようにするため。過去分の掘り起こしはしない: 単価を自前で掛けて二重に推定し直すことになるため
export const usageAggregateSchema = z.object({
  rows: z.array(usageRowSchema),
  since: isoDateTime.nullable(),
  // `since` と1つにしない: 層の軸より前の行には `layer='manager'` / `site='session'` が既定として入っており観測ではなく、1つにすると層を足す前の期間が「クローンは使っていなかった」と読めるため
  layersSince: isoDateTime.nullable(),
  // 真なら「その範囲は 0 ではなく記録が無い」と言う: 台帳が無かった期間が「使っていない期間」に見えるため
  beforeLedger: z.boolean(),
  // 真なら「その範囲の層と場所は既定値であって観測ではない」と言う
  beforeLayers: z.boolean(),
  // `since` が非 null でも null でありうる: プールを使っていないと積んでいても帰属が取れず、それが既定の構成のため
  tokensSince: isoDateTime.nullable(),
  // 真なら「その範囲にトークンの帰属は無い」と言う: 内訳が既定値なのではなくそもそも無く、0 でも既定値でもなく取れていないため
  beforeTokens: z.boolean(),
  turnRows: z.array(usageTurnRowSchema),
  // 「まだ1件も数えられる形で起きていない」の意味: 回数は台帳の行が動いた回でだけ数え、増分が空の record では始まらないため
  turnsSince: isoDateTime.nullable(),
  // 真なら「その範囲の回数は 0 ではなく取れていない」と言う
  beforeTurns: z.boolean(),
  // 1行でも外したときだけ載せ、0件なら鍵ごと無い: 既存の応答を変えないため。外した行の値は足さず推測で補わない。`UsageTotals.unreadable` とは別物
  unreadableRows: z.array(unreadableUsageRowSchema).optional(),
  // 1行でもあるときだけ載せる: Claude だけの器の応答を変えないため。合計には足さない
  unmeteredRows: z.array(usageUnmeteredRowSchema).optional(),
  notice: z.literal(USAGE_ESTIMATE_NOTICE),
});

export type UsageAggregate = z.infer<typeof usageAggregateSchema>;

// `byModel` に `turns` を付けない: `usageTurnRowSchema` が `model` を鍵に持たず、モデル軸に回数を帰属させる方法が無いため。該当する turnRow が無い要素は `turns` を持たない（`0` にしない）
const turnsField = z.number().int().positive().optional();

export const usageBreakdownSchema = z.object({
  total: usageTotalsSchema,
  turns: turnsField,
  byDate: z.array(
    z.object({ date: usageDateSchema, totals: usageTotalsSchema, turns: turnsField }),
  ),
  byManager: z.array(
    z.object({ managerId: z.string(), totals: usageTotalsSchema, turns: turnsField }),
  ),
  byModel: z.array(z.object({ model: z.string(), totals: usageTotalsSchema })),
  // 出てこない層・場所・トークンを 0 で補わない: 補うと「0 使った」に見えるため
  byLayer: z.array(
    z.object({ layer: usageLayerSchema, totals: usageTotalsSchema, turns: turnsField }),
  ),
  bySite: z.array(
    z.object({ site: usageSiteSchema, totals: usageTotalsSchema, turns: turnsField }),
  ),
  // `tokenId` が `null` の要素を消さない: 落とすとこの軸だけ `total` に足し合わなくなり、読み手からは足りないことに気づく手がかりが無いため
  byToken: z.array(
    z.object({
      tokenId: z.string().min(1).nullable(),
      totals: usageTotalsSchema,
      turns: turnsField,
    }),
  ),
});

export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;
