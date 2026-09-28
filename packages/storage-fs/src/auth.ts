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
  CreateAccountWithIdentityOutcome,
  GrantOutcome,
  LoginRequest,
  OwnerOutcome,
  RevokeAccessTokenOutcome,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * トップレベルの形だけを見る。**4配列のどれも、各要素はここでは検査しない**
 * ——`z.array(authAccountSchema)` のように行のスキーマを直接使うと、1行の
 * 不正が配列全体を道連れにする（直す前の形。issue #1942。`FsJobStore` の
 * `fileSchema` と同じ理由・同じ形——issue #1868 / #1928）。行ごとの検査は
 * `#read()` がそれぞれの行スキーマで `safeParse` して1行ずつ行う。
 *
 * **ここで投げる例外は今のままでよい**——配列が配列でない・ファイルが
 * オブジェクトでない、はファイル全体の形の問題であって、1行の問題ではない。
 */
const fileSchema = z.object({
  accounts: z.array(z.unknown()).default([]),
  identities: z.array(z.unknown()).default([]),
  accessTokens: z.array(z.unknown()).default([]),
  loginRequests: z.array(z.unknown()).default([]),
});

/**
 * `auth.json` の中身。**検査を通った4配列と、それぞれ形が不正で読めなかった
 * `invalid*Raw`（生の要素。パース前のまま）を分けて持つ**（issue #1942。
 * `FsJobStore` の `JobFile` / `FsCredentialVaultStore` の `CredentialFile`
 * と同じ形）。
 *
 * `invalid*Raw` を消さずに持ち回るのが、この直しの核心である。書き込み系の
 * メソッドはいずれも最終的にこれを丸ごとシリアライズし直す（`#serialize`）
 * ので、ここへ入れなかった行は次の書き込みで消える——検査を通った行だけを
 * 書けば、版ずれ・手編集でできた不正な行が黙って消えることになる。
 */
interface AuthFile {
  accounts: AuthAccount[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
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

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`FsJobStore` の `summarizeInvalidFields` /
 * `FsCredentialVaultStore` の同名関数と同じ理由・同じ形）。4配列共通。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/**
 * 生の要素から、値を出さずに「id」だけを安全に取り出す（取れなければ
 * `undefined`）。`accounts` / `accessTokens` / `loginRequests` の3配列で使う
 * ——`identities` だけ `id` を持たず `(provider, subject)` が鍵なので、
 * こちらは {@link extractIdentityKey} を使う。
 */
function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * 生の要素から、値を出さずに identity の鍵（`provider` / `subject`）だけを
 * 安全に取り出す（取れない欄は `undefined`）。
 */
function extractIdentityKey(raw: unknown): { provider?: string; subject?: string } {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  return {
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    subject: typeof record.subject === 'string' ? record.subject : undefined,
  };
}

/** 生の要素の identity 鍵が、指定した (provider, subject) と一致するか。 */
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

/**
 * 飛ばした identity 行を stderr へ1行で要約する。**id を持たないので、鍵
 * （`provider` / `subject`）で識別する。** `email` 等の他の値は絶対に載せない。
 */
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
    // 大小文字を区別しない（#1702）。memory / pg の実装と同じ規約。
    const needle = email.toLowerCase();
    return (
      accounts.find(
        (account) => account.email !== null && account.email.toLowerCase() === needle,
      ) ?? null
    );
  }

