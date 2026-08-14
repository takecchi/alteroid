import { z } from 'zod';

import { runUsageProbe, settleWithin, type UsageProbeQuery } from './usage-probe.js';

/**
 * アカウント全体の利用状況（claude.ai 側が言っている値）。
 *
 * **台帳（`usage.ts`）とは別物である。足したり混ぜたりしないこと。** 台帳は
 * 「alteroid が使った分」を自分で数えた推定値で、こちらは「アカウントの枠を
 * どれだけ使ったか」を向こうが言っている値である。一致する保証はない。
 *
 * 出所は SDK の control channel で、口は2つ。
 *
 * - `Query.accountInfo()` — プラン名・組織・API バックエンド
 * - `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` —
 *   claude.ai の `/usage` スナップショット（枠の利用率と**支出上限**）
 *
 * ## 実測された落とし穴（すべて要件にしてある）
 *
 * 1. **`rate_limits_available: true` でも `rate_limits` が `null` のことがある**
 *    （Claude Team で再現）。だから `available` を「枠がある」の根拠にしない。
 *    さらに `false` のときは各フィールドが null になるのではなく
 *    **オブジェクトごと `null`** になる（未ログイン環境で実測）。
 * 2. **`utilization` が付かない枠がある**（`five_hour` で実測）。だから
 *    「% が無い枠」を 0% として描かない。**取れなかったものを 0 にしない。**
 * 3. **時刻の単位が2系統ある。** `/usage` は ISO 8601 文字列、`rate_limit_event` は
 *    Unix **秒**。混ぜると必ず事故るので、正規化した先（epoch ミリ秒）だけを持つ。
 * 4. **ターンを回した直後の実セッションで usage 要求を呼ぶと
 *    `ProcessTransport is not ready for writing` で失敗する。** alteroid の
 *    マネージャーは常にターンを回しているので、**相乗りせず使い捨ての probe を
 *    立てる**（`usage-probe.ts`）。
 *
 * ## 未実測のまま残っているもの
 *
 * **`extraUsage`（支出上限）の実物は観測できていない。** ログイン済みの claude.ai
 * サブスクリプションからしか `rate_limits` が埋まらず、CI もコンテナも未ログイン
 * だからである。型宣言どおりに読むところまでを実装し、**取れなければ「取れなかった」
 * と言う**形にしてある。持ち主が実測するためのスクリプトは
 * `packages/core/scripts/usage-probe.mjs`。実測できたらここを直す。
 */

/** 枠の種類。SDK の `rateLimitType` と `/usage` のキーを1つに寄せたもの。 */
export const usageWindowKindSchema = z.enum([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
]);

export type UsageWindowKind = z.infer<typeof usageWindowKindSchema>;

/**
 * 枠1つ。
 *
 * `utilization` と `resetsAt` が**どちらも省略可能**なのは、実測でどちらも欠ける
 * ことがあるからである。**欠けたものを 0 や「いま」で埋めないこと。**
 */
export const usageWindowSchema = z.object({
  kind: usageWindowKindSchema,
  /** 使用率（0〜100）。取れなかったときは undefined。**0 で埋めないこと。** */
  utilization: z.number().nonnegative().optional(),
  /** リセット時刻（epoch ミリ秒）。取れなかったときは undefined。 */
  resetsAt: z.number().int().positive().optional(),
  /** まだ通してもらえているか。`rate_limit_event` からしか分からない。 */
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
});

export type UsageWindow = z.infer<typeof usageWindowSchema>;

/**
 * 支出上限（extra usage / 課金枠）。**この依頼の核心。**
 *
 * 枠（`five_hour` 等）の利用率は「いま重い仕事を投げてよいか」の判断に効くが、
 * **支出上限は「今日もう委譲を続けられるか」の判断に効く。** 実際に当たったのは
 * こちらで、当たると走行中のマネージャーが返答を返さずに終わる。
 *
 * **単位は未実測である。** 型宣言は `used_credits` / `monthly_limit` が
 * `number | null`、`currency` が `string | null` としか言っていない。USD なのか
 * クレジットなのかは実測できていないので、**通貨が分からないときは金額として
 * 整形しない**（`$` を付けて嘘の単位を名乗らない）。
 */
export const extraUsageSchema = z.object({
  enabled: z.boolean(),
  /** 月額の上限。取れなかったときは undefined。 */
  monthlyLimit: z.number().nonnegative().optional(),
  /** 使った分。取れなかったときは undefined。 */
  usedCredits: z.number().nonnegative().optional(),
  /** 使用率（0〜100）。取れなかったときは undefined。 */
  utilization: z.number().nonnegative().optional(),
  /** 通貨コード。**これが無いときは金額として整形しないこと**（単位が分からない）。 */
  currency: z.string().optional(),
});

export type ExtraUsage = z.infer<typeof extraUsageSchema>;

/**
 * アカウント全体のスナップショット1つ。
 *
 * **「取れなかった」を表現できる形にしてある。** `limitsAvailable` が真でも
 * `windows` が空のことがあり、それは「0%」ではなく「向こうが枠を教えてくれなかった」
 * である。読む側がそれを区別できないと、画面は静かに嘘をつく。
 */
