import {
  accessTokenRecordSchema,
  assertNoNul,
  authAccountSchema,
  authIdentitySchema,
  hasNul,
  loginRequestSchema,
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
  OwnerOutcome,
  RemoveUnreadableRowsResult,
  RevokeAccessTokenOutcome,
  UnreadableAccount,
} from '@alteroid/core';
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { authAccessTokens, authAccounts, authIdentities, authLoginRequests } from './schema.js';

const LOGIN_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

function optionalDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function optionalIso(value: Date | null): string | null {
  return value === null ? null : toIso(value);
}

// 列の既定の照合順に任せない: 本番の pg と PGlite、fs / インメモリとで並びが食い違うため。
function byteOrder(column: SQLWrapper): SQL {
  return sql`${column} collate "C"`;
}

// 素のトークンを入れない: `sha256` だけを持つ。DB のダンプが漏れても再利用できてはいけないため。
export class PgAuthStore implements AuthStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listAccounts(): Promise<AuthAccount[]> {
    // `createdAt` だけの `ORDER BY` にしない: 同着の行どうしの順を SQL が保証しないため。
    const rows = await this.#db
      .select()
      .from(authAccounts)
      .orderBy(asc(authAccounts.createdAt), asc(byteOrder(authAccounts.id)));
    return rows.map((row) => this.#toAccount(row));
  }

  async listUnreadableAccounts(): Promise<UnreadableAccount[]> {
    return [];
  }

  async getAccount(id: string): Promise<AuthAccount | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db.select().from(authAccounts).where(eq(authAccounts.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccount(row);
  }

  async findAccountByEmail(email: string): Promise<AuthAccount | null> {
    // NUL を含むメールは DB に投げる前に「無い」と答える（#3011）。
    if (hasNul(email)) return null;
    // `eq` で比べない: 一意索引（`auth_accounts_email_lower_idx`）に乗らず、memory / fs と判定が食い違うため。
    const rows = await this.#db
      .select()
      .from(authAccounts)
      .where(sql`lower(${authAccounts.email}) = lower(${email})`)
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccount(row);
  }

  async putAccount(account: AuthAccount): Promise<void> {
    const value = stripNulls(prepareAccountForWrite(authAccountSchema.parse(account)));
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

  // `putAccount` を使わない: upsert が `granted_at` 等を無条件に `set` に含み、そのあいだに完了した grant / revoke / owner 宣言を踏みつぶすため。
  async markAccountLoggedIn(accountId: string, at: string): Promise<void> {
    if (hasNul(accountId)) return;
    await this.#db
      .update(authAccounts)
      .set({ lastLoginAt: new Date(at) })
      .where(eq(authAccounts.id, accountId));
  }

  async removeUnreadableAccounts(ids: readonly string[]): Promise<RemoveUnreadableRowsResult> {
    return { kind: 'unknown', count: new Set(ids).size };
  }

  // `putAccount` を使わない: upsert が `last_login_at` も無条件に `set` に含み、そのあいだに完了した再ログインを踏みつぶすため。
  async revokeAccountAccess(accountId: string): Promise<void> {
    if (hasNul(accountId)) return;
    await this.#db
      .update(authAccounts)
      .set({ grantedAt: null, grantedBy: null, ownerDeclaredAt: null })
      .where(eq(authAccounts.id, accountId));
  }

  async findIdentity(provider: string, subject: string): Promise<AuthIdentity | null> {
    if (hasNul(provider) || hasNul(subject)) return null;
    const rows = await this.#db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toIdentity(row);
  }

  async listIdentities(accountId: string): Promise<AuthIdentity[]> {
    if (hasNul(accountId)) return [];
    const rows = await this.#db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, accountId))
      .orderBy(
        asc(authIdentities.createdAt),
        asc(byteOrder(authIdentities.provider)),
        asc(byteOrder(authIdentities.subject)),
      );
    return rows.map((row) => this.#toIdentity(row));
  }

  async putIdentity(identity: AuthIdentity): Promise<void> {
    const value = stripNulls(prepareIdentityForWrite(authIdentitySchema.parse(identity)));
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

  // account を先に insert しない: 負けた側が identity の `on conflict do nothing` に辿り着く前に、メールの一意索引で本物の例外として落ちるため。identity を先にして、入らなければ account へ進まない。
  // account の insert の `onConflictDoNothing()` に target を付けない: 式索引と主キーのどちらの衝突か区別せず、メールを空にして入れ直し、それでも入らなければ id の衝突として例外にするため。
  async createAccountWithIdentity(input: {
    account: AuthAccount;
    identity: AuthIdentity;
  }): Promise<CreateAccountWithIdentityOutcome> {
    const account = stripNulls(prepareAccountForWrite(authAccountSchema.parse(input.account)));
    const identity = stripNulls(prepareIdentityForWrite(authIdentitySchema.parse(input.identity)));

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

      // 事前 select を外さない: 大小文字を区別する旧索引だけの DB では、DB 制約が大小文字違いの衝突を拒まないため。
      const values = (email: string | null) => ({
        id: account.id,
        displayName: account.displayName,
        email,
        createdAt: new Date(account.createdAt),
        lastLoginAt: optionalDate(account.lastLoginAt),
        grantedAt: optionalDate(account.grantedAt),
        grantedBy: account.grantedBy,
        ownerDeclaredAt: optionalDate(account.ownerDeclaredAt),
      });

      let emailForInsert = account.email;
      if (emailForInsert !== null) {
        const collisionRows = await tx
          .select({ id: authAccounts.id })
          .from(authAccounts)
          .where(sql`lower(${authAccounts.email}) = lower(${emailForInsert})`)
          .limit(1);
        if (collisionRows.length > 0) {
          emailForInsert = null;
        }
      }

      let insertedRows = await tx
        .insert(authAccounts)
        .values(values(emailForInsert))
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length === 0) {
        if (emailForInsert === null) {
          throw new Error(
            'createAccountWithIdentity: account の insert が id の衝突などで通らない',
          );
        }
        insertedRows = await tx
          .insert(authAccounts)
          .values(values(null))
          .onConflictDoNothing()
          .returning();
        if (insertedRows.length === 0) {
          throw new Error(
            'createAccountWithIdentity: メールを空にしても account の insert が通らない（id の衝突）',
          );
        }
      }

      const insertedRow = insertedRows[0];
      if (insertedRow === undefined) {
        throw new Error('createAccountWithIdentity: insert の returning が空（矛盾）');
      }
      return { created: true, account: this.#toAccount(insertedRow) };
    });
  }

  async putAccessToken(token: AccessTokenRecord): Promise<void> {
    const value = stripNulls(prepareAccessTokenForWrite(accessTokenRecordSchema.parse(token)));
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

  // `putAccessToken` を使わない: upsert が `revoked_at` を無条件に `set` に含み、そのあいだに完了したログアウトを踏みつぶすため。
  async markAccessTokenUsed(id: string, at: string): Promise<void> {
    if (hasNul(id)) return;
    await this.#db
      .update(authAccessTokens)
      .set({ lastUsedAt: new Date(at) })
      .where(and(eq(authAccessTokens.id, id), isNull(authAccessTokens.revokedAt)));
  }

  async findAccessTokenBySha256(hash: string): Promise<AccessTokenRecord | null> {
    if (hasNul(hash)) return null;
    const rows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.sha256, hash))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccessToken(row);
  }

  async listAccessTokens(accountId: string): Promise<AccessTokenRecord[]> {
    if (hasNul(accountId)) return [];
    const rows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.accountId, accountId))
      .orderBy(asc(authAccessTokens.createdAt), asc(byteOrder(authAccessTokens.id)));
    return rows.map((row) => this.#toAccessToken(row));
  }

