import {
  renderMemoryDocuments,
  verifyPersonaCreatedAtContract,
  verifyPersonaDescribedAtContract,
  verifyPersonaDescribedBytesContract,
  verifyPersonaIfMatchContract,
  verifyPersonaNulContract,
  verifyPersonaProtectionStatusContract,
  verifyPersonaWriteContract,
} from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { memory } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('PgPersonaStore', () => {
  it('本文の NUL の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyPersonaNulContract(stores.persona);
  });

  it('書き込みの正規化と追記の契約（fs・pg・インメモリで同じ挙動）', async () => {
    await verifyPersonaWriteContract(stores.persona);
  });

  it('write / remove の前提の版 ifMatch の契約（Issue #2743・#2881。fs・pg・インメモリで同じ挙動）', async () => {
    await verifyPersonaIfMatchContract(stores.persona);
  });

  it('protectionStatus（保護状態の派生値）の契約', async () => {
    await verifyPersonaProtectionStatusContract(stores.persona, {
      rewriteBehindStore: async (slug, content) => {
        await db.execute(sql`update memory set content = ${content} where slug = ${slug}`);
      },
    });
  });

  it('createdAt（作成時刻の派生値）の契約', async () => {
    await verifyPersonaCreatedAtContract(stores.persona, {
      forgetCreatedAt: async (slug) => {
        await db.execute(sql`update memory set created_at = null where slug = ${slug}`);
      },
    });
  });

  it('describedAt（要旨の鮮度の派生値）の契約', async () => {
    await verifyPersonaDescribedAtContract(stores.persona);
  });

  it('describedBytes（本文の変化量の派生値、#913）の契約', async () => {
    await verifyPersonaDescribedBytesContract(stores.persona, {
      forgetDescribedBytes: async (slug, { withAt }) => {
        await db.execute(
          withAt
            ? sql`update memory set described_bytes = null, described_bytes_at = null where slug = ${slug}`
            : sql`update memory set described_bytes = null where slug = ${slug}`,
        );
      },
    });
  });

  it('書いて読める（記憶は Markdown のまま）', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
    expect(doc?.bytes).toBeGreaterThan(0);
  });

  it('外から書き換えられた記憶が次の読み出しに反映される（受け入れ基準3）', async () => {
    const BEFORE_CONTENT = '# 価値観\n\nもとの内容\n';
    await stores.persona.write('values', BEFORE_CONTENT);

    await stores.persona.write('values', '# 価値観\n\n人間が書き換えた\n');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    const cardBefore = renderMemoryDocuments([{ slug: 'values', content: BEFORE_CONTENT }]);
    const cardAfter = renderMemoryDocuments(await stores.persona.documents());
    expect(cardAfter).not.toBe(cardBefore);
    expect(cardAfter).toContain('# 価値観');
    expect(cardAfter).not.toContain('人間が書き換えた');
    expect(cardAfter).not.toContain('もとの内容');
  });

  it('存在しない記憶は null / 経路をまたぐスラッグは拒む', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('documents は全文書を本文つき・slug 昇順で返す（fs 版と同じ形）', async () => {
    await stores.persona.write('b', '# B\n\nい\n');
    await stores.persona.write('a', '# A\n\nあ\n');

    const docs = await stores.persona.documents();

    expect(docs.map((d) => d.slug)).toEqual(['a', 'b']);
    expect(docs.map((d) => d.content)).toEqual(['# A\n\nあ\n', '# B\n\nい\n']);

    const all = renderMemoryDocuments(docs);

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });

  it('消せる', async () => {
    await stores.persona.write('tmp', '# 一時\n');
    await stores.persona.remove('tmp');

    expect(await stores.persona.read('tmp')).toBeNull();
  });

  // 契約は列の値までは見ない（器の裏側を知らないため）: human_touched_at の列そのものが巻き戻らないことは pg 固有の観測。
  it('humanTouchedAt の列は、古い時刻の write で巻き戻らない', async () => {
    await stores.persona.write('values', '# 版1\n', {
      humanTouchedAt: '2026-01-02T00:00:00.000Z',
    });
    await stores.persona.write('values', '# 版2\n', {
      humanTouchedAt: '2020-01-01T00:00:00.000Z',
    });
    await stores.persona.write('values', '# 版3\n');
    const rows = await db
      .select({ at: memory.humanTouchedAt })
      .from(memory)
      .where(eq(memory.slug, 'values'));
    expect(rows[0]?.at?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('markCreatedAt は content_sha256 の列を直接読んでも書き換えない（healRow を経由しない計器）', async () => {
    await stores.persona.write(
      'runbook',
      ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
    );
    await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);

    const beforeRows = await db
      .select({ contentSha256: memory.contentSha256 })
      .from(memory)
      .where(eq(memory.slug, 'runbook'));
    const beforeSha256 = beforeRows[0]?.contentSha256;
    expect(beforeSha256).not.toBeNull();

    const wrote = await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

    // `protectionStatus()` を差し込まない: `#healRow` が列を埋め直し、変異が生存してこの歯が緑のまま何も測らなくなるため。
    const afterRows = await db
      .select({ contentSha256: memory.contentSha256 })
      .from(memory)
      .where(eq(memory.slug, 'runbook'));
    const afterSha256 = afterRows[0]?.contentSha256;

    expect(wrote).toBe(true);
    expect(afterSha256).toBe(beforeSha256);
  });
});
