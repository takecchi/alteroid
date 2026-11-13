import {
  verifyAuthAccountFieldsContract,
  verifyAuthConcurrentWritesContract,
  verifyAuthListOrderContract,
  verifyAuthLoginRequestContract,
  verifyAuthLogoutRaceContract,
  verifyAuthRecordsContract,
  verifyAuthRevokeAccessTokenContract,
  verifyAuthVerifiedEmailContract,
  verifyAuthWriteValidationContract,
} from '@alteroid/core/contracts';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import {
  createPgStoresFromDb,
  describePgConnectionError,
  migrate,
  type PgStores,
} from './index.js';
import { AUTH_ACCOUNTS_EMAIL_LOWER_INDEX } from './migrate.js';
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

describe('AuthStore', () => {
  // 契約はケースごとに空の器を要る（固定の id で始めるため）。立てた接続は afterEach で閉じる。
  const opened: TestDbHandle[] = [];
  const makeAuth = async () => {
    const handle = await createMigratedTestDb();
    opened.push(handle.client);
    return createPgStoresFromDb(handle.db).auth;
  };
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((handle) => handle.close()));
  });

  // 1つの `it` が DB を何本も立てる: 既定の 5 秒では足りないので、契約のケースの数に合わせて延ばす。
  const CONTRACT_TIMEOUT_MS = 60_000;

  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
  };

  it(
    '保存と読み戻しの契約（fs・pg・インメモリで同じ挙動）',
    async () => {
      await verifyAuthRecordsContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '一覧の並びの契約（createdAt の実時刻順・同着の2次キー、issue #1688）。時刻は timestamptz 列で比べるのでオフセット表記が違っても崩れない',
    async () => {
      await verifyAuthListOrderContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    'revokeAccessToken と markAccessTokenUsed の契約',
    async () => {
      await verifyAuthRevokeAccessTokenContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    'markAccountLoggedIn と revokeAccountAccess の契約（issue #1870・#1915）',
    async () => {
      await verifyAuthAccountFieldsContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    'ログイン要求の引き取りと交換への着手の契約',
    async () => {
      await verifyAuthLoginRequestContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '同時の許可と同時のアカウント作成の契約',
    async () => {
      await verifyAuthConcurrentWritesContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '同じ検証済みメール（大小文字だけの違いを含む）の契約（#1702・#1741・#1714）',
    async () => {
      await verifyAuthVerifiedEmailContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    'ログアウトと同時の authenticate が失効を巻き戻さない契約（issue #1782）',
    async () => {
      await verifyAuthLogoutRaceContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '書き込みの形式検査の契約',
    async () => {
      await verifyAuthWriteValidationContract(makeAuth);
    },
    CONTRACT_TIMEOUT_MS,
  );

  // 「migrate を2回通す」だけにしない: 許可済みの行が1つだと、持ち主を1人に縛る一意索引が戻っていても通ってしまうため。2人目を挟む。
  it('許可を2つ積んでから起動し直しても migrate が落ちない（持ち主を1人に縛る索引が無い）', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);
    const at = '2026-01-02T00:00:00.000Z';
    await stores.auth.grantAccess('account-1', at, 'operator');
    await stores.auth.grantAccess('account-2', at, 'operator');

    await expect(migrate(db)).resolves.toBeUndefined();
    await expect(migrate(db)).resolves.toBeUndefined();

    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(2);
  }, 30_000);

  // 重複の有無を assert しない: 事前 select と insert の間の競合 window は塞がっておらず、保証できるのは「投げないこと」だけのため。
  it('#1702 の重複状態（旧索引だけの DB）でも、別々の identity・大小文字違いの候補メールで並行に呼んでも投げない', async () => {
    // `createEmptyTestDb()` ＋ `migrate` を使わない: テスト本体で PGlite をもう1つ起こすと、並列で混んだとき vitest 既定の 5 秒の上限を食い潰すため。
    const localDb = db;
    await localDb.execute(sql.raw(`drop index if exists ${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX}`));
    await localDb.execute(
      sql.raw('create unique index if not exists auth_accounts_email_idx on auth_accounts (email)'),
    );
    const localStores = createPgStoresFromDb(localDb);

    const makeInput = (accountId: string, subject: string, email: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
      },
      identity: {
        provider: 'google',
        subject,
        accountId,
        email,
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    await expect(
      Promise.all([
        localStores.auth.createAccountWithIdentity(
          makeInput('account-old-format-a', 'sub-old-format-a', 'alice@example.test'),
        ),
        localStores.auth.createAccountWithIdentity(
          makeInput('account-old-format-b', 'sub-old-format-b', 'ALICE@EXAMPLE.TEST'),
        ),
      ]),
    ).resolves.toBeDefined();
  });
});

// `createPgStores` を直接呼ばない: 本物の `Pool` に実際の PostgreSQL が要るため、整形部分の `describePgConnectionError` を呼ぶ。
describe('describePgConnectionError', () => {
  it('SQLSTATE 等の構造化フィールドが出る。detail の値は出ない', () => {
    const pgError = new Error('duplicate key value violates unique constraint "journal_pkey"');
    Object.assign(pgError, {
      code: '23505',
      constraint: 'journal_pkey',
      table: 'journal',
      detail: 'Key (id)=(11111111-2222-3333-4444-555555555555) already exists.',
    });

    const line = describePgConnectionError(pgError);

    expect(line).toContain('alteroid: PostgreSQL の接続でエラー:');
    expect(line).toContain('code=23505');
    expect(line).toContain('constraint=journal_pkey');
    expect(line).toContain('table=journal');
    expect(line).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('SQLSTATE を持たない素の Error でも落ちない（メッセージだけ出る）', () => {
    const line = describePgConnectionError(new Error('ECONNRESET'));

    expect(line).toContain('ECONNRESET');
  });
});
