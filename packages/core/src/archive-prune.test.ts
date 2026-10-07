import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  matchesArchiveRemoveManyFilter,
  selectArchiveRemovalTargets,
  type ArchiveRemovalSelection,
} from './archive-prune.js';
import type { ArchiveEntry } from './store.js';

function entry(partial: {
  readonly id: string;
  readonly sessionId: string;
  readonly minute: number;
  readonly storedBytes?: number;
  readonly continuity?: ArchiveEntry['continuity'];
  readonly removedAt?: string;
}): ArchiveEntry {
  const minute = String(partial.minute).padStart(2, '0');
  return {
    id: partial.id,
    sessionId: partial.sessionId,
    at: `2026-01-01T00:${minute}:00.000Z`,
    storedBytes: partial.storedBytes ?? 100,
    continuity: partial.continuity,
    removedAt: partial.removedAt,
  };
}

function assertInvariant(selection: ArchiveRemovalSelection): void {
  const total =
    selection.targets.length +
    selection.skipped.newest +
    selection.skipped.alreadyRemoved +
    selection.skipped.notContained +
    selection.skipped.protected +
    selection.remaining;
  expect(total).toBe(selection.matched);
}

describe('matchesArchiveRemoveManyFilter', () => {
  it('絞り込みが空なら全行に当たる', () => {
    const e = entry({ id: 'a', sessionId: 's1', minute: 0 });
    expect(matchesArchiveRemoveManyFilter(e, {})).toBe(true);
  });

  it('sessionIds は完全一致', () => {
    const e = entry({ id: 'a', sessionId: 's1', minute: 0 });
    expect(matchesArchiveRemoveManyFilter(e, { sessionIds: ['s1'] })).toBe(true);
    expect(matchesArchiveRemoveManyFilter(e, { sessionIds: ['s2'] })).toBe(false);
  });

  it('before は排他（at がちょうど before の行は当たらない）', () => {
    const e = entry({ id: 'a', sessionId: 's1', minute: 5 });
    expect(matchesArchiveRemoveManyFilter(e, { before: '2026-01-01T00:06:00.000Z' })).toBe(true);
    expect(matchesArchiveRemoveManyFilter(e, { before: '2026-01-01T00:05:00.000Z' })).toBe(false);
    expect(matchesArchiveRemoveManyFilter(e, { before: '2026-01-01T00:04:00.000Z' })).toBe(false);
  });

  it('minStoredBytes は以上（>=）', () => {
    const e = entry({ id: 'a', sessionId: 's1', minute: 0, storedBytes: 500 });
    expect(matchesArchiveRemoveManyFilter(e, { minStoredBytes: 500 })).toBe(true);
    expect(matchesArchiveRemoveManyFilter(e, { minStoredBytes: 501 })).toBe(false);
  });
});

