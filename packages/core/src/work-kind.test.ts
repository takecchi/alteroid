import { describe, expect, it } from 'vitest';

import { groupByWorkKind, UNCLASSIFIED_WORK_KIND_LABEL, workKindGroupKey } from './work-kind.js';

describe('workKindGroupKey（#1308 段B）', () => {
  it('機械的に同じと言える差だけを寄せる（互換正規化・前後の空白・大文字小文字）', () => {
    expect(workKindGroupKey('実装')).toBe(workKindGroupKey(' 実装 '));
    expect(workKindGroupKey('ＲＥＶＩＥＷ')).toBe(workKindGroupKey('review'));
    // 意味が近いだけのものは寄せない（それは判断であって器の変換ではない）。
    expect(workKindGroupKey('実装')).not.toBe(workKindGroupKey('実装作業'));
  });

  it('種類が無い・空白だけなら null（未分類）', () => {
    expect(workKindGroupKey(undefined)).toBeNull();
    expect(workKindGroupKey('   ')).toBeNull();
  });
});

describe('groupByWorkKind（#1308 段B）', () => {
  it('件数の多い群から並べ、未分類は件数に関わらず最後に置く', () => {
    const groups = groupByWorkKind(
      [
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4, kind: '調査' },
        { id: 5, kind: '実装' },
        { id: 6, kind: '実装 ' },
      ],
      (item: { id: number; kind?: string }) => item.kind,
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['実装', [5, 6]],
      ['調査', [4]],
      [UNCLASSIFIED_WORK_KIND_LABEL, [1, 2, 3]],
    ]);
  });

  it('件数が同じ群は鍵の辞書順（入力の順序に依存しない）', () => {
    const labels = (kinds: string[]) =>
      groupByWorkKind(kinds, (kind) => kind).map((group) => group.label);
    expect(labels(['b', 'a'])).toEqual(labels(['a', 'b']));
  });
});
