import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

// #2948: 持ち主の宣言の仕組みを畳んだ。既存の `auth.json` には `ownerDeclaredAt` の鍵が残りうるので、
// 鍵つきの行を読んでも壊れない（読めない行へ落ちない）こと、書き戻しで鍵が落ちて他の欄が壊れないことを確かめる。
describe('FsAuthStore — ownerDeclaredAt の鍵が残った旧い auth.json（#2948）', () => {
  let root: string;
  let authPath: string;

  const legacy = {
    id: 'acct-legacy',
    displayName: 'Alice',
    email: 'alice@example.test',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: '2026-09-04T00:00:00.000Z',
    grantedAt: '2026-09-02T00:00:00.000Z',
    grantedBy: 'operator',
    ownerDeclaredAt: '2026-09-03T00:00:00.000Z',
  };
  const expected = {
    id: legacy.id,
    displayName: legacy.displayName,
    email: legacy.email,
    createdAt: legacy.createdAt,
    lastLoginAt: legacy.lastLoginAt,
    grantedAt: legacy.grantedAt,
    grantedBy: legacy.grantedBy,
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    authPath = join(root, 'auth', 'auth.json');
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify({ accounts: [legacy], identities: [], accessTokens: [], loginRequests: [] })}\n`,
    );
  });

  it('鍵つきの行は読める行として読まれ、宣言の欄は持たない', async () => {
    const stores = createFsStores(root);

    const read = await stores.auth.getAccount(legacy.id);
    expect(read).toEqual(expected);
    expect(read).not.toHaveProperty('ownerDeclaredAt');
    expect(await stores.auth.listAccounts()).toEqual([expected]);
    expect(await stores.auth.listUnreadableAccounts()).toEqual([]);
  });

  it('許可の取り消し・再ログインの書き込みが通り、他の欄は壊れない（書き戻した行から鍵は落ちる）', async () => {
    const stores = createFsStores(root);

    await stores.auth.markAccountLoggedIn(legacy.id, '2026-09-05T00:00:00.000Z');
    await stores.auth.revokeAccountAccess(legacy.id);

    expect(await stores.auth.getAccount(legacy.id)).toEqual({
      ...expected,
      lastLoginAt: '2026-09-05T00:00:00.000Z',
      grantedAt: null,
      grantedBy: null,
    });
    const raw = JSON.parse(await readFile(authPath, 'utf8')) as { accounts: object[] };
    expect(raw.accounts).toHaveLength(1);
    expect(raw.accounts[0]).not.toHaveProperty('ownerDeclaredAt');
  });
});
