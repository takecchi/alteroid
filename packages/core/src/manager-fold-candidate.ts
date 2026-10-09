import type { ManagerActivityKind } from './manager-activity.js';
import type { JobStatus } from './schema.js';

// 判定材料が取れなければ候補にしない: 「取れない」を「空いた」へ倒さない。
// 6つ目の条件（その委譲への未配達の入力が無い）は判定に使わない: `ManagerSummary` にも `Job` にも材料の欄が無く、「材料が無いから候補にしてよい」と決め打てない。5条件（1〜5）だけで判定する。
// 条件3（器が背景処理待ちの印を送る版だと確かめられた）は、呼び出し元が器の機能申告から渡す必須の boolean で受け取る: 印が無いことを「待っていない」と読めるのは、その器が印を送る版と確かめられたときだけ。名乗らない器は `false`（「送っているはず」と仮定しない）。
export interface ManagerFoldCandidateInput {
  readonly status: JobStatus;
  // 立っていれば無条件で候補にしない。外すと背景処理待ちの委譲まで候補に出る。
  readonly hasAwaitingBackgroundSignal: boolean;
  readonly awaitingBackgroundSignalVersionConfirmed: boolean;
  // `'active'` 以外（`'unknown'` を含む）は候補にしない: 判定できないを「手が空いている」へ倒さない。
  readonly activityKind: ManagerActivityKind;
  // `turnEndedAt` ではなく `updatedAt` を渡すこと: `turnEndedAt` は `running` の委譲だけが計算されるので、`done` では古い値のままか未設定になる。`updatedAt` は `done` へ遷移した瞬間の時刻を確実に持つ。
  readonly lastTurnEndedAt?: string;
}

export const MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS = 6 * 60 * 60_000;

// 判定の唯一の点: `isManagerFoldCandidate` と `describeManagerFoldCandidate` で判定のコピーを2つ作らない。
function evaluateFoldCandidate(
  input: ManagerFoldCandidateInput,
  now: Date,
): { readonly elapsedMs: number } | null {
  if (input.status !== 'done') return null;
  if (input.hasAwaitingBackgroundSignal) return null;
  if (!input.awaitingBackgroundSignalVersionConfirmed) return null;
  if (input.activityKind !== 'active') return null;
  if (input.lastTurnEndedAt === undefined) return null;
  const lastTurnEndedAtMs = Date.parse(input.lastTurnEndedAt);
  if (Number.isNaN(lastTurnEndedAtMs)) return null;
  const elapsedMs = now.getTime() - lastTurnEndedAtMs;
  if (elapsedMs < MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS) return null;
  return { elapsedMs };
}

export function isManagerFoldCandidate(input: ManagerFoldCandidateInput, now: Date): boolean {
  return evaluateFoldCandidate(input, now) !== null;
}

// 「いまは表示だけで、畳む操作はしない」を毎回添える: 読み手が「⚠ が出た＝もう畳まれた」と誤読しないため。
export function describeManagerFoldCandidate(
  input: ManagerFoldCandidateInput,
  now: Date,
): string | null {
  const result = evaluateFoldCandidate(input, now);
  if (result === null) return null;
  const elapsedHours = Math.floor(result.elapsedMs / 3_600_000);
  return (
    `  ⚠ 畳む候補（手が空いてから${elapsedHours}時間。背景処理待ちの印なし・` +
    '状態の判定 active）。いまは表示だけで、畳む操作はしない。'
  );
}
