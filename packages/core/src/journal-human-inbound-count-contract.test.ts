import { describe, expect, it } from 'vitest';

import { verifyJournalStoreHumanInboundCountContract } from './journal-human-inbound-count-contract.js';
import { createMemoryStores } from './testing.js';

describe('verifyJournalStoreHumanInboundCountContract（インメモリ）', () => {
  it('インメモリは契約を満たす', async () => {
    const stores = createMemoryStores();
    await expect(
      verifyJournalStoreHumanInboundCountContract(stores.journal),
    ).resolves.toBeUndefined();
  });

  it('口を持たない器は契約の破れとして落とす', async () => {
    const stores = createMemoryStores();
    await expect(
      verifyJournalStoreHumanInboundCountContract({
        append: stores.journal.append.bind(stores.journal),
        list: stores.journal.list.bind(stores.journal),
      }),
    ).rejects.toThrow('countHumanInboundTurns を持っていない');
  });

  it('outbound も数える実装は落ちる', async () => {
    const stores = createMemoryStores();
    const countsOutbound = {
      append: stores.journal.append.bind(stores.journal),
      list: stores.journal.list.bind(stores.journal),
      async countHumanInboundTurns(query: { since: string; until: string }) {
        const rows = await stores.journal.list({
          types: ['exchange'],
          with: ['human'],
          since: query.since,
          until: query.until,
        });
        return rows.length;
      },
    };
    await expect(verifyJournalStoreHumanInboundCountContract(countsOutbound)).rejects.toThrow(
      '窓の内',
    );
  });

  it('マネージャーとの往復も数える実装は落ちる', async () => {
    const stores = createMemoryStores();
    const countsManager = {
      append: stores.journal.append.bind(stores.journal),
      list: stores.journal.list.bind(stores.journal),
      async countHumanInboundTurns(query: { since: string; until: string }) {
        const rows = await stores.journal.list({
          types: ['exchange'],
          since: query.since,
          until: query.until,
        });
        return rows.filter((row) => row.type === 'exchange' && row.role === 'inbound').length;
      },
    };
    await expect(verifyJournalStoreHumanInboundCountContract(countsManager)).rejects.toThrow(
      '窓の内',
    );
  });

  it('境界を含まない実装は落ちる', async () => {
    const stores = createMemoryStores();
    const exclusive = {
      append: stores.journal.append.bind(stores.journal),
      list: stores.journal.list.bind(stores.journal),
      async countHumanInboundTurns(query: { since: string; until: string }) {
        const rows = await stores.journal.list({ types: ['exchange'], with: ['human'] });
        return rows.filter(
          (row) =>
            row.type === 'exchange' &&
            row.role === 'inbound' &&
            row.at > query.since &&
            row.at < query.until,
        ).length;
      },
    };
    await expect(verifyJournalStoreHumanInboundCountContract(exclusive)).rejects.toThrow();
  });
});
