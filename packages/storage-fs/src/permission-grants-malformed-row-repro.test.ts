import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { PermissionGrant } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1941。`FsPermissionGrantStore#read()` は `fileSchema.parse` で
 * `permission-grants.json` の `grants` 配列全体を1回に検査していたため、
 * 1行でも `permissionGrantSchema` に合わないと `list()` / `get()` / `put()` /
 * `revoke()` / `markUsed()` が丸ごと例外を投げ、正しい許可の記録も読めなく
 * なっていた——pg 実装（`PgPermissionGrantStore.list()`）は1行ずつ
 * `safeParse` して不正な行を外していたので、fs だけがこの穴を持っていた。
 *
 * jobs 側（#1868 / PR #1884）・approvals 側（#1928 / PR #1930）・
 * credentials 側（#1740）と同じ「その行だけを飛ばし、残りは返す。書き戻しでは
 * 元の形のまま保つ」に fs の permission-grants 実装もそろえることを確かめる。
 */
describe('FsPermissionGrantStore — permission-grants.json の不正な1行を読み飛ばす（issue #1941）', () => {
  let root: string;
  let grantsPath: string;

  const GOOD_GRANT: PermissionGrant = {
    id: 'grant-good',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-good',
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
  };

  // `route` が欠けている（必須欄）——版ずれ（新しいデーモンが先に書いた欄を
  // 古いデーモンがまだ知らない）・手編集を模す。`allows` / `denies` には
  // 人間の依頼文が入りうる本文を仕込み、跡に出ないことも確かめる。
  const BAD_GRANT_RAW = {
    id: 'grant-bad',
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文（この文字列は跡に出てはいけない）'],
    denies: ['壊れた許可の本文2（この文字列も跡に出てはいけない）'],
    approvalId: 'ap-bad',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
    // route が無い。
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    grantsPath = join(root, 'jobs', 'permission-grants.json');
  });

  /** permission-grants.json を、正常な行1件 + 壊れた行1件で直接作る（手編集・版ずれを模す）。 */
  async function writeRawGrantsFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.permissionGrants.put(GOOD_GRANT);
    const raw = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
    raw.grants.push(BAD_GRANT_RAW);
    await writeFile(grantsPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  function findRowById(rows: unknown[], id: string): unknown {
    return rows.find(
      (row) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id,
    );
  }

  it('list() は不正な行を飛ばし、正しい行だけを返す（直す前は例外で赤）', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    let found: PermissionGrant[] = [];
    await captureStderr(async () => {
      found = await stores.permissionGrants.list();
    });

    expect(found.map((g) => g.id)).toEqual(['grant-good']);
  });

  it('跡: 飛ばした行を stderr へ1行出す。値（allows/denies の本文）は絶対に含めない', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.permissionGrants.list();
    });
    const joined = lines.join('');

    // 位置・id は載ってよい。
    expect(joined).toContain('grant-bad');
    // **本文（allows/denies）は絶対に出ない**（正常行・壊れた行のどちらの値も）。
    expect(joined).not.toContain(GOOD_GRANT.allows[0]);
    expect(joined).not.toContain(BAD_GRANT_RAW.allows[0]);
    expect(joined).not.toContain(BAD_GRANT_RAW.denies[0]);
  });

  it('get() は、不正な行を id 指定しても例外を投げず null を返す。正しい行は返す', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    let good: PermissionGrant | null = null;
    let bad: PermissionGrant | null = null;
    await captureStderr(async () => {
      good = await stores.permissionGrants.get('grant-good');
      bad = await stores.permissionGrants.get('grant-bad');
    });

    expect(good).toEqual(GOOD_GRANT);
    // **fail-closed——壊れた行の許可は「無い」として扱われる**（許可あり、
    // とは絶対に読まない。issue #1941 の「確かめていないこと」の2点目）。
    expect(bad).toBeNull();
  });

  it('put() は投げない。書いた後のファイルに不正な行が元の形のまま残っている', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    const NEW_GRANT: PermissionGrant = {
      id: 'grant-new',
      rule: 'Bash(git push:*)',
      allows: ['git push'],
      denies: [],
      approvalId: 'ap-new',
      answer: '許可します',
      grantedAt: '2026-01-03T00:00:00.000Z',
      route: { principalKind: 'account', accountId: 'acc-1' },
    };

    await captureStderr(async () => {
      await expect(stores.permissionGrants.put(NEW_GRANT)).resolves.toBeUndefined();
    });

    const raw = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
    const badRow = findRowById(raw.grants, 'grant-bad');

    // **元の形のまま**——書き換えられず、消えてもいない（別の id を put しただけ）。
    expect(badRow).toEqual(BAD_GRANT_RAW);

    let found: PermissionGrant[] = [];
    await captureStderr(async () => {
      found = await stores.permissionGrants.list();
    });
    expect(found.map((g) => g.id).sort()).toEqual(['grant-good', 'grant-new']);
  });

  it('put() は、書き込む id と一致する不正な行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    // 壊れた行と同じ id（grant-bad）で、正しい許可を put する——「直した」つもり。
    await captureStderr(() =>
      stores.permissionGrants.put({
        id: 'grant-bad',
        rule: 'Bash(rm -rf /some/path:*)',
        allows: ['直した許可'],
        denies: [],
        approvalId: 'ap-bad',
        answer: '許可します',
        grantedAt: '2026-01-02T00:00:00.000Z',
        route: { principalKind: 'account', accountId: 'acc-1' },
      }),
    );

    const raw = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
    const rowsWithId = raw.grants.filter(
      (row) =>
        typeof row === 'object' && row !== null && (row as { id?: unknown }).id === 'grant-bad',
    );

    // **その id は1行だけ**（新しい値）——古い壊れた行と共存しない。
    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0]).toMatchObject({ id: 'grant-bad', allows: ['直した許可'] });

    // 直したので、次の list() では跡が1行も出ない。
    const lines = await captureStderr(async () => {
      const found = await stores.permissionGrants.list();
      expect(found.map((g) => g.id).sort()).toEqual(['grant-bad', 'grant-good']);
    });
    expect(lines).toHaveLength(0);
  });

  it('revoke() / markUsed() は、無い id と同じく壊れた行の id にも「無い」として振る舞う（fail-closed）', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    let revoked: PermissionGrant | null = null;
    let used: boolean | undefined;
    await captureStderr(async () => {
      revoked = await stores.permissionGrants.revoke('grant-bad', '2026-01-05T00:00:00.000Z');
      used = await stores.permissionGrants.markUsed('grant-bad', '2026-01-05T00:00:00.000Z');
    });

    expect(revoked).toBeNull();
    expect(used).toBe(false);

    // ファイル上の壊れた行はそのまま——revoke/markUsed が触れて壊すことも無い。
    const raw = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
    expect(findRowById(raw.grants, 'grant-bad')).toEqual(BAD_GRANT_RAW);
  });

  it('対照: 壊れた行が無ければ、今まで通り正しく読み書きできる', async () => {
    const stores = createFsStores(root);
    await stores.permissionGrants.put(GOOD_GRANT);

    const lines = await captureStderr(async () => {
      const found = await stores.permissionGrants.list();
      expect(found).toEqual([GOOD_GRANT]);
    });
    expect(lines).toHaveLength(0);
  });

  /**
   * issue #2191。`#read()` は `list()` / `get()` / `put()` / `revoke()` /
   * `markUsed()` のどれを呼んでも通るので、直っていない壊れた行が1つあると
   * `clone.ts` の `#onPreToolUse`（Bash を呼ぶたびに `list()` を引き直す）が
   * 同じ警告を積み上げ続けていた。**同じストアインスタンスの生存中は、同じ
   * 行につき1回だけ知らせる**——鍵は行の id（`unreadableRowKey`）。
   */
  it('list() を3回呼んでも、知らせは1回だけ出る（issue #2191）', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.permissionGrants.list();
      await stores.permissionGrants.list();
      await stores.permissionGrants.list();
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('grant-bad');
  });
});
