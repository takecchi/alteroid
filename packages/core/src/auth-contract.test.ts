import { describe, it } from 'vitest';

import {
  verifyAuthAccountFieldsContract,
  verifyAuthConcurrentWritesContract,
  verifyAuthListOrderContract,
  verifyAuthLoginRequestContract,
  verifyAuthLogoutRaceContract,
  verifyAuthRecordsContract,
  verifyAuthRevokeAccessTokenContract,
  verifyAuthTieByteOrderContract,
  verifyAuthVerifiedEmailContract,
  verifyAuthWriteValidationContract,
} from './auth-contract.js';
import { createMemoryStores } from './testing.js';

// 契約そのものは `auth-contract.ts`（素の関数。vitest に依存しない）。fs は `packages/storage-fs/src/index.test.ts` ほか、pg は `packages/storage-pg/src/index.auth.test.ts` ほかから同じ関数を当てる。
const makeAuth = () => createMemoryStores().auth;

describe('AuthStore の契約（インメモリ実装）', () => {
  it('保存と読み戻し', async () => {
    await verifyAuthRecordsContract(makeAuth);
  });

  it('一覧の並び（createdAt の実時刻順・同着の2次キー）', async () => {
    await verifyAuthListOrderContract(makeAuth);
  });

  it('同着の2次キーはバイト順（issue #2458）', async () => {
    await verifyAuthTieByteOrderContract(makeAuth);
  });

  it('revokeAccessToken と markAccessTokenUsed', async () => {
    await verifyAuthRevokeAccessTokenContract(makeAuth);
  });

  it('markAccountLoggedIn と revokeAccountAccess', async () => {
    await verifyAuthAccountFieldsContract(makeAuth);
  });

  it('ログイン要求の引き取りと交換への着手', async () => {
    await verifyAuthLoginRequestContract(makeAuth);
  });

  it('同時の許可と同時のアカウント作成', async () => {
    await verifyAuthConcurrentWritesContract(makeAuth);
  });

  it('同じ検証済みメール（大小文字だけの違いを含む）の扱い', async () => {
    await verifyAuthVerifiedEmailContract(makeAuth);
  });

  it('ログアウトと同時の authenticate が失効を巻き戻さない（issue #1782）', async () => {
    await verifyAuthLogoutRaceContract(makeAuth);
  });

  it('書き込みの形式検査', async () => {
    await verifyAuthWriteValidationContract(makeAuth);
  });
});
