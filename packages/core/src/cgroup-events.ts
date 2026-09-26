import { z } from 'zod';

import { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote } from './cgroup-events-format.js';

/**
 * 器の cgroup が持つ「上限に当たって拒んだ／殺した」累計の、委譲が生きていた
 * 間の差分（Issue #1517「最小の形」1）。
 *
 * ## 何の差分か
 *
 * `/sys/fs/cgroup/pids.events` の `max`（pids 上限で fork を断った累計回数）と
 * `/sys/fs/cgroup/memory.events` の `oom_kill`（OOM で殺した累計回数）は、
 * **器（コンテナ）全体**の累計であって、この委譲だけのものではない。ここに
 * 持つのは「この委譲のセッションが開いてから `closed` になるまでの間に、
 * その累計がいくつ増えたか」——器全体で起きた回数であって、**この委譲が
 * それで落ちたと名乗るものではない**（`withCgroupEventsNote` の doc）。
 *
 * ## 2つの欄は独立に省略できる
 *
 * `pids.events` と `memory.events` は別のファイルで、cgroup のコントローラは
 * 選んで有効化できる（pids コントローラだけが有効で memory は無効、という
 * 器がありうる）。だから `runnerExecutionResourcesSchema` の `cpu` / `memory`
 * / `pids` が独立に省略できるのと同じ作法で、こちらも独立に省略できる——
 * 片方が読めなくてももう片方は出す。
 *
 * ## 読めなければ欄を出さない（0 と混ぜない）
 *
 * 開いたときの値が無い（runner の再起動をまたいだ等）・読めない・パース
 * できない、のいずれでも、その欄は出さない——`0` にすると「起きなかった」と
 * 「取れなかった」が同じ形になる（`AGENTS.md`「取れない軸に 0 の行を作る」）。
 *
 * ## `.optional()` にしてある理由（版ずれ）
 *
 * runner とデーモンは別デプロイなので、版はずれる。この欄が無い `closed`
 * （この機能より前の runner から届いたもの）を1つも壊さないために、両方の
 * 欄を任意にしてある——`runner-protocol.ts` の `closed.systemError` /
 * `closed.selfFenced` と同じ先例に倣った。
 */
export const cgroupEventsDeltaSchema = z.object({
  /** この委譲が生きていた間に、器で pids 上限により fork が断られた回数の増分。 */
  pidsMaxDelta: z.number().int().nonnegative().optional(),
  /** この委譲が生きていた間に、器で OOM kill が起きた回数の増分。 */
  oomKillDelta: z.number().int().nonnegative().optional(),
});

export type CgroupEventsDelta = z.infer<typeof cgroupEventsDeltaSchema>;

/**
 * 生のカウンタ2点（開いたとき・畳んだとき）から差分を作る。
 *
 * **どちらか一方が読めていない軸は、差分も出さない。** `before` / `after` の
 * 片方でも `undefined` なら、その軸の差分は計算しない——引き算の材料が
 * 揃っていないのに `0` や `NaN` を返すと、「読めなかった」が消える。
 *
 * **カウンタが逆行していたら、その軸も出さない。** cgroup のこの2つの
 * カウンタは単調増加のはずだが（同じ cgroup が生き続ける限り、拒んだ・殺した
 * 累計が減ることは無い）、`after < before` が観測されたなら、それは委譲の
 * 生きている間に別の cgroup を見てしまった（測り違え）と疑うべき状態で
 * ある。**負の差分をそのまま出すより、判定を諦めるほうが安全側**——保守的な
 * 側に倒す（マネージャーとの合意）。
 *
 * 両方の軸が出せなければ `undefined`（`cgroupEvents` 欄そのものを出さない）。
 */
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

/**
 * `CGROUP_EVENTS_UNKNOWN_NOTE` / `formatCgroupEventsNote` の定義そのものは
 * `cgroup-events-format.ts`（軽い口 `@alteroid/core/cgroup-events-format`。
 * import を1つも持たない）へ移した。ここは re-export するだけ——既存の
 * import 元（`tools.ts` の `manager_list` / `manager_report`、
 * `cgroup-events.test.ts`）を1つも書き換えずに済ませるため。**文言・ロジックは
 * 1文字も変えていない**（移しただけ。issue #1645 で Web 側がこの2つを
 * 手で複製していた重複を解消する一環——Web はいまこの軽い口を直接使う。
 * `apps/web/app/routes/manager-detail.tsx` の doc）。
 */
export { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote };

/**
 * `closed_failed` の受信箱本文へ、`event.cgroupEvents` を運ぶ。
 *
 * `system-error.ts` の `withSystemErrorNote` と同じ形——`base` を1文字も
 * 変えず、末尾に改行1本と1行を足すだけ。`withSystemErrorNote` の後に重ねて
 * 使う想定（系統立った説明は `cgroupEventsDeltaSchema` の doc）。
 */
export function withCgroupEventsNote(base: string, delta: CgroupEventsDelta | undefined): string {
  if (delta === undefined) {
    return `${base}\n（${CGROUP_EVENTS_UNKNOWN_NOTE}）`;
  }
  return `${base}\n（${formatCgroupEventsNote(delta)}）`;
}
