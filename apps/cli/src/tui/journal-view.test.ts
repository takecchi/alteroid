import { SEARCH_SCOPE_NOTE } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

import { initialJournalState } from './journal-controller.js';
import { LIST_FIXED_ROWS, bottomLineText, bottomLines, listFixedRows } from './journal-view.js';

describe('最下行', () => {
  it('読めている間は末尾に追従中と言う', () => {
    expect(bottomLineText({ ...initialJournalState, status: 'ready' }, 'live')).toContain(
      '末尾に追従中',
    );
  });

  it('再読込に失敗している間は、新着を入れていないと言い、追従中とは言わない', () => {
    const text = bottomLineText(
      { ...initialJournalState, status: 'error', error: '繋がらない', follow: true },
      'live',
    );
    expect(text).not.toContain('追従中');
    expect(text).toContain('新着を一覧に入れていない');
  });
});

describe('取りこぼし確認の失敗（#3483）', () => {
  it('追従中とは言わず、失敗と r で読み直すことを言う（error が消えても残る）', () => {
    const text = bottomLineText(
      { ...initialJournalState, status: 'ready', follow: true, newerFailed: true, error: null },
      'live',
    );
    expect(text).not.toContain('追従中');
    expect(text).toContain('取りこぼし確認に失敗');
    expect(text).toContain('r で読み直す');
  });
});

describe('語で絞っているときの最下行（#2588）', () => {
  const base = { ...initialJournalState, status: 'ready' as const };

  it('語が無ければ状態の 1 行だけで、固定行は 3', () => {
    expect(bottomLines(base, 'live')).toEqual([bottomLineText(base, 'live')]);
    expect(listFixedRows(base)).toBe(LIST_FIXED_ROWS);
  });

  it('語で絞っていても、ライブ切断と取りこぼし確認の停止が上の行に出て、断り書きが下の行に出る', () => {
    const state = { ...base, q: 'foo', newerBlocked: true };
    const lines = bottomLines(state, 'offline');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('ライブ切断');
    expect(lines[0]).toContain('取りこぼし確認');
    expect(lines[1]).toBe(SEARCH_SCOPE_NOTE);
  });

  it('語で絞っているときは、固定行が 1 行増える（行数の勘定が合う）', () => {
    const state = { ...base, q: 'foo' };
    expect(listFixedRows(state)).toBe(LIST_FIXED_ROWS + bottomLines(state, 'live').length - 1);
    expect(listFixedRows(state)).toBe(LIST_FIXED_ROWS + 1);
  });
});
