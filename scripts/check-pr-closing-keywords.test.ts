import { describe, expect, it } from 'vitest';

import {
  CLOSING_KEYWORDS,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-closing-keywords-core.mjs';

describe('CLOSING_KEYWORDS', () => {
  it('公式 doc の一覧と完全一致する9語', () => {
    expect(CLOSING_KEYWORDS).toEqual([
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ]);
  });
});
