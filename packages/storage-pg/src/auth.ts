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
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { authAccessTokens, authAccounts, authIdentities, authLoginRequests } from './schema.js';

/*
 * ⚠️ **ここに `isUniqueViolation`（SQLSTATE 23505 を `cause` を辿って見る関数）が
 * 在った。** 唯一の呼び手だった `grantExclusive` の索引ごと落としたので消した
 * （2026-09-09）。**知識のほうは消していない** — drizzle がドライバの例外を自前の
 * エラーで包むので最前面だけ見ると `code` が見つからない、という事実は
 * `.claude/skills/auth-and-access/SKILL.md` が持つ。この表にはまだ一意索引が在る
 * （`auth_accounts_email_lower_idx`。#1702 で `auth_accounts_email_idx` から
 * `lower(email)` へ移した）ので、翻訳が要る日が来たらそこから書き戻すこと。
 */

/** 期限切れのログイン要求をいつまでも抱えない（往復用の一時的な行なので）。 */
const LOGIN_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

function optionalDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function optionalIso(value: Date | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * ログインとアクセス許可（PostgreSQL）。fs ドライバと同じ IF を満たす別の器。
 *
 * **素のトークンは1文字も入らない**（`sha256` だけ）。記憶へ到達できる鍵なので、
 * DB のダンプが漏れても再利用できてはいけない。
 */
export class PgAuthStore implements AuthStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listAccounts(): Promise<AuthAccount[]> {
    // **2次キーに `id` を持つ**（issue #1688）。`createdAt` だけの `ORDER BY` は
    // 同着（`createdAt` が完全に同じ）行どうしの順を SQL が保証しない
    // （`AuthStore` の doc「並びの契約」）。
    const rows = await this.#db
      .select()
      .from(authAccounts)
      .orderBy(asc(authAccounts.createdAt), asc(authAccounts.id));
    return rows.map((row) => this.#toAccount(row));
  }

  async getAccount(id: string): Promise<AuthAccount | null> {
    const rows = await this.#db.select().from(authAccounts).where(eq(authAccounts.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccount(row);
  }

  async findAccountByEmail(email: string): Promise<AuthAccount | null> {
    // 大小文字を区別しない（#1702）。一意索引（auth_accounts_email_lower_idx）
    // と同じ `lower()` で比べる——`eq` のままだと索引に乗らない上に、
    // memory / fs の実装と判定が食い違う。
    const rows = await this.#db
      .select()
      .from(authAccounts)
      .where(sql`lower(${authAccounts.email}) = lower(${email})`)
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccount(row);
  }

  async putAccount(account: AuthAccount): Promise<void> {
    const value = stripNulls(authAccountSchema.parse(account));
    const set = {
      displayName: value.displayName,
      email: value.email,
      lastLoginAt: optionalDate(value.lastLoginAt),
      grantedAt: optionalDate(value.grantedAt),
      grantedBy: value.grantedBy,
      ownerDeclaredAt: optionalDate(value.ownerDeclaredAt),
    };
    await this.#db
      .insert(authAccounts)
      .values({ id: value.id, createdAt: new Date(value.createdAt), ...set })
      .onConflictDoUpdate({ target: authAccounts.id, set });
  }

  async findIdentity(provider: string, subject: string): Promise<AuthIdentity | null> {
    const rows = await this.#db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toIdentity(row);
  }

  async listIdentities(accountId: string): Promise<AuthIdentity[]> {
    // **2次キーに `provider` → `subject` を持つ**（issue #1688。`(provider,
    // subject)` は一意なので、これで完全に決まった順になる）。
    const rows = await this.#db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, accountId))
      .orderBy(
        asc(authIdentities.createdAt),
        asc(authIdentities.provider),
        asc(authIdentities.subject),
      );
    return rows.map((row) => this.#toIdentity(row));
  }

  async putIdentity(identity: AuthIdentity): Promise<void> {
    const value = stripNulls(authIdentitySchema.parse(identity));
    const set = {
      accountId: value.accountId,
      email: value.email,
      emailVerified: value.emailVerified,
      lastLoginAt: new Date(value.lastLoginAt),
    };
    await this.#db
      .insert(authIdentities)
      .values({
        provider: value.provider,
        subject: value.subject,
        createdAt: new Date(value.createdAt),
        ...set,
      })
      .onConflictDoUpdate({
        target: [authIdentities.provider, authIdentities.subject],
        set,
      });
  }

  /**
   * 「初めて見る identity」の account 作成を**1つのトランザクションで**行う
   * （issue #1714）。
   *
   * **identity を先に、`(provider, subject)` の一意制約に対する
   * `on conflict do nothing` で insert する。1行入ったときだけ account を
   * insert する。** identity が入らなかった（＝別の呼び出しが先に同じ
   * identity を作っていた）ら、**account の insert そのものへ進まない**——
   * 同じトランザクション内で既存の identity を読み直して返す。
   *
   * ⚠️ **順序は「account を先」ではいけない**（#1714 の最初の実装がこの順で、
   * レビューで指摘された）。`auth_accounts_email_lower_idx`（#1702。`lower(email)`
   * の一意索引）が本番の pg には在る。同じ identity の2つのログインは
   * `completeLogin` の外側の衝突検査で同じ検証済みメールを候補 account に
   * 載せるので、account を先に insert すると**負けた側が identity の
   * `on conflict do nothing` へ辿り着く前に、account 側のメール一意索引で
   * 一意制約違反として落ちる**（`tx.rollback()` ではなく本物の例外）。
   * identity を先にすれば、負けた側は identity の一意制約で
   * do nothing になり、account の insert へ進まない——メールの索引には
   * そもそも当たらない。
   *
   * **`auth_identities.account_id` に外部キーは無い**（`migrate.ts` の
   * `create table auth_identities` に `references` 節が無いことを DDL で
   * 確認済み）。だから identity を先に insert しても、まだ存在しない
   * account を指す一時的な状態を作ることに問題は無い——同じトランザクション内で
   * 即座に account を insert して埋める。
   *
   * account の insert が（この対象とは別の理由で）落ちたら、例外はそのまま
   * 投げる——トランザクションごと巻き戻るので、先に入れた identity も一緒に
   * 消える（孤児は作らない）。
   */
  async createAccountWithIdentity(input: {
    account: AuthAccount;
    identity: AuthIdentity;
  }): Promise<CreateAccountWithIdentityOutcome> {
    const account = stripNulls(authAccountSchema.parse(input.account));
    const identity = stripNulls(authIdentitySchema.parse(input.identity));

    return this.#db.transaction(async (tx) => {
      const identityRows = await tx
        .insert(authIdentities)
        .values({
          provider: identity.provider,
          subject: identity.subject,
          accountId: identity.accountId,
          email: identity.email,
          emailVerified: identity.emailVerified,
          createdAt: new Date(identity.createdAt),
          lastLoginAt: new Date(identity.lastLoginAt),
        })
        .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.subject] })
        .returning();

      if (identityRows.length === 0) {
        // 負けた。account へは進まない——ここまでで既に、同じ identity を
        // 取り合う競合が起こりうる唯一の索引（identity の主キー）を通過して
        // いる。勝った側の commit は `on conflict do nothing` 自体が待つので、
        // ここで読み直せば必ず見える。
        const existingRows = await tx
          .select()
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.provider, identity.provider),
              eq(authIdentities.subject, identity.subject),
            ),
          )
          .limit(1);
        const existingRow = existingRows[0];
        if (existingRow === undefined) {
          throw new Error(
            'createAccountWithIdentity: 競合したはずの identity が読めない（他の1操作と矛盾）',
          );
        }
        return { created: false, existing: this.#toIdentity(existingRow) };
      }

      await tx.insert(authAccounts).values({
        id: account.id,
        displayName: account.displayName,
        email: account.email,
        createdAt: new Date(account.createdAt),
        lastLoginAt: optionalDate(account.lastLoginAt),
        grantedAt: optionalDate(account.grantedAt),
        grantedBy: account.grantedBy,
        ownerDeclaredAt: optionalDate(account.ownerDeclaredAt),
      });

      return { created: true };
    });
  }

  async putAccessToken(token: AccessTokenRecord): Promise<void> {
    const value = stripNulls(accessTokenRecordSchema.parse(token));
    const set = {
      accountId: value.accountId,
      sha256: value.sha256,
      label: value.label,
      expiresAt: optionalDate(value.expiresAt),
      lastUsedAt: optionalDate(value.lastUsedAt),
      revokedAt: optionalDate(value.revokedAt),
    };
    await this.#db
      .insert(authAccessTokens)
      .values({ id: value.id, createdAt: new Date(value.createdAt), ...set })
      .onConflictDoUpdate({ target: authAccessTokens.id, set });
  }

  async findAccessTokenBySha256(hash: string): Promise<AccessTokenRecord | null> {
    const rows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.sha256, hash))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccessToken(row);
  }

  async listAccessTokens(accountId: string): Promise<AccessTokenRecord[]> {
    // **2次キーに `id` を持つ**（issue #1688。`id` は一意なので、これで完全に
    // 決まった順になる）。
    const rows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.accountId, accountId))
      .orderBy(asc(authAccessTokens.createdAt), asc(authAccessTokens.id));
    return rows.map((row) => this.#toAccessToken(row));
  }

  /**
   * この1本のアクセストークンだけを失効させる（issue #1757）。
   *
   * **条件付き UPDATE（`revoked_at is null`）で強制する** —— `grantAccess` と
   * 同じ理由。同じトークンへ同時にログアウトが来たとき、先に書いた側の時刻を
   * 後から来た側が上書きしない。更新が0行なら、既に失効済みか、そもそも
   * その id の行が無いかのどちらかなので、読み直して区別する。
   */
  async revokeAccessToken(id: string, at: string): Promise<RevokeAccessTokenOutcome> {
    const rows = await this.#db
      .update(authAccessTokens)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(authAccessTokens.id, id), isNull(authAccessTokens.revokedAt)))
      .returning();
    const row = rows[0];
    if (row !== undefined) return { status: 'revoked', token: this.#toAccessToken(row) };

    // 更新できなかった。行そのものが無いのか、既に失効済みなのかを分けて返す。
    const existingRows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.id, id))
      .limit(1);
    const existing = existingRows[0];
    return existing === undefined
      ? { status: 'not_found' }
      : { status: 'already_revoked', token: this.#toAccessToken(existing) };
  }

  async putLoginRequest(request: LoginRequest): Promise<void> {
    const value = stripNulls(loginRequestSchema.parse(request));
    const expiresAt = new Date(value.expiresAt);
    await this.#db
      .insert(authLoginRequests)
      .values({ id: value.id, request: value, expiresAt })
      .onConflictDoUpdate({
        target: authLoginRequests.id,
        set: { request: value, expiresAt },
      });
    // 溜め込まない。往復が終われば用済みの行である。
    await this.#db
      .delete(authLoginRequests)
      .where(lt(authLoginRequests.expiresAt, new Date(Date.now() - LOGIN_REQUEST_RETENTION_MS)));
  }

  async getLoginRequest(id: string): Promise<LoginRequest | null> {
    const rows = await this.#db
      .select({ request: authLoginRequests.request })
      .from(authLoginRequests)
      .where(eq(authLoginRequests.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = loginRequestSchema.safeParse(row.request);
    return parsed.success ? parsed.data : null;
  }

  /**
   * `pending` → `processing` を**条件付き UPDATE 1文で**行う。
   *
   * 更新行数が「交換へ進む権利を取れたのは自分だけか」の判定になる。
   */
  async beginLoginExchange(id: string): Promise<LoginRequest | null> {
    const rows = await this.#db
      .update(authLoginRequests)
      .set({
        request: sql`jsonb_set(${authLoginRequests.request}, '{status}', '"processing"'::jsonb)`,
      })
      .where(
        and(
          eq(authLoginRequests.id, id),
          sql`${authLoginRequests.request} ->> 'status' = 'pending'`,
        ),
      )
      .returning({ request: authLoginRequests.request });

    const row = rows[0];
    if (row === undefined) return null;
    const parsed = loginRequestSchema.safeParse(row.request);
    return parsed.success ? parsed.data : null;
  }

  /**
   * `authenticated` → `consumed` と**トークンの INSERT を1つのトランザクションで**行う。
   *
   * 条件付き UPDATE の更新行数が「確保できたのは自分だけか」の判定になる
   * （PostgreSQL は同じ行への並行 UPDATE を直列化し、待たされた側は再評価で
   * `status = 'authenticated'` を満たさなくなる＝0行更新）。INSERT が落ちれば
   * トランザクションごと巻き戻り、要求は `authenticated` のまま残る — だから
   * 「トークンは返らなかったのに二度と引き取れない」状態が作れない。
   */
  async claimLoginRequest(
    id: string,
    issue: (request: LoginRequest) => AccessTokenRecord,
  ): Promise<{ request: LoginRequest; token: AccessTokenRecord } | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .update(authLoginRequests)
        .set({
          request: sql`jsonb_set(${authLoginRequests.request}, '{status}', '"consumed"'::jsonb)`,
        })
        .where(
          and(
            eq(authLoginRequests.id, id),
            sql`${authLoginRequests.request} ->> 'status' = 'authenticated'`,
          ),
        )
        .returning({ request: authLoginRequests.request });

      const row = rows[0];
      if (row === undefined) return null;
      const parsed = loginRequestSchema.safeParse(row.request);
      if (!parsed.success) return null;

      const token = accessTokenRecordSchema.parse(stripNulls(issue(parsed.data)));
      await tx.insert(authAccessTokens).values({
        id: token.id,
        accountId: token.accountId,
        sha256: token.sha256,
        label: token.label,
        createdAt: new Date(token.createdAt),
        expiresAt: optionalDate(token.expiresAt),
        lastUsedAt: optionalDate(token.lastUsedAt),
        revokedAt: optionalDate(token.revokedAt),
      });

      return { request: parsed.data, token };
    });
  }

  /**
   * この account を許可する。
   *
   * ⚠️ **2026-09-09 のオーナー決定まで、ここは `grantExclusive` で、最後の砦は
   * 部分一意索引 `auth_accounts_single_owner_idx`（`granted_at` が入る行はテーブル
   * 全体で1行まで）だった。索引そのものを落としてある** — 落とさずに条件だけ外すと、
   * 2人目を許可した後の**次の起動**で `could not create unique index … is duplicated`
   * になり、デーモンが上がらなくなる（`migrate.ts` の「古い鍵の `create` は配列から
   * 消す」。逐語は `grep -Fn -- '「2回目は no-op」を約束しない' packages/storage-pg/src/migrate.ts`）。
   *
   * 条件付き UPDATE（`granted_at is null`）は残す。**他の行との不変条件のためではなく、
   * 同じ行への同時 grant で `grantedBy` が上書きされないため**である
   * （理由は `AuthStore.grantAccess` の doc）。
   */
  async grantAccess(accountId: string, at: string, by: string): Promise<GrantOutcome> {
    const account = await this.getAccount(accountId);
    if (account === null) return { status: 'not_found' };
    if (account.grantedAt !== null) return { status: 'granted', account };

    const rows = await this.#db
      .update(authAccounts)
      .set({ grantedAt: new Date(at), grantedBy: by })
      .where(and(eq(authAccounts.id, accountId), isNull(authAccounts.grantedAt)))
      .returning();
    const row = rows[0];
    if (row === undefined) {
      // 同じ行が同時に許可された。読み直せばどちらが勝ったか分かる。
      const current = await this.getAccount(accountId);
      return current === null ? { status: 'not_found' } : { status: 'granted', account: current };
    }
    return { status: 'granted', account: this.#toAccount(row) };
  }

  /**
   * この account を「実行環境の持ち主として宣言された」状態にする、または解く
   * （issue #1198）。
   *
   * **不変条件「宣言 ⟹ 許可済み」は条件付き UPDATE（`granted_at is not null`）
   * そのもので強制する** —— 「読む→検査→書く」に割ると、検査と書き込みの間に
   * 許可が取り消される窓ができる。**取り消し（`declaredAt === null`）はこの
   * 条件を付けない** —— 許可が取り消された後に宣言だけを取り消す
   * （`AuthService.revoke` が両方を落とす）経路があるため。
   */
  async setAccountOwner(accountId: string, declaredAt: string | null): Promise<OwnerOutcome> {
    if (declaredAt === null) {
      const rows = await this.#db
        .update(authAccounts)
        .set({ ownerDeclaredAt: null })
        .where(eq(authAccounts.id, accountId))
        .returning();
      const row = rows[0];
      return row === undefined
        ? { status: 'not_found' }
        : { status: 'ok', account: this.#toAccount(row) };
    }

    const rows = await this.#db
      .update(authAccounts)
      .set({ ownerDeclaredAt: new Date(declaredAt) })
      .where(and(eq(authAccounts.id, accountId), isNotNull(authAccounts.grantedAt)))
      .returning();
    const row = rows[0];
    if (row !== undefined) return { status: 'ok', account: this.#toAccount(row) };

    // 更新できなかった。行そのものが無いのか、未許可なのかを分けて返す。
    const account = await this.getAccount(accountId);
    return account === null ? { status: 'not_found' } : { status: 'not_granted' };
  }

  #toAccount(row: typeof authAccounts.$inferSelect): AuthAccount {
    return {
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      createdAt: toIso(row.createdAt),
      lastLoginAt: optionalIso(row.lastLoginAt),
      grantedAt: optionalIso(row.grantedAt),
      grantedBy: row.grantedBy,
      ownerDeclaredAt: optionalIso(row.ownerDeclaredAt),
    };
  }

  #toIdentity(row: typeof authIdentities.$inferSelect): AuthIdentity {
    return {
      provider: row.provider,
      subject: row.subject,
      accountId: row.accountId,
      email: row.email,
      emailVerified: row.emailVerified,
      createdAt: toIso(row.createdAt),
      lastLoginAt: toIso(row.lastLoginAt),
    };
  }

  #toAccessToken(row: typeof authAccessTokens.$inferSelect): AccessTokenRecord {
    return {
      id: row.id,
      accountId: row.accountId,
      sha256: row.sha256,
      label: row.label,
      createdAt: toIso(row.createdAt),
      expiresAt: optionalIso(row.expiresAt),
      lastUsedAt: optionalIso(row.lastUsedAt),
      revokedAt: optionalIso(row.revokedAt),
    };
  }
}
