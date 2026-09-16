import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  matchesArchiveRemoveManyFilter,
  selectArchiveRemovalTargets,
  type ArchiveRemovalSelection,
} from './archive-prune.js';
import type { ArchiveEntry } from './store.js';

/**
 * `ArchiveEntry` の最小限のフィクスチャを作る。`at` は分単位の連番文字列
 * （'2026-01-01T00:0M:00.000Z'）で作り、テスト中の時系列を目で追いやすくする。
 */
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

/** 不変条件（doc `ArchiveRemovalSelection`）: matched は5つの区分の総和に等しい。 */
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
    // 絞り込みは全行に当たる（minStoredBytes: 0）。それでも最新行 a2 は除かれる。
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
    // どの行の continuity も 'continues' ではない（a1: undefined, a2: diverged,
    // a3: diverged）ので、新しい方から見て一度も coveredBySurvivor が立たない
    // ——最新行 a3 を除く全行が「後続に読める形で含まれる」ことを一度も証明
    // できず notContained になる。
    expect(selection.targets).toHaveLength(0);
    expect(selection.skipped.newest).toBe(1); // a3
    expect(selection.skipped.notContained).toBe(2); // a1, a2
    assertInvariant(selection);
  });

  it('既に tombstone された行を含有の証明に使わない（最新行が removedAt を持つとき、直前の行は continues でも notContained）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      // a2 は a1 を前方一致で含むが、既に removedAt が付いている
      // （＝ 本文はもう読めない）ので、a1 を「a2 に含まれているから消してよい」
      // とは言えない。
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
    // a2 自身は既に消えているので alreadyRemoved、a1 は証明できず notContained。
    expect(selection.skipped.alreadyRemoved).toBe(1);
    expect(selection.skipped.notContained).toBe(1);
    assertInvariant(selection);
  });

  it('鎖が切れると、切れた箇所の直前の行だけが notContained になる（continues, diverged, continues の並び）', () => {
    // 古い順: a1(first) -> a2(continues, a1を含む) -> a3(diverged, a2を含まない)
    //         -> a4(continues, a3を含む・最新)
    //
    // a4 は最新行なので別枠（newest）。a3 は「a2 を含む」とは言えない
    // （diverged）ので、a2 は a3 を根拠に証明できない ⟹ notContained。
    //
    // **ここが直感に反する点なので明記する**: a1 は notContained には
    // ならない。a1 の証明の根拠は a3 ではなく a2 である——a2 自身は
    // 「a1 を含み（continues）、かつ生きている（removedAt 無し）」ので、
    // a2 が a3 を含むかどうかに関係なく a1 は安全に消せる。**鎖の途中の
    // 切断は、その切断の直前の1行（a2）の証明だけを塞ぐのであって、
    // それより古い行（a1）の証明を連鎖的に無効化するわけではない**——
    // a1 の証明は a2 という「もう1つ新しい、直接生きている行」で
    // 独立に成り立っている。⟹ a3 も同様に、a4（生きていて a3 を含む）を
    // 根拠に単独で証明でき、a2 の断絶とは無関係に targets に入る。
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'diverged' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.map((t) => t.id)).toEqual(['a1', 'a3']);
    expect(selection.skipped.newest).toBe(1); // a4
    expect(selection.skipped.notContained).toBe(1); // a2
    assertInvariant(selection);
  });

  it('対象に入れた行が、別の対象行の証明の錨になる（a2 は targets に入りつつ a1 の錨でもある）', () => {
    // 古い順: a1(first) -> a2(continues, a1を含む) -> a3(continues, a2を含む)
    //         -> a4(diverged, a3を含まない・最新)
    //
    // a1 の証明の錨は a2（continues かつ生存）である。a2 自身もこの一括の
    // 対象（targets）に入る——「錨がいなくなるのに証明は有効なのか」が
    // 非自明な形。doc の健全性の論証が撃つ具体例そのもの: a2 は消えるが
    // a2 の中身（と a1 の中身）は a3（この一括では消えない終点 m）から
    // 推移的に読める。
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'diverged' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(selection.skipped.newest).toBe(1); // a4
    expect(selection.skipped.notContained).toBe(1); // a3 (a4 が diverged なので証明できない)
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
    // a3 は newest。a2 は a3(continues, 生存) に含まれるので本来は消せるが、
    // a1 は protectedIds で守られているため targets に入らない。
    expect(selection.targets.map((t) => t.id)).not.toContain('a1');
    expect(selection.skipped.protected).toBe(1);
    assertInvariant(selection);
  });

  it('絞り込みの外の行が証明の錨になれる（before で候補から外れた新しい行が、古い行の証明に使う）', () => {
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      // a2 は before で候補から外れる（minute 1 は before=00:01 の境界より前
      // ではない）が、a1 を継続しており生きている ⟹ a1 の証明の錨になる。
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
    ];
    const selection = selectArchiveRemovalTargets(rows, {
      before: '2026-01-01T00:01:00.000Z', // a1(minute 0) だけが当たる。a2は排他で外れる
      minStoredBytes: 0,
    });
    expect(selection.matched).toBe(1); // a1 だけが filter に当たる
    expect(selection.targets.map((t) => t.id)).toEqual(['a1']);
    expect(selection.skipped.notContained).toBe(0);
    assertInvariant(selection);
  });

  it('不変条件の等式が成り立つ（複数セッション・複数理由が混在するとき）', () => {
    const rows = [
      // s1: a1 protected, a2 continues(生存, 消せる), a3 newest
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'continues' }),
      // s2: b1 already removed, b2 diverged(notContained), b3 newest
      entry({
        id: 'b1',
        sessionId: 's2',
        minute: 0,
        continuity: 'first',
        removedAt: '2026-01-01T02:00:00.000Z',
      }),
      entry({ id: 'b2', sessionId: 's2', minute: 1, continuity: 'diverged' }),
      // b3 も diverged にする — b2 が「後続に読める形で含まれる」ことを
      // 一度も証明できないようにする（b3 が continues だと、b3 自身が
      // 生きて b2 を含むという別経路で b2 が証明できてしまい、この歯が
      // 撃ちたい notContained を再現できない）。
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
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }), // newest
    ];
    // a1, a2, a3 は生存する後続に含まれ全部消せる候補（a4 は newest で除外）。
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 }, { limit: 2 });
    expect(selection.targets.map((t) => t.id)).toEqual(['a1', 'a2']); // 古い順に2件
    expect(selection.remaining).toBe(1); // a3 が溢れる
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
    expect(selection.targets.map((t) => t.id)).toEqual(['a1']); // a2 は newest
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
    expect(selection.matched).toBe(1); // a2 だけが当たる
    // a2 は最新行なので newest へ。a1 はそもそも当たらない。
    expect(selection.skipped.newest).toBe(1);
    expect(selection.targets).toHaveLength(0);
    assertInvariant(selection);
  });

  /**
   * 🔑 健全性の不変条件そのものを撃つ歯（doc の「対象に入れた行どうしが
   * 互いの証明を支え合っていて安全か」の節）。
   *
   * `targets` に入れたどの行についても、同じセッションの新しい側へ
   * `continuity === 'continues'` の鎖を辿ると、`targets` にも既存の
   * `removedAt` にも入っていない行（＝ この一括を実行した後も読める行）へ
   * 必ず到達することを検査する。**期待値をベタ書きしない**——並びを変え、
   * 性質そのものを検査する。これが「畳んだのに読めなくなった」を撃つ本体。
   */
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
    expect(selection.targets.length).toBeGreaterThan(0); // 空だと歯が空撃ちになる
    assertInvariant(selection);
    assertEveryTargetIsReachableFromASurvivor(rows, selection);
  });

  it('🔑 健全性の不変条件: 途中で diverged が混じり、対象行どうしが錨を連鎖しても崩れない', () => {
    // a1, a3, a4 が targets に入る。a3 の錨は a4（それ自身も target）、
    // a4 の錨は a5（notContained で残る）——対象が対象を錨にする鎖。
    const rows = [
      entry({ id: 'a1', sessionId: 's1', minute: 0, continuity: 'first' }),
      entry({ id: 'a2', sessionId: 's1', minute: 1, continuity: 'continues' }),
      entry({ id: 'a3', sessionId: 's1', minute: 2, continuity: 'diverged' }),
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }),
      entry({ id: 'a5', sessionId: 's1', minute: 4, continuity: 'continues' }),
      entry({ id: 'a6', sessionId: 's1', minute: 5, continuity: 'diverged' }), // newest
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
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }), // newest
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
      entry({ id: 'a4', sessionId: 's1', minute: 3, continuity: 'continues' }), // newest
      entry({ id: 'b1', sessionId: 's2', minute: 0, continuity: 'first' }),
      entry({ id: 'b2', sessionId: 's2', minute: 1, continuity: 'continues' }),
      entry({ id: 'b3', sessionId: 's2', minute: 2, continuity: 'unknown' }),
      entry({ id: 'b4', sessionId: 's2', minute: 3, continuity: 'continues' }), // newest
    ];
    const selection = selectArchiveRemovalTargets(rows, { minStoredBytes: 0 });
    expect(selection.targets.length).toBeGreaterThan(0);
    assertInvariant(selection);
    assertEveryTargetIsReachableFromASurvivor(rows, selection);
  });
});
