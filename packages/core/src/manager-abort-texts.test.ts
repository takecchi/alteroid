import { describe, expect, it } from 'vitest';

import { abortTextsOf } from './manager-notices.js';

// `abortTextsOf`（`Pool#abort` の日誌の detail・配る文・本文の印）の入力→出力の表。
// 人間が打った reason が messageText に入る回（stopped の人間発）だけ markup が 'none' になる。

const WHO = {
  human: '人間',
  clone: 'クローン',
  'auto-fold': 'デーモン（pids逼迫の自動畳み）',
} as const;

describe('abortTextsOf: stopped', () => {
  it('人間発・reason あり: detail に reason、messageText に「理由:」、markup は none', () => {
    expect(
      abortTextsOf({
        outcome: 'stopped',
        stopError: undefined,
        who: WHO.human,
        reason: '要らなくなった',
        by: 'human',
        managerId: 'mgr-1',
        withheldNote: '',
      }),
    ).toEqual({
      detail: '人間が停止させた: 要らなくなった',
      messageText: 'mgr-1 を人間が停止させました。理由: 要らなくなった',
      markup: 'none',
    });
  });

  it('人間発・reason なし: 文に理由を入れず、markup は立てない', () => {
    const texts = abortTextsOf({
      outcome: 'stopped',
      stopError: undefined,
      who: WHO.human,
      reason: undefined,
      by: 'human',
      managerId: 'mgr-1',
      withheldNote: '',
    });
    expect(texts.detail).toBe('人間が停止させた。');
    expect(texts.messageText).toBe('mgr-1 を人間が停止させました。');
    expect(texts.markup).toBeUndefined();
  });

  it('クローン発・reason あり: markup は立てない（クローン発に none も markdown も立てない）', () => {
    const texts = abortTextsOf({
      outcome: 'stopped',
      stopError: undefined,
      who: WHO.clone,
      reason: '重複',
      by: 'clone',
      managerId: 'mgr-2',
      withheldNote: '',
    });
    expect(texts.detail).toBe('クローンが停止させた: 重複');
    expect(texts.messageText).toBe('mgr-2 をクローンが停止させました。理由: 重複');
    expect(texts.markup).toBeUndefined();
  });

  it('自動の畳み発・reason あり: markup は立てない', () => {
    const texts = abortTextsOf({
      outcome: 'stopped',
      stopError: undefined,
      who: WHO['auto-fold'],
      reason: 'pids 逼迫',
      by: 'auto-fold',
      managerId: 'mgr-3',
      withheldNote: '',
    });
    expect(texts.detail).toBe('デーモン（pids逼迫の自動畳み）が停止させた: pids 逼迫');
    expect(texts.messageText).toBe(
      'mgr-3 をデーモン（pids逼迫の自動畳み）が停止させました。理由: pids 逼迫',
    );
    expect(texts.markup).toBeUndefined();
  });

  it('stopError と withheldNote は detail の末尾へこの順に付き、messageText には withheldNote だけ付く', () => {
    expect(
      abortTextsOf({
        outcome: 'stopped',
        stopError: new Error('接続が切れた'),
        who: WHO.human,
        reason: undefined,
        by: 'human',
        managerId: 'mgr-1',
        withheldNote: '（控えた報告 2 件）',
      }),
    ).toEqual({
      detail:
        '人間が停止させた。（runner.stop() が例外を投げた: Error: 接続が切れた）（控えた報告 2 件）',
      messageText: 'mgr-1 を人間が停止させました。（控えた報告 2 件）',
      markup: undefined,
    });
  });
});

describe('abortTextsOf: not_stopped', () => {
  it('reason なし・stopError なし: セッションが残っていて止まっていない', () => {
    expect(
      abortTextsOf({
        outcome: 'not_stopped',
        stopError: undefined,
        who: WHO.human,
        reason: undefined,
        by: 'human',
        managerId: 'mgr-1',
        withheldNote: '控えの文',
      }),
    ).toEqual({
      detail:
        '人間が停止を試みた。runner には mgr-1 のセッションがまだ残っている。止まっていない。',
      messageText:
        'mgr-1 を人間が止めようとしましたが、まだ止まっていません（runner にセッションが残っています）。',
      markup: undefined,
    });
  });

  it('reason あり・stopError あり: reason は detail にだけ入り、markup は none にならない', () => {
    expect(
      abortTextsOf({
        outcome: 'not_stopped',
        stopError: 'stop が落ちた',
        who: WHO.human,
        reason: '止めたい',
        by: 'human',
        managerId: 'mgr-1',
        withheldNote: '',
      }),
    ).toEqual({
      detail:
        '人間が停止を試みた: 止めたいrunner には mgr-1 のセッションがまだ残っている。止まっていない。' +
        '（runner.stop() が例外を投げた: stop が落ちた）',
      messageText:
        'mgr-1 を人間が止めようとしましたが、まだ止まっていません（runner にセッションが残っています）。',
      markup: undefined,
    });
  });
});

describe('abortTextsOf: unknown', () => {
  it('クローン発・reason なし: 確認が取れず止まったかは未確認', () => {
    expect(
      abortTextsOf({
        outcome: 'unknown',
        stopError: undefined,
        who: WHO.clone,
        reason: undefined,
        by: 'clone',
        managerId: 'mgr-2',
        withheldNote: '',
      }),
    ).toEqual({
      detail: 'クローンが停止を試みた。runner に確認が取れず、止まったかは未確認。',
      messageText:
        'mgr-2 をクローンが止めようとしましたが、止まったかどうか確認が取れませんでした。',
      markup: undefined,
    });
  });

  it('人間発・reason あり・stopError あり: reason は detail にだけ入り、markup は none にならない', () => {
    expect(
      abortTextsOf({
        outcome: 'unknown',
        stopError: new Error('タイムアウト'),
        who: WHO.human,
        reason: '止めたい',
        by: 'human',
        managerId: 'mgr-1',
        withheldNote: '',
      }),
    ).toEqual({
      detail:
        '人間が停止を試みた: 止めたいrunner に確認が取れず、止まったかは未確認。' +
        '（runner.stop() が例外を投げた: Error: タイムアウト）',
      messageText: 'mgr-1 を人間が止めようとしましたが、止まったかどうか確認が取れませんでした。',
      markup: undefined,
    });
  });
});
