import { describe, expect, it } from 'vitest';

import { verifyTranscriptArchiveContract } from './archive-contract.js';
import { createMemoryStores, seedFingerprintlessArchiveRow } from './testing.js';

/**
 * `TranscriptArchive` の契約（#698）を、**インメモリ実装**（`testing.ts`）に
 * 対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`journal-search-contract.test.ts` と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 */
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

/**
 * 契約テストが測らない、インメモリ実装ならではの細部。
 *
 * **⛔ `remove()` は `archives`（本体の Map）から行を消さない。** 契約テストの
 * 「1. remove() の後も行は在る」は `list()` に出るかしか見ていない——ここでは
 * `archive()` を呼ばずに直接 Map の中身を検査できないので（実装の内部状態）、
 * `list()` の要素数が変わらないことで代用する。
 */
describe('TranscriptArchive（インメモリ実装）固有の細部', () => {
  it('remove() の前後で list() の件数が変わらない（行を削除していない）', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('session-1', 'BODY\n')).id;
    const before = (await stores.archive.list()).length;

    await stores.archive.remove(id);

    expect((await stores.archive.list()).length).toBe(before);
  });

  /**
   * `sessions().continuity`（#698 続き）——インメモリ実装は
   * `tallyArchiveContinuity`（`archive-continuity.ts`）で数える。`absent` は
   * `seedFingerprintlessArchiveRow` が作った、指紋も `continuity` も持たない
   * 行（この機能より前に積まれた行の再現）。`unknown` は、その直後の
   * `archive()` が「直前の行は指紋を持たない」と判定した結果——`absent` と
   * `unknown` が別カウンタに割れることを、インメモリ実装で直接測る。
   */
  it('sessions()のcontinuityはfirst/continues/diverged/unknown/absentを正しく数える', async () => {
    const stores = createMemoryStores();
    const sessionId = 'session-continuity-tally';

    const writeFirst = await stores.archive.archive(sessionId, 'A\n');
    expect(writeFirst.continuity).toBe('first');
    const writeContinues = await stores.archive.archive(sessionId, 'A\nB\n');
    expect(writeContinues.continuity).toBe('continues');
    const writeDiverged = await stores.archive.archive(sessionId, 'X\n');
    expect(writeDiverged.continuity).toBe('diverged');

    // absent: 指紋も continuity も持たない行（この機能より前の行の再現）。
    await seedFingerprintlessArchiveRow(stores.archive, sessionId, 'LEGACY\n');

    // unknown: 直前の行（上で seed した行）が指紋を持たないので、
    // その直後の archive() はここに落ちる。
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
