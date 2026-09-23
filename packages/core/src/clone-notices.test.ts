import { describe, expect, it } from 'vitest';

import { CloneNotices } from './clone-notices.js';
import type { TurnNoticeKey } from './clone-notices.js';

/**
 * `clone-notices.ts` の歯。**純粋なクラスなので I/O のモック無しで全分岐に通せる**
 * （`superseded.ts` の歯と同じ作法）。
 */

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
    // set していないキーは初期値の空文字のまま。
    expect(forTurn.superseded).toBe('');
    expect(forTurn.validity).toBe('');
    expect(forTurn.mergedBatchTruncation).toBe('');
  });

  it('clearTurn は6本全部を空文字へ戻す', () => {
    const notices = new CloneNotices();
    for (const key of TURN_NOTICE_KEYS) notices.set(key, `${key}-値`);

    // 戻す前は6本とも非空であることを先に確かめる（対照——空振りしていないこと）。
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
    // `redelivery` を上書きしても `superseded` は変わらない。
    expect(notices.forTurn().redelivery).toBe('A2');
    expect(notices.forTurn().superseded).toBe('B');
  });
});

describe('CloneNotices — 人間へ返す1行の畳み（foldHumanFailure / forgetConversation）', () => {
  it('同じ会話に同じ文言を渡すたびに畳んだ件数が1, 2 と進む', () => {
    const notices = new CloneNotices();
    const text = 'いま利用上限に当たっているので、この発言にはまだ返せない。';

    // 1回目: 初めての会話なので null（畳んでいない＝新しい1行）。
    expect(notices.foldHumanFailure('conv-1', text)).toBeNull();
    // 2回目: 同じ文言なので畳んだ件数 1。
    expect(notices.foldHumanFailure('conv-1', text)).toBe(1);
    // 3回目: 畳んだ件数 2。
    expect(notices.foldHumanFailure('conv-1', text)).toBe(2);
  });

  it('違う文言が来たら畳まず null を返し、記録を新しい文言へ進める（folded は0から再スタート）', () => {
    const notices = new CloneNotices();
    const first = 'いま利用上限に当たっているので、この発言にはまだ返せない。';
    const second =
      'いま利用上限に当たっているので、この発言にはまだ返せない（文脈窓にも当たった）。';

    expect(notices.foldHumanFailure('conv-1', first)).toBeNull();
    expect(notices.foldHumanFailure('conv-1', first)).toBe(1);
    // 文言が変わったので畳まない（null）——記憶は新しい文言へ進む。
    expect(notices.foldHumanFailure('conv-1', second)).toBeNull();
    // 新しい文言をもう一度渡せば、今度はそちらが畳まれる。
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

    // conv-1 は記憶が落ちているので、同じ文言でも「新しい1行」として null。
    expect(notices.foldHumanFailure('conv-1', text)).toBeNull();
    // conv-2 の記憶はそのまま残っている——畳んだ件数は 2 まで進む。
    expect(notices.foldHumanFailure('conv-2', text)).toBe(2);
  });
});

describe('CloneNotices — 利用上限の通知の畳み（noteUsage）', () => {
  it('同じ kind で違う文言が来れば毎回 true（畳まない）', () => {
    const notices = new CloneNotices();
    const a = "You've hit your individual spend limit for this account.";
    const b = "You're now using extra usage until your limit resets.";

    // kind ごとに独立して覚える。
    expect(notices.noteUsage('reached', a)).toBe(true);
    // 同じ kind・同じ文言なら false（畳む）。
    expect(notices.noteUsage('reached', a)).toBe(false);
    expect(notices.noteUsage('reached', a)).toBe(false);

    // 別の kind は別の記憶なので、初回は true。
    expect(notices.noteUsage('transition', b)).toBe(true);
    expect(notices.noteUsage('transition', b)).toBe(false);

    // **交互の文言では毎回 true になる**（同じ kind で A→B→A→B）。
    expect(notices.noteUsage('reached', b)).toBe(true);
    expect(notices.noteUsage('reached', a)).toBe(true);
    expect(notices.noteUsage('reached', b)).toBe(true);
    expect(notices.noteUsage('reached', a)).toBe(true);
  });
});
