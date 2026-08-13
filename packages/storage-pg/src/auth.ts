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
  LoginRequest,
} from '@alteroid/core';
import { and, asc, eq, lt } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { authAccessTokens, authAccounts, authIdentities, authLoginRequests } from './schema.js';

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
    const rows = await this.#db.select().from(authAccounts).orderBy(asc(authAccounts.createdAt));
    return rows.map((row) => this.#toAccount(row));
  }

  async getAccount(id: string): Promise<AuthAccount | null> {
    const rows = await this.#db.select().from(authAccounts).where(eq(authAccounts.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toAccount(row);
  }

  async findAccountByEmail(email: string): Promise<AuthAccount | null> {
    const rows = await this.#db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.email, email))
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
    const rows = await this.#db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, accountId))
      .orderBy(asc(authIdentities.createdAt));
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
    const rows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.accountId, accountId))
      .orderBy(asc(authAccessTokens.createdAt));
    return rows.map((row) => this.#toAccessToken(row));
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

  #toAccount(row: typeof authAccounts.$inferSelect): AuthAccount {
    return {
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      createdAt: toIso(row.createdAt),
      lastLoginAt: optionalIso(row.lastLoginAt),
      grantedAt: optionalIso(row.grantedAt),
      grantedBy: row.grantedBy,
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
