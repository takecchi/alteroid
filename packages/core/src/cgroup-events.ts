import { z } from 'zod';

import { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote } from './cgroup-events-format.js';

// 欄を `.optional()` にする: runner とデーモンは別デプロイで版がずれ、この欄が無い `closed` を壊さないため
// 読めない欄を 0 にしない: 「起きなかった」と「取れなかった」が同じ形になるため
export const cgroupEventsDeltaSchema = z.object({
  pidsMaxDelta: z.number().int().nonnegative().optional(),
  oomKillDelta: z.number().int().nonnegative().optional(),
});

export type CgroupEventsDelta = z.infer<typeof cgroupEventsDeltaSchema>;

// 逆行したカウンタは出さない: 別の cgroup を見てしまった（測り違え）と疑うべきで、負の差分を出すより判定を諦めるほうが安全側のため
export function cgroupEventsDeltaOf(
  opened: { pidsMax?: number; oomKill?: number } | undefined,
  closed: { pidsMax?: number; oomKill?: number } | undefined,
): CgroupEventsDelta | undefined {
  if (opened === undefined || closed === undefined) return undefined;
  const pidsMaxDelta = nonNegativeDeltaOf(opened.pidsMax, closed.pidsMax);
  const oomKillDelta = nonNegativeDeltaOf(opened.oomKill, closed.oomKill);
  if (pidsMaxDelta === undefined && oomKillDelta === undefined) return undefined;
  return {
    ...(pidsMaxDelta === undefined ? {} : { pidsMaxDelta }),
    ...(oomKillDelta === undefined ? {} : { oomKillDelta }),
  };
}

function nonNegativeDeltaOf(
  before: number | undefined,
  after: number | undefined,
): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  if (after < before) return undefined;
  return after - before;
}

export { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote };

export function withCgroupEventsNote(base: string, delta: CgroupEventsDelta | undefined): string {
  if (delta === undefined) {
    return `${base}\n（${CGROUP_EVENTS_UNKNOWN_NOTE}）`;
  }
  return `${base}\n（${formatCgroupEventsNote(delta)}）`;
}
