import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, UnreadablePermissionGrantError } from '@alteroid/core';
import type { PermissionGrant } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

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

  const BAD_GRANT_RAW = {
    id: 'grant-bad',
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文（この文字列は跡に出てはいけない）'],
    denies: ['壊れた許可の本文2（この文字列も跡に出てはいけない）'],
    approvalId: 'ap-bad',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    grantsPath = join(root, 'jobs', 'permission-grants.json');
  });

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

    expect(joined).toContain('grant-bad');
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

    expect(rowsWithId).toHaveLength(1);
    expect(rowsWithId[0]).toMatchObject({ id: 'grant-bad', allows: ['直した許可'] });

    const lines = await captureStderr(async () => {
      const found = await stores.permissionGrants.list();
      expect(found.map((g) => g.id).sort()).toEqual(['grant-bad', 'grant-good']);
    });
    expect(lines).toHaveLength(0);
  });

  it('markUsed() は壊れた行の id を「無い」として扱い、revoke() は「無い」と言わず投げる（fail-closed。issue #2425）', async () => {
    await writeRawGrantsFile();
    const stores = createFsStores(root);

    let revokeError: unknown;
    let used: boolean | undefined;
    await captureStderr(async () => {
      try {
        await stores.permissionGrants.revoke('grant-bad', '2026-01-05T00:00:00.000Z');
      } catch (error) {
        revokeError = error;
      }
      used = await stores.permissionGrants.markUsed('grant-bad', '2026-01-05T00:00:00.000Z');
    });

    expect(revokeError).toBeInstanceOf(UnreadablePermissionGrantError);
    expect(used).toBe(false);

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
