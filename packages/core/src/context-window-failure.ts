/**
 * 構造化された印で判定しない: 文脈窓専用の値が無く（下の13値）、文脈窓超過でも assistant.error は max_output_tokens のままで、印だけでは出力超過と区別できないため。折り返さず1行に置く: grep -F と check-sdk-quotes の門が当たらなくなるため
 *   [sdk-verbatim SDKAssistantMessageError]
 *   > 'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'verification_required' | 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens' | 'cloud_credential_error'
 */

export const CONTEXT_WINDOW_FAILURE_KINDS = [
  'prompt_too_long',
  'max_tokens_context_overflow',
  'model_context_window_exceeded',
] as const;

export type ContextWindowFailureKind = (typeof CONTEXT_WINDOW_FAILURE_KINDS)[number];

export interface ContextWindowFailure {
  kind: ContextWindowFailureKind;
  text: string;
}

// 「context window」の部分一致を採らない: 文脈窓の話題に触れただけの地の文まで拾い、誤検知の幅が広いため。これは文言の型合わせであって契約ではないので、当たらなかった失敗を「文脈窓ではない」と読み替えない
const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'input is too long for requested model',
] as const;

const MAX_TOKENS_CONTEXT_OVERFLOW_PATTERNS = [
  'input length and `max_tokens` exceed context limit',
] as const;

const MID_TURN_PATTERNS = ['the model has reached its context window limit'] as const;

function includesAny(lowerText: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => lowerText.includes(pattern));
}

// 投げない: 観測であって仕事ではなく、文字列以外を渡されても例外にしない
export function classifyContextWindowFailure(text: string): ContextWindowFailure | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const lower = text.toLowerCase();
  if (includesAny(lower, PROMPT_TOO_LONG_PATTERNS)) return { kind: 'prompt_too_long', text };
  if (includesAny(lower, MAX_TOKENS_CONTEXT_OVERFLOW_PATTERNS)) {
    return { kind: 'max_tokens_context_overflow', text };
  }
  if (includesAny(lower, MID_TURN_PATTERNS)) {
    return { kind: 'model_context_window_exceeded', text };
  }
  return undefined;
}

// 日本語の言い回しだけにしない: 表記ゆれで journal_read q= から引けなくなるため ASCII の検索語を含める。生の文言を繰り返さない: 呼び出し側の message に既に乗っているため。先頭を変えず末尾へ足す形で使う: 既存の startsWith の歯を壊すため
export function describeContextWindowFailure(failure: ContextWindowFailure): string {
  return (
    `（文脈窓（コンテキストウィンドウ）に当たった可能性がある: ` +
    `context_window_failure kind=${failure.kind}。` +
    `⚠️ この判定は文言の型合わせであって契約ではない — ` +
    `新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が` +
    `「文脈窓ではない」とも限らない）`
  );
}