  // 条件付き UPDATE（`revoked_at is null`）にする: 同時にログアウトが来たとき、先に書いた側の時刻を後から来た側が上書きしないため。
  async revokeAccessToken(id: string, at: string): Promise<RevokeAccessTokenOutcome> {
    if (hasNul(id)) return { status: 'not_found' };
    const rows = await this.#db
      .update(authAccessTokens)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(authAccessTokens.id, id), isNull(authAccessTokens.revokedAt)))
      .returning();
    const row = rows[0];
    if (row !== undefined) return { status: 'revoked', token: this.#toAccessToken(row) };

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
    const value = stripNulls(prepareLoginRequestForWrite(loginRequestSchema.parse(request)));
    const expiresAt = new Date(value.expiresAt);
    await this.#db
      .insert(authLoginRequests)
      .values({ id: value.id, request: value, expiresAt })
      .onConflictDoUpdate({
        target: authLoginRequests.id,
        set: { request: value, expiresAt },
      });
    await this.#db
      .delete(authLoginRequests)
      .where(lt(authLoginRequests.expiresAt, new Date(Date.now() - LOGIN_REQUEST_RETENTION_MS)));
  }

  async getLoginRequest(id: string): Promise<LoginRequest | null> {
    if (hasNul(id)) return null;
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

  async beginLoginExchange(id: string): Promise<LoginRequest | null> {
    if (hasNul(id)) return null;
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

  // トークンの INSERT と同じトランザクションにする: 落ちたら要求が `authenticated` のまま残り、「トークンは返らなかったのに二度と引き取れない」状態を作らないため。
  async claimLoginRequest(
    id: string,
    issue: (request: LoginRequest) => AccessTokenRecord,
  ): Promise<{ request: LoginRequest; token: AccessTokenRecord } | null> {
    if (hasNul(id)) return null;
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

      const token = stripNulls(
        prepareAccessTokenForWrite(accessTokenRecordSchema.parse(issue(parsed.data))),
      );
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

  // 条件付き UPDATE（`granted_at is null`）を外さない: 同じ行への同時 grant で `grantedBy` が上書きされるため。
  async grantAccess(accountId: string, at: string, by: string): Promise<GrantOutcome> {
    if (hasNul(accountId)) return { status: 'not_found' };
    assertNoNul('authAccount.grantedBy', by);
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
      const current = await this.getAccount(accountId);
      return current === null ? { status: 'not_found' } : { status: 'granted', account: current };
    }
    return { status: 'granted', account: this.#toAccount(row) };
  }

  // 「読む→検査→書く」に割らない: 検査と書き込みの間に許可が取り消される窓ができるため。
  // 取り消し（`declaredAt === null`）に `granted_at is not null` を付けない: 許可が取り消された後に宣言だけを取り消す経路があるため。
  async setAccountOwner(accountId: string, declaredAt: string | null): Promise<OwnerOutcome> {
    if (hasNul(accountId)) return { status: 'not_found' };
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
