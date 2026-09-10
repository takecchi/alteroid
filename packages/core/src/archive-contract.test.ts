import { describe, expect, it } from 'vitest';

import { verifyTranscriptArchiveContract } from './archive-contract.js';
import { createMemoryStores } from './testing.js';

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

    await expect(verifyTranscriptArchiveContract(stores.archive)).resolves.toBeUndefined();
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
    const id = await stores.archive.archive('session-1', 'BODY\n');
    const before = (await stores.archive.list()).length;

    await stores.archive.remove(id);

    expect((await stores.archive.list()).length).toBe(before);
  });
});
