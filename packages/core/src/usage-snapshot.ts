import { z } from 'zod';

import {
  describeProbeError,
  runUsageProbe,
  settleWithin,
  type UsageProbeFailure,
  type UsageProbeQuery,
} from './usage-probe.js';

// 台帳（`usage.ts`）と混ぜない: 台帳は自分で数えた推定値で、こちらは向こうが言っている値で、一致する保証がないため
// 取れなかったものを 0 にしない: `rate_limits_available: true` でも `rate_limits` が `null` のことがあり、`utilization` が付かない枠もあるため
// 時刻は epoch ミリ秒だけを持つ: `/usage` は ISO 8601、`rate_limit_event` は Unix 秒で、混ぜると事故るため
// 実セッションに相乗りせず使い捨ての probe を立てる: ターン直後の usage 要求は `ProcessTransport is not ready for writing` で失敗するため
export const usageWindowKindSchema = z.enum([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
]);

export type UsageWindowKind = z.infer<typeof usageWindowKindSchema>;

// 欠けたものを 0 や「いま」で埋めない: utilization と resetsAt は実測でどちらも欠けることがあるため
export const usageWindowSchema = z.object({
  kind: usageWindowKindSchema,
  utilization: z.number().nonnegative().optional(),
  resetsAt: z.number().int().positive().optional(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
});

export type UsageWindow = z.infer<typeof usageWindowSchema>;

// 通貨が分からないときは金額として整形しない: 型宣言は単位を言わず USD かクレジットか未実測で、`$` を付けると嘘の単位を名乗るため
export const extraUsageSchema = z.object({
  enabled: z.boolean(),
  monthlyLimit: z.number().nonnegative().optional(),
  usedCredits: z.number().nonnegative().optional(),
  utilization: z.number().nonnegative().optional(),
  currency: z.string().optional(),
});

export type ExtraUsage = z.infer<typeof extraUsageSchema>;

// 値を許可リストで絞る: `AccountInfo.apiKeySource` は SDK 上 string としか宣言されず形の保証が無く、`GET /usage` はアクセストークンで読める面なので、素通しにすると鍵に関する自由文字列が外へ配られうるため
// [sdk-verbatim AccountInfo.apiKeySource]
// > apiKeySource?: string;
// [sdk-verbatim ApiKeySource]
// > Where the credential used for API requests came from: 'ANTHROPIC_API_KEY' (environment variable), 'apiKeyHelper' (the configured helper command), '/login managed key' (an API key created and stored by /login with an Anthropic Console account), or 'none' (no API key in use - e.g. claude.ai OAuth login, a bearer token, or a third-party cloud provider). 'user' | 'project' | 'org' | 'temporary' | 'oauth' are legacy members that current CLIs never emit; they remain only so the type stays backward compatible.
// 'unrecognized' を足す: 知らない値を欄が無い（undefined）へ畳むと、SDK が新しい値を出し始めたことが永久に見えなくなるため。SDK 由来の文字は運ばない
export const accountApiKeySourceSchema = z.enum([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
  'unrecognized',
]);

export type AccountApiKeySource = z.infer<typeof accountApiKeySourceSchema>;

export const accountApiProviderSchema = z.enum([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'gateway',
  'unrecognized',
]);

export type AccountApiProvider = z.infer<typeof accountApiProviderSchema>;

// 値を運ばず状態だけにする: `AccountInfo.tokenSource` は SDK 側に値の一覧が無い自由文字列で、許可リストを作れないため
// [sdk-verbatim AccountInfo.tokenSource]
// > tokenSource?: string;
// 欄が無いのは「この版が送らない」の1通り: 同じプロセスで作る限り3値のどれかが入る。既定値で埋めない: 「送らなかった」と「試して not_returned だった」が区別できなくなるため
export const tokenSourcePresenceSchema = z.enum(['not_returned', 'present', 'empty']);

export type TokenSourcePresence = z.infer<typeof tokenSourcePresenceSchema>;

export const accountUsageSchema = z.object({
  at: z.string().datetime({ offset: true }),
  plan: z.string().optional(),
  organization: z.string().optional(),
  apiProvider: accountApiProviderSchema.optional(),
  // tokenSourcePresence と混ぜない: 鍵が届いているかと届いた鍵の由来は別で、混同すると `apiKeySource: 'none'` を「鍵が無い」と読み違えるため。判定には使わない
  apiKeySource: accountApiKeySourceSchema.optional(),
  // 生の tokenSource を載せない: `GET /usage` はアクセストークンで読める面で、許可リストを作れないため
  tokenSourcePresence: tokenSourcePresenceSchema.optional(),
  // 「枠が取れた」の根拠にしない: true でも `rate_limits` が null のことがあり、windows の中身で判断するため
  limitsAvailable: z.boolean(),
  windows: z.array(usageWindowSchema),
  extraUsage: extraUsageSchema.optional(),
});

export type AccountUsage = z.infer<typeof accountUsageSchema>;

// `undetermined` を持つ: 2値だと false の原因を1つに潰し、「このアカウントは Claude のサブスクを持っていない」と読み違えさせたため。`missing profile scope` と断定しない: 消去法で絞れたことと確かめたことは別で、apiProvider: firstParty と plan: 無しは食い違う合図のため
// [sdk-verbatim SDKControlGetUsageResponse.rate_limits_available]
// > False when plan rate limits do not apply (API key, Bedrock, Vertex, or missing profile scope) — rate_limits will be null.
// [sdk-verbatim AccountInfo.apiProvider]
// > Active API backend. Anthropic OAuth login only applies when "firstParty"; for 3P providers the other fields are absent and auth is external (AWS creds, gcloud ADC, etc.). "gateway" means the CLI is authenticated against an enterprise gateway.
// [sdk-verbatim SDKControlGetUsageResponse.subscription_type]
// > Claude.ai subscription type ('pro', 'max', 'team', 'enterprise') or null for API key / 3P provider sessions.
export const limitsUnavailableCauseSchema = z.enum([
  'not_logged_in',
  'non_first_party',
  'undetermined',
]);
export type LimitsUnavailableCause = z.infer<typeof limitsUnavailableCauseSchema>;

// 保っている `ok` に失敗を添える: 保つだけで失敗を隠すと、取れていない値を取れているように見せるため。値（鍵・応答の中身）は載せない
export const accountUsageRefreshFailureSchema = z.object({
  since: z.string().datetime({ offset: true }),
  at: z.string().datetime({ offset: true }),
  reason: z.string(),
});

export type AccountUsageRefreshFailure = z.infer<typeof accountUsageRefreshFailureSchema>;

export const accountUsageStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({
    state: z.literal('ok'),
    usage: accountUsageSchema,
    refreshFailure: accountUsageRefreshFailureSchema.optional(),
  }),
  z.object({
    state: z.literal('failed'),
    at: z.string().datetime({ offset: true }),
    reason: z.string(),
  }),
  z.object({
    state: z.literal('unavailable'),
    at: z.string().datetime({ offset: true }),
    reason: z.string(),
    // 省略可・既定値で埋めない: 版がずれたデーモンの応答を新しい画面が読む組み合わせがあり、必須だと `GET /usage` の応答が parse に失敗するため。無いのは「理由が無い」ではなく「その版が言えなかった」
    cause: limitsUnavailableCauseSchema.optional(),
    // `usage` ごとは積まない: plan / organization / apiProvider / 支出上限が `GET /usage`（アクセストークンで読める面）へまとめて出てしまうため。この欄だけ運ぶ: `undetermined` に割れた回だけ消えていたため
    // 既定値で埋めない: `'none'` は「API キーを使っていない」という積極的な事実で、取れなかったとは意味が正反対のため
    apiKeySource: accountApiKeySourceSchema.optional(),
    // 値は持たず欄の名前だけ運ぶ: `GET /usage` はアクセストークンで読める面のため
    accountKeys: z.array(z.string()).optional(),
  }),
]);

