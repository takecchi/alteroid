import { describe, expect, it } from 'vitest';

import { verifyJournalStoreToolUseCountContract } from './journal-tool-use-count-contract.js';
import { createMemoryStores } from './testing.js';

describe('verifyJournalStoreToolUseCountContract（インメモリ）', () => {
  it('インメモリは契約を満たす', async () => {
    const stores = createMemoryStores();
    await expect(verifyJournalStoreToolUseCountContract(stores.journal)).resolves.toBeUndefined();
  });

  it('口を持たない器は契約の破れとして落とす', async () => {
    const stores = createMemoryStores();
    await expect(
      verifyJournalStoreToolUseCountContract({
        append: stores.journal.append.bind(stores.journal),
      }),
    ).rejects.toThrow('countToolUsesByActor を持っていない');
  });

  it('種別で絞らず窓の内の行を全部数える実装は落ちる', async () => {
    const stores = createMemoryStores();
    const unfiltered = {
      append: stores.journal.append.bind(stores.journal),
      async countToolUsesByActor(query: { since: string; until: string }) {
        const rows = await stores.journal.list({ since: query.since, until: query.until });
        const counts = new Map<string, number>();
        for (const row of rows) {
          const actor =
            row.type === 'tool_use' ? row.actor : `${'journal-tool-use-count-contract'}:a`;
          counts.set(actor, (counts.get(actor) ?? 0) + 1);
        }
        return [...counts].map(([actor, count]) => ({ actor, count }));
      },
    };
    await expect(verifyJournalStoreToolUseCountContract(unfiltered)).rejects.toThrow('窓の内');
  });

  it('境界を含まない実装は落ちる', async () => {
    const stores = createMemoryStores();
    const exclusive = {
      append: stores.journal.append.bind(stores.journal),
      async countToolUsesByActor(query: { since: string; until: string }) {
        const rows = await stores.journal.list({ types: ['tool_use'] });
        const counts = new Map<string, number>();
        for (const row of rows) {
          if (row.type === 'tool_use' && row.at > query.since && row.at < query.until) {
            counts.set(row.actor, (counts.get(row.actor) ?? 0) + 1);
          }
        }
        return [...counts].map(([actor, count]) => ({ actor, count }));
      },
    };
    await expect(verifyJournalStoreToolUseCountContract(exclusive)).rejects.toThrow();
  });

  it('actor を割って返す実装は落ちる', async () => {
    const stores = createMemoryStores();
    const split = {
      append: stores.journal.append.bind(stores.journal),
      async countToolUsesByActor(query: { since: string; until: string }) {
        const rows = await stores.journal.list({
          types: ['tool_use'],
          since: query.since,
          until: query.until,
        });
        return rows.flatMap((row) =>
          row.type === 'tool_use' ? [{ actor: row.actor, count: 1 }] : [],
        );
      },
    };
    await expect(verifyJournalStoreToolUseCountContract(split)).rejects.toThrow('group');
  });
});
