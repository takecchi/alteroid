import { createMemoryStores, type ArchiveContinuity } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * **NUL の位置だけが違う本文は、pg でも「続いていない」と読む（#1709）。** pg は NUL を
 * 受け付けないので保存の前に除くが、以前は指紋も除いた後の値で取っていて、同じ入力で
 * pg だけが `continues`、fs / インメモリは `diverged` を返していた。連続性は畳んでよいかの
 * 材料なので、オーナーの判断で安全側（続いていない＝畳まない）に揃えた。値はすべて偽物。
 */
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
    // 1本目: 'AAAA' + NUL + '\n'。
    const transcript1 = 'AAAA\u0000\n';
    // 2本目: NUL がそのまま改行に化けた「見た目」。生のバイト列としては
    // transcript1 と5文字目（0始まりで index 4）から食い違う
    // （transcript1[4] = '\u0000'、transcript2[4] = '\n'）——生の前方一致は崩れる。
    const transcript2 = 'AAAA\nBBBB\n';

    // 前提: 生の文字列としては前方一致していないこと（自明だが明示しておく）。
    expect(transcript2.startsWith(transcript1)).toBe(false);
    // 前提: NUL を取り除けば前方一致すること（このテストが作りたい状況）。
    expect(transcript2.startsWith(transcript1.replaceAll('\u0000', ''))).toBe(true);

    const memoryStores = createMemoryStores();

    const sessionId = 'bughunt-nul-continuity';

    const pgWrite1 = await pgStores.archive.archive(sessionId, transcript1);
    const pgWrite2 = await pgStores.archive.archive(sessionId, transcript2);

    const memWrite1 = await memoryStores.archive.archive(sessionId, transcript1);
    const memWrite2 = await memoryStores.archive.archive(sessionId, transcript2);

    expect(pgWrite1.continuity).toBe<ArchiveContinuity>('first');
    expect(memWrite1.continuity).toBe<ArchiveContinuity>('first');

    // ⭐ 本体: 同じ2本の生の入力を与えたのに、pg と インメモリで
    // continuity が食い違う。
    expect(pgWrite2.continuity).toBe(memWrite2.continuity);
    expect(pgWrite2.continuity).toBe<ArchiveContinuity>('diverged');
  });
});
