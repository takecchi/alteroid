import { describe, expect, it } from 'vitest';

import { CloneNotices } from './clone-notices.js';
import type { TurnNoticeKey } from './clone-notices.js';

const TURN_NOTICE_KEYS: readonly TurnNoticeKey[] = [
  'redelivery',
  'superseded',
  'validity',
  'mergedBatchTruncation',
  'commitment',
  'situation',
];

describe('CloneNotices — 1反復ぶんの断り書き6本（set / forTurn / clearTurn）', () => {
  it('forTurn は set した値をそのまま返す', () => {
    const notices = new CloneNotices();
    notices.set('redelivery', 'これは配り直しである');
    notices.set('commitment', '未了が1件ある');
    notices.set('situation', 'いまの全体');

    const forTurn = notices.forTurn();
    expect(forTurn.redelivery).toBe('これは配り直しである');
    expect(forTurn.commitment).toBe('未了が1件ある');
    expect(forTurn.situation).toBe('いまの全体');
    expect(forTurn.superseded).toBe('');
    expect(forTurn.validity).toBe('');
    expect(forTurn.mergedBatchTruncation).toBe('');
  });

  it('clearTurn は6本全部を空文字へ戻す', () => {
    const notices = new CloneNotices();
    for (const key of TURN_NOTICE_KEYS) notices.set(key, `${key}-値`);

    const before = notices.forTurn();
    for (const key of TURN_NOTICE_KEYS) expect(before[key]).not.toBe('');

    notices.clearTurn();

    const after = notices.forTurn();
    for (const key of TURN_NOTICE_KEYS) expect(after[key]).toBe('');
  });

  it('set は他のキーへ影響しない', () => {
    const notices = new CloneNotices();
    notices.set('redelivery', 'A');
    notices.set('superseded', 'B');

    expect(notices.forTurn().redelivery).toBe('A');
    expect(notices.forTurn().superseded).toBe('B');

    notices.set('redelivery', 'A2');
    expect(notices.forTurn().redelivery).toBe('A2');
    expect(notices.forTurn().superseded).toBe('B');
  });
});

describe('CloneNotices — 人間へ返す1行の畳み（foldHumanFailure / forgetConversation）', () => {
  it('同じ会話に同じ文言を渡すたびに畳んだ件数が1, 2 と進む', () => {
    const notices = new CloneNotices();
    const text = 'いま利用上限に当たっているので、この発言にはまだ返せない。';

    expect(notices.foldHumanFailure('conv-1', text)).toBeNull();
    expect(notices.foldHumanFailure('conv-1', text)).toBe(1);
    expect(notices.foldHumanFailure('conv-1', text)).toBe(2);
  });

  it('違う文言が来たら畳まず null を返し、記録を新しい文言へ進める（folded は0から再スタート）', () => {
    const notices = new CloneNotices();
    const first = 'いま利用上限に当たっているので、この発言にはまだ返せない。';
    const second =
      'いま利用上限に当たっているので、この発言にはまだ返せない（文脈窓にも当たった）。';

    expect(notices.foldHumanFailure('conv-1', first)).toBeNull();
    expect(notices.foldHumanFailure('conv-1', first)).toBe(1);
    expect(notices.foldHumanFailure('conv-1', second)).toBeNull();
    expect(notices.foldHumanFailure('conv-1', second)).toBe(1);
  });

  it('forgetConversation はその会話だけを落とす（他の会話の記憶は残る）', () => {
    const notices = new CloneNotices();
    const text = '同じ理由で落ちた。';

    expect(notices.foldHumanFailure('conv-1', text)).toBeNull();
    expect(notices.foldHumanFailure('conv-1', text)).toBe(1);
    expect(notices.foldHumanFailure('conv-2', text)).toBeNull();
    expect(notices.foldHumanFailure('conv-2', text)).toBe(1);

    notices.forgetConversation('conv-1');

    expect(notices.foldHumanFailure('conv-1', text)).toBeNull();
    expect(notices.foldHumanFailure('conv-2', text)).toBe(2);
  });
});

describe('CloneNotices — 利用上限の通知の畳み（noteUsage）', () => {
  it('同じ kind で違う文言が来れば毎回 true（畳まない）', () => {
    const notices = new CloneNotices();
    const a = "You've hit your individual spend limit for this account.";
    const b = "You're now using extra usage until your limit resets.";

    expect(notices.noteUsage('reached', a)).toBe(true);
    expect(notices.noteUsage('reached', a)).toBe(false);
    expect(notices.noteUsage('reached', a)).toBe(false);

    expect(notices.noteUsage('transition', b)).toBe(true);
    expect(notices.noteUsage('transition', b)).toBe(false);

    expect(notices.noteUsage('reached', b)).toBe(true);
    expect(notices.noteUsage('reached', a)).toBe(true);
    expect(notices.noteUsage('reached', b)).toBe(true);
    expect(notices.noteUsage('reached', a)).toBe(true);
  });
});
