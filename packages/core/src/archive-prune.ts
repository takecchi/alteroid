import { archiveIdBranch } from './archive-id.js';
import type { ArchiveEntry } from './store.js';

// tools.ts の定数を使い回さない: 値が同じでも出所が違うため
export const ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT = 500;
export const ARCHIVE_REMOVE_MANY_LIMIT_MAX = 2_000;
export const ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS = 3_600;

export interface ArchiveRemoveManyFilter {
  readonly sessionIds?: readonly string[];
  // `at < before`（排他）: 締め切りの瞬間に積まれたばかりの行まで一緒に持っていかないため
  readonly before?: string;
  readonly minStoredBytes?: number;
}

export function matchesArchiveRemoveManyFilter(
  entry: ArchiveEntry,
  filter: ArchiveRemoveManyFilter,
): boolean {
  if (filter.sessionIds !== undefined && !filter.sessionIds.includes(entry.sessionId)) {
    return false;
  }
  if (filter.before !== undefined && Date.parse(entry.at) >= Date.parse(filter.before)) {
    return false;
  }
  if (filter.minStoredBytes !== undefined && entry.storedBytes < filter.minStoredBytes) {
    return false;
  }
  return true;
}

export interface ArchiveRemovalSelectionOptions {
  readonly requireContainment?: boolean;
  readonly limit?: number;
  // 「墓標」の概念を持ち込まない: 他の「守るべき id」の理由からも再利用できるようにするため
  readonly protectedIds?: readonly string[];
}

// skipped を0件でも省かない: 省くと「飛ばしていない」と「測っていない」が区別できなくなるため
export interface ArchiveRemovalSelection {
  readonly totalRows: number;
  readonly matched: number;
  readonly targets: readonly ArchiveEntry[];
  readonly remaining: number;
  readonly skipped: {
    readonly newest: number;
    readonly alreadyRemoved: number;
    readonly notContained: number;
    readonly protected: number;
  };
}

// 同着を id の字面で並べない: `-` < `.` なので、枝番の無い1本目が最新に来て、本当の最新行が削除対象に入るため
function compareOldestFirst(a: ArchiveEntry, b: ArchiveEntry): number {
  const byAt = Date.parse(a.at) - Date.parse(b.at);
  if (byAt !== 0) return byAt;
  if (a.sessionId === b.sessionId) {
    const byBranch = archiveIdBranch(a.id) - archiveIdBranch(b.id);
    if (byBranch !== 0) return byBranch;
  }
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// 本文に触れない: 消す対象の確認で `body` まで取得する運用のほうが危ないため
// ## 含有の証明（`requireContainment` が `true` のときだけ効く）: 含有が証明できない行は消さない。内容が失われるため
export function selectArchiveRemovalTargets(
  entries: readonly ArchiveEntry[],
  filter: ArchiveRemoveManyFilter,
  options: ArchiveRemovalSelectionOptions = {},
): ArchiveRemovalSelection {
  const requireContainment = options.requireContainment ?? true;
  const limit = options.limit ?? ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT;
  const protectedIds = new Set(options.protectedIds ?? []);

  // 絞り込みの前に全行へ isNewest と含有の証明を決める: 絞り込み後の集合だけで決めると、証明の錨が外れたり、本当の最新行を誤認して守られていない行を消すため
  const bySession = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const group = bySession.get(entry.sessionId);
    if (group === undefined) bySession.set(entry.sessionId, [entry]);
    else group.push(entry);
  }

  const newestIds = new Set<string>();
  const coveredById = new Map<string, boolean>();
  for (const group of bySession.values()) {
    group.sort(compareOldestFirst);
    const n = group.length;
    if (n === 0) continue;
    const newest = group[n - 1];
    if (newest === undefined) continue;
    newestIds.add(newest.id);
    let coveredBySurvivor = false;
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = group[i];
      if (row === undefined) continue;
      coveredById.set(row.id, coveredBySurvivor);
      // removedAt を見る: tombstone 済みの行は本文が読めず、証明の錨にならないため
      // undefined（門より前の行）を 'continues' に倒さない: 前方一致が確認できていないため
      if (row.continuity === 'continues') {
        coveredBySurvivor = coveredBySurvivor || row.removedAt === undefined;
      } else {
        coveredBySurvivor = false;
      }
    }
  }

  let matched = 0;
  let skippedProtected = 0;
  let skippedAlreadyRemoved = 0;
  let skippedNewest = 0;
  let skippedNotContained = 0;
  const candidates: ArchiveEntry[] = [];

  for (const entry of entries) {
    if (!matchesArchiveRemoveManyFilter(entry, filter)) continue;
    matched += 1;

    if (protectedIds.has(entry.id)) {
      skippedProtected += 1;
      continue;
    }
    if (entry.removedAt !== undefined) {
      skippedAlreadyRemoved += 1;
      continue;
    }
    if (newestIds.has(entry.id)) {
      skippedNewest += 1;
      continue;
    }
    if (requireContainment && !(coveredById.get(entry.id) ?? false)) {
      skippedNotContained += 1;
      continue;
    }
    candidates.push(entry);
  }

  // 古い順に採る: いちばん遡りたいものから失うのを避けるため
  candidates.sort(compareOldestFirst);
  const targets = candidates.slice(0, limit);
  const remaining = candidates.length - targets.length;

  return {
    totalRows: entries.length,
    matched,
    targets,
    remaining,
    skipped: {
      newest: skippedNewest,
      alreadyRemoved: skippedAlreadyRemoved,
      notContained: skippedNotContained,
      protected: skippedProtected,
    },
  };
}
