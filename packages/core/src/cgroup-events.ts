import { z } from 'zod';

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
 * D（この軸では判定できなかった）の核となる一文（`system-error.ts` の
 * `SYSTEM_ERROR_UNKNOWN_NOTE` と同じ作法で1箇所にまとめる）。
 */
export const CGROUP_EVENTS_UNKNOWN_NOTE =
  'この委譲が走っていた間に器で pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった';

/**
 * 差分を、人が読む一文へ整形する。
 *
 * **因果は名乗らない。** ここで言えるのは「同じ時間帯に器でそれが起きた／
 * 起きなかった」までで、「この委譲がそれで落ちた」ではない（#1517 の注意）。
 *
 * **両方が読めて、両方が 0 のときだけ、断定してよい強い言い方をする。** それ
 * 以外（どちらかが正の値・どちらかが読めていない）は、読めた分だけを数で
 * 出し、読めていない軸はそう名乗る——0 と「読めなかった」を混ぜない。
 */
export function formatCgroupEventsNote(delta: CgroupEventsDelta): string {
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
