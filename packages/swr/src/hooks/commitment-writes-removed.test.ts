import { describe, expect, it } from 'vitest';

import * as swr from '../index';

// 台帳の撤去の段2b: 台帳へ書く mutation は無い。読む `useCommitments` / `useCommitment` は段3まで残る。
describe('swr に台帳の書き込みの hook は無い', () => {
  it.each([
    'usePushCommitment',
    'useCloseCommitment',
    'useReopenCommitment',
    'useEditCommitment',
    'CommitmentConflictError',
  ])('%s を export しない', (name) => {
    expect(Object.keys(swr)).not.toContain(name);
  });

  it('読む hook は残っている', () => {
    expect(swr.useCommitments).toBeTypeOf('function');
    expect(swr.useCommitment).toBeTypeOf('function');
  });
});
