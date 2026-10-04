import { captureStderr } from '@alteroid/core';
import type { Practice, PracticeVersion } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { practices, practiceVersions } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #2011（#1975 の pg 側。fs の practices を直した issue #1967 の続き）。
 * `PgPracticeStore` は `practices` / `practiceVersions` の列をそのまま詰め替えて
 * 返し、`practiceMetaSchema` / `practiceSchema` / `practiceVersionMetaSchema` /
 * `practiceVersionSchema` のどれも通していなかった。そのため **型に合わない行
 * （版ずれ・手編集で `kind` 欄が `practiceKindSchema`（=
 * `z.string().min(1).max(128)`）の下限を割った行など）が、検査されずにそのまま
 * 読み手へ渡る**。
 *
 * ⚠️ **Issue #2011 の「歯の案」は `kind = 'bogus'` を例に挙げているが、それは
 * 実際には赤にならない。** `practiceKindSchema`（`packages/core/src/schema.ts`）は
 * 意図して `z.enum` にしていない自由文字列（#1055 段3の決定。「仕事の型を
 * 実装専用に狭めない」——`docs/north_star.md`）なので、`'bogus'` のような
 * 「決められた一覧に無い」値はそもそも `practiceKindSchema` を**通る**。ここでは
 * 代わりに、`kind` を空文字列にする（`practiceKindSchema.min(1)` に違反する、実際に
 * 検査へ落ちる形）——`practices` テーブルの `kind` 列は `NOT NULL` だが空文字列
 * `''` は DB 上は許される（アプリの `write()` は `practiceSchema.parse` を通す
 * ので空文字列を書けないが、直接 `INSERT` すれば書ける。版ずれ・手編集を模す）。
 *
 * `get(kind)` 相当の `read()` / `readVersion()` はこれまでどおり投げる
 * （`PracticeStore.read` の doc「無ければ null。読めないは throw」）。`list()` /
 * `listVersions()` は行ごとに検査し、合わない行は跡（slug とどの欄が不正かだけ。
 * title / content は出さない）を stderr に残して飛ばす——fs 版
 * （`packages/storage-fs/src/practices-malformed-row-repro.test.ts`、issue #1967）
 * と同じ形。DB の行そのものは触らない（`UPDATE` / `DELETE` をしない）。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