export const accountUsageSchema = z.object({
  at: z.string().datetime({ offset: true }),
  /** プラン名（`Claude Team` 等）。SDK が返す表示用文字列なので翻訳しない。 */
  plan: z.string().optional(),
  organization: z.string().optional(),
  /**
   * どのバックエンドで話しているか。`firstParty` のときだけ claude.ai の
   * サブスク制限が効く（Bedrock / Vertex / API キーには無い）。
   */
  apiProvider: z.string().optional(),
  /**
   * 認証の出所。**`none` は「サブスクが無い」ではなく「まだログインしていない」。**
   *
   * この2つを混同すると、**鍵が後から届く構成で永久に「サブスクなし」と表示される。**
   * alteroid は鍵を走行中に回せる設計（`credentials.ts` / `POST /runners/credentials`）
   * なので、「トークンが後から来る」は異常ではなく通常の状態である。
   */
  tokenSource: z.string().optional(),
  /**
   * 向こうが「プランの枠が効く」と言っているか。
   *
   * **これを「枠が取れた」の根拠にしないこと。** `true` でも `rate_limits` が
   * `null` のことがある（実測）。枠があるかどうかは `windows` の中身で判断する。
   */
  limitsAvailable: z.boolean(),
  /** 取れた枠。**空は「0%」ではなく「取れなかった」。** */
  windows: z.array(usageWindowSchema),
  /** 支出上限。取れなかったときは undefined（＝「取れなかった」）。 */
  extraUsage: extraUsageSchema.optional(),
});

export type AccountUsage = z.infer<typeof accountUsageSchema>;

/**
 * スナップショットを取れなかったこと自体を持つ器。
 *
 * **「まだ取れていない」と「取ろうとして取れなかった」と「この構成では取れない」を
 * 区別する。** 全部 `null` にすると、画面は3つとも同じ顔で見せることになり、
 * 人間もクローンも「見えていない理由」を判断できない。
 */
export const accountUsageStateSchema = z.discriminatedUnion('state', [
  /** 一度も取りに行っていない（起動直後）。 */
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('ok'), usage: accountUsageSchema }),
  /** 取りに行ったが失敗した（通信断・タイムアウト・SDK の口が変わった）。 */
  z.object({
    state: z.literal('failed'),
    at: z.string().datetime({ offset: true }),
    reason: z.string(),
  }),
  /**
   * この認証では原理的に取れない（API キー / Bedrock / Vertex / 未ログイン）。
   *
   * `reason` に何が分かっているかを入れる。**「取れない」と「使っていない」を
   * 混ぜないため**に、状態として分けてある。
   */
  z.object({
    state: z.literal('unavailable'),
    at: z.string().datetime({ offset: true }),
    reason: z.string(),
  }),
]);

export type AccountUsageState = z.infer<typeof accountUsageStateSchema>;

// ---------------------------------------------------------------------------
// 正規化（生 JSON → 上の形）
// ---------------------------------------------------------------------------

/** `/usage` の応答キー → 枠の種類。 */
const WINDOW_KEYS: Readonly<Record<string, UsageWindowKind>> = {
  five_hour: 'five_hour',
  seven_day: 'seven_day',
  seven_day_opus: 'seven_day_opus',
  seven_day_sonnet: 'seven_day_sonnet',
};

function ratio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** ISO 8601 → epoch ミリ秒。読めなければ undefined（**NaN を下へ流さない**）。 */
function isoToEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * `rate_limit_event` の `resetsAt` は Unix **秒**。epoch ミリ秒へ寄せる。
 *
 * 将来 SDK がミリ秒へ変えても壊れないよう、既にミリ秒の桁なら素通しする
 * （秒でこの桁に届くのは西暦 5138 年なので、本物の秒と衝突しない）。
 */
export function secondsToEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e11 ? Math.floor(value) : Math.floor(value * 1000);
}

function toExtraUsage(value: unknown): ExtraUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.is_enabled === true,
    monthlyLimit: positive(raw.monthly_limit),
    usedCredits: positive(raw.used_credits),
    utilization: ratio(raw.utilization),
    currency: nonEmpty(raw.currency),
  };
}

/**
 * `usage_EXPERIMENTAL_...()` の応答を正規化する。**決して投げない。**
 *
 * 想定外の形は「枠なし」に落とす。probe は best-effort であって、ここで例外を
 * 上げると利用状況が見えないどころかデーモンの周期処理を巻き込む。
 */
