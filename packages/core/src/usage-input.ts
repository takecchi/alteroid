import { hasNul, stripNul } from './nul-guard.js';
import type { UsageSnapshot } from './usage.js';

// NUL だけの tokenId を空文字にしない: 空文字は「帰属なし」の行を表し、落とすとそこへ混ざるため。丸括弧は UUID に現れず、本物の id と衝突しない
export const USAGE_NUL_ONLY_TOKEN_ID = '(nul-only)';

function stripNulFromTokenId(tokenId: string): string {
  const stripped = stripNul(tokenId);
  return stripped === '' && hasNul(tokenId) ? USAGE_NUL_ONLY_TOKEN_ID : stripped;
}

// 鍵でも断らず落として残す: 断ると消費の記録が丸ごと消える（呼び出し側は失敗を握りつぶすだけ）ため
export function stripNulFromUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return {
    ...snapshot,
    ...(snapshot.sessionId === undefined ? {} : { sessionId: stripNul(snapshot.sessionId) }),
    models: Object.fromEntries(
      Object.entries(snapshot.models).map(([model, totals]) => [stripNul(model), totals]),
    ),
  };
}

export function stripNulFromUsageRecord<
  T extends {
    managerId: string;
    tokenId?: string;
    snapshot: UsageSnapshot;
    runner?: { readonly id: string; readonly superseded: boolean };
  },
>(input: T): T {
  return {
    ...input,
    managerId: stripNul(input.managerId),
    ...(input.runner === undefined
      ? {}
      : { runner: { id: stripNul(input.runner.id), superseded: input.runner.superseded } }),
    ...(input.tokenId === undefined ? {} : { tokenId: stripNulFromTokenId(input.tokenId) }),
    snapshot: stripNulFromUsageSnapshot(input.snapshot),
  };
}

export function stripNulFromUnmeteredRecord<
  T extends { managerId: string; tokenId?: string; provider: string },
>(input: T): T {
  return {
    ...input,
    managerId: stripNul(input.managerId),
    provider: stripNul(input.provider),
    ...(input.tokenId === undefined ? {} : { tokenId: stripNulFromTokenId(input.tokenId) }),
  };
}

export function stripNulFromUsageQuery<
  T extends { from?: string; to?: string; managerId?: string; tokenId?: string },
>(query: T): T {
  // NUL を含む日付は落として引かない: 別の日に一致してしまうため。どの日付も含まない範囲に置き換える
  const unreadableRange =
    (query.from !== undefined && hasNul(query.from)) ||
    (query.to !== undefined && hasNul(query.to));
  return {
    ...query,
    ...(unreadableRange ? { from: '9999-12-31', to: '0000-01-01' } : {}),
    ...(query.managerId === undefined ? {} : { managerId: stripNul(query.managerId) }),
    ...(query.tokenId === undefined ? {} : { tokenId: stripNulFromTokenId(query.tokenId) }),
  };
}
