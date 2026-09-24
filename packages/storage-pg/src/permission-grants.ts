import { permissionGrantSchema } from '@alteroid/core';
import type { PermissionGrant, PermissionGrantStore } from '@alteroid/core';
import { asc, eq } from 'drizzle-orm';

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
}
