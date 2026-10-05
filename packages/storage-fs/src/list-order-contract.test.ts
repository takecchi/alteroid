import { verifyListOrderContract } from '@alteroid/core';
import { describe, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('一覧の並びの契約（#2913）— fs', () => {
  it('名前の並びがコード単位の順である', async () => {
    await verifyListOrderContract(createFsStores(await makeTempDir('alteroid-test-')));
  });
});
