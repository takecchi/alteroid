import { describe, expect, it } from 'vitest';

import { decideAnswer, inferDecision } from './runner.js';

/**
 * `decision` を付け忘れた回答の読み取り（issue #1827）。
 *
 * `inferDecision` は「否定が読み取れたときだけ拒否」する設計で、語の一覧に
 * 無い否定は **allow に化ける**（許しすぎる側）。「拒否」「無理」のような
 * ごく普通の拒否の言い方が一覧から漏れていた。
 */
describe('inferDecision / 普通の拒否の言い方を拒否として読む（issue #1827）', () => {
  it.each([
    '拒否します',
    'それは拒否する。',
    'それは無理です',
    'お断りします',
    '断る',
    '許可できない',
    '認めない',
    '承認できません',
    'reject',
    'Rejected.',
    'I refuse.',
    'decline this one',
  ])('「%s」は deny', (message) => {
    expect(inferDecision(message)).toBe('deny');
  });

  it('decideAnswer（permission・decision なし）も、拒否の言い方を deny にする', () => {
    expect(decideAnswer('permission', undefined, 'それは拒否する。')).toBe('deny');
  });

  it.each(['はい、どうぞ', 'OK、進めてよい', '許可する', 'go ahead'])(
    '対照: 「%s」は今までどおり allow',
    (message) => {
      expect(inferDecision(message)).toBe('allow');
    },
  );

  it('対照: 明示の decision は語より優先する', () => {
    expect(decideAnswer('permission', 'allow', 'それは拒否する。')).toBe('allow');
  });
});