export type AccountUsageState = z.infer<typeof accountUsageStateSchema>;

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

// `a ?? b` に書き換えない: `''` は nullish ではないので、空の第1候補が非空の第2候補の値を食うため
function firstPresentString(...candidates: readonly unknown[]): string | undefined {
  const strings = candidates.filter((value): value is string => typeof value === 'string');
  return strings.find((value) => value.trim().length > 0) ?? strings[0];
}

// `nonEmpty()` を使わない: 「返らなかった」と「返ったが空だった」を同じ `undefined` へ畳まないため
export function toTokenSourcePresence(raw: unknown): TokenSourcePresence {
  if (typeof raw !== 'string') return 'not_returned';
  return raw.trim().length > 0 ? 'present' : 'empty';
}

// SDK が別に export している union の `ApiKeySource` を鏡像にする（`AccountInfo.apiKeySource` 自体は string）。この行が `pnpm check:sdk-quotes` の同期の門になる
// [sdk-verbatim ApiKeySource]
// > export declare type ApiKeySource = 'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none' | 'user' | 'project' | 'org' | 'temporary' | 'oauth';
const SDK_API_KEY_SOURCES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
]);

export function toAccountApiKeySource(raw: unknown): AccountApiKeySource | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  if (SDK_API_KEY_SOURCES.has(raw)) return raw as AccountApiKeySource;
  return 'unrecognized';
}

