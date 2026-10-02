import { describe, expect, it } from 'vitest';

import { journalEntry, minute, said } from './fake-api.js';
import {
  JOURNAL_MAX_LIMIT,
  applyInitialPage,
  applyNewerPage,
  applyOlderPage,
  entryChars,
  journalHorizonNote,
  listWindow,
  mergeBack,
  mergeFront,
  newerPageQuery,
  olderPageQuery,
  pageOutcome,
  trimToBudget,
} from './journal-window.js';

describe('マージ（id で重複を除き、新しい順を保つ）', () => {
  it('新着は先頭へ、過去は末尾へ。既に在る id は足さない', () => {
    const existing = [said(3), said(2)];
    expect(mergeFront(existing, [said(4), said(3)]).entries.map((e) => e.id)).toEqual([
      'e4',
      'e3',
      'e2',
    ]);
    expect(mergeFront(existing, [said(3)])).toEqual({ entries: existing, freshCount: 0 });
    expect(mergeBack(existing, [said(2), said(1)])).toMatchObject({ freshCount: 1 });
    expect(mergeBack(existing, [said(2), said(1)]).entries.map((e) => e.id)).toEqual([
      'e3',
      'e2',
      'e1',
    ]);
    expect(mergeBack(existing, [])).toEqual({ entries: existing, freshCount: 0 });
  });
});

describe('pageOutcome（Web の journal-window.test.ts と同じ表）', () => {
  it.each([
    // [返った件数, limit, 新規, maxLimit, 期待]
    [10, 10, 3, 1000, 'progress'],
    [5, 10, 0, 1000, 'end'],
    [10, 10, 0, 1000, 'retryLarger'],
    [1000, 1000, 0, 1000, 'blocked'],
    [0, 10, 0, 1000, 'end'],
  ] as const)('%i 件 / limit %i / 新規 %i → %s', (len, limit, fresh, max, expected) => {
    expect(pageOutcome(len, limit, fresh, max)).toBe(expected);
  });

  it('上限は 1000（daemon の journalQuery と同じ）', () => {
    expect(JOURNAL_MAX_LIMIT).toBe(1000);
  });

  it('初期読み込みは limit 未満で終端と言い切れる（境界の曖昧さが無い）', () => {
    expect(applyInitialPage([said(1)], 100).outcome).toBe('end');
    expect(
      applyInitialPage(
        Array.from({ length: 100 }, (_, i) => said(i)),
        100,
      ).outcome,
    ).toBe('progress');
  });

  it('applyOlderPage / applyNewerPage は境界の再送を数えない', () => {
    const existing = [said(3), said(2)];
    expect(applyOlderPage(existing, [said(2)], 5).outcome).toBe('end');
    expect(applyNewerPage(existing, [said(3)], 5).outcome).toBe('end');
    expect(applyNewerPage(existing, [said(3)], 1).outcome).toBe('retryLarger');
  });

  it('次に撃つ引数は、過去なら末尾（最古）の at を until、新着なら先頭（最新）の at を since', () => {
    const entries = [said(3), said(2), said(1)];
    expect(olderPageQuery(entries)).toEqual({ until: minute(1) });
    expect(newerPageQuery(entries)).toEqual({ since: minute(3) });
    expect(olderPageQuery([])).toBeUndefined();
    expect(newerPageQuery([])).toBeUndefined();
  });
});

describe('日誌の地平の注記', () => {
  it('終端で、地平にかかっていて、最古が分かるときだけ言う', () => {
    expect(journalHorizonNote('end', '2026-01-01T00:00:00.000Z', true)).toContain(
      '2026-01-01T00:00:00.000Z',
    );
    expect(journalHorizonNote('progress', 'x', true)).toBeUndefined();
    expect(journalHorizonNote('end', 'x', false)).toBeUndefined();
    expect(journalHorizonNote('end', null, true)).toBeUndefined();
    expect(journalHorizonNote('end', undefined, true)).toBeUndefined();
  });
});

describe('文字数の予算', () => {
  it('大きさは JSON にした長さ。超えたら古い側（末尾）から手放し、最低 1 件は残す', () => {
    const entries = [
      said(3, 'あ'.repeat(100)),
      said(2, 'い'.repeat(100)),
      said(1, 'う'.repeat(100)),
    ];
    const one = entryChars(entries[0] ?? said(0));
    const fits2 = trimToBudget(entries, one * 2 + 10);
    expect(fits2.entries.map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(fits2.dropped).toBe(1);
    expect(fits2.chars).toBeLessThanOrEqual(one * 2 + 10);
    expect(trimToBudget(entries, 1).entries.map((e) => e.id)).toEqual(['e3']);
    expect(trimToBudget(entries, 1_000_000).dropped).toBe(0);
  });

  it('件数ではなく文字数で締まる: 小さい行なら多く、大きい行なら少なく残る', () => {
    const small = Array.from({ length: 50 }, (_, i) =>
      journalEntry(`s${String(i)}`, 'turn_usage', minute(i)),
    );
    const large = Array.from({ length: 50 }, (_, i) => said(i, 'あ'.repeat(500)));
    const budget = 10_000;
    expect(trimToBudget(small, budget).entries.length).toBeGreaterThan(
      trimToBudget(large, budget).entries.length,
    );
  });
});

describe('可視窓', () => {
  it('全部が窓に収まるなら全部。追従中は末尾の窓', () => {
    expect(listWindow(3, 0, true, 10)).toEqual({ start: 0, end: 3 });
    expect(listWindow(100, 0, true, 10)).toEqual({ start: 90, end: 100 });
  });

  it('遡っている間は選択を窓の中ほどに置き、新着が末尾に足されても窓は動かない', () => {
    // 100 件のうち、最新から 30 番目を選択（表示位置 69）。
    const before = listWindow(100, 30, false, 10);
    expect(before.start).toBeLessThanOrEqual(69);
    expect(before.end).toBeGreaterThan(69);
    expect(before.end - before.start).toBe(10);
    // 新着 5 件が末尾に足された: 選択は新しい順で 35 番目になるが、表示位置は同じ 69。
    expect(listWindow(105, 35, false, 10)).toEqual(before);
  });

  it('端では窓がはみ出さない', () => {
    expect(listWindow(100, 99, false, 10)).toEqual({ start: 0, end: 10 });
    expect(listWindow(100, 0, false, 10)).toEqual({ start: 90, end: 100 });
  });
});
