import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  accessTokenRecordSchema,
  authAccountSchema,
  authIdentitySchema,
  loginRequestSchema,
} from '@alteroid/core';
import type {
  AccessTokenRecord,
  AuthAccount,
  AuthIdentity,
  AuthStore,
  GrantOutcome,
  LoginRequest,
} from '@alteroid/core';
import { z } from 'zod';

const fileSchema = z.object({
  accounts: z.array(authAccountSchema).default([]),
  identities: z.array(authIdentitySchema).default([]),
  accessTokens: z.array(accessTokenRecordSchema).default([]),
  loginRequests: z.array(loginRequestSchema).default([]),
});

type AuthFile = z.infer<typeof fileSchema>;

const EMPTY: AuthFile = { accounts: [], identities: [], accessTokens: [], loginRequests: [] };

/** 期限切れのログイン要求をいつまでも抱えない（往復用の一時的な行なので）。 */
const LOGIN_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * ログイン・アクセス許可 = 1枚の JSON（`~/.alteroid/auth/auth.json`）。
 *
 * **記憶（`memory/`）とは別のディレクトリに置く。** 記憶は「人間がいつでも読んで
 * 直せる Markdown」であることが要件だが、こちらは書き換えると鍵になる値
 * （トークンの sha256）を含む。人間が編集する前提の場所に混ぜない。
 *
 * ファイルは 0600 で作る。**このファイルを読めること自体が実行環境の境界である**
 * — 素のトークンは保存していないが、許可の2値を書き換えられれば誰でも通せる。
 */
export class FsAuthStore implements AuthStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'auth.json');
  }

  async listAccounts(): Promise<AuthAccount[]> {
    const { accounts } = await this.#read();
    return [...accounts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAccount(id: string): Promise<AuthAccount | null> {
    const { accounts } = await this.#read();
    return accounts.find((account) => account.id === id) ?? null;
  }

  async findAccountByEmail(email: string): Promise<AuthAccount | null> {
    const { accounts } = await this.#read();
    return accounts.find((account) => account.email === email) ?? null;
  }

  async putAccount(account: AuthAccount): Promise<void> {
    const parsed = authAccountSchema.parse(account);
    await this.#update((file) => ({
      ...file,
      accounts: [...file.accounts.filter((it) => it.id !== parsed.id), parsed],
    }));
  }

  async findIdentity(provider: string, subject: string): Promise<AuthIdentity | null> {
    const { identities } = await this.#read();
    return identities.find((it) => it.provider === provider && it.subject === subject) ?? null;
  }

  async listIdentities(accountId: string): Promise<AuthIdentity[]> {
    const { identities } = await this.#read();
    return identities.filter((identity) => identity.accountId === accountId);
  }

  async putIdentity(identity: AuthIdentity): Promise<void> {
    const parsed = authIdentitySchema.parse(identity);
    await this.#update((file) => ({
      ...file,
      identities: [
        ...file.identities.filter(
          (it) => !(it.provider === parsed.provider && it.subject === parsed.subject),
        ),
        parsed,
      ],
    }));
  }

  async putAccessToken(token: AccessTokenRecord): Promise<void> {
    const parsed = accessTokenRecordSchema.parse(token);
    await this.#update((file) => ({
      ...file,
      accessTokens: [...file.accessTokens.filter((it) => it.id !== parsed.id), parsed],
    }));
  }

  async findAccessTokenBySha256(hash: string): Promise<AccessTokenRecord | null> {
    const { accessTokens } = await this.#read();
    return accessTokens.find((token) => token.sha256 === hash) ?? null;
  }

  async listAccessTokens(accountId: string): Promise<AccessTokenRecord[]> {
    const { accessTokens } = await this.#read();
    return accessTokens.filter((token) => token.accountId === accountId);
  }

  async putLoginRequest(request: LoginRequest): Promise<void> {
    const parsed = loginRequestSchema.parse(request);
    const horizon = Date.now() - LOGIN_REQUEST_RETENTION_MS;
    await this.#update((file) => ({
      ...file,
      loginRequests: [
        ...file.loginRequests.filter(
          (it) => it.id !== parsed.id && Date.parse(it.expiresAt) > horizon,
        ),
        parsed,
      ],
    }));
  }

  async getLoginRequest(id: string): Promise<LoginRequest | null> {
    const { loginRequests } = await this.#read();
    return loginRequests.find((request) => request.id === id) ?? null;
  }

  /**
   * `authenticated` → `consumed` と**トークンの保存を1回の書き込みで**行う。
   *
   * 分けると壊れる（読みと書きを分ければ二重発行、consumed を先に書けば保存失敗で
   * ログインを回収できなくなる）。ここは1つの排他区間かつ1回の `rename` なので、
   * 両方が成るか両方が成らないかのどちらかにしかならない。
   */
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
      const token = accessTokenRecordSchema.parse(issue(consumed));
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

  /**
   * 「他に持ち主が居なければ許可する」を**1つの排他区間の中で**行う。
   *
   * 一覧を見てから書く形に分けると、owner が居ない状態で別々のアカウントへ同時に
   * grant したとき両方が通り、「持ち主は高々1つ」が破れる（＝マルチユーザーになる）。
   */
  async grantExclusive(accountId: string, at: string, by: string): Promise<GrantOutcome> {
    return this.#mutate<GrantOutcome>((file): { next: AuthFile | null; result: GrantOutcome } => {
      const account = file.accounts.find((it) => it.id === accountId);
      if (account === undefined) return { next: null, result: { status: 'not_found' as const } };
      if (account.grantedAt !== null) {
        return { next: null, result: { status: 'granted' as const, account } };
      }
      const owner = file.accounts.find((it) => it.grantedAt !== null);
      if (owner !== undefined) {
        return { next: null, result: { status: 'conflict' as const, owner } };
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
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /** read-modify-write を直列化する（デーモン1プロセス前提の最小の排他）。 */
  async #update(mutate: (file: AuthFile) => AuthFile): Promise<void> {
    await this.#mutate((file) => ({ next: mutate(file), result: undefined }));
  }

  /**
   * `#update` と同じ排他区間で、**中で決めた値を返せる**版。
   *
   * 「読んで、条件を見て、書いて、書けたかを返す」を呼び出し側で分けさせないために
   * ある（分けた瞬間に一度きりの保証が壊れる）。`next` が `null` なら書かない。
   */
  async #mutate<T>(mutate: (file: AuthFile) => { next: AuthFile | null; result: T }): Promise<T> {
    const run = this.#chain.then(async () => {
      const { next, result } = mutate(await this.#read());
      if (next === null) return result;
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      // 一時ファイルの時点で 0600。rename 後に絞ると、その隙間で他人が読める。
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.#path);
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
