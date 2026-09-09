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
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { authAccessTokens, authAccounts, authIdentities, authLoginRequests } from './schema.js';

/*
 * ⚠️ **ここに `isUniqueViolation`（SQLSTATE 23505 を `cause` を辿って見る関数）が
 * 在った。** 唯一の呼び手だった `grantExclusive` の索引ごと落としたので消した
 * （2026-09-09）。**知識のほうは消していない** — drizzle がドライバの例外を自前の
 * エラーで包むので最前面だけ見ると `code` が見つからない、という事実は
 * `.claude/skills/auth-and-access/SKILL.md` が持つ。この表にはまだ一意索引が在る
 * （`auth_accounts_email_idx`）ので、翻訳が要る日が来たらそこから書き戻すこと。
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