describe('selectArchiveRemovalTargets', () => {
  it('セッションの最新行は、絞り込みに当たっても targets に入らない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.map((t) => t.id)).not.toContain('a2');
    expect(selection.skipped.newest).toBe(1);
    assertInvariant(selection);
  });

  it("continuity が 'diverged' / undefined の行は requireContainment 既定で notContained へ落ちる", () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: undefined }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'diverged' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'diverged' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets).toHaveLength(0);
    expect(selection.skipped.newest).toBe(1);
    expect(selection.skipped.notContained).toBe(2);
    assertInvariant(selection);
  });

  it('既に tombstone された行を含有の証明に使わない（最新行が removedAt を持つとき、直前の行は continues でも notContained）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({
        id: 'a2',
        sessionId: 's1',
        minute: 1,
        continuity: 'continues',
        removedAt: '2026-01-01T01:00:00.000Z',
      }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.map((t) => t.id)).not.toContain('a1');
    expect(selection.skipped.alreadyRemoved).toBe(1);
    expect(selection.skipped.notContained).toBe(1);
    assertInvariant(selection);
  });

  it('鎖が切れると、切れた箇所の直前の行だけが notContained になる（continues, diverged, continues の並び）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'diverged' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.map((t) => t.id)).toEqual(['a1', 'a3']);
    expect(selection.skipped.newest).toBe(1);
    expect(selection.skipped.notContained).toBe(1);
    assertInvariant(selection);
  });

  it('対象に入れた行が、別の対象行の証明の錨になる（a2 は targets に入りつつ a1 の錨でもある）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'diverged' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(selection.skipped.newest).toBe(1);
    expect(selection.skipped.notContained).toBe(1);
    assertInvariant(selection);
  });

  it('protectedIds の行は消えない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(
      rows,
      { minStoredBytes: 0 },
      { protectedIds: ['a1'] },
    );
    expect(selection.targets.map((t) => t.id)).not.toContain('a1');
    expect(selection.skipped.protected).toBe(1);
    assertInvariant(selection);
  });

  it('絞り込みの外の行が証明の錨になれる（before で候補から外れた新しい行が、古い行の証明に使う）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, {
      before: '2026-01-01T00:01:00.000Z',
      minStoredBytes: 0,
    });
    expect(selection.matched).toBe(1);
    expect(selection.targets.map((t) => t.id)).toEqual(['a1']);
    expect(selection.skipped.notContained).toBe(0);
    assertInvariant(selection);
  });

  it('不変条件の等式が成り立つ（複数セッション・複数理由が混在するとき）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      entry({
        id: 'b1',
        sessionId: 's2',
        minute: 0,
        continuity: 'first',
        removedAt: '2026-01-01T02:00:00.000Z',
      }),
      entry({ id: 'b2', sessionId: 's2', minute: 1, continuity: 'diverged' }),
      entry({ id: 'b3', sessionId: 's2', minute: 2, continuity: 'diverged' }),
    ];
    const selection = selectArchiveRemovalTargets(
      rows,
      { minStoredBytes: 0 },
      { protectedIds: ['a1'] },
    );
    expect(selection.matched).toBe(6);
    assertInvariant(selection);
    expect(selection.targets.map((t) => t.id)).toEqual(['a2']);
  });

  it('limit で溢れた分が remaining に出て、溢れた行は targets に入らない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 }, { limit: 2 });
    expect(selection.targets.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(selection.remaining).toBe(1);
    assertInvariant(selection);
  });

  it('既定の limit は ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT である', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      entry({
        id: `a${i}`,
        sessionId: 's1',
        minute: i,
        continuity: i === 0 ? 'first' : 'continues',
      }),
    );
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.remaining).toBe(0);
    expect(ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT).toBeGreaterThan(rows.length);
    assertInvariant(selection);
  });

  it('requireContainment: false なら diverged/undefined の行も targets に入りうる（最新行だけは常に除く）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: undefined }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'diverged' }),
    ];
    const selection = selectArchiveRemovalTargets(
      rows,
      { minStoredBytes: 0 },
      { requireContainment: false },
    );
    expect(selection.targets.map((t) => t.id)).toEqual(['a1']);
    expect(selection.skipped.notContained).toBe(0);
    assertInvariant(selection);
  });

  it('絞り込みに当たらない行は matched にも skipped にも数えない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, storedBytes: 10, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, storedBytes: 1000, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 1000 });
    expect(selection.totalRows).toBe(2);
    expect(selection.matched).toBe(1);
    expect(selection.skipped.newest).toBe(1);
    expect(selection.targets).toHaveLength(0);
    assertInvariant(selection);
  });

  function assertEveryTargetIsReachableFromASurvivor(
    rows: readonly ArchiveEntry[],
    selection: ArchiveRemovalSelection,
  ): void {
    const targetIds = new Set(selection.targets.map((t) => t.id));
    const bySession = new Map<string, ArchiveEntry[]>();
    for (const row of rows) {
      const group = bySession.get(row.sessionId);
      if (group === undefined) bySession.set(row.sessionId, [row]);
      else group.push(row);
    }
    for (const group of bySession.values()) {
      const sorted = [...group].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      for (let i = 0; i < sorted.length; i += 1) {
        const row = sorted[i];
        if (row === undefined || !targetIds.has(row.id)) continue;
        let reachedSurvivor = false;
        for (let j = i + 1; j < sorted.length; j += 1) {
          const next = sorted[j];
          if (next === undefined || next.continuity !== 'continues') break;
          if (!targetIds.has(next.id) && next.removedAt === undefined) {
            reachedSurvivor = true;
            break;
          }
        }
        expect(reachedSurvivor).toBe(true);
      }
    }
  }

  it('🔑 健全性の不変条件: 全部 continues の鎖では、targets の各行が新しい側の生存行へ届く', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      entry({
        id: `a${i}`,
        sessionId: 's1',
        minute: i,
        continuity: i === 0 ? 'first' : 'continues',
      }),
    );
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.length).toBeGreaterThan(0);
    assertInvariant(selection);
    assertEveryTargetIsReachableFromASurvivor(rows, selection);
  });

  it('🔑 健全性の不変条件: 途中で diverged が混じり、対象行どうしが錨を連鎖しても崩れない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'diverged' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
      entry({ id: 'a5', sessionId: 's1', minute: 4, continuity: 'continues' }),
      entry({ id: 'a6', sessionId: 's1', minute: 5, continuity: 'diverged' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.length).toBeGreaterThan(0);
    assertInvariant(selection);
    assertEveryTargetIsReachableFromASurvivor(rows, selection);
  });

  it('🔑 健全性の不変条件: 既に removedAt が付いた行（tombstone）が鎖の途中に混じっても崩れない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({
        id: 'a2',
        sessionId: 's1',
        minute: 1,
        continuity: 'continues',
        removedAt: '2026-01-01T01:00:00.000Z',
      }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.length).toBeGreaterThan(0);
    assertInvariant(selection);
    assertEveryTargetIsReachableFromASurvivor(rows, selection);
  });

  it('🔑 健全性の不変条件: continuity が unknown / undefined の行が複数セッションに混じっても崩れない', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: undefined }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'unknown' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
      entry({ id: 'b1', sessionId: 's2', minute: 0, continuity: 'first' }),
      entry({ id: 'b2', sessionId: 's2', minute: 1, continuity: 'continues' }),
      entry({ id: 'b3', sessionId: 's2', minute: 2, continuity: 'unknown' }),
      entry({ id: 'b4', sessionId: 's2', minute: 3, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.length).toBeGreaterThan(0);
    assertInvariant(selection);
    assertEveryTargetIsReachableFromASurvivor(rows, selection);
  });
});

