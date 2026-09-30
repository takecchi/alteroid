import { isDelegationActorId } from '@alteroid/core/usage';
import { Link } from 'react-router';

import type { JournalEntry } from '@alteroid/logic';

/** 日誌の1行から辿れる、別の画面の詳細（issue #2064）。 */
export interface JournalLink {
  to: string;
  label: string;
  /**
   * 1行に収めるための短い名前（issue #2071）。ダッシュボードの「いま届いている
   * 出来事」は開閉しない1行なので、id を含む `label` を置くと要旨を押し出す。
   * そちらは `short` を出し、`label` を `title` に入れる。
   */
  short: string;
}

/**
 * 日誌の1行が指している実体の詳細画面へのリンクを並べる（issue #2064）。
 *
 * 日誌の行は委譲の id や記憶の slug を要旨の文字列に出すが、その詳細へは
 * 飛べなかった。`commitments.tsx`（#2028）・`approvals.tsx`（#2041）・
 * `usage.tsx`（#2046）で `/managers/<id>` へつないだのと同じ導線を、
 * 開いた行の中に置く。
 *
 * **要旨の文字列（`summarizeJournalEntry`）には手を入れない。** 行全体が
 * 開閉の `<button>` なので、その中へリンクを入れると入れ子の対話要素に
 * なる。リンクは開いた後の領域に置く。
 *
 * - **`managerId` は、クローンの id（`CLONE_ACTOR_ID`）ではないものだけ**
 *   （`isDelegationActorId`。`mgr-` の接頭辞では見分けない — Issue #2269）。
 *   `turn_usage` / `context_usage` の `managerId` は「誰の分か」の一般名で、クローンの分は
 *   `CLONE_ACTOR_ID` になる（`packages/core/src/schema.ts` の doc。見分けの
 *   根拠は `packages/core/src/usage.ts` の `CLONE_ACTOR_ID` の doc）。
 *   種別を名指しせず欄の有無で見るので、`managerId` を持つ種別が増えても
 *   ここは追いつく。
 * - **`memory_update` は slug の記憶へ。** 消した記録（`action: 'delete'`）でも
 *   出す。行き先はいまの版で、無ければ詳細画面が 404 を「これから書く記憶」
 *   として出す（`routes/memory-detail.tsx`）。文言は「いまの版」と言っておく。
 */
export function journalEntryLinks(entry: JournalEntry): JournalLink[] {
  const links: JournalLink[] = [];
  const managerId = (entry as { managerId?: unknown }).managerId;
  if (typeof managerId === 'string' && isDelegationActorId(managerId)) {
    links.push({
      to: `/managers/${managerId}`,
      label: `委譲 ${managerId} の詳細`,
      short: '委譲',
    });
  }
  if (entry.type === 'memory_update') {
    links.push({
      to: `/memory/${entry.slug}`,
      label: `記憶 ${entry.slug}（いまの版）`,
      short: '記憶',
    });
  }
  return links;
}

/** 開いた行に、実体の詳細へのリンクを並べる（issue #2064）。無ければ何も出さない。 */
export function JournalEntryLinks({ entry }: { entry: JournalEntry }) {
  const links = journalEntryLinks(entry);
  if (links.length === 0) return null;
  return (
    // 上の余白は持たない（余白は包む側が持つ。部品の `JournalEntryRow` の開いた領域が間隔を作るので、ここで持つと二重になる）
    <div className="flex flex-wrap gap-3 text-xs">
      {links.map((link) => (
        <Link key={link.to} to={link.to} className="text-primary hover:underline">
          {link.label} →
        </Link>
      ))}
    </div>
  );
}
