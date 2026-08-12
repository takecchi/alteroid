import { describe, expect, it } from 'vitest';

import { STORAGE_FS_INFO } from './index.js';

describe('@alteroid/storage-fs', () => {
  it('ワークスペース間のパッケージ解決が通る（M0 スモーク）', () => {
    expect(STORAGE_FS_INFO.core).toBe('0.0.0');
  });
});
