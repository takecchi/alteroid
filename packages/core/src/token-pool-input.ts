import { assertNoNul, stripNul } from './nul-guard.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';

// 例外の文に id を載せない（NulNotAllowedError と同じ）
export class DuplicateTokenIdError extends Error {
  constructor() {
    super('認証トークンの id が重複しているので、受け付けない');
    this.name = 'DuplicateTokenIdError';
  }
}

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

export function assertValidActiveToken(active: ActiveAgentToken): void {
  assertNoNul('active.tokenId', active.tokenId);
}