  async putAccount(account: AuthAccount): Promise<void> {
    const parsed = authAccountSchema.parse(account);
    await this.#update((file) => {
      // **書き込む id と一致する壊れた行は置き換える**（`FsJobStore.putJob` /
      // `FsCredentialVaultStore.put` と同じフォローアップ。issue #1942）。
      // 直したはずの id の壊れた行が `invalidAccountsRaw` として残り続けると、
      // ファイルに同じ id が2行並び、以後 `listAccounts()` のたびに直した
      // はずの跡が出続ける——「直した」という呼び手の意図に対する驚きになる。
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

  /**
   * `lastLoginAt` だけを書く。**1つの排他区間の中で、いまのファイルの行を読んで**
   * 書く（issue #1870。`markAccessTokenUsed` と同じ形）。呼び手が読んだときの
   * 写しは使わない——使うと、そのあいだに完了した access grant / access revoke /
   * owner 宣言を書き戻してしまう。無い id では何もしない。
   */
  async markAccountLoggedIn(accountId: string, at: string): Promise<void> {
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

  /**
   * `grantedAt` / `grantedBy` / `ownerDeclaredAt` の3欄だけを null にする。
   * **1つの排他区間の中で、いまのファイルの行を読んで**書く（issue #1915。
   * `markAccountLoggedIn` と同じ形）。呼び手が読んだときの写しは使わない
   * ——使うと、そのあいだに完了した再ログインの `lastLoginAt` を書き戻して
   * しまう。無い id では何もしない。
   */
  async revokeAccountAccess(accountId: string): Promise<void> {
    await this.#mutate<null>((file): { next: AuthFile | null; result: null } => {
      const account = file.accounts.find((it) => it.id === accountId);
      if (account === undefined) return { next: null, result: null };
      const updated = authAccountSchema.parse({
        ...account,
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
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
    await this.#update((file) => {
      // **書き込む鍵（provider, subject）と一致する壊れた行は置き換える**
      // （`putAccount` と同じフォローアップ。issue #1942）。`identities` は
      // `id` を持たないので、鍵の一致で判定する（`identityKeyMatches`）。
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

  /**
   * 「初めて見る identity」の account 作成を**1回の書き込みで**行う（issue #1714。
   * 検証済みメールの衝突検査も同じ書き込みの中で行う——issue #1751 / #1741）。
   *
   * `#mutate` の判定・書き込みは同期的に評価されるので（`#mutate` の doc）、
   * ここで見た「identity が無い」「メールが衝突しているか」はどちらも
   * 書き込みの瞬間まで有効——同じ排他区間の外から割り込む隙間が無い。
   * identity が在れば `next: null` で何も書かずに既存を返す。メールが
   * 大小文字を区別せずに他の account と衝突していれば、空のメールで保存する。
   */
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
        // 大小文字を区別しない（#1702）。memory / pg の実装と同じ規約。
        const needle = input.account.email?.toLowerCase() ?? null;
        const emailCollides =
          needle !== null &&
          file.accounts.some((it) => it.email !== null && it.email.toLowerCase() === needle);
        const accountInput = emailCollides ? { ...input.account, email: null } : input.account;
        const account = authAccountSchema.parse(accountInput);
        const identity = authIdentitySchema.parse(input.identity);
        // **fail-closed（issue #1942）。** `existing` が `undefined` なのは
        // 「本当に初めて見る identity」だけでなく、**同じ (provider, subject)
        // の行が壊れていて `file.identities`（検査を通った行）に居ないとき
        // も同じ形になる**——見分けが付かない。後者では、ここで新しい
        // account を作る。**新しい account は常に未許可（`grantedAt: null`）
        // で作られる**（呼び手が渡す `input.account` がそもそも未許可の
        // 状態で組み立てる——`auth-service.ts` 側の約束）ので、壊れた行が
        // 元は許可済みの account を指していたとしても、その許可は引き継がれ
        // ない。権限が増える方向へは倒れない。
        //
        // **書き込む鍵と一致する壊れた identity 行は置き換える**
        // （`putIdentity` と同じフォローアップ）。壊れた生の行と新しい行が
        // 同じ (provider, subject) で並んだまま残ると、次回以降の
        // `findIdentity` は検査を通った新しい行を返すので実害は無いが、
        // ファイルに同じ鍵の行が2行残り続けるのは「直した」呼び手の意図に
        // 対する驚きになる。
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
    const parsed = accessTokenRecordSchema.parse(token);
    await this.#update((file) => {
      // **書き込む id と一致する壊れた行は置き換える**（`putAccount` と同じ
      // フォローアップ。issue #1942）。
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

  /**
   * `lastUsedAt` だけを書く。**1つの排他区間の中で、いまのファイルの行を読んで**
   * 書く（issue #1782）。呼び手が読んだときの写しは使わない——使うと、そのあいだに
   * 完了したログアウトの `revokedAt` を書き戻してしまう。失効済み・無い id では
   * 何も書かない。
   */
  async markAccessTokenUsed(id: string, at: string): Promise<void> {
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
    // **明示的に並べる。** `putAccessToken` も既存行を消して末尾へ足す形なので、
    // `lastUsedAt` の書き戻し（`touch()`）だけで作成順が崩れる。pg は `createdAt`
    // の `asc()` で並べるので、ここも実時刻昇順に揃える（issue #1676）。
    // 同着（createdAt が完全に同じ）の相対順は `id` で決める
    // （issue #1688。`compareAccessTokenOrder` の doc）。
    return accessTokens
      .filter((token) => token.accountId === accountId)
      .sort(compareAccessTokenOrder);
  }

  /**
   * この1本のアクセストークンだけを失効させる。**1つの排他区間の中で**行う
   * （issue #1757）。
   *
   * `revokedAt` が空のときだけ立てる——同じトークンへ同時にログアウトが来ても、
   * 先に書いた側の時刻が残る（後から来た側は `already_revoked` を見る）。
   */
  async revokeAccessToken(id: string, at: string): Promise<RevokeAccessTokenOutcome> {
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
    const parsed = loginRequestSchema.parse(request);
    const horizon = Date.now() - LOGIN_REQUEST_RETENTION_MS;
    await this.#update((file) => {
      // **書き込む id と一致する壊れた行は置き換える**（`putAccount` と同じ
      // フォローアップ。issue #1942）。**期限切れの掃除（`horizon`）は壊れた
      // 行までは追わない**——壊れた行は `expiresAt` すら安全に読めているとは
      // 限らないので（それ自体が不正な理由かもしれない）、ここでは書き込む
      // id と一致した行だけを掃除の対象にする、より保守的な形にしてある。
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

  /**
   * `auth.json` を読む。**4配列すべてを行ごとに検査し、不正な1行だけを
   * 飛ばす**（issue #1942。以前は `fileSchema.parse` で4配列それぞれを1回に
   * 検査していたため、どれか1行でも不正だとログイン・アクセストークンの
   * 照会・`access grant` / `revoke` まで、同じ `auth.json` を読む操作が
   * すべて丸ごと例外を投げていた——`#read()` が4配列を同時に返す1つの関数
   * だからである。pg 実装（`PgAuthStore`）は `accounts` / `identities` /
   * `accessTokens` を正規化された列で持つので、そもそも「1行の不正が他の
   * 行を道連れにする」形をしていない。`loginRequests` だけ JSONB で持つが、
   * そちらは元から行ごとに `safeParse` している）。
   *
   * **飛ばすのは行の形が不正なとき（必須欄が欠けている・型が違う、など）
   * だけである。** ファイルそのものが JSON として読めない・トップレベルの
   * 形が違う（各配列が配列でない等）ときは、いまの振る舞い（例外）のまま
   * にしてある——それは1行の問題ではないため。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkipped*Row`。**値は
   * `email` 等の本文を含めず、id（または identity の鍵）だけ**）、
   * `invalid*Raw` として生の形のまま保持する——`put*` 系のメソッドがこれを
   * 書き戻すことで、版ずれ・手編集でできた不正な行を黙って消さない。
   */
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

  /**
   * `AuthFile` をディスク上の形へ直す。**検査を通った4配列と、それぞれの
   * `invalid*Raw` を1本ずつの配列へ合流させる**——分けたまま書くと、次の
   * `#read()` が `fileSchema`（トップレベルの形しか見ない）を通すときに
   * 未知のキー（`invalid*Raw`）として黙って捨てられ、壊れた行を持ち回る
   * 意味が消える。
   */
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
      await writeFileAtomic(this.#path, `${JSON.stringify(this.#serialize(next), null, 2)}\n`, {
        mode: 0o600,
      });
      return result;
    });
  }
}
