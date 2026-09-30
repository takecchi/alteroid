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
import type { SQL, SQLWrapper } from 'drizzle-orm';

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
 * 並びの2次キー（`id` / `provider` / `subject`）を**照合順 C（バイト順）で**比べる式
 * （issue #2458）。
 *
 * **列の既定の照合順に任せないこと。** これらの列は `text` で `COLLATE` の指定が
 * 無いので、DB を作ったときの照合順（`datcollate`）に従う。PGlite は C だが、
 * 本番の pg が `en_US.UTF-8` などなら大文字と小文字、`-` と `_` の前後が変わる
 * ——pg 同士（本番と PGlite）でも、fs / インメモリ（コード単位の比較。
 * `packages/storage-fs/src/auth.ts` の `compareCodeUnits`）とも並びが食い違う。
 * `ORDER BY` の式に `COLLATE "C"` を付けるだけなのでスキーマは変えない
 * （migration は要らない）。
 */
function byteOrder(column: SQLWrapper): SQL {
  return sql`${column} collate "C"`;
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
    // （`AuthStore` の doc「並びの契約」）。**2次キーは照合順を C に固定する**
    // （issue #2458。`byteOrder` の doc）。
    const rows = await this.#db
      .select()
      .from(authAccounts)
      .orderBy(asc(authAccounts.createdAt), asc(byteOrder(authAccounts.id)));
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

  /**
   * `last_login_at` だけを書く。**条件無しの UPDATE 1文で、他の列には触らない**
   * （issue #1870）。`putAccount` の upsert は `granted_at` / `granted_by` /
   * `owner_declared_at` を無条件に `set` に含むので、読んだときの写しで呼ぶと、
   * そのあいだに完了した access grant / access revoke / owner 宣言を踏みつぶす
   * （`markAccessTokenUsed` が #1782 で塞いだのと同じ形）。無い id では0行の
   * 更新になる（投げない）。
   */
  async markAccountLoggedIn(accountId: string, at: string): Promise<void> {
    await this.#db
      .update(authAccounts)
      .set({ lastLoginAt: new Date(at) })
      .where(eq(authAccounts.id, accountId));
  }

  /**
   * `granted_at` / `granted_by` / `owner_declared_at` の3列だけを書く。
   * **条件無しの UPDATE 1文で、他の列には触らない**（issue #1915）。
   * `putAccount` の upsert は `last_login_at` も無条件に `set` に含むので、
   * 読んだときの写しで呼ぶと、そのあいだに完了した再ログインの
   * `last_login_at` を踏みつぶす（`markAccountLoggedIn` が #1870 で塞いだ
   * のと同じ形）。無い id では0行の更新になる（投げない）。
   */
  async revokeAccountAccess(accountId: string): Promise<void> {
    await this.#db
      .update(authAccounts)
      .set({ grantedAt: null, grantedBy: null, ownerDeclaredAt: null })
      .where(eq(authAccounts.id, accountId));
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
    // subject)` は一意なので、これで完全に決まった順になる）。**2次キーは照合順を
    // C に固定する**（issue #2458。`byteOrder` の doc）。
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
   * （issue #1714。検証済みメールの衝突検査も同じトランザクションの中——
   * issue #1751 / #1741）。
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
   * **account の insert 自体も、いまは生の insert ではない（issue #1751 /
   * #1741）。** `completeLogin` の外側にあった `findAccountByEmail` を消した
   * ので、**別々の** identity が同じ検証済みメールを同時に候補 account へ
   * 載せる形が、この操作の内側でだけ起こりうる。account の insert は
   * `onConflictDoNothing()` ＋ 事前の大小文字を区別しない select の2段構えで
   * 行う（実装本体の doc に詳細がある）——生の一意制約違反では落ちず、
   * 衝突していればメールを空にして入れ直す。account の insert がそれでも
   * 通らない（id の衝突など、メールの手当てが効かない理由）場合だけ、例外を
   * そのまま投げる——トランザクションごと巻き戻るので、先に入れた identity
   * も一緒に消える（孤児は作らない）。
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

      /**
       * **検証済みメールの衝突検査も、この同じトランザクションの中で行う**
       * （issue #1751 / #1741）。ここまでで identity の一意制約は通過している
       * ので、ここから先で起こりうる衝突は「**別々の** identity が同じ検証済み
       * メールを同時に候補 account へ載せた」形だけである。
       *
       * 2段構えにする。
       *
       * 1. **事前 select**（大小文字を区別しない、`findAccountByEmail` と同じ
       *    `lower()` 比較）。#1702 の重複状態（`auth_accounts_email_lower_idx`
       *    が作れず、大小文字を区別する旧索引 `auth_accounts_email_idx` だけが
       *    在る DB）では、DB 制約は大小文字違いの衝突を拒まない——ここが
       *    唯一の防波堤になる。ただし select から insert までの間に別の
       *    トランザクションが割り込む窓は残る（下の注記）。
       * 2. **`onConflictDoNothing()`（target 無し＝無条件）での insert。**
       *    新索引がある DB では、事前 select と insert の間に別のトランザクション
       *    が同じメールを先に commit しても、ここで do nothing になる
       *    （生の 23505 では落ちない）。0行のまま返ってきたら、メールを空に
       *    して同じ id で入れ直す。
       *
       * **target を明示しない理由**: 索引は `lower(email)` という式索引で、
       * かつ `id` の主キー制約もこのテーブルに在る。式索引をピンポイントで
       * 狙うより、「この insert で起きた conflict はひとまずメールが原因と
       * 仮定して空で入れ直し、それでも入らなければ id の衝突として例外にする」
       * ほうが単純——2回目の insert（同じ id・メールは null）が通れば
       * 1回目の失敗はメール起因だったと分かり、2回目も0行なら id 起因だったと
       * 分かる。`id` は乱数（`newId()`）なので id 衝突は実質起きない
       * （**確かめてはいない** —— id 生成の一意性は `newId()` 側の責務で、
       * ここでは「万一起きたら空メールでの回避を試みずに例外にする」という
       * fail-closed のふるまいだけを保証する）。
       *
       * ⚠️ **#1702 の重複状態でも、事前 select と insert の間の競合windowは
       * 完全には塞がらない。** 新索引が無い DB では、2つのトランザクションが
       * 互いにまだ commit していない状態で両方が select を通過すると、
       * どちらも「衝突なし」を見て両方とも実メールで insert し、DB 制約も
       * 検出しないので、大小文字違いの重複が残ることがある——これは #1702
       * 以前から在った「同時性の窓」の範囲内で、新しく直した穴ではない。
       */
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
          // メールを空にした状態でも一意制約に当たった——email 列は
          // NULL どうしを衝突として扱わないので、残る一意制約は id（主キー）
          // しかない。メールを空にする手当ては効かない種類の衝突なので、
          // 例外として投げる。
          throw new Error(
            'createAccountWithIdentity: account の insert が id の衝突などで通らない',
          );
        }
        // 負けた——事前 select の後、この insert までの間に別のトランザクション
        // が同じ（大小文字違いを含む）検証済みメールを先に commit した。
        // メールを空にして、同じ id で入れ直す。
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

  /**
   * `last_used_at` だけを書く。**条件付き UPDATE（`revoked_at is null`）で、
   * ほかの列には触らない**（issue #1782）。`putAccessToken` の upsert は
   * `revoked_at` を無条件に `set` に含むので、読んだときの写しで呼ぶと、
   * そのあいだに完了したログアウトを踏みつぶす。失効済み・無い id では0行の更新になる。
   */
  async markAccessTokenUsed(id: string, at: string): Promise<void> {
    await this.#db
      .update(authAccessTokens)
      .set({ lastUsedAt: new Date(at) })
      .where(and(eq(authAccessTokens.id, id), isNull(authAccessTokens.revokedAt)));
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
    // 決まった順になる）。**2次キーは照合順を C に固定する**（issue #2458。
    // `byteOrder` の doc）。
    const rows = await this.#db
      .select()
      .from(authAccessTokens)
      .where(eq(authAccessTokens.accountId, accountId))
      .orderBy(asc(authAccessTokens.createdAt), asc(byteOrder(authAccessTokens.id)));
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
