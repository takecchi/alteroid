import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import {
  ORG_POLICY_LIMIT_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
  USAGE_TRANSITION_PREFIXES,
  USAGE_WARNING_PREFIXES,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// 文言のパターンを自前で書かない: 手で書いた正規表現は腐り、検知しなくなる形で静かに効かなくなるため。SDK の定数を使う
export const usageLimitKindSchema = z.enum(['reached', 'transition', 'warning', 'org_policy']);

export type UsageLimitKind = z.infer<typeof usageLimitKindSchema>;

export const usageLimitNoticeSchema = z.object({
  kind: usageLimitKindSchema,
  text: z.string(),
  // 文言だけの経路では推測で埋めない: 「回復予定が無い」と「回復予定を知らない」が区別できなくなるため
  resetsAt: z.number().int().positive().optional(),
});

export type UsageLimitNotice = z.infer<typeof usageLimitNoticeSchema>;

// 最初に当たったものを採らず最長を採る: 短い接頭辞が長い接頭辞を食うため。配列を引数で受けて export する: SDK の並び順に依存せずテストで測るため
export function longestMatchingPrefix(
  text: string,
  prefixes: readonly string[],
): string | undefined {
  const trimmed = text.trimStart();
  let best: string | undefined;
  for (const prefix of prefixes) {
    if (!trimmed.startsWith(prefix) && !trimmed.includes(prefix)) continue;
    if (best === undefined || prefix.length > best.length) best = prefix;
  }
  return best;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return longestMatchingPrefix(text, prefixes) !== undefined;
}

// 順序を入れ替えない: 前方一致の範囲が重なりうるので、重い側から見ないと止まっているのに警告として扱う。組織方針は上限と混ぜず独立に見る
export function classifyUsageNotice(text: string): UsageLimitNotice | undefined {
  if (text.trim().length === 0) return undefined;
  if (startsWithAny(text, ORG_POLICY_LIMIT_PREFIXES)) return { kind: 'org_policy', text };
  if (startsWithAny(text, USAGE_LIMIT_ERROR_PREFIXES)) return { kind: 'reached', text };
  if (startsWithAny(text, USAGE_TRANSITION_PREFIXES)) return { kind: 'transition', text };
  if (startsWithAny(text, USAGE_WARNING_PREFIXES)) return { kind: 'warning', text };
  return undefined;
}

export function describeUsageNotice(notice: UsageLimitNotice): string {
  const head =
    notice.kind === 'reached'
      ? '利用上限に当たった。この文言で仕事が止まっている'
      : notice.kind === 'transition'
        ? '枠を使い切って課金枠（extra usage）に移った。**まだ動くが、この先で止まる**'
        : notice.kind === 'warning'
          ? '利用上限に近づいている'
          : '組織の方針で止められている（利用上限ではないので、待っても増やしても直らない）';
  return `${head}: ${notice.text}`;
}

// unknown を action と同じ扱いにしない: action と読み違えると、まだ戻るトークンを捨てるため
// 回復の見込みは散文より先に overageDisabledReason を見るべき: 閉じた union の構造化された値のため（「overageDisabledReason?: 'overage_not_provisioned'」 [sdk-verbatim SDKRateLimitInfo.overageDisabledReason]）
export const limitRecoverySchema = z.enum(['time', 'action', 'unknown']);
export type LimitRecovery = z.infer<typeof limitRecoverySchema>;

function refineHitYourFamilyRecovery(text: string): LimitRecovery {
  // `individual spend limit` を time にしない: `You've hit your individual spend limit · ask your admin to raise it` は人間が上限を上げるまで開かない壁のため
  if (text.includes('individual spend limit')) return 'action';
  if (text.includes("org's monthly spend limit")) return 'time';
  if (/\bresets\b/i.test(text)) return 'time';
  // 分類していない変種は time にしない: 粗い既定値が黙って time を名乗るため
  return 'unknown';
}

type RecoveryRule = LimitRecovery | ((text: string) => LimitRecovery);

const LIMIT_RECOVERY_BY_PREFIX = new Map<string, RecoveryRule>([
  ["You've hit your", refineHitYourFamilyRecovery],
  ["You've reached your", refineHitYourFamilyRecovery],
  ['Your org is out of usage · add funds to continue', 'action'],
  ['Your org is out of usage · contact your admin', 'action'],
  ["Your seat type doesn't include usage credits", 'action'],
  ["Your seat type doesn't include usage", 'action'],
  ['Your usage allocation has been disabled by your admin', 'action'],
  ["Your group's usage limit is set to $0", 'action'],
  ["Your seat type doesn't include extra usage", 'action'],
  // action にしない: クレジットが買うものか配られるものかを知らず、action と書くと月初に戻るトークンを捨てるため
  ["You're out of usage credits", 'unknown'],
  ['Fable 5 requires usage credits', 'unknown'],
  ["You're out of extra usage", 'unknown'],
]);

export function knownLimitRecoveryPrefixes(): string[] {
  return [...LIMIT_RECOVERY_BY_PREFIX.keys()];
}

// limitRecoveryOf に畳まない: 長短の取り違えは limitRecoveryOf の返り値だけを見ても現れない。
export function matchedUsageLimitPrefix(text: string): string | undefined {
  return longestMatchingPrefix(text, USAGE_LIMIT_ERROR_PREFIXES);
}

// 組織方針を先に見る: 待っても直らない（`ORG_POLICY_LIMIT_PREFIXES` の doc: 「This service is disabled for your org」 [sdk-verbatim ORG_POLICY_LIMIT_PREFIXES]）
export function limitRecoveryOf(text: string): LimitRecovery {
  if (longestMatchingPrefix(text, ORG_POLICY_LIMIT_PREFIXES) !== undefined) return 'action';
  const prefix = matchedUsageLimitPrefix(text);
  if (prefix === undefined) return 'unknown';
  const rule = LIMIT_RECOVERY_BY_PREFIX.get(prefix);
  if (rule === undefined) return 'unknown';
  // matched した接頭辞ではなく元の text を渡す: 細分が見るのは接頭辞より後ろの部分のため
  return typeof rule === 'function' ? rule(text) : rule;
}

export const STALE_TOKEN_RECOVERY_CAVEAT =
  '⚠ ただしこの見込みは**枠のほうの話**であって、この委譲が戻ることを意味しない' +
  '——認証トークンの世代が食い違っているので、枠がリセットされても' +
  'このセッションは古い鍵のまま走り続ける（上の世代の行を見ること）。';

export const STALE_TOKEN_RESTART_ADVICE =
  '⚠ 止める前に、その委譲がターンの途中かどうかを manager_stop の断り' +
  '（未 push・未コミットの実物が出る）で確かめること。そのうえで ' +
  'manager_stop → manager_start で起こし直すこと（新しいプロセスなので新しい鍵で走る）。' +
  '⚠ 失われるのは会話だけではない——そのターンで進行中だった作業も失われる。';

export const RESTART_BEFORE_CHECK_ADVICE_CORE = '確かめる前に manager_start で起こし直さないこと';

export const RESTART_BEFORE_CHECK_ADVICE = `**${RESTART_BEFORE_CHECK_ADVICE_CORE}** — 同じ仕事が2本になる。`;

export const RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN =
  '**確かめる前に `manager_start` で起こし直さないこと** — 同じ仕事が2本になる。';

// unknown のときは何も足さない: 毎回「不明」の1行を足すと、大半の合図に読む価値の無いノイズが増えるため
export function withRecoveryNote(
  base: string,
  recovery: LimitRecovery,
  options?: { readonly staleToken?: boolean },
): string {
  if (recovery === 'unknown') return base;
  const label = recovery === 'time' ? '時間で戻る（time）' : '人間が動かないと戻らない（action）';
  const note = `${base}\n（回復の見込み: ${label}）`;
  // action には足さない: 既に「待っても戻らない」と言っており、同じことを2行で言うだけになるため
  if (options?.staleToken !== true || recovery !== 'time') return note;
  return `${note}\n${STALE_TOKEN_RECOVERY_CAVEAT}`;
}

// billing_error を決め打たない: 同じ語で individual spend limit（action）と org's monthly spend limit（time）の両方が実測されており、答えは文言側の軸が持つため
// 確信が持てない語を action にしない: action と読み違えると、まだ戻るトークンを捨てるため
type SDKAssistantMessageErrorの語が増えたらこの表と_usage_limits_ts_の_doc_へ足して同じ_PR_で緑にする =
  Record<SDKAssistantMessageError, LimitRecovery>;

const LIMIT_RECOVERY_BY_ASSISTANT_ERROR: SDKAssistantMessageErrorの語が増えたらこの表と_usage_limits_ts_の_doc_へ足して同じ_PR_で緑にする =
  {
    authentication_failed: 'action',
    oauth_org_not_allowed: 'action',
    account_on_hold: 'action',
    verification_required: 'action',
    billing_error: 'unknown',
    rate_limit: 'time',
    overloaded: 'time',
    invalid_request: 'unknown',
    model_not_found: 'unknown',
    server_error: 'time',
    unknown: 'unknown',
    max_output_tokens: 'unknown',
    cloud_credential_error: 'unknown',
  };

// 型で塞いだ分岐にも実行時の倒れ先を置く: 表が SDK の新しい語に追いつく前や、別の版の core を積んだ側から知らない語が来うるため
export function limitRecoveryOfAssistantError(code: string): LimitRecovery {
  return Object.prototype.hasOwnProperty.call(LIMIT_RECOVERY_BY_ASSISTANT_ERROR, code)
    ? LIMIT_RECOVERY_BY_ASSISTANT_ERROR[code as SDKAssistantMessageError]
    : 'unknown';
}

export function knownAssistantErrorRecoveryCodes(): SDKAssistantMessageError[] {
  return Object.keys(LIMIT_RECOVERY_BY_ASSISTANT_ERROR) as SDKAssistantMessageError[];
}

export const rateLimitFactsSchema = z.object({
  kind: z.string().optional(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
  utilization: z.number().nonnegative().optional(),
  resetsAt: z.number().int().positive().optional(),
  overageStatus: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
  overageResetsAt: z.number().int().positive().optional(),
  overageDisabledReason: z.string().optional(),
  usingOverage: z.boolean().optional(),
  errorCode: z.string().optional(),
});

export type RateLimitFacts = z.infer<typeof rateLimitFactsSchema>;

const STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const;

function toStatus(value: unknown): (typeof STATUSES)[number] | undefined {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as (typeof STATUSES)[number])
    : undefined;
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e11 ? Math.floor(value) : Math.floor(value * 1000);
}

export function toRateLimitFacts(value: unknown): RateLimitFacts | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const facts: RateLimitFacts = {
    kind: typeof raw.rateLimitType === 'string' ? raw.rateLimitType : undefined,
    status: toStatus(raw.status),
    utilization:
      typeof raw.utilization === 'number' &&
      Number.isFinite(raw.utilization) &&
      raw.utilization >= 0
        ? raw.utilization
        : undefined,
    resetsAt: toEpochMs(raw.resetsAt),
    overageStatus: toStatus(raw.overageStatus),
    overageResetsAt: toEpochMs(raw.overageResetsAt),
    overageDisabledReason:
      typeof raw.overageDisabledReason === 'string' ? raw.overageDisabledReason : undefined,
    usingOverage:
      typeof raw.isUsingOverage === 'boolean'
        ? raw.isUsingOverage
        : typeof raw.overageInUse === 'boolean'
          ? raw.overageInUse
          : undefined,
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : undefined,
  };
  return Object.values(facts).some((v) => v !== undefined) ? facts : undefined;
}

