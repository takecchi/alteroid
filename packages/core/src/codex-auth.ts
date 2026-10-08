import type { CodexGetAccountResponse, CodexLoginApiKeyParams } from './codex-protocol.js';

export interface CodexAuthInput {
  apiKey?: string | null;
  // 確定にしない: 保存先が keyring のことも auth.json に API キーだけのこともあり、確定は起動後の account/read だけができるため
  chatgptLogin: boolean;
}

export type CodexAuthChoice =
  { kind: 'apiKey'; apiKey: string } | { kind: 'chatgpt' } | { kind: 'none'; reason: string };

export const CODEX_AUTH_NONE_REASON =
  'Codex の認証が無い: 袋に CODEX_API_KEY が無い（または空）、かつ CODEX_HOME に ChatGPT ログインが見つからない';

export function selectCodexAuth(input: CodexAuthInput): CodexAuthChoice {
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (key !== '') return { kind: 'apiKey', apiKey: key };
  if (input.chatgptLogin) return { kind: 'chatgpt' };
  return { kind: 'none', reason: CODEX_AUTH_NONE_REASON };
}

// ephemeral の欄を足さない: LoginAccountParams の apiKey 枝は type と apiKey だけで、ephemeral は config 側（cli_auth_credentials_store）で指定するため
export function buildCodexApiKeyLoginParams(apiKey: string): CodexLoginApiKeyParams {
  return { type: 'apiKey', apiKey };
}

export type CodexAuthMode = 'apiKey' | 'chatgpt' | 'unknown';

export function codexAuthModeFromAccount(
  response: Pick<CodexGetAccountResponse, 'account'> | null | undefined,
): CodexAuthMode {
  const type = response?.account?.type;
  if (type === 'apiKey') return 'apiKey';
  if (type === 'chatgpt') return 'chatgpt';
  return 'unknown';
}
