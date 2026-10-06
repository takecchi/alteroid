import { hasNul, integrationKeyRecordSchema, prepareIntegrationKeyForWrite } from '@alteroid/core';
import type {
  IntegrationKeyRecord,
  IntegrationKeyStore,
  RevokeIntegrationKeyOutcome,
} from '@alteroid/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { toIso } from './db.js';
import { integrationKeys } from './schema.js';

function optionalDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function optionalIso(value: Date | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * 連携の鍵（PostgreSQL）。fs ドライバと同じ IF を満たす別の器。**素の値は1文字も入らない**（`sha256` だけ）。
 */
export class PgIntegrationKeyStore implements IntegrationKeyStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async putIntegrationKey(key: IntegrationKeyRecord): Promise<void> {
    const value = prepareIntegrationKeyForWrite(integrationKeyRecordSchema.parse(key));
    // 上書きしない（同じ id・同じ sha256 は一意制約で落ちる）。
    await this.#db.insert(integrationKeys).values({
      id: value.id,
      name: value.name,
      source: value.source,
      sha256: value.sha256,
      createdAt: new Date(value.createdAt),
      createdBy: value.createdBy,
      expiresAt: optionalDate(value.expiresAt),
      revokedAt: optionalDate(value.revokedAt),
      lastUsedAt: optionalDate(value.lastUsedAt),
      maxBodyBytes: value.maxBodyBytes,
      ratePerMinute: value.ratePerMinute,
    });
  }

  async findIntegrationKeyBySha256(sha256: string): Promise<IntegrationKeyRecord | null> {
    if (hasNul(sha256)) return null;
    const rows = await this.#db
      .select()
      .from(integrationKeys)
      .where(eq(integrationKeys.sha256, sha256))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toRecord(row);
  }

  async getIntegrationKey(id: string): Promise<IntegrationKeyRecord | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select()
      .from(integrationKeys)
      .where(eq(integrationKeys.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#toRecord(row);
  }

  async listIntegrationKeys(): Promise<IntegrationKeyRecord[]> {
    // 2次キーは照合順 C（バイト順）に固定する（`PgAuthStore` の `byteOrder` と同じ理由。issue #2458）。
    const rows = await this.#db
      .select()
      .from(integrationKeys)
      .orderBy(asc(integrationKeys.createdAt), asc(sql`${integrationKeys.id} collate "C"`));
    return rows.map((row) => this.#toRecord(row));
  }

  /** `last_used_at` だけを書く。失効済み・無い id では0行の更新になる（`markAccessTokenUsed` と同じ形）。 */
  async markIntegrationKeyUsed(id: string, at: string): Promise<void> {
    if (hasNul(id)) return;
    await this.#db
      .update(integrationKeys)
      .set({ lastUsedAt: new Date(at) })
      .where(and(eq(integrationKeys.id, id), isNull(integrationKeys.revokedAt)));
  }

  async revokeIntegrationKey(id: string, at: string): Promise<RevokeIntegrationKeyOutcome> {
    if (hasNul(id)) return { status: 'not_found' };
    const rows = await this.#db
      .update(integrationKeys)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(integrationKeys.id, id), isNull(integrationKeys.revokedAt)))
      .returning();
    const row = rows[0];
    if (row !== undefined) return { status: 'revoked', key: this.#toRecord(row) };
    const existing = await this.getIntegrationKey(id);
    if (existing === null) return { status: 'not_found' };
    return { status: 'already_revoked', key: existing };
  }

  #toRecord(row: typeof integrationKeys.$inferSelect): IntegrationKeyRecord {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      sha256: row.sha256,
      createdAt: toIso(row.createdAt),
      createdBy: row.createdBy,
      expiresAt: optionalIso(row.expiresAt),
      revokedAt: optionalIso(row.revokedAt),
      lastUsedAt: optionalIso(row.lastUsedAt),
      maxBodyBytes: row.maxBodyBytes,
      ratePerMinute: row.ratePerMinute,
    };
  }
}
