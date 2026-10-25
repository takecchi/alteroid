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

function charsOf(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) total += (JSON.stringify(entry) ?? '').length;
  return total;
}

// 最後の entry の `timestamp` を新しさとする。読めなければ最も古い扱い（落とす側へ倒す）
function recencyOf(entries: readonly unknown[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== 'object' || entry === null) continue;
    const stamp = (entry as { timestamp?: unknown }).timestamp;
    if (typeof stamp === 'string') {
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * 新しい順に、合計が上限に収まるぶんだけ選ぶ。1本が入らなくても、次の（より小さい）ものが入るなら入れる。
 * 落としたものの subpath は `omitted` に返す（呼び出し側が日誌へ残す。黙って落とさない）。
 */
export function selectSubagentsWithinBudget(
  candidates: readonly ResumeSubagentTranscript[],
  budgetChars: number = RESUME_SUBAGENT_BUDGET_CHARS,
): { included: ResumeSubagentTranscript[]; omitted: string[] } {
  const ranked = candidates
    .map((candidate) => ({ candidate, recency: recencyOf(candidate.entries) }))
    .sort(
      (a, b) =>
        b.recency - a.recency ||
        (a.candidate.subpath < b.candidate.subpath
          ? 1
          : a.candidate.subpath > b.candidate.subpath
            ? -1
            : 0),
    );
  const included: ResumeSubagentTranscript[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { candidate } of ranked) {
    const size = charsOf(candidate.entries);
    if (used + size > budgetChars) {
      omitted.push(candidate.subpath);
      continue;
    }
    used += size;
    included.push(candidate);
  }
  return { included, omitted };
}
