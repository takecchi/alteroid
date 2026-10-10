import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  accessTokenRecordSchema,
  authAccountSchema,
  authIdentitySchema,
  loginRequestSchema,
  UnreadableAccountError,
  assertNoNul,
  hasNul,
  prepareAccessTokenForWrite,
  prepareAccountForWrite,
  prepareIdentityForWrite,
  prepareLoginRequestForWrite,
} from '@alteroid/core';
import type {
  AccessTokenRecord,
  AuthAccount,
  AuthIdentity,
  AuthStore,
  CreateAccountWithIdentityOutcome,
  GrantOutcome,
  LoginRequest,
  RemoveUnreadableRowsOptions,
  RemoveUnreadableRowsResult,
  RevokeAccessTokenOutcome,
  UnreadableAccount,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 行の中身はここで検査しない: 行のスキーマを直接使うと、1行の不正が配列全体を道連れにするため
const fileSchema = z.object({
  accounts: z.array(z.unknown()).default([]),
  identities: z.array(z.unknown()).default([]),
  accessTokens: z.array(z.unknown()).default([]),
  loginRequests: z.array(z.unknown()).default([]),
});

interface AuthFile {
  accounts: AuthAccount[];
  // `invalid*Raw` は消さずに持ち回る: 書き戻しに入れないと、次の書き込みで消えるため
  invalidAccountsRaw: unknown[];
  identities: AuthIdentity[];
  invalidIdentitiesRaw: unknown[];
  accessTokens: AccessTokenRecord[];
  invalidAccessTokensRaw: unknown[];
  loginRequests: LoginRequest[];
  invalidLoginRequestsRaw: unknown[];
}

const EMPTY: AuthFile = {
  accounts: [],
  invalidAccountsRaw: [],
  identities: [],
  invalidIdentitiesRaw: [],
  accessTokens: [],
  invalidAccessTokensRaw: [],
  loginRequests: [],
  invalidLoginRequestsRaw: [],
};

// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function extractIdentityKey(raw: unknown): { provider?: string; subject?: string } {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  return {
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    subject: typeof record.subject === 'string' ? record.subject : undefined,
  };
}

function identityKeyMatches(raw: unknown, provider: string, subject: string): boolean {
  const key = extractIdentityKey(raw);
  return key.provider === provider && key.subject === subject;
}

function describeSkippedAccountRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: accounts の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

function describeSkippedIdentityRow(params: {
  index: number;
  reason: string;
  provider?: string;
  subject?: string;
}): string {
  const keyNote =
    params.provider === undefined && params.subject === undefined
      ? ''
      : ` provider=${JSON.stringify(params.provider ?? null)} subject=${JSON.stringify(
          params.subject ?? null,
        )}`;
  return (
    `alteroid: identities の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${keyNote}`
  );
}

function describeSkippedAccessTokenRow(params: {
  index: number;
  reason: string;
  id?: string;
}): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: accessTokens の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

function describeSkippedLoginRequestRow(params: {
  index: number;
  reason: string;
  id?: string;
}): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: loginRequests の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

// 文字列比較せず実時刻で比べる: オフセット表記の違う行で順が崩れ、pg（`timestamptz` の `asc()`）と食い違うため
// 単独では使わない: `createdAt` が同着の行どうしの相対順を決めないため
function compareCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

// `localeCompare` を使わない: 大文字小文字や `-` と `_` の前後が C の順と逆になり、pg の `COLLATE "C"` と食い違うため
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 2次キーに `id` を使う: `putAccount` は既存行を消して末尾へ足すので、`createdAt` 同着の片方だけ更新すると「最後に触られた順」になるため
function compareAccountOrder(a: AuthAccount, b: AuthAccount): number {
  return compareCreatedAt(a, b) || compareCodeUnits(a.id, b.id);
}

function compareIdentityOrder(a: AuthIdentity, b: AuthIdentity): number {
  return (
    compareCreatedAt(a, b) ||
    compareCodeUnits(a.provider, b.provider) ||
    compareCodeUnits(a.subject, b.subject)
  );
}

function compareAccessTokenOrder(a: AccessTokenRecord, b: AccessTokenRecord): number {
  return compareCreatedAt(a, b) || compareCodeUnits(a.id, b.id);
}

const LOGIN_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

