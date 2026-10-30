import * as logic from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

import * as swr from './index';

// 同じ値を出す口を2つにしない: どちらを読むかが分かれ、片方だけ直る形になるため（#5670）
describe('JOURNAL_PAGE の正本', () => {
  it('logic だけが出し、swr からは出さない', () => {
    expect(logic.JOURNAL_PAGE).toBe(100);
    expect('JOURNAL_PAGE' in swr).toBe(false);
  });
});
