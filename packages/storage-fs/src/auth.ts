import { mkdir, readFile } from 'node:fs/promises';
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
  OwnerOutcome,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const fileSchema = z.object({
  accounts: z.array(authAccountSchema).default([]),
  identities: z.array(authIdentitySchema).default([]),
  accessTokens: z.array(accessTokenRecordSchema).default([]),
  loginRequests: z.array(loginRequestSchema).default([]),
});

type AuthFile = z.infer<typeof fileSchema>;

const EMPTY: AuthFile = { accounts: [], identities: [], accessTokens: [], loginRequests: [] };

/**
 * `createdAt` の**実時刻**昇順（issue #1676）。**単独では使わない** ——
 * `createdAt` が完全に同じ（同着）行どうしの相対順を決めないため（issue
 * #1688）。並び全体を決めるのは直下の `compareAccountOrder` /
 * `compareIdentityOrder` / `compareAccessTokenOrder` である。
 *
 * **文字列の `localeCompare` を使わないこと。** `isoDateTime`
 * （`z.string().datetime({ offset: true })`）はオフセット付きの任意の表記を
 * 許すので、同じ瞬間でも書き方は一意ではない（例: `+09:00` 表記と `+00:00`
 * 表記）。文字列比較だとオフセット表記が違う行で実時刻の順が崩れる——
 * pg（`timestamptz` 列に対する `asc()`）は実時刻で比較するので崩れない。
 * 3実装で同じ並びにする（fs / pg のどちらのドライバでも同じ IF を満たす、
 * `AuthStore` の doc）。
 */
function compareCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/**
 * `listAccounts` の並び全体（issue #1688）。`createdAt` の実時刻 → `id`。
 *
 * **2次キーが要る理由**: `putAccount` は「既存行を消して末尾へ足す」形
 * （直下の doc）なので、`createdAt` が完全に同じ2行のうち片方だけ後から
 * 更新すると、`compareCreatedAt` だけ（`Array.prototype.sort` は安定）では
 * 更新されたほうが後ろへ回る——「作成順」ではなく「最後に触られた順」に
 * なってしまう。`id` は一意なので、これで並びが完全に決まる（pg の
 * `orderBy(asc(createdAt), asc(id))` と同じ形）。
 */
function compareAccountOrder(a: AuthAccount, b: AuthAccount): number {
  return compareCreatedAt(a, b) || a.id.localeCompare(b.id);
}

/**
 * `listIdentities` の並び全体（issue #1688）。
 * `createdAt` の実時刻 → `provider` → `subject`。
 *
 * `(provider, subject)` は一意なので（`AuthStore.putIdentity` の doc）、
 * これで並びが完全に決まる。2次キーが要る理由は `compareAccountOrder` と
 * 同じ——`putIdentity` も「既存行を消して末尾へ足す」形である。
 */
function compareIdentityOrder(a: AuthIdentity, b: AuthIdentity): number {
  return (
    compareCreatedAt(a, b) ||
    a.provider.localeCompare(b.provider) ||
    a.subject.localeCompare(b.subject)
  );
}

/**
 * `listAccessTokens` の並び全体（issue #1688）。`createdAt` の実時刻 → `id`。
 *
 * `id` は一意なので、これで並びが完全に決まる。2次キーが要る理由は
 * `compareAccountOrder` と同じ——`putAccessToken` も「既存行を消して末尾へ
 * 足す」形である（`lastUsedAt` の書き戻し＝`touch()` だけで動く）。
 */
