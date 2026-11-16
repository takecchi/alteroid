import type { UsageBreakdown } from '@alteroid/core';

// MCP の `usage_read` が返す集計を、`top`（一覧ごとの上位 N 件）と `sections`（返す内訳の種類）で縮める。
// 1日分でも manager が数百件あると、`byManager` と `unrecordedManagers` だけで 60,000 字を超える（実測: 100,948 字）。
// 縮めたことは必ず `lists` に出す（一覧ごとの総数・返した件数・切った件数）: 黙って欠けると「その manager は使っていない」と読める。

// 実在する欄の名前だけ。`totals` は `breakdown.total`（と `turns`）で、他は内訳の一覧と、集計の側の一覧
export const USAGE_SECTIONS = [
  'totals',
  'byDate',
  'byManager',
  'byModel',
  'byLayer',
  'bySite',
  'byToken',
  'unrecordedManagers',
  'unreadableRows',
  'unmeteredRows',
  'resets',
] as const;

export type UsageSection = (typeof USAGE_SECTIONS)[number];

const BREAKDOWN_LISTS = ['byDate', 'byManager', 'byModel', 'byLayer', 'bySite', 'byToken'] as const;

export interface UsageShapeOptions {
  top?: number | undefined;
  sections?: readonly UsageSection[] | undefined;
}

export interface ListCount {
  total: number;
  returned: number;
  omitted: number;
}

interface UsageSource {
  breakdown: UsageBreakdown;
  unrecordedManagers: readonly unknown[];
  unreadableRows?: readonly unknown[] | undefined;
  unmeteredRows?: readonly unknown[] | undefined;
  resets?: readonly unknown[] | undefined;
}

// 大きい順 = 費用の大きい順（`top` を渡したときだけ並べ替える。渡さなければ従来の並びのまま）
const byCostDesc = (a: { totals: { costUsd: number } }, b: { totals: { costUsd: number } }) =>
  b.totals.costUsd - a.totals.costUsd;

export function shapeUsageAggregate<S extends UsageSource>(
  source: S,
  options: UsageShapeOptions,
): { data: Record<string, unknown>; lists: Record<string, ListCount> | undefined } {
  const { top, sections } = options;
  const shaping = top !== undefined || sections !== undefined;
  const lists: Record<string, ListCount> = {};
  const wanted = (name: UsageSection) => sections === undefined || sections.includes(name);

  function pick<T>(
    name: UsageSection,
    items: readonly T[] | undefined,
    rank?: (a: T, b: T) => number,
  ): readonly T[] | undefined {
    if (items === undefined) return undefined;
    if (!wanted(name)) {
      lists[name] = { total: items.length, returned: 0, omitted: items.length };
      return undefined;
    }
    const ordered = top !== undefined && rank !== undefined ? [...items].sort(rank) : items;
    const out = top === undefined ? ordered : ordered.slice(0, top);
    lists[name] = { total: items.length, returned: out.length, omitted: items.length - out.length };
    return out;
  }

  const { breakdown, unrecordedManagers, unreadableRows, unmeteredRows, resets, ...rest } = source;
  const shapedBreakdown: Record<string, unknown> = { total: breakdown.total };
  if (breakdown.turns !== undefined) shapedBreakdown.turns = breakdown.turns;
  for (const name of BREAKDOWN_LISTS) {
    const items = pick<{ totals: { costUsd: number } }>(name, breakdown[name], byCostDesc);
    if (items !== undefined) shapedBreakdown[name] = items;
  }

  const data: Record<string, unknown> = { ...rest, breakdown: shapedBreakdown };
  const extras = { unrecordedManagers, unreadableRows, unmeteredRows, resets } as const;
  for (const [name, items] of Object.entries(extras) as [UsageSection, readonly unknown[]][]) {
    const out = pick(name, items);
    if (out !== undefined) data[name] = out;
  }
  return { data, lists: shaping ? lists : undefined };
}

// 既定のまま上限に当たったときに順に試す top。要求が小さければ、それより小さいものだけを試す
const TOP_LADDER = [50, 20, 10, 5] as const;

export interface UsageAttempt {
  options: UsageShapeOptions;
  step: string;
}

export function usageAttempts(requested: UsageShapeOptions): UsageAttempt[] {
  const attempts: UsageAttempt[] = [{ options: requested, step: 'requested' }];
  for (const top of TOP_LADDER) {
    if (requested.top !== undefined && top >= requested.top) continue;
    attempts.push({ options: { ...requested, top }, step: `top=${String(top)}` });
  }
  attempts.push({ options: { ...requested, top: 5, sections: ['totals'] }, step: 'totals-only' });
  return attempts;
}
