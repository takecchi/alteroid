import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// 応答かどうかを文言で判定しない: `classifyUsageNotice` は部分一致なので、クローンが日報に「上限に当たった」と書いた瞬間に上限と誤判定するため
export type SdkFailureVia = 'assistant_error' | 'result_subtype' | 'result_is_error';

export interface SdkFailure {
  via: SdkFailureVia;
  // 言い換えない: 人間が SDK の型定義で引ける語のまま残すため
  code: string;
  text: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

// `cloud_credential_error` を「待てば開く」とも「人が動く」とも分類しない: SDK 自身の印が割れているため
// メッセージそのものを受け取らない: SDK の綴りを読むのは `claude-provider.ts` の `foldClaudeMessage` の仕事で、ここに3つ目の写しを作ると取り違えが片方だけで起きるため
export function assistantFailureOf(error: unknown, text: string): SdkFailure | undefined {
  const code = nonEmpty(error);
  return code === undefined ? undefined : { via: 'assistant_error', code, text };
}

// `usage.ts` の `isSuccessResult` に寄せない: 台帳側を厳しくすると `is_error` の回の累積が載らず、応答側を緩くすると `subtype: 'success'` かつ `is_error: true` が「答えが返った」ことになるため
export function isAnsweredResult(message: unknown): boolean {
  const candidate = message as { subtype?: unknown; is_error?: unknown };
  return candidate.subtype === 'success' && candidate.is_error !== true;
}

// HTTP の状態番号を落とさない: 429 と 402 と 500 は待ち方が違うため
export function resultFailureOf(message: SDKMessage): SdkFailure | undefined {
  if (isAnsweredResult(message)) return undefined;
  const candidate = message as {
    subtype?: unknown;
    result?: unknown;
    api_error_status?: unknown;
  };
  const subtype = nonEmpty(candidate.subtype);
  const status =
    typeof candidate.api_error_status === 'number' && Number.isFinite(candidate.api_error_status)
      ? `/${String(candidate.api_error_status)}`
      : '';
  return {
    via: subtype === 'success' ? 'result_is_error' : 'result_subtype',
    code: `${subtype ?? '(不明)'}${status}`,
    text: nonEmpty(candidate.result) ?? '',
  };
}

export function resultErrorLines(message: SDKMessage): string[] {
  const errors = (message as { errors?: unknown }).errors;
  return Array.isArray(errors)
    ? errors.filter((line): line is string => typeof line === 'string')
    : [];
}
