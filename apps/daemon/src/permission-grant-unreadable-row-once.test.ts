import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, type PermissionGrant, type PermissionGrantStore } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { PGlite } from '@electric-sql/pglite';
import { createPgStoresFromDb, migrate, tables } from '@alteroid/storage-pg';
import type { Db } from '@alteroid/storage-pg';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

/**
 * fs（`FsPermissionGrantStore#read()`）・pg（`PgPermissionGrantStore.list()` /
 * `.get()`）のどちらも、壊れた行（`permissionGrantSchema` に合わない。版ずれ・
 * 手編集を模す）を見つけるたびに stderr へ跡を残していた（fs は issue #1941、
 * pg の `revoke()` / `markUsed()` は issue #2158）。だが `clone.ts` の
 * `#onPreToolUse` は Bash を呼ぶたびに `list()` を引き直すため、直っていない
 * 壊れた行が1つあるだけで**同じ警告が積み上がり続ける**（fs は毎呼び出し、
 * pg は `list()` / `get()` がそもそも跡を1つも残していなかった）。
 *
 * issue #2191: 両方を「壊れた行は、ストアのインスタンスごとに1行につき1回
 * だけ stderr に知らせる」に揃える。鍵は行の id（`packages/core/src/
 * unreadable-row-once.ts` の `unreadableRowKey` / `createUnreadableRowOnce`。
 * 置き場所の理由はそのファイルの doc）。
 *
 * **`revoke()` / `markUsed()` の「名指しで触った」知らせ（pg のみ。fs には
 * 元から専用の跡が無い——`revoke()` / `markUsed()` は検査を通った `grants`
 * からしか探さないため、壊れた行の id を指定しても `#read()` の一般的な
 * 跡以外は出ない）は、いままでどおり毎回出る——`list()` / `get()` の
 * 「1回だけ」とは独立している。
 *
 * `apps/daemon/src/permission-grant-unreadable-row.test.ts`（issue #2158。
 * `revoke()` / `markUsed()` 横断）と同じ置き場・同じ理由——`apps/daemon` だけが
 * `@alteroid/core` / `@alteroid/storage-fs` / `@alteroid/storage-pg` の
 * 3つすべてに依存できるため、fs / pg を横並びにした歯はここへ置く。
 *
 * **インメモリ実装（`createMemoryStores`）は対象外**（既存ファイルの doc と
 * 同じ理由——`Map` はモジュール private で外から直接書き込む口が無く、壊れた
 * 行をそもそも作れない）。
 */