describe('PgPracticeStore — practices の不正な1行を読み飛ばす（issue #2011）', () => {
  const GOOD_PRACTICE = {
    slug: 'good-practice',
    kind: '実装',
    title: '正常なやり方（この文字列がそのまま跡に出てはいけない）',
    content: '正常な本文\n',
  };

  const BAD_SLUG = 'bad-practice';
  // kind が空文字列——`practiceKindSchema.min(1)` に違反する、実際に赤になる形
  // （直上の doc コメント参照。issue #2011 の例示 `kind = 'bogus'` は自由文字列
  // なので赤にならない）。
  const BAD_TITLE = '壊れたやり方（この文字列も跡に出てはいけない）';
  const BAD_CONTENT = '壊れた本文（跡に出てはいけない）\n';

  async function insertBadPracticeRow(): Promise<void> {
    await db.insert(practices).values({
      slug: BAD_SLUG,
      kind: '',
      title: BAD_TITLE,
      content: BAD_CONTENT,
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    });
  }

  async function insertBadVersionRow(): Promise<void> {
    await db.insert(practiceVersions).values({
      slug: BAD_SLUG,
      version: 1,
      kind: '',
      title: BAD_TITLE,
      content: BAD_CONTENT,
      at: new Date('2026-09-02T00:00:00.000Z'),
    });
  }

  it('list() は、不正な行があっても落ちず、正しいやり方だけを返す（直す前は不正な行もそのまま返っていて赤）', async () => {
    await stores.practices.write(GOOD_PRACTICE);
    await insertBadPracticeRow();

    let found: Awaited<ReturnType<typeof stores.practices.list>> = { entries: [], unreadable: [] };
    await captureStderr(async () => {
      found = await stores.practices.list();
    });

    // 戻り型が `{ entries, unreadable }` になった（issue #2346）ので `entries` から読む。
    // 保証（飛ばして正しい行だけを返す）は `entries` に対して今もそのまま成り立つ。
    expect(found.entries.map((entry) => entry.slug)).toEqual(['good-practice']);
  });

  it('list() の unreadable に slug と不正な欄名だけが返る。題・本文は載らない（issue #2346）', async () => {
    await stores.practices.write(GOOD_PRACTICE);
    await insertBadPracticeRow();

    let found: Awaited<ReturnType<typeof stores.practices.list>> = { entries: [], unreadable: [] };
    await captureStderr(async () => {
      found = await stores.practices.list();
    });

    expect(found.unreadable).toEqual([{ slug: BAD_SLUG, reason: '不正な欄: kind' }]);
    const serialized = JSON.stringify(found.unreadable);
    expect(serialized).not.toContain(BAD_TITLE);
    expect(serialized).not.toContain(BAD_CONTENT);
  });

  it('対照: 不正な行が無ければ unreadable は空。0件なら entries も空（issue #2346）', async () => {
    expect(await stores.practices.list()).toEqual({ entries: [], unreadable: [] });
    await stores.practices.write(GOOD_PRACTICE);
    const found = await stores.practices.list();
    expect(found.entries.map((entry) => entry.slug)).toEqual(['good-practice']);
    expect(found.unreadable).toEqual([]);
  });

  it('跡: list() で飛ばした行を stderr へ1行出す。title / content の値は絶対に含めない', async () => {
    await stores.practices.write(GOOD_PRACTICE);
    await insertBadPracticeRow();

    const lines = await captureStderr(async () => {
      await stores.practices.list();
    });
    const joined = lines.join('');

    expect(joined).toContain(BAD_SLUG);
    expect(joined).toContain('kind');
    expect(joined).not.toContain(BAD_TITLE);
    expect(joined).not.toContain(BAD_CONTENT);
    expect(joined).not.toContain(GOOD_PRACTICE.title);
    expect(joined).not.toContain(GOOD_PRACTICE.content);
  });

  it('read() は、正しい slug は返し、不正な行を slug 指定すると投げる（消されたのとは区別する。直す前は投げずにそのまま返っていて赤）', async () => {
    const written = await stores.practices.write(GOOD_PRACTICE);
    await insertBadPracticeRow();

    const goodRead: Practice | null = await stores.practices.read('good-practice');
    expect(goodRead).toEqual(written);
    await expect(stores.practices.read(BAD_SLUG)).rejects.toThrow();
    // 本当に無い slug（一度も書いていない）は、投げずに null。
    expect(await stores.practices.read('never-existed')).toBeNull();
  });

  it('listVersions() は、不正な版の行があっても落ちず、正しい版だけを返す（直す前は赤）', async () => {
    await stores.practices.write(GOOD_PRACTICE);
    await insertBadVersionRow();

    let found: Awaited<ReturnType<typeof stores.practices.listVersions>> = [];
    await captureStderr(async () => {
      found = await stores.practices.listVersions(BAD_SLUG);
    });

    expect(found).toEqual([]);

    const goodVersions = await stores.practices.listVersions('good-practice');
    expect(goodVersions.map((entry) => entry.version)).toEqual([1]);
  });

  it('跡: listVersions() で飛ばした行を stderr へ1行出す。title / content の値は絶対に含めない', async () => {
    await insertBadVersionRow();

    const lines = await captureStderr(async () => {
      await stores.practices.listVersions(BAD_SLUG);
    });
    const joined = lines.join('');

    expect(joined).toContain(BAD_SLUG);
    expect(joined).toContain('kind');
    expect(joined).not.toContain(BAD_TITLE);
    expect(joined).not.toContain(BAD_CONTENT);
  });

  it('readVersion() は、正しい版は返し、不正な版の行を指定すると投げる（直す前は投げずにそのまま返っていて赤）', async () => {
    const written = await stores.practices.write(GOOD_PRACTICE);
    await insertBadVersionRow();

    const goodVersion: PracticeVersion | null = await stores.practices.readVersion(
      'good-practice',
      1,
    );
    expect(goodVersion?.content).toBe(written.content);
    await expect(stores.practices.readVersion(BAD_SLUG, 1)).rejects.toThrow();
    // 本当に無い版（一度も書いていない）は、投げずに null。
    expect(await stores.practices.readVersion('good-practice', 999)).toBeNull();
  });

  it('行は DELETE されない。同じ slug を write() で書き直せば読める（回復手段）', async () => {
    await insertBadPracticeRow();
    await expect(stores.practices.read(BAD_SLUG)).rejects.toThrow();

    await stores.practices.write({
      slug: BAD_SLUG,
      kind: '調査',
      title: '直したやり方',
      content: '直した本文\n',
    });

    const fixed = await stores.practices.read(BAD_SLUG);
    expect(fixed?.title).toBe('直したやり方');
  });
});
