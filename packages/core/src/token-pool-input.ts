import { assertNoNul, stripNul } from './nul-guard.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';

/**
 * `TokenPoolStore.replace` に同じ id が2行以上渡されたときの例外（issue #2927 の項目3）。
 * 以前は fs が2行とも保存し、pg は主キー違反の DB エラーで落ちていた。
 * **例外の文に id を載せない**（`NulNotAllowedError` と同じ理由）。
 */
export class DuplicateTokenIdError extends Error {
  constructor() {
    super('認証トークンの id が重複しているので、受け付けない');
    this.name = 'DuplicateTokenIdError';
  }
}

/**
 * `replace` の入力を、書く前に全件検査して整える（3実装が同じものを呼ぶ）。
 *
 * - 鍵（`id`）と資格（`value`）に NUL があれば `NulNotAllowedError`。
 * - `id` の重複は `DuplicateTokenIdError`。
 * - それ以外の文字列（`label`・`lastRejectedReason` など）は NUL を落として残す。
 *
 * 入力は書き換えず、整えた写しを返す。
 */
export function prepareTokensForReplace(tokens: readonly AgentToken[]): AgentToken[] {
  const seen = new Set<string>();
  return tokens.map((token) => {
    assertNoNul('token.id', token.id);
    if (token.value !== undefined) assertNoNul('token.value', token.value);
    if (seen.has(token.id)) throw new DuplicateTokenIdError();
    seen.add(token.id);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(token)) {
      out[key] =
        typeof field === 'string' && key !== 'id' && key !== 'value' ? stripNul(field) : field;
    }
    return out as unknown as AgentToken;
  });
}

/** `writeActive` の入力を検査する。`tokenId` は鍵なので NUL は断る。 */
export function assertValidActiveToken(active: ActiveAgentToken): void {
  assertNoNul('active.tokenId', active.tokenId);
}
