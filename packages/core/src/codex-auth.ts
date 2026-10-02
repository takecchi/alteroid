import type { CodexGetAccountResponse, CodexLoginApiKeyParams } from './codex-protocol.js';

/**
 * Codex の認証の選び方（#486 M7 S6）。純粋な決定表で、ファイル・環境変数は読まない
 * （呼び出し側が渡す）。どこからも呼ばれない部品。
 *
 * 優先順: API キー（袋の `CODEX_API_KEY`）が先、ChatGPT ログインは控え、どちらも無ければ失敗。
 * app-server は環境変数 `CODEX_API_KEY` を読まないため、駆動役が袋から読んで
 * `account/login/start` に渡す。
 *
 * **鍵の値は、このファイルの出力（reason を含む）のどこにも載せない。**
 * 値が出るのは `buildCodexApiKeyLoginParams` の戻り値（プロトコルに載せる params）だけで、
 * それは送信専用でログへ渡さないこと。
 */

export interface CodexAuthInput {
  /** 袋から読んだ API キー。無い・空・空白だけは「無い」として扱う。 */
  apiKey?: string | null;
  /**
   * ChatGPT ログインがあるか。
   * 根拠: 起動前に分かる手がかりは `CODEX_HOME/auth.json` の存在だけだが、保存先が keyring のことも
   * あり（rust-v0.160.0 `AuthCredentialsStoreMode`: file/keyring/auto/ephemeral）、auth.json に
   * API キーだけが入っていることもある。よって確定は起動後の `account/read`
   * （`account.type === 'chatgpt'`）で行い、これは「あるかもしれない」手がかりとして呼び出し側が渡す。
   */
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

/**
 * apiKey のときに `account/login/start` へ送る params。
 * ephemeral 保存を指定する欄はプロトコルに無い（生成スキーマ 0.160.0 の LoginAccountParams の
 * apiKey 枝は `type` と `apiKey` のみ）。0.160.0 の app-server は `cli_auth_credentials_store`
 * 設定（既定 file）に従い `CODEX_HOME/auth.json` へ保存する。ephemeral は config 側
 * （`cli_auth_credentials_store = "ephemeral"`）で指定する必要がある。
 */
export function buildCodexApiKeyLoginParams(apiKey: string): CodexLoginApiKeyParams {
  return { type: 'apiKey', apiKey };
}

/** 記録用: 実際にどちらで動いているか。 */
export type CodexAuthMode = 'apiKey' | 'chatgpt' | 'unknown';

/** `account/read` の応答から記録用の値へ。知らない種別・account 無しは 'unknown'。 */
export function codexAuthModeFromAccount(
  response: Pick<CodexGetAccountResponse, 'account'> | null | undefined,
): CodexAuthMode {
  const type = response?.account?.type;
  if (type === 'apiKey') return 'apiKey';
  if (type === 'chatgpt') return 'chatgpt';
  return 'unknown';
}