// 記憶（`memory/`）とは別のディレクトリに置く: 書き換えると鍵になる値（トークンの sha256）を含み、人間が編集する前提の場所に混ぜないため
export class FsAuthStore implements AuthStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'auth.json');
  }

  async listAccounts(): Promise<AuthAccount[]> {
    const { accounts } = await this.#read();
    return [...accounts].sort(compareAccountOrder);
  }

  async listUnreadableAccounts(): Promise<UnreadableAccount[]> {
    const { invalidAccountsRaw } = await this.#read();
    return invalidAccountsRaw.map((raw): UnreadableAccount => {
      const id = extractRowId(raw);
      const result = authAccountSchema.safeParse(raw);
      return {
        ...(id === undefined ? {} : { id }),
        reason: result.success ? '不正な行' : summarizeInvalidFields(result.error.issues),
      };
    });
  }

  async getAccount(id: string): Promise<AuthAccount | null> {
    const { accounts } = await this.#read();
    return accounts.find((account) => account.id === id) ?? null;
  }

  async findAccountByEmail(email: string): Promise<AuthAccount | null> {
    if (hasNul(email)) return null;
    const { accounts } = await this.#read();
    // 大小文字を区別しない: memory / pg の実装と同じ規約のため
    const needle = email.toLowerCase();
    return (
      accounts.find(
        (account) => account.email !== null && account.email.toLowerCase() === needle,
      ) ?? null
    );
  }

  async putAccount(account: AuthAccount): Promise<void> {
    const parsed = prepareAccountForWrite(authAccountSchema.parse(account));
    await this.#update((file) => {
      // 書き込む id と一致する壊れた行は置き換える: 残すと同じ id が2行並び、`listAccounts()` のたびに直したはずの跡が出続けるため
      const invalidAccountsRaw = file.invalidAccountsRaw.filter(
        (raw) => extractRowId(raw) !== parsed.id,
      );
      return {
        ...file,
        accounts: [...file.accounts.filter((it) => it.id !== parsed.id), parsed],
        invalidAccountsRaw,
      };
    });
  }

  async markAccountLoggedIn(accountId: string, at: string): Promise<void> {
    // 排他区間の中で、いまのファイルの行を読んで書く: 呼び手が読んだ写しを使うと、そのあいだに完了した操作を書き戻してしまうため
    await this.#mutate<null>((file): { next: AuthFile | null; result: null } => {
      const account = file.accounts.find((it) => it.id === accountId);
      if (account === undefined) return { next: null, result: null };
      const updated = authAccountSchema.parse({ ...account, lastLoginAt: at });
      return {
        next: {
          ...file,
          accounts: file.accounts.map((it) => (it.id === accountId ? updated : it)),
        },
        result: null,
      };
    });
  }

  async revokeAccountAccess(accountId: string): Promise<void> {
    // NUL を含む id の行は存在しない: 書き込みで断るため。手で直した読めない行にも一致させない
    if (hasNul(accountId)) return;
    await this.#mutate<null>((file): { next: AuthFile | null; result: null } => {
      const account = file.accounts.find((it) => it.id === accountId);
      if (account === undefined) {
        if (file.invalidAccountsRaw.some((raw) => extractRowId(raw) === accountId)) {
          throw new UnreadableAccountError({ id: accountId });
        }
        return { next: null, result: null };
      }
      const updated = authAccountSchema.parse({
        ...account,
        grantedAt: null,
        grantedBy: null,
      });
      return {
        next: {
          ...file,
          accounts: file.accounts.map((it) => (it.id === accountId ? updated : it)),
        },
        result: null,
      };
    });
  }

  // `#mutate` を使わず直に書く: `#mutate` は同期の `mutate` しか受けず、`beforeRemove` を排他区間の中で await できないため
  async removeUnreadableAccounts(
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions = {},
  ): Promise<RemoveUnreadableRowsResult> {
    const wanted = [...new Set(ids)];
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const present = new Set(
        file.invalidAccountsRaw.flatMap((raw) => {
          const id = extractRowId(raw);
          return id === undefined || hasNul(id) ? [] : [id];
        }),
      );
      const unknown = wanted.filter((id) => !present.has(id));
      if (unknown.length > 0 || wanted.length === 0) {
        return { kind: 'unknown', count: unknown.length };
      }
      // 日誌などを先に呼ぶ: 投げたらここで止まり、何も書かないため
      await options.beforeRemove?.(wanted);
      const drop = new Set(wanted);
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(
          this.#serialize({
            ...file,
            invalidAccountsRaw: file.invalidAccountsRaw.filter((raw) => {
              const id = extractRowId(raw);
              return id === undefined || !drop.has(id);
            }),
          }),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return { kind: 'removed', ids: wanted };
    });
  }

  async findIdentity(provider: string, subject: string): Promise<AuthIdentity | null> {
    const { identities } = await this.#read();
    return identities.find((it) => it.provider === provider && it.subject === subject) ?? null;
  }

  async listIdentities(accountId: string): Promise<AuthIdentity[]> {
    const { identities } = await this.#read();
    // 明示的に並べる: `putIdentity` は既存行を消して末尾へ足すので、ソートを外すと「最後に触られた順」になるため
    return identities
      .filter((identity) => identity.accountId === accountId)
      .sort(compareIdentityOrder);
  }

  async putIdentity(identity: AuthIdentity): Promise<void> {
    const parsed = prepareIdentityForWrite(authIdentitySchema.parse(identity));
    await this.#update((file) => {
      // 書き込む鍵（provider, subject）と一致する壊れた行は置き換える: `identities` は `id` を持たないので鍵の一致で判定する
      const invalidIdentitiesRaw = file.invalidIdentitiesRaw.filter(
        (raw) => !identityKeyMatches(raw, parsed.provider, parsed.subject),
      );
      return {
        ...file,
        identities: [
          ...file.identities.filter(
            (it) => !(it.provider === parsed.provider && it.subject === parsed.subject),
          ),
          parsed,
        ],
        invalidIdentitiesRaw,
      };
    });
  }

  async createAccountWithIdentity(input: {
    account: AuthAccount;
    identity: AuthIdentity;
  }): Promise<CreateAccountWithIdentityOutcome> {
    return this.#mutate<CreateAccountWithIdentityOutcome>(
      (file): { next: AuthFile | null; result: CreateAccountWithIdentityOutcome } => {
        const existing = file.identities.find(
          (it) => it.provider === input.identity.provider && it.subject === input.identity.subject,
        );
        if (existing !== undefined) {
          return { next: null, result: { created: false, existing } };
        }
        // 大小文字を区別しない: memory / pg の実装と同じ規約のため
        const needle = input.account.email?.toLowerCase() ?? null;
        const emailCollides =
          needle !== null &&
          file.accounts.some((it) => it.email !== null && it.email.toLowerCase() === needle);
        const accountInput = emailCollides ? { ...input.account, email: null } : input.account;
        const account = prepareAccountForWrite(authAccountSchema.parse(accountInput));
        const identity = prepareIdentityForWrite(authIdentitySchema.parse(input.identity));
        // 壊れた行と初見は見分けられないので、どちらも新しい account を作る: 新しい account は常に未許可なので、権限が増える方向へは倒れないため
        // 書き込む鍵と一致する壊れた identity 行は置き換える: 同じ鍵の行が2行残り続けるのを避けるため
        const invalidIdentitiesRaw = file.invalidIdentitiesRaw.filter(
          (raw) => !identityKeyMatches(raw, identity.provider, identity.subject),
        );
        return {
          next: {
            ...file,
            accounts: [...file.accounts.filter((it) => it.id !== account.id), account],
            identities: [...file.identities, identity],
            invalidIdentitiesRaw,
          },
          result: { created: true, account },
        };
      },
    );
  }

  async putAccessToken(token: AccessTokenRecord): Promise<void> {
    const parsed = prepareAccessTokenForWrite(accessTokenRecordSchema.parse(token));
    await this.#update((file) => {
      // 書き込む id と一致する壊れた行は置き換える: 残すと同じ id が2行並ぶため
      const invalidAccessTokensRaw = file.invalidAccessTokensRaw.filter(
        (raw) => extractRowId(raw) !== parsed.id,
      );
      return {
        ...file,
        accessTokens: [...file.accessTokens.filter((it) => it.id !== parsed.id), parsed],
        invalidAccessTokensRaw,
      };
    });
  }

  async markAccessTokenUsed(id: string, at: string): Promise<void> {
    // 排他区間の中で、いまのファイルの行を読んで書く: 呼び手が読んだ写しを使うと、そのあいだに完了したログアウトの `revokedAt` を書き戻してしまうため
    await this.#mutate<null>((file): { next: AuthFile | null; result: null } => {
      const token = file.accessTokens.find((it) => it.id === id);
      if (token === undefined || token.revokedAt !== null) return { next: null, result: null };
      const used = accessTokenRecordSchema.parse({ ...token, lastUsedAt: at });
      return {
        next: {
          ...file,
          accessTokens: file.accessTokens.map((it) => (it.id === id ? used : it)),
        },
        result: null,
      };
    });
  }

  async findAccessTokenBySha256(hash: string): Promise<AccessTokenRecord | null> {
    const { accessTokens } = await this.#read();
    return accessTokens.find((token) => token.sha256 === hash) ?? null;
  }

  async listAccessTokens(accountId: string): Promise<AccessTokenRecord[]> {
    const { accessTokens } = await this.#read();
    // 明示的に並べる: `putAccessToken` は既存行を消して末尾へ足すので、`lastUsedAt` の書き戻しだけで作成順が崩れるため
    return accessTokens
      .filter((token) => token.accountId === accountId)
      .sort(compareAccessTokenOrder);
  }

  async revokeAccessToken(id: string, at: string): Promise<RevokeAccessTokenOutcome> {
    // `revokedAt` が空のときだけ立てる: 同じトークンへ同時にログアウトが来ても、先に書いた側の時刻が残るため
    return this.#mutate<RevokeAccessTokenOutcome>(
      (file): { next: AuthFile | null; result: RevokeAccessTokenOutcome } => {
        const token = file.accessTokens.find((it) => it.id === id);
        if (token === undefined) return { next: null, result: { status: 'not_found' as const } };
        if (token.revokedAt !== null) {
          return { next: null, result: { status: 'already_revoked' as const, token } };
        }
        const revoked = accessTokenRecordSchema.parse({ ...token, revokedAt: at });
        return {
          next: {
            ...file,
            accessTokens: file.accessTokens.map((it) => (it.id === id ? revoked : it)),
          },
          result: { status: 'revoked' as const, token: revoked },
        };
      },
    );
  }

  async putLoginRequest(request: LoginRequest): Promise<void> {
    const parsed = prepareLoginRequestForWrite(loginRequestSchema.parse(request));
    const horizon = Date.now() - LOGIN_REQUEST_RETENTION_MS;
    await this.#update((file) => {
      // 書き込む id と一致する壊れた行は置き換える: 残すと同じ id が2行並ぶため
      // 期限切れの掃除（`horizon`）は壊れた行まで追わない: 壊れた行は `expiresAt` すら安全に読めるとは限らないため
      const invalidLoginRequestsRaw = file.invalidLoginRequestsRaw.filter(
        (raw) => extractRowId(raw) !== parsed.id,
      );
      return {
        ...file,
        loginRequests: [
          ...file.loginRequests.filter(
            (it) => it.id !== parsed.id && Date.parse(it.expiresAt) > horizon,
          ),
          parsed,
        ],
        invalidLoginRequestsRaw,
      };
    });
  }

  async getLoginRequest(id: string): Promise<LoginRequest | null> {
    const { loginRequests } = await this.#read();
    return loginRequests.find((request) => request.id === id) ?? null;
  }

  async beginLoginExchange(id: string): Promise<LoginRequest | null> {
    // 排他区間の中で `pending` → `processing` にする: 読んでから書く形だと、同じ callback の並行到着で両方が交換し、失敗した側が成功した側の結果を上書きしうるため
    return this.#mutate<LoginRequest | null>(
      (file): { next: AuthFile | null; result: LoginRequest | null } => {
        const found = file.loginRequests.find((request) => request.id === id);
        if (found === undefined || found.status !== 'pending') {
          return { next: null, result: null };
        }
        const processing: LoginRequest = { ...found, status: 'processing' };
        return {
          next: {
            ...file,
            loginRequests: file.loginRequests.map((request) =>
              request.id === id ? processing : request,
            ),
          },
          result: processing,
        };
      },
    );
  }

  // `consumed` とトークンの保存を1回の書き込みにする: 分けると二重発行になるか、保存失敗でログインを回収できなくなるため
  async claimLoginRequest(
    id: string,
    issue: (request: LoginRequest) => AccessTokenRecord,
  ): Promise<{ request: LoginRequest; token: AccessTokenRecord } | null> {
    type Claimed = { request: LoginRequest; token: AccessTokenRecord } | null;
    return this.#mutate<Claimed>((file): { next: AuthFile | null; result: Claimed } => {
      const found = file.loginRequests.find((request) => request.id === id);
      if (found === undefined || found.status !== 'authenticated') {
        return { next: null, result: null };
      }
      const consumed: LoginRequest = { ...found, status: 'consumed' };
      const token = prepareAccessTokenForWrite(accessTokenRecordSchema.parse(issue(consumed)));
      return {
        next: {
          ...file,
          loginRequests: file.loginRequests.map((request) =>
            request.id === id ? consumed : request,
          ),
          accessTokens: [...file.accessTokens.filter((it) => it.id !== token.id), token],
        },
        result: { request: consumed, token },
      };
    });
  }

  async grantAccess(accountId: string, at: string, by: string): Promise<GrantOutcome> {
    // 排他区間は残す: 同じ account へ同時に grant が来たとき、先に書いた側を勝たせて `grantedBy` の上書きを防ぐため
    if (hasNul(accountId)) return { status: 'not_found' };
    assertNoNul('authAccount.grantedBy', by);
    return this.#mutate<GrantOutcome>((file): { next: AuthFile | null; result: GrantOutcome } => {
      const account = file.accounts.find((it) => it.id === accountId);
      if (account === undefined) return { next: null, result: { status: 'not_found' as const } };
      if (account.grantedAt !== null) {
        return { next: null, result: { status: 'granted' as const, account } };
      }
      const granted = authAccountSchema.parse({ ...account, grantedAt: at, grantedBy: by });
      return {
        next: {
          ...file,
          accounts: file.accounts.map((it) => (it.id === accountId ? granted : it)),
        },
        result: { status: 'granted' as const, account: granted },
      };
    });
  }

  async #read(): Promise<AuthFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));

      const accounts: AuthAccount[] = [];
      const invalidAccountsRaw: unknown[] = [];
      top.accounts.forEach((rawAccount, index) => {
        const result = authAccountSchema.safeParse(rawAccount);
        if (result.success) {
          accounts.push(result.data);
          return;
        }
        invalidAccountsRaw.push(rawAccount);
        process.stderr.write(
          `${describeSkippedAccountRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawAccount),
          })}\n`,
        );
      });

      const identities: AuthIdentity[] = [];
      const invalidIdentitiesRaw: unknown[] = [];
      top.identities.forEach((rawIdentity, index) => {
        const result = authIdentitySchema.safeParse(rawIdentity);
        if (result.success) {
          identities.push(result.data);
          return;
        }
        invalidIdentitiesRaw.push(rawIdentity);
        const key = extractIdentityKey(rawIdentity);
        process.stderr.write(
          `${describeSkippedIdentityRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            provider: key.provider,
            subject: key.subject,
          })}\n`,
        );
      });

      const accessTokens: AccessTokenRecord[] = [];
      const invalidAccessTokensRaw: unknown[] = [];
      top.accessTokens.forEach((rawToken, index) => {
        const result = accessTokenRecordSchema.safeParse(rawToken);
        if (result.success) {
          accessTokens.push(result.data);
          return;
        }
        invalidAccessTokensRaw.push(rawToken);
        process.stderr.write(
          `${describeSkippedAccessTokenRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawToken),
          })}\n`,
        );
      });

      const loginRequests: LoginRequest[] = [];
      const invalidLoginRequestsRaw: unknown[] = [];
      top.loginRequests.forEach((rawRequest, index) => {
        const result = loginRequestSchema.safeParse(rawRequest);
        if (result.success) {
          loginRequests.push(result.data);
          return;
        }
        invalidLoginRequestsRaw.push(rawRequest);
        process.stderr.write(
          `${describeSkippedLoginRequestRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawRequest),
          })}\n`,
        );
      });

      return {
        accounts,
        invalidAccountsRaw,
        identities,
        invalidIdentitiesRaw,
        accessTokens,
        invalidAccessTokensRaw,
        loginRequests,
        invalidLoginRequestsRaw,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  // 1本ずつの配列へ合流させる: 分けたまま書くと、次の `#read()` で未知のキーとして黙って捨てられるため
  #serialize(file: AuthFile): {
    accounts: unknown[];
    identities: unknown[];
    accessTokens: unknown[];
    loginRequests: unknown[];
  } {
    return {
      accounts: [...file.accounts, ...file.invalidAccountsRaw],
      identities: [...file.identities, ...file.invalidIdentitiesRaw],
      accessTokens: [...file.accessTokens, ...file.invalidAccessTokensRaw],
      loginRequests: [...file.loginRequests, ...file.invalidLoginRequestsRaw],
    };
  }

  async #update(mutate: (file: AuthFile) => AuthFile): Promise<void> {
    await this.#mutate((file) => ({ next: mutate(file), result: undefined }));
  }

  async #mutate<T>(mutate: (file: AuthFile) => { next: AuthFile | null; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      if (next === null) return result;
      await mkdir(this.#dir, { recursive: true });
      // rename 後に絞らず、一時ファイルを 0600 で作る: 隙間で他人が読めるため
      await writeFileAtomic(this.#path, `${JSON.stringify(this.#serialize(next), null, 2)}\n`, {
        mode: 0o600,
      });
      return result;
    });
  }
}