// この行が `pnpm check:sdk-quotes` の同期の門になる
// [sdk-verbatim AccountInfo.apiProvider]
// > apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'gateway';
const SDK_API_PROVIDERS: ReadonlySet<string> = new Set([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'gateway',
]);

// 空文字を `'unrecognized'` へ倒さない: 空文字は「名乗ったが知らない値」ではなく「何も名乗っていない」で、倒すと観測していないことを断定するため
export function toAccountApiProvider(raw: unknown): AccountApiProvider | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  if (SDK_API_PROVIDERS.has(raw)) return raw as AccountApiProvider;
  return 'unrecognized';
}

function isoToEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// 既にミリ秒の桁なら素通しする: 将来 SDK がミリ秒へ変えても壊れないよう。秒でこの桁に届くのは西暦 5138 年なので衝突しない
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

// 投げない: 想定外の形は「枠なし」に落とす。ここで例外を上げるとデーモンの周期処理を巻き込むため
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

  // `rate_limits_available` は見ない: 中身があるかどうかだけで判断する
  if (typeof limits === 'object' && limits !== null) {
    const record = limits as Record<string, unknown>;
    for (const [key, kind] of Object.entries(WINDOW_KEYS)) {
      const entry = record[key];
      if (typeof entry !== 'object' || entry === null) continue;
      const json = entry as Record<string, unknown>;
      const utilization = ratio(json.utilization);
      const resetsAt = isoToEpochMs(json.resets_at);
      if (utilization === undefined && resetsAt === undefined) continue;
      windows.push({ kind, utilization, resetsAt });
    }
    extraUsage = toExtraUsage(record.extra_usage);
  }

  return {
    at,
    plan: firstPresentString(account.subscriptionType, usage.subscription_type),
    organization: firstPresentString(account.organization),
    apiProvider: toAccountApiProvider(account.apiProvider),
    apiKeySource: toAccountApiKeySource(account.apiKeySource),
    // 生の `tokenSource` を載せない: `AccountUsage` はそのまま `GET /usage` へ載る型のため
    tokenSourcePresence: toTokenSourcePresence(account.tokenSource),
    limitsAvailable: usage.rate_limits_available === true,
    windows,
    extraUsage,
  };
}

// 判定は意図して2つに束ねる: `nonEmpty()` を外す前の挙動を変えないため。観測や表示の側でこの束ね方を真似しない
function hasPlanName(usage: AccountUsage): boolean {
  return usage.plan !== undefined && usage.plan.trim().length > 0;
}

// 順序を入れ替えない: 未ログインを最初に見ないと、鍵が届く前の状態が `non_first_party` や `undetermined` を名乗る
// `provider` が `undefined` / `'unrecognized'` のとき `non_first_party` へ倒さない: 名乗っていない・知らない値は「3P である」の断定ではなく、観測していないことを断定するため
// `limitsAvailable === false` を1つの理由に潰さない: 未ログインでも false が返るが「サブスクが無い」ではなく、鍵が後から届くのは通常の状態のため
export function classifyLimitsUnavailable(
  usage: AccountUsage,
  tokenSourceRaw: string | undefined,
): LimitsUnavailableCause | undefined {
  if (isNotLoggedIn(tokenSourceRaw)) return 'not_logged_in';
  const provider = usage.apiProvider;
  if (provider !== undefined && provider !== 'firstParty' && provider !== 'unrecognized') {
    return 'non_first_party';
  }
  if (usage.limitsAvailable === false && !hasPlanName(usage)) return 'undetermined';
  return undefined;
}

// `??` の既定値にしない: `''` は nullish ではないので既定値が出ず空白が出るため
function planForReason(plan: string | undefined): string {
  if (plan === undefined) return '不明';
  return plan.trim().length === 0 ? '不明（欄はあるが空）' : plan;
}

// `undetermined` の文言に「サブスクが無い」と書かない: 読んだ人間が「このアカウントは Claude のサブスクを持っていない」と読み違えるため
export function describeLimitsUnavailable(
  usage: AccountUsage,
  cause: LimitsUnavailableCause,
): string {
  switch (cause) {
    case 'not_logged_in':
      return 'claude.ai にログインしていない（鍵が届けば取れる）';
    case 'non_first_party':
      return `この認証では claude.ai の枠が効かない（apiProvider: ${usage.apiProvider ?? '不明'}）`;
    case 'undetermined':
      return (
        '枠が効かない理由を言い分けられない' +
        `（rate_limits_available: ${String(usage.limitsAvailable)} / apiProvider: ${usage.apiProvider ?? '不明'} / plan: ${planForReason(usage.plan)}）` +
        '。**「サブスクが無い」と読まないこと** —— この欄が false になる原因には' +
        '「profile スコープの不足」（鍵を取り直せば戻りうる）が含まれる（#681）'
      );
  }
}