// kind だけを鍵にしない: 別々のアカウントの事実が同じ欄を踏み合い、同じ知らせの再配達と別トークンの rejected の取りこぼしの両方が起きるため
// 区切り文字ではなく長さで分ける: 値の中身への仮定なしに衝突を防ぐため。区切りに制御文字を使わない: 生の NUL が追跡対象に入ると CI が落ちるため
export function rateLimitMemoryKey(tokenId: string | undefined, kind: string | undefined): string {
  const token = tokenId ?? '';
  return `${String(token.length)}:${token}${kind ?? ''}`;
}

// 置き換えない: status を運ばない観測が rejected の記憶を消し、次の同じ rejected が新しい遷移として再配達されるため
// allowed で届いたら記憶を上書きする（塞がない）: 塞ぐと本物の再発が黙って消えるため
export function mergeRateLimitFacts(
  previous: RateLimitFacts | undefined,
  next: RateLimitFacts,
): RateLimitFacts {
  if (previous === undefined) return next;
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as RateLimitFacts;
}

// 毎ターン届く同じ事実を遷移にしない: 受信箱が埋まり、本当に変わった1回が埋もれるため
// overageDisabledReason が undefined の観測は「変わった」に数えない: mergeRateLimitFacts が覚えている値を消さないのと同じ理由
export function usageTransitionOf(
  previous: RateLimitFacts | undefined,
  next: RateLimitFacts,
): 'entered_overage' | 'rejected' | undefined {
  if (next.status === 'rejected' && previous?.status !== 'rejected') return 'rejected';
  if (
    next.status === 'rejected' &&
    next.overageDisabledReason !== undefined &&
    next.overageDisabledReason !== previous?.overageDisabledReason
  ) {
    return 'rejected';
  }
  if (next.usingOverage === true && previous?.usingOverage !== true) return 'entered_overage';
  return undefined;
}
