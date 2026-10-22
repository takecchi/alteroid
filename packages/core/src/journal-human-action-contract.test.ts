import { describe, expect, it } from 'vitest';

import { verifyJournalStoreHumanActionContract } from './journal-human-action-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の人間の操作の印の契約（インメモリ実装）', () => {
  it('5種の印が via ごと書き戻せ、印の無い行は無いまま読める', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreHumanActionContract(stores.journal)).resolves.toBeUndefined();
  });

  it('歯: 印の欄を落とすストアでは契約が落ちる', async () => {
    const stores = createMemoryStores();
    const dropping = {
      append: async (input: Parameters<typeof stores.journal.append>[0]) => {
        const stripped = { ...input } as Record<string, unknown>;
        delete stripped.humanAction;
        return stores.journal.append(stripped as typeof input);
      },
      list: stores.journal.list.bind(stores.journal),
    };

    await expect(verifyJournalStoreHumanActionContract(dropping)).rejects.toThrow(
      /人間の操作の印の契約/,
    );
  });

  it('歯: via を落とすストアでは契約が落ちる', async () => {
    const stores = createMemoryStores();
    const droppingVia = {
      append: async (input: Parameters<typeof stores.journal.append>[0]) => {
        if (input.type !== 'decision' || input.humanAction === undefined) {
          return stores.journal.append(input);
        }
        return stores.journal.append({
          ...input,
          humanAction: { ...input.humanAction, via: { kind: 'operator', auth: 'disabled' } },
        });
      },
      list: stores.journal.list.bind(stores.journal),
    };

    await expect(verifyJournalStoreHumanActionContract(droppingVia)).rejects.toThrow(
      /人間の操作の印の契約/,
    );
  });

  it('歯: 印の無い行に印が湧くストアでは契約が落ちる', async () => {
    const stores = createMemoryStores();
    const inventing = {
      append: async (input: Parameters<typeof stores.journal.append>[0]) => {
        if (input.type !== 'decision' || input.humanAction !== undefined) {
          return stores.journal.append(input);
        }
        return stores.journal.append({
          ...input,
          humanAction: {
            kind: 'practice_write',
            target: 'x',
            via: { kind: 'operator', auth: 'disabled' },
          },
        });
      },
      list: stores.journal.list.bind(stores.journal),
    };

    await expect(verifyJournalStoreHumanActionContract(inventing)).rejects.toThrow(
      /印の無い行に humanAction/,
    );
  });
});
