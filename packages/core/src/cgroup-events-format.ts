/**
 * `lastCgroupEvents`（cgroup の pids/OOM カウンタの差分）を人が読む一文へ
 * 整形する、**唯一の定義元**（issue #1517 の文言。切り出しは横断レビュー
 * 指摘——クローンの一覧（`tools.ts`）と Web UI の診断欄
 * （`apps/web/app/routes/manager-detail.tsx`）が、同じ文言を別々に複製して
 * いた）。
 *
 * **`mask-url.ts` / `job-status-running.ts` と同じ形。** ブラウザのバンドルへ
 * 入る軽い口（`@alteroid/core/cgroup-events-format`。`tsup.config.ts` の
 * `entry` の doc）にするため、**import を1つも持たない。**
 *
 * ## なぜ手で複製した型を使うか（`cgroup-events.ts` を import しない）
 *
 * `cgroup-events.ts` は `cgroupEventsDeltaSchema`（zod）を同じファイルに持ち、
 * zod は実行時の依存になる——`job-status-running.ts` の同じ doc と同じ理由で、
 * ここから型を取ると zod ごとブラウザバンドルへ入る。構造的に一致すること
 * （選択肢が増えたのに揃え忘れたら `typecheck` が落ちること）は `schema.ts` の
 * `_AssertCgroupEventsDeltaMatchesLikeType` が保証する。
 *
 * ## 元の場所（`cgroup-events.ts`）との関係
 *
 * `cgroup-events.ts` はこの2つ（{@link CGROUP_EVENTS_UNKNOWN_NOTE} /
 * {@link formatCgroupEventsNote}）をここから import して re-export する
 * ——既存の import 元（`tools.ts` / `cgroup-events.test.ts`）を1つも
 * 書き換えないため。**文言・ロジックは1文字も変えていない**（移しただけ）。
 */

/**
 * `formatCgroupEventsNote` が受ける入力の構造的な型。`CgroupEventsDelta`
 * （`cgroup-events.ts` の `z.infer<typeof cgroupEventsDeltaSchema>`）と
 * 同じ形を手で複製したもの——理由は上の doc。
 */
export interface CgroupEventsDeltaLike {
  readonly pidsMaxDelta?: number;
  readonly oomKillDelta?: number;
}

/**
 * D（この軸では判定できなかった）の核となる一文（`system-error-format.ts` の
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
