// 種別 → 取り直す先の対応: Web の `use-journal-live.ts` の `invalidate`（`approvals` / `managers`）と揃える。画面のバンドルを増やさないため core ではなくここに置く
import { isCloneActor, type JournalEntry } from '@alteroid/core';

// 委譲の状態も一覧の行も動かさない種別。`worker_wait` / `subagent_stall` は Web と同じく動かさない側に置く
const NEVER_MOVES_MANAGERS = new Set([
  'turn_usage',
  'context_usage',
  'inbox_flow',
  'github_observation',
  'memory_update',
  'daily_report',
  'token_rotation',
  'subagent_stall',
  'worker_wait',
  // 会話の削除（#4218）。会話の一覧は動くが、委譲の状態と承認の件数は動かない
  'conversation_deleted',
]);

// 承認待ちの件数と一覧が動くのは `escalation`（開く・答える・取り下げるの全部が積む）だけ
export function affectsApprovals(type: string): boolean {
  return type === 'escalation';
}

// 本体が無い（`entry` が `null`・未指定）ときは「動くかもしれない」に倒す: 件数が古いまま残るより、取り直しが1回増えるほうが安いため
export function affectsManagers(type: string, entry?: JournalEntry | null): boolean {
  if (NEVER_MOVES_MANAGERS.has(type)) return false;
  if (entry === null || entry === undefined) return true;
  // クローン自身の `tool_use` は委譲を動かさない。`lost` への遷移は `decision` として積まれるので、`decision` は落とさない
  if (entry.type === 'tool_use') return !isCloneActor(entry.actor);
  if (entry.type === 'exchange') return entry.with === 'manager';
  return true;
}

export function affectsCounts(type: string, entry?: JournalEntry | null): boolean {
  return affectsApprovals(type) || affectsManagers(type, entry);
}