describe('PermissionGrantStore — 壊れた行は1回だけ知らせる（fs / pg。issue #2191）', () => {
  const ID = 'grant-once';

  function validGrant(grantedAt: string): PermissionGrant {
    return {
      id: ID,
      rule: 'Bash(gh release edit:*)',
      allows: ['gh release edit'],
      denies: ['gh release edit; rm -rf /'],
      approvalId: 'ap-once',
      answer: '許可します',
      grantedAt,
      route: { principalKind: 'account', accountId: 'acc-1' },
    };
  }

  // `route`（必須欄）が欠けている——版ずれ・手編集を模す（既存の
  // `permission-grants-malformed-row-repro.test.ts` / `permission-grant-
  // unreadable-row.test.ts` と同じ壊し方で揃える）。`allows` / `denies` には
  // 人間の依頼文が入りうる本文を仕込み、跡に出ないことも確かめる。
  const BROKEN_RAW = {
    id: ID,
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文（この文字列は跡に出てはいけない）'],
    denies: ['壊れた許可の本文2（この文字列も跡に出てはいけない）'],
    approvalId: 'ap-once',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
    // route が無い。
  };

  interface Harness {
    stores: { permissionGrants: PermissionGrantStore };
    /** `ID` の行を、ストアを経由せず直接「壊れた形」で置く（既存があれば置換）。 */
    setBrokenRow(): Promise<void>;
    /** `ID` の行を、ストアを経由せず直接「読める形」で置く（既存があれば置換）。 */
    setGoodRow(): Promise<void>;
  }

  async function setupFs(): Promise<Harness> {
    const root = await makeTempDir('alteroid-test-');
    const grantsPath = join(root, 'jobs', 'permission-grants.json');
    const stores = createFsStores(root);

    async function readFile_(): Promise<{ grants: unknown[] }> {
      try {
        return JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
      } catch {
        return { grants: [] };
      }
    }

    async function setRow(raw: unknown): Promise<void> {
      const file = await readFile_();
      const withoutId = file.grants.filter(
        (row) => typeof row !== 'object' || row === null || (row as { id?: unknown }).id !== ID,
      );
      withoutId.push(raw);
      await mkdir(join(root, 'jobs'), { recursive: true });
      await writeFile(grantsPath, `${JSON.stringify({ grants: withoutId }, null, 2)}\n`);
    }

    return {
      stores,
      setBrokenRow: () => setRow(BROKEN_RAW),
      setGoodRow: () => setRow(validGrant('2026-01-01T00:00:00.000Z')),
    };
  }

  async function setupPg(): Promise<Harness & { close(): Promise<void> }> {
    const client = new PGlite();
    const db: Db = drizzle(client);
    await migrate(db);
    const stores = createPgStoresFromDb(db);

    async function upsert(record: Record<string, unknown>, grantedAt: string): Promise<void> {
      const set = { grantedAt: new Date(grantedAt), revokedAt: null, record };
      await db
        .insert(tables.permissionGrants)
        .values({ id: ID, ...set })
        .onConflictDoUpdate({ target: tables.permissionGrants.id, set });
    }

    return {
      stores,
      setBrokenRow: () => upsert(BROKEN_RAW, BROKEN_RAW.grantedAt),
      setGoodRow: () => {
        const grant = validGrant('2026-01-01T00:00:00.000Z');
        return upsert(grant as unknown as Record<string, unknown>, grant.grantedAt);
      },
      async close() {
        await client.close();
      },
    };
  }

  const implementations: Array<[string, () => Promise<Harness & { close?(): Promise<void> }>]> = [
    ['fs 実装', setupFs],
    ['pg 実装（PGlite）', setupPg],
  ];

  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it.each(implementations)(
    'list() を3回呼んでも、知らせは1回だけ出る。本文（allows/denies）は載らない — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.setBrokenRow();

      const lines = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
        await harness.stores.permissionGrants.list();
        await harness.stores.permissionGrants.list();
      });

      expect(lines).toHaveLength(1);
      const joined = lines.join('');
      expect(joined).toContain(ID);
      expect(joined).not.toContain(BROKEN_RAW.allows[0]);
      expect(joined).not.toContain(BROKEN_RAW.denies[0]);
    },
    // **既定の5000msでは足りないことがある**（issue #2191 実装中の実測。
    // `PGlite`（WASM の postgres）は `new PGlite()` の起動＋`migrate()` だけで
    // 数秒かかり、器が混むとさらに伸びる——器を共有する他のマネージャー・
    // 作業者の負荷で、pg 実装だけが時々 timeout する形を複数回実測した）。
    20000,
  );

  it.each(implementations)(
    'get() を3回呼んでも、知らせは1回だけ出る — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.setBrokenRow();

      const lines = await captureStderr(async () => {
        await harness.stores.permissionGrants.get(ID);
        await harness.stores.permissionGrants.get(ID);
        await harness.stores.permissionGrants.get(ID);
      });

      expect(lines).toHaveLength(1);
      const joined = lines.join('');
      expect(joined).not.toContain(BROKEN_RAW.allows[0]);
      expect(joined).not.toContain(BROKEN_RAW.denies[0]);
    },
    20000, // 上と同じ理由（PGlite の起動コスト・器の混雑）。
  );

  it.each(implementations)(
    '直してから（読める形へ置き換えてから）また壊すと、もう一度知らせる — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;

      await harness.setBrokenRow();
      const first = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
      });
      expect(first).toHaveLength(1);

      await harness.setGoodRow();
      const afterFix = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
      });
      expect(afterFix).toHaveLength(0);

      await harness.setBrokenRow();
      const afterReBreak = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
      });
      expect(afterReBreak).toHaveLength(1);
    },
    20000, // 上と同じ理由（PGlite の起動コスト・器の混雑）。この歯は3回
    // setBrokenRow/setGoodRow + list() を挟むので、特に時間がかかる。
  );

  it.each(implementations)(
    '対照: 壊れた行が無ければ、list() を繰り返しても知らせは0件のまま — %s',
    async (_label, setup) => {
      const harness = await setup();
      if (harness.close !== undefined) cleanup = harness.close;
      await harness.setGoodRow();

      const lines = await captureStderr(async () => {
        await harness.stores.permissionGrants.list();
        await harness.stores.permissionGrants.list();
      });
      expect(lines).toHaveLength(0);
    },
    20000, // 上と同じ理由（PGlite の起動コスト・器の混雑）。
  );

  /**
   * pg だけの要件（issue #2191）。`revoke()` / `markUsed()` は「名指しで
   * 触った」ことそのものの跡なので、`list()` / `get()` の1回だけの間引きとは
   * 独立に、呼ぶたびに毎回出る——直前の `list()` が既に同じ行を知らせていても
   * 黙らない。
   *
   * **fs は対象外。** fs の `revoke()` / `markUsed()` は検査を通った `grants`
   * （壊れた行はそもそも入らない）からしか探さないため、壊れた行の id を
   * 指定しても「無い」と同じ扱いになるだけで、専用の跡を持たない
   * （`permission-grant-unreadable-row.test.ts` で既に固定済み）。
   */
  it('pg: revoke() / markUsed() は、名指しした場合は繰り返しても毎回知らせる', async () => {
    const harness = await setupPg();
    cleanup = harness.close;
    await harness.setBrokenRow();

    // 直前に list() で同じ行を1回知らせておく——それでも revoke/markUsed は
    // 黙らないことを確かめる。
    await captureStderr(async () => {
      await harness.stores.permissionGrants.list();
    });

    const lines = await captureStderr(async () => {
      await harness.stores.permissionGrants.revoke(ID, '2026-01-05T00:00:00.000Z');
      await harness.stores.permissionGrants.markUsed(ID, '2026-01-05T00:00:00.000Z');
    });

    expect(lines).toHaveLength(2);
    const joined = lines.join('');
    expect(joined).not.toContain(BROKEN_RAW.allows[0]);
    expect(joined).not.toContain(BROKEN_RAW.denies[0]);
  }, 20000); // 上と同じ理由（PGlite の起動コスト・器の混雑）。

  /**
   * 対照: `route` を id を持たない壊れ方にすると（id 自体は取れる形のまま
   * ここでは崩さない——pg は行の主キー `id` 列が常に在るので、id が取れない
   * 形は fs 側でしか作れない）、fs は内容の指紋を鍵にする。指紋を鍵にしても
   * 「1回だけ」が壊れないことを確かめる（fs のみ）。
   */
  it('fs: id が取れない行でも、指紋を鍵に list() の知らせは1回だけになる', async () => {
    // id 自体を欠いた壊れた行を直接書く（pg は行の主キー `id` 列が常に在る
    // ので、id が取れない形は fs 側でしか作れない）。
    const noIdRow = {
      rule: 'Bash(rm -rf /some/path:*)',
      allows: ['本文（跡に出てはいけない）'],
      denies: [],
      approvalId: 'ap-no-id',
      answer: '許可します',
      grantedAt: '2026-01-03T00:00:00.000Z',
      // id も route も無い。
    };

    const root = await makeTempDir('alteroid-test-');
    const grantsPath = join(root, 'jobs', 'permission-grants.json');
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(grantsPath, `${JSON.stringify({ grants: [noIdRow] }, null, 2)}\n`);
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.permissionGrants.list();
      await stores.permissionGrants.list();
    });

    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain('本文（跡に出てはいけない）');
  });
});
