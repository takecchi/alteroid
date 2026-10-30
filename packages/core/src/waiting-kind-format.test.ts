import { describe, expect, it } from 'vitest';

import { describeWaitingKind } from './waiting-kind-format.js';

// core（manager_list）と CLI が同じ1本を使う（#5683）
describe('describeWaitingKind', () => {
  it('question は質問、permission は実行許可', () => {
    expect(describeWaitingKind('question')).toBe('質問');
    expect(describeWaitingKind('permission')).toBe('実行許可');
  });
});
