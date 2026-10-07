// cgroup-events.ts を import しない: zod ごとブラウザバンドルへ入るため。型は手で複製し、schema.ts の `_AssertCgroupEventsDeltaMatchesLikeType` が一致を保証する
export interface CgroupEventsDeltaLike {
  readonly pidsMaxDelta?: number;
  readonly oomKillDelta?: number;
}

export const CGROUP_EVENTS_UNKNOWN_NOTE =
  'この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった';

// 因果は名乗らない: 言えるのは同じ時間帯に器でそれが起きた／起きなかったまでで、この委譲がそれで落ちたとは言えないため
// 両方が読めて両方 0 のときだけ強く言う: 0 と「読めなかった」を混ぜないため
export function formatCgroupEventsNote(delta: CgroupEventsDeltaLike): string {
  if (delta.pidsMaxDelta === 0 && delta.oomKillDelta === 0) {
    return 'この委譲が走っていた間、器で pids 上限による fork の拒否も OOM kill も起きていなかった';
  }
  const pidsPart =
    delta.pidsMaxDelta === undefined
      ? 'pids 上限による fork 拒否の回数は判定できなかった'
      : `器で fork が pids 上限により ${delta.pidsMaxDelta} 回断られた`;
  const oomPart =
    delta.oomKillDelta === undefined
      ? 'OOM kill の回数は判定できなかった'
      : `OOM kill が ${delta.oomKillDelta} 回あった`;
  return `この委譲が走っていた間 —— ${pidsPart}。${oomPart}`;
}
