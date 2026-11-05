import { compareCodeUnits } from './code-unit-order.js';
import type {
  UsageLayer,
  UsageQuery,
  UsageRow,
  UsageSite,
  UsageTotals,
  UsageTurnRow,
  UsageUnmeteredRow,
} from './usage.js';
import { addUnreadableCounts } from './usage-format.js';

// fs の保存先とインメモリの器が使う、使用量台帳の「照会・鍵・並び・足し込み」の1か所。
// pg は SQL（`where` と `order by ... collate "C"`）で同じことを書くので、ここは使わない。向きは `usage-query-contract.ts` が3器に同じ入力を当てて測る。

/**
 * 読めた行が集計の絞り込み（期間・担当・層・場所・鍵）に当たるか。日ごと・ターン・測れなかった行の3つの表が同じ条件で絞る:
 * 表ごとに条件を写すと、1つの表だけ条件が抜けて、同じ問いで表によって答えが割れるため。
 */
export function matchesUsageQuery(
  row: {
    readonly date: string;
    readonly managerId: string;
    readonly layer: string;
    readonly site: string;
    readonly tokenId?: string | undefined;
  },
  query: UsageQuery,
): boolean {
  if (query.from !== undefined && row.date < query.from) return false;
  if (query.to !== undefined && row.date > query.to) return false;
  if (query.managerId !== undefined && row.managerId !== query.managerId) return false;
  if (query.layer !== undefined && row.layer !== query.layer) return false;
  if (query.site !== undefined && row.site !== query.site) return false;
  if (query.tokenId !== undefined && row.tokenId !== query.tokenId) return false;
  return true;
}

// 層と場所を鍵から外さない: 同じ actor・日・モデルで意味の違う行が足し込まれ、誤帰属になるため
// 生の NUL ではなくエスケープで書く: 生のバイトをソースへ置くと git がこのファイルを binary と判定し、PR の差分が読めなくなるため
// トークンは省略されうるので、空の区画として鍵へ入れる: 鍵から外すと、回した前後の増分が同じ行へ足し込まれて誤帰属になるため
export function usageRowKey(
  date: string,
  managerId: string,
  model: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${model}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

export function usageTurnKey(
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

export function usageUnmeteredKey(
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  provider: string,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${layer}\u0000${site}\u0000${provider}\u0000${tokenId ?? ''}`;
}

// 基準の鍵は「層 × actor」: actor の id だけだと、層をまたいで同じ id が来たとき別の累積が1つの基準を共有して差分が嘘になるため
export function usageBaselineKey(layer: UsageLayer, managerId: string): string {
  return `${layer}\u0000${managerId}`;
}

// 番兵の文字で代用しない: U+FFFF のような最大文字へ倒すと、その文字が id に現れたときだけ静かに順序が壊れるため
// pg 側（`nullif(token_id, '') collate "C" asc nulls last`）と向きを揃える: 器が違うだけで行の並びが変わると、同じ照会が口によって違う順で出るため
function compareTokenId(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return compareCodeUnits(a, b);
}

export function compareUsageRows(a: UsageRow, b: UsageRow): number {
  return (
    compareCodeUnits(a.date, b.date) ||
    compareCodeUnits(a.managerId, b.managerId) ||
    compareCodeUnits(a.model, b.model) ||
    compareCodeUnits(a.layer, b.layer) ||
    compareCodeUnits(a.site, b.site) ||
    compareTokenId(a.tokenId, b.tokenId)
  );
}

export function compareUsageTurnRows(a: UsageTurnRow, b: UsageTurnRow): number {
  return (
    compareCodeUnits(a.date, b.date) ||
    compareCodeUnits(a.managerId, b.managerId) ||
    compareCodeUnits(a.layer, b.layer) ||
    compareCodeUnits(a.site, b.site) ||
    compareTokenId(a.tokenId, b.tokenId)
  );
}

export function compareUsageUnmeteredRows(a: UsageUnmeteredRow, b: UsageUnmeteredRow): number {
  return (
    compareCodeUnits(a.date, b.date) ||
    compareCodeUnits(a.managerId, b.managerId) ||
    compareCodeUnits(a.layer, b.layer) ||
    compareCodeUnits(a.site, b.site) ||
    compareCodeUnits(a.provider, b.provider) ||
    compareTokenId(a.tokenId, b.tokenId)
  );
}

// `unreadable` も足し込む: 足さないと、読めなかった行の件数が足し込みのたびに落ちるため
export function addUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const unreadable = addUnreadableCounts(a.unreadable, b.unreadable);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
    costUsd: a.costUsd + b.costUsd,
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}
