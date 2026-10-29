import { selectNewestWithinBudget } from './resume-budget.js';

/**
 * 担当の resume で戻す作業者（サブエージェント）の会話の記録。
 * 預かり先（SessionStore）では、主の記録と同じ `projectKey` / `sessionId` に `subpath`（`subagents/agent-<id>` など）を足した鍵で持つ。
 */
export interface ResumeSubagentTranscript {
  readonly subpath: string;
  readonly entries: unknown[];
}

/** 作業者の記録だけを戻す: 他の subpath（SDK が将来足すもの）は、戻し方を知らないまま置くと壊れうるので触らない。 */
export const RESUME_SUBAGENT_SUBPATH_PREFIX = 'subagents/';

/**
 * 作業者の分の合計の上限（各 entry の JSON の文字数の和）。主の記録（`entries`）には掛けない: 主を欠けさせると会話が続かないため。
 * 作業者の分は、入らなければ落として知らせるほうが、resume そのものを巨大な本文で壊すより安全。
 */
export const RESUME_SUBAGENT_BUDGET_CHARS = 32 * 1024 * 1024;

export function isSubagentSubpath(subpath: string): boolean {
  return subpath.startsWith(RESUME_SUBAGENT_SUBPATH_PREFIX);
}

/** 選び方は `selectNewestWithinBudget` のとおり。落としたものの subpath は `omitted` に返す。 */
export function selectSubagentsWithinBudget(
  candidates: readonly ResumeSubagentTranscript[],
  budgetChars: number = RESUME_SUBAGENT_BUDGET_CHARS,
): { included: ResumeSubagentTranscript[]; omitted: string[] } {
  return selectNewestWithinBudget(candidates, (candidate) => candidate.subpath, budgetChars);
}
