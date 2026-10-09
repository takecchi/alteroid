import { describe, expect, it } from 'vitest';

import { verifyProfileStoreContract } from './profile-store-contract.js';
import { createMemoryStores } from './testing.js';

describe('ProfileStore の契約（インメモリ）', () => {
  it('3実装で同じ契約を通る（fs / pg は各パッケージのテストが同じ関数を呼ぶ）', async () => {
    await verifyProfileStoreContract(createMemoryStores().profile);
  });

  it('契約の歯が反応する（並びがコード単位順でない器は落ちる）', async () => {
    const stores = createMemoryStores();
    const store = stores.profile;
    const broken = {
      ...store,
      list: async () =>
        (await store.list()).sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
    };

    await expect(verifyProfileStoreContract(broken)).rejects.toThrow('コード単位順でない');
  });
});
