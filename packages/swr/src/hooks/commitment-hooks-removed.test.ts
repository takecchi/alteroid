import { describe, expect, it } from 'vitest';

import * as swr from '../index';

// 台帳の撤去（段2b で書く hook、段3 で読む hook）: swr に台帳の hook は無い。
describe('swr に台帳の hook は無い', () => {
  it.each([
    'usePushCommitment',
    'useCloseCommitment',
    'useReopenCommitment',
    'useEditCommitment',
    'CommitmentConflictError',
    'useCommitments',
    'useCommitment',
  ])('%s を export しない', (name) => {
    expect(Object.keys(swr)).not.toContain(name);
  });
});