export function toAccountUsage(
  at: string,
  usageJson: unknown,
  accountJson?: unknown,
): AccountUsage {
  const usage = (typeof usageJson === 'object' && usageJson !== null ? usageJson : {}) as Record<
    string,
    unknown
  >;
  const account = (
    typeof accountJson === 'object' && accountJson !== null ? accountJson : {}
  ) as Record<string, unknown>;

  const limits = usage.rate_limits;
  const windows: UsageWindow[] = [];
  let extraUsage: ExtraUsage | undefined;

  // `rate_limits_available` は見ない。**中身があるかどうかだけで判断する。**
  if (typeof limits === 'object' && limits !== null) {
    const record = limits as Record<string, unknown>;
    for (const [key, kind] of Object.entries(WINDOW_KEYS)) {
      const entry = record[key];
      if (typeof entry !== 'object' || entry === null) continue;
      const json = entry as Record<string, unknown>;
      const utilization = ratio(json.utilization);
      const resetsAt = isoToEpochMs(json.resets_at);
      // どちらも無い枠は載せない（ラベルだけの行は場所を取るだけで何も言わない）。
      if (utilization === undefined && resetsAt === undefined) continue;
      windows.push({ kind, utilization, resetsAt });
    }
    extraUsage = toExtraUsage(record.extra_usage);
  }

  return {
    at,
    plan: nonEmpty(account.subscriptionType) ?? nonEmpty(usage.subscription_type),
    organization: nonEmpty(account.organization),
    apiProvider: nonEmpty(account.apiProvider),
    tokenSource: nonEmpty(account.tokenSource),
    limitsAvailable: usage.rate_limits_available === true,
    windows,
    extraUsage,
  };
}

/**
 * この認証では枠が原理的に取れないと**断定できる**か。
 *
 * **`limitsAvailable === false` だけを根拠にしないこと。** 未ログイン
 * （`tokenSource: 'none'`）でも `false` が返る（実測）が、それは「サブスクが無い」
 * ではなく「まだログインしていない」である。alteroid は鍵を走行中に回せる設計
 * なので、鍵が後から届くのは通常の状態である。ここを混ぜると、鍵が届いた後も
 * 永久に「このアカウントにはサブスクが無い」と表示し続ける。
 */
export function isSubscriptionImpossible(usage: AccountUsage): boolean {
  if (usage.tokenSource === 'none') return false; // まだログインしていないだけ
  const provider = usage.apiProvider;
  if (provider !== undefined && provider !== 'firstParty') return true;
  return usage.limitsAvailable === false && usage.plan === undefined;
}

/** まだログインしていないと読めるか（＝鍵が届けば取れるようになる）。 */
export function isNotLoggedIn(usage: AccountUsage): boolean {
  return usage.tokenSource === 'none';
}

/** 何か表示できるものが取れたか。 */
export function hasAccountUsageDetail(usage: AccountUsage): boolean {
  return usage.plan !== undefined || usage.windows.length > 0 || usage.extraUsage !== undefined;
}

// ---------------------------------------------------------------------------
// 取りに行く
// ---------------------------------------------------------------------------

/**
 * probe 1回ぶんの締め切り。
 *
 * 短めにしてあるのは、これが**best-effort の観測**であって仕事ではないからである。
 * 実測では 300〜400ms で答えが返っている（推論を走らせないため）。
 */
export const ACCOUNT_USAGE_READ_TIMEOUT_MS = 10_000;

/**
 * アカウント全体の利用状況を1回読む。**決して投げない。**
 *
 * 2つの口を**独立に**読む。片方が固まってももう片方を捨てないためで、実測でも
 * 「`accountInfo()` は答えるのに usage 側は `rate_limits: null`」という食い違いが
 * 出ている。実験的な control 要求は固まる可能性がいちばん高い種類のものである。
 */
export async function fetchAccountUsage(
  queryFn: UsageProbeQuery,
  options: { cwd: string; signal?: AbortSignal },
): Promise<AccountUsageState> {
  const at = new Date().toISOString();

  const read = await runUsageProbe(queryFn, options, async (handle) => {
    const [account, usage] = await Promise.all([
      settleWithin(handle.accountInfo?.(), ACCOUNT_USAGE_READ_TIMEOUT_MS),
      settleWithin(
        handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.(),
        ACCOUNT_USAGE_READ_TIMEOUT_MS,
      ),
    ]);
    return { account, usage };
  });

  if (read === undefined) {
    return { state: 'failed', at, reason: 'probe が応答しなかった（起動失敗・締め切り・中断）' };
  }
  if (read.account === undefined && read.usage === undefined) {
    return { state: 'failed', at, reason: '2つの口のどちらも答えなかった' };
  }

  const usage = toAccountUsage(at, read.usage, read.account);

  if (isNotLoggedIn(usage)) {
    // **「取れない」ではない。** 鍵が届けば取れる。ローカル開発や鍵の配布前は
    // ここへ落ちるのが正常であり、異常として扱わないこと。
    return {
      state: 'unavailable',
      at,
      reason: 'claude.ai にログインしていない（鍵が届けば取れる）',
    };
  }
  if (isSubscriptionImpossible(usage)) {
    return {
      state: 'unavailable',
      at,
      reason: `この認証では claude.ai の枠が無い（apiProvider: ${usage.apiProvider ?? '不明'}）`,
    };
  }
  if (!hasAccountUsageDetail(usage)) {
    // **`limitsAvailable` が真でも枠が来ないことがある**（実測）。0% と描かない。
    return {
      state: 'failed',
      at,
      reason: `枠の中身が返らなかった（rate_limits_available: ${usage.limitsAvailable}）`,
    };
  }
  return { state: 'ok', usage };
}