describe('selectArchiveRemovalTargets — 同じミリ秒に積んだ行の順（#908 の漏れ）', () => {
  it('同じミリ秒の2本のうち、後から積んだ方（枝番2）を最新行として残す', () => {
    const sessionId = 'sess-tie';
    const tiedAt = '2026-01-01T00:05:00.000Z';
    const stamp = tiedAt.replace(/[:.]/g, '-');
    const first: ArchiveEntry = {
      id: `${sessionId}-2026-01-01T00-00-00-000Z.jsonl`,
      sessionId,
      at: '2026-01-01T00:00:00.000Z',
      storedBytes: 100,
      continuity: 'first',
    };
    const branch1: ArchiveEntry = {
      id: `${sessionId}-${stamp}.jsonl`,
      sessionId,
      at: tiedAt,
      storedBytes: 200,
      continuity: 'continues',
    };
    const branch2: ArchiveEntry = {
      id: `${sessionId}-${stamp}-2.jsonl`,
      sessionId,
      at: tiedAt,
      storedBytes: 300,
      continuity: 'continues',
    };

    const selection = selectArchiveRemovalTargets([branch2, first, branch1], {});
    const targetIds = selection.targets.map((target) => target.id);

    expect(targetIds).not.toContain(branch2.id);
    expect(targetIds).toEqual([first.id, branch1.id]);
    expect(selection.skipped.newest).toBe(1);
  });
});
