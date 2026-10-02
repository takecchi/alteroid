import { describe, expect, it } from 'vitest';

import { describeQuestionLines, summarizeQuestions } from './approval-questions.js';

const single = { id: 'a', prompt: 'A', options: [{ id: 'x', label: 'X' }] };
const multi = { id: 'b', prompt: 'B', multiple: true, options: [{ id: 'y', label: 'Y' }] };

describe('summarizeQuestions（core の定義の再 export）', () => {
  // 旧い写し（ui の summarizeApprovalQuestions、#2558 で消した）が返していた文字列を直に書く。
  it.each([
    [[], '設問 0 件（選択肢つき）'],
    [[single], '設問 1 件（選択肢つき）'],
    [[single, multi], '設問 2 件（うち複数選択 1）（選択肢つき）'],
    [[multi, multi, single], '設問 3 件（うち複数選択 2）（選択肢つき）'],
  ])('%j', (questions, expected) => {
    expect(summarizeQuestions(questions)).toBe(expected);
  });

  it('describeQuestionLines も同じ口から読める', () => {
    expect(describeQuestionLines([multi])).toEqual([
      'Q1 [id=b] B（複数選択可・その他を書ける）',
      '  (a) [id=y] Y',
    ]);
  });
});
