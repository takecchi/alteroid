import { createMemoryStores, type ArchiveContinuity } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

describe('pg の archive() の連続性の判定は、NUL を含む本文で fs / インメモリと揃う（#1709）', () => {
  let client: TestDbHandle;
  let db: Db;
  let pgStores: PgStores;

  beforeEach(async () => {
    ({ client, db } = await createMigratedTestDb());
    pgStores = createPgStoresFromDb(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('NUL 入りの1本目の後に、NUL が無かった場合の見た目の2本目を積んでも、pg はインメモリと同じく diverged を返す', async () => {
    const transcript1 = 'AAAA\u0000\n';
    const transcript2 = 'AAAA\nBBBB\n';

    expect(transcript2.startsWith(transcript1)).toBe(false);
    expect(transcript2.startsWith(transcript1.replaceAll('\u0000', ''))).toBe(true);

    const memoryStores = createMemoryStores();

    const sessionId = 'bughunt-nul-continuity';

    const pgWrite1 = await pgStores.archive.archive(sessionId, transcript1);
    const pgWrite2 = await pgStores.archive.archive(sessionId, transcript2);

    const memWrite1 = await memoryStores.archive.archive(sessionId, transcript1);
    const memWrite2 = await memoryStores.archive.archive(sessionId, transcript2);

    expect(pgWrite1.continuity).toBe<ArchiveContinuity>('first');
    expect(memWrite1.continuity).toBe<ArchiveContinuity>('first');

    expect(pgWrite2.continuity).toBe(memWrite2.continuity);
    expect(pgWrite2.continuity).toBe<ArchiveContinuity>('diverged');
  });
});
