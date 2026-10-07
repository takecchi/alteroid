import { describe, expect, it } from 'vitest';

import { verifyTranscriptArchiveContract } from './archive-contract.js';
import { createMemoryStores, seedFingerprintlessArchiveRow } from './testing.js';

describe('TranscriptArchive の契約（インメモリ実装）', () => {
  it('remove() は行を消さない／read()は3つの顔／巻き添え無し／存在しないidは黙って成功しない／空の本文はremovedにならない／二重removeは冪等', async () => {
    const stores = createMemoryStores();

    await expect(
      verifyTranscriptArchiveContract(stores.archive, {
        seedFingerprintlessRow: (sessionId, body) =>
          seedFingerprintlessArchiveRow(stores.archive, sessionId, body),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('TranscriptArchive（インメモリ実装）固有の細部', () => {
  it('remove() の前後で list() の件数が変わらない（行を削除していない）', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('session-1', 'BODY\n')).id;
    const before = (await stores.archive.list()).length;

    await stores.archive.remove(id);

    expect((await stores.archive.list()).length).toBe(before);
  });

  it('sessions()のcontinuityはfirst/continues/diverged/unknown/absentを正しく数える', async () => {
    const stores = createMemoryStores();
    const sessionId = 'session-continuity-tally';

    const writeFirst = await stores.archive.archive(sessionId, 'A\n');
    expect(writeFirst.continuity).toBe('first');
    const writeContinues = await stores.archive.archive(sessionId, 'A\nB\n');
    expect(writeContinues.continuity).toBe('continues');
    const writeDiverged = await stores.archive.archive(sessionId, 'X\n');
    expect(writeDiverged.continuity).toBe('diverged');

    await seedFingerprintlessArchiveRow(stores.archive, sessionId, 'LEGACY\n');

    const writeAfterSeed = await stores.archive.archive(sessionId, 'ANYTHING\n');
    expect(writeAfterSeed.continuity).toBe('unknown');

    const summaries = await stores.archive.sessions();
    const summary = summaries.find((s) => s.sessionId === sessionId);
    expect(summary?.rows).toBe(5);
    expect(summary?.continuity).toEqual({
      first: 1,
      continues: 1,
      diverged: 1,
      unknown: 1,
      absent: 1,
    });
  });
});
