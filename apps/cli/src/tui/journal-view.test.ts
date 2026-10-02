import { describe, expect, it } from 'vitest';

import { initialJournalState } from './journal-controller.js';
import { bottomLineText } from './journal-view.js';

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