function compareAccessTokenOrder(a: AccessTokenRecord, b: AccessTokenRecord): number {
  return compareCreatedAt(a, b) || a.id.localeCompare(b.id);
}

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

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'auth.json');
  }

  async listAccounts(): Promise<AuthAccount[]> {
    const { accounts } = await this.#read();
    return [...accounts].sort(compareAccountOrder);
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
    // **明示的に並べる。** `putIdentity` は既存行を消して末尾へ足す形なので
    // （直下の doc）、更新されたばかりの identity ほど配列の後ろへ動く——
    // ソートを外すと「作成順」ではなく「最後に触られた順」になる。pg は
    // `createdAt` の `asc()` で並べるので、ここも実時刻昇順に揃える（issue #1676）。
    // 同着（createdAt が完全に同じ）の相対順は `provider`/`subject` で決める
    // （issue #1688。`compareIdentityOrder` の doc）。
    return identities
      .filter((identity) => identity.accountId === accountId)
      .sort(compareIdentityOrder);
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
    // **明示的に並べる。** `putAccessToken` も既存行を消して末尾へ足す形なので、
    // `lastUsedAt` の書き戻し（`touch()`）だけで作成順が崩れる。pg は `createdAt`
    // の `asc()` で並べるので、ここも実時刻昇順に揃える（issue #1676）。
    // 同着（createdAt が完全に同じ）の相対順は `id` で決める
    // （issue #1688。`compareAccessTokenOrder` の doc）。
    return accessTokens
      .filter((token) => token.accountId === accountId)
      .sort(compareAccessTokenOrder);
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
   * `pending` → `processing` を**1つの排他区間の中で**行う。
   *
   * 外部プロバイダとの交換へ進む権利をここで1つに絞る。読んでから書く形だと、
   * 同じ callback の並行到着で両方が交換し、失敗した側が成功した側の結果を
   * 上書きしうる。
   */
  async beginLoginExchange(id: string): Promise<LoginRequest | null> {
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
   * この account を許可する。**1つの排他区間の中で**行う。
   *
   * ⚠️ **2026-09-09 のオーナー決定まで、ここは `grantExclusive` で「他に持ち主が
   * 居なければ」という条件が付いていた。** 外したのは条件のほうで、排他区間は残す —
   * 同じ account へ同時に grant が来たとき、先に書いた側を勝たせて `grantedBy` の
   * 上書きを防ぐためである（理由は `AuthStore.grantAccess` の doc）。
   */
  async grantAccess(accountId: string, at: string, by: string): Promise<GrantOutcome> {
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

  /**
   * この account を「実行環境の持ち主として宣言された」状態にする、または解く。
   * **1つの排他区間の中で**行う（issue #1198）。
   *
   * 不変条件「宣言 ⟹ 許可済み」はここで強制する。`declaredAt !== null` で
   * 未許可の行を渡されたら書かずに `not_granted` を返す — `grantAccess` と
   * 同じ排他区間の内側なので、検査と書き込みの間に許可が取り消される窓は無い。
   * 取り消し（`declaredAt === null`）は行が在れば常に通す。
   */
  async setAccountOwner(accountId: string, declaredAt: string | null): Promise<OwnerOutcome> {
    return this.#mutate<OwnerOutcome>((file): { next: AuthFile | null; result: OwnerOutcome } => {
      const account = file.accounts.find((it) => it.id === accountId);
      if (account === undefined) return { next: null, result: { status: 'not_found' as const } };
      if (declaredAt !== null && account.grantedAt === null) {
        return { next: null, result: { status: 'not_granted' as const } };
      }
      const updated = authAccountSchema.parse({ ...account, ownerDeclaredAt: declaredAt });
      return {
        next: {
          ...file,
          accounts: file.accounts.map((it) => (it.id === accountId ? updated : it)),
        },
        result: { status: 'ok' as const, account: updated },
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

  /**
   * read-modify-write を直列化する（issue #1113 / #1050 — `withPathLock` で
   * プロセス内・プロセス間の両方を排他する。advisory の強さは `file-lock.ts`
   * の doc を見よ）。
   */
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
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      if (next === null) return result;
      await mkdir(this.#dir, { recursive: true });
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。rename 後に
      // 絞ると、その隙間で他人が読める。
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return result;
    });
  }
}
