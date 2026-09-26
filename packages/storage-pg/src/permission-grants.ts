import { permissionGrantSchema } from '@alteroid/core';
import type { PermissionGrant, PermissionGrantStore } from '@alteroid/core';
import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { permissionGrants } from './schema.js';

/**
 * 人間が承認した Bash 許可の記録（PostgreSQL）。fs ドライバ
 * （`FsPermissionGrantStore`）と同じ IF を満たす別の器。
 *
 * **`approvals` / `authLoginRequests` と同じ jsonb-blob の形。** 正規化した
 * 列を持たないのは、`PermissionGrant` が人間の記憶と同じ「読み書きは alteroid
 * 自身しか行わない」記録であって、SQL 側から直接クエリする要件が無いため
 * （`schema.ts` の `permissionGrants` の doc）。
 */
export class PgPermissionGrantStore implements PermissionGrantStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<PermissionGrant[]> {
    const rows = await this.#db
      .select({ record: permissionGrants.record })
      .from(permissionGrants)
      .orderBy(asc(permissionGrants.grantedAt));
    return rows
      .map((row) => permissionGrantSchema.safeParse(row.record))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);
  }

  async get(id: string): Promise<PermissionGrant | null> {
    const rows = await this.#db
      .select({ record: permissionGrants.record })
      .from(permissionGrants)
      .where(eq(permissionGrants.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = permissionGrantSchema.safeParse(row.record);
    return parsed.success ? parsed.data : null;
  }

  async put(grant: PermissionGrant): Promise<void> {
    const value = permissionGrantSchema.parse(grant);
    const set = {
      grantedAt: new Date(value.grantedAt),
      revokedAt: value.revokedAt === undefined ? null : new Date(value.revokedAt),
      record: value,
    };
    await this.#db
      .insert(permissionGrants)
      .values({ id: value.id, ...set })
      .onConflictDoUpdate({ target: permissionGrants.id, set });
  }

  /**
   * `PermissionGrantStore.revoke` の doc（lost update・#1654 と同型）。
   * **条件付き UPDATE 1文で**行う（`PgAuthStore.beginLoginExchange` と同じ
   * 形——`jsonb_set` ＋ `coalesce` の右辺に渡す「現在値」は、この1文の中で
   * 読む行のイメージ（pre-image）であって、アプリ層が別に読んだ古い写しでは
   * ない）。**`record.revokedAt` と派生列 `revoked_at` は、同じ pre-image の
   * `record ->> 'revokedAt'` から両方を導く**——別々に `coalesce` すると、
   * 万一2つが食い違っていたときに決定がずれうるため。
   */
  async revoke(id: string, at: string): Promise<PermissionGrant | null> {
    const rows = await this.#db
      .update(permissionGrants)
      .set({
        record: sql`jsonb_set(
          ${permissionGrants.record},
          '{revokedAt}',
          to_jsonb(coalesce(${permissionGrants.record} ->> 'revokedAt', ${at}::text)),
          true
        )`,
        revokedAt: sql`coalesce(
          (${permissionGrants.record} ->> 'revokedAt')::timestamptz,
          ${at}::timestamptz
        )`,
      })
      .where(eq(permissionGrants.id, id))
      .returning({ record: permissionGrants.record });

    const row = rows[0];
    if (row === undefined) return null;
    const parsed = permissionGrantSchema.safeParse(row.record);
    return parsed.success ? parsed.data : null;
  }

  /**
   * `PermissionGrantStore.markUsed` の doc。**`jsonb_set` で `lastUsedAt` の
   * 1本の欄だけを差し替える**——`revokedAt` を含む他の欄には触れない（触れて
   * いないことは、この文が `record` の他のキーを1つも参照しないことで担保
   * される）。既存より古い時刻では戻さない（`case` で pre-image と比べる）。
   */
  async markUsed(id: string, at: string): Promise<void> {
    await this.#db
      .update(permissionGrants)
      .set({
        record: sql`jsonb_set(
          ${permissionGrants.record},
          '{lastUsedAt}',
          to_jsonb(
            case
              when ${permissionGrants.record} ->> 'lastUsedAt' is null then ${at}::text
              when (${permissionGrants.record} ->> 'lastUsedAt')::timestamptz
                < ${at}::timestamptz then ${at}::text
              else ${permissionGrants.record} ->> 'lastUsedAt'
            end
          ),
          true
        )`,
      })
      .where(eq(permissionGrants.id, id));
  }
}