export function isNotLoggedIn(tokenSourceRaw: string | undefined): boolean {
  return tokenSourceRaw === 'none';
}

export const ACCOUNT_INFO_KEYS_LIMIT = 32;

// 識別子の形でない名前は落とす: 名前の位置に自由文が来る形を、外へ出る面へ運ばないため
export function accountInfoKeysOf(accountJson: unknown): string[] | undefined {
  if (typeof accountJson !== 'object' || accountJson === null || Array.isArray(accountJson)) {
    return undefined;
  }
  return Object.keys(accountJson)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))
    .sort()
    .slice(0, ACCOUNT_INFO_KEYS_LIMIT);
}

function rawTokenSourceOf(accountJson: unknown): string | undefined {
  const account = (
    typeof accountJson === 'object' && accountJson !== null ? accountJson : {}
  ) as Record<string, unknown>;
  return nonEmpty(account.tokenSource);
}

export function hasAccountUsageDetail(usage: AccountUsage): boolean {
  return hasPlanName(usage) || usage.windows.length > 0 || usage.extraUsage !== undefined;
}

export const ACCOUNT_USAGE_READ_TIMEOUT_MS = 10_000;

// export する: `fetchAccountUsage` 経由では timeout / aborted を作れず（読み取りが常に外側の締め切りより先に終わる）、直接呼ぶ単体テストで両方の分岐を確かめるため
export function describeOuterFailure(failure: UsageProbeFailure): string {
  const label: Record<UsageProbeFailure['kind'], string> = {
    exception: '起動失敗',
    timeout: '締め切り',
    aborted: '中断',
  };
  return `probe が応答しなかった（${label[failure.kind]}: ${failure.reason}）`;
}

export function describeSilentChannels(
  accountReject: string | undefined,
  usageReject: string | undefined,
): string {
  const describe = (reject: string | undefined) =>
    reject === undefined ? '応答なし（口が無いか、締め切りに間に合わなかった）' : `例外: ${reject}`;
  return (
    `2つの口のどちらも答えなかった` +
    `（accountInfo: ${describe(accountReject)} / usage: ${describe(usageReject)}）`
  );
}

// 2つの口を独立に読む: 片方が固まってももう片方の答えを捨てないため（`accountInfo()` は答えるのに usage 側は `rate_limits: null` という食い違いが実測されている）
export async function fetchAccountUsage(
  queryFn: UsageProbeQuery,
  options: {
    cwd: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    withheldEnvKeys?: readonly string[];
  },
): Promise<AccountUsageState> {
  const at = new Date().toISOString();

  let accountReject: string | undefined;
  let usageReject: string | undefined;

  const outcome = await runUsageProbe(queryFn, options, async (handle) => {
    const [account, usage] = await Promise.all([
      settleWithin(handle.accountInfo?.(), ACCOUNT_USAGE_READ_TIMEOUT_MS, (error) => {
        accountReject = describeProbeError(error, options.env);
      }),
      settleWithin(
        handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.(),
        ACCOUNT_USAGE_READ_TIMEOUT_MS,
        (error) => {
          usageReject = describeProbeError(error, options.env);
        },
      ),
    ]);
    return { account, usage };
  });

  if (!outcome.ok) {
    return { state: 'failed', at, reason: describeOuterFailure(outcome.failure) };
  }
  const read = outcome.value;
  if (read.account === undefined && read.usage === undefined) {
    return { state: 'failed', at, reason: describeSilentChannels(accountReject, usageReject) };
  }

  const usage = toAccountUsage(at, read.usage, read.account);
  // 生値はここだけで持つ: `usage`（外へ出る型）には積まない
  const tokenSourceRaw = rawTokenSourceOf(read.account);
  const accountKeys = accountInfoKeysOf(read.account);

  // 理由を1つに潰さない: 未ログイン・3P・言い分けられないは、判定が同じ `undecidable` でも人間が次にやることが違うため
  const unavailable = classifyLimitsUnavailable(usage, tokenSourceRaw);
  if (unavailable !== undefined) {
    return {
      state: 'unavailable',
      at,
      reason: describeLimitsUnavailable(usage, unavailable),
      cause: unavailable,
      apiKeySource: usage.apiKeySource,
      ...(accountKeys === undefined ? {} : { accountKeys }),
    };
  }
  if (!hasAccountUsageDetail(usage)) {
    return {
      state: 'failed',
      at,
      reason: `枠の中身が返らなかった（rate_limits_available: ${usage.limitsAvailable}）`,
    };
  }
  return { state: 'ok', usage };
}
