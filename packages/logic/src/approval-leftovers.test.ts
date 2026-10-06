import { describe, expect, it } from 'vitest';

import { describeApprovalLeftover, settleApprovalDraft } from './approval-leftovers.js';

const form = (supplement: string, chosen: string[] = []) => ({
  drafts: chosen.length === 0 ? {} : { q: { chosen, other: '', otherOn: false } },
  supplement,
});

describe('settleApprovalDraft（issue #3515）', () => {
  it('送った時点と同じ項目は畳む', () => {
    const next = settleApprovalDraft(
      { texts: { a: '答え', b: '別' }, questions: { a: form('補', ['x']) } },
      'a',
      { text: '答え', questions: form('補', ['x']) },
    );
    expect(next).toEqual({ texts: { b: '別' }, questions: {} });
  });

  it('違う項目（打ち足した分）は残し、同じ項目だけ畳む', () => {
    const next = settleApprovalDraft(
      { texts: { a: '答え+' }, questions: { a: form('補', ['x']) } },
      'a',
      { text: '答え', questions: form('補', ['x']) },
    );
    expect(next).toEqual({ texts: { a: '答え+' }, questions: {} });
  });

  it('何も変わらないときは同じ参照を返す', () => {
    const current = { texts: { b: 'b' }, questions: {} };
    expect(settleApprovalDraft(current, 'a', { text: '' })).toBe(current);
  });
});

describe('describeApprovalLeftover', () => {
  it('選択肢は名前で、「その他」と補足も書く。残るものが無ければ空', () => {
    const source = {
      question: '?',
      questions: [{ id: 'q', prompt: '先', options: [{ id: 'x', label: 'X社' }] }],
    };
    const drafts = {
      texts: { a: '本文' },
      questions: {
        a: { drafts: { q: { chosen: ['x'], other: '他', otherOn: false } }, supplement: '補' },
      },
    };
    expect(describeApprovalLeftover(source, drafts, 'a')).toBe(
      '本文\n\n先\n  選んだ: X社\n  その他: 他\n補足: 補',
    );
    expect(describeApprovalLeftover(source, { texts: {}, questions: {} }, 'a')).toBe('');
  });
});
