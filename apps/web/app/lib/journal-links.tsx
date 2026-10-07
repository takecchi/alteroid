import { isDelegationActorId } from '@alteroid/core/usage';
import { Link } from 'react-router';

import type { JournalEntry } from '@alteroid/logic';

export interface JournalLink {
  to: string;
  label: string;
  short: string;
}

// 要旨の文字列にリンクを入れない: 行全体が開閉の <button> なので、入れ子の対話要素になるため
// managerId を `mgr-` の接頭辞で見分けない: id の発行は差し替えられ、接頭辞は委譲の証拠にならないため
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

export function JournalEntryLinks({ entry }: { entry: JournalEntry }) {
  const links = journalEntryLinks(entry);
  if (links.length === 0) return null;
  return (
    // 上の余白を持たない: 開いた領域が間隔を作るので、ここで持つと二重になるため
    <div className="flex flex-wrap gap-3 text-xs">
      {links.map((link) => (
        <Link key={link.to} to={link.to} className="text-primary hover:underline">
          {link.label} →
        </Link>
      ))}
    </div>
  );
}
