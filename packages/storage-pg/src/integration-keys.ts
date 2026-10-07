import { hasNul, integrationKeyRecordSchema, prepareIntegrationKeyForWrite } from '@alteroid/core';
import type {
  IntegrationKeyRecord,
  IntegrationKeyStore,
  RemoveUnreadableRowsOptions,
  RemoveUnreadableRowsResult,
  RevokeIntegrationKeyOutcome,
  UnreadableIntegrationKey,
} from '@alteroid/core';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { toIso } from './db.js';
import { integrationKeys } from './schema.js';

// `issue.message` を使わない: 出すのは「どの欄が」だけにするため。
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function optionalDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function optionalIso(value: Date | null): string | null {
  return value === null ? null : toIso(value);
}

// 素の値を入れない: `sha256` だけを持つ。
export class PgIntegrationKeyStore implements IntegrationKeyStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async putIntegrationKey(key: IntegrationKeyRecord): Promise<void> {
    const value = prepareIntegrationKeyForWrite(integrationKeyRecordSchema.parse(key));
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
    return row === undefined ? null : this.#readable(row);
  }

  async getIntegrationKey(id: string): Promise<IntegrationKeyRecord | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select()
      .from(integrationKeys)
      .where(eq(integrationKeys.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.#readable(row);
  }

  async listIntegrationKeys(): Promise<IntegrationKeyRecord[]> {
    // 2次キーの照合順を既定に任せない: 環境で並びが変わるため。
    const rows = await this.#db
      .select()
      .from(integrationKeys)
      .orderBy(asc(integrationKeys.createdAt), asc(sql`${integrationKeys.id} collate "C"`));
    return rows.flatMap((row) => this.#readable(row) ?? []);
  }

  async listUnreadableIntegrationKeys(): Promise<UnreadableIntegrationKey[]> {
    const rows = await this.#db
      .select()
      .from(integrationKeys)
      .orderBy(asc(integrationKeys.createdAt), asc(sql`${integrationKeys.id} collate "C"`));
    const result: UnreadableIntegrationKey[] = [];
    for (const row of rows) {
      const parsed = integrationKeyRecordSchema.safeParse(this.#toRecord(row));
      if (parsed.success) continue;
      result.push({ id: row.id, reason: summarizeInvalidFields(parsed.error.issues) });
    }
    return result;
  }

  // `beforeRemove` をトランザクションの外で呼ぶ: 日誌ストアが同じ接続を使う器で、開いたままのトランザクションが日誌の書き込みを待たせ続けるため。
  async removeUnreadableIntegrationKeys(
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions = {},
  ): Promise<RemoveUnreadableRowsResult> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return { kind: 'unknown', count: 0 };
    // NUL を含む id を DB へ投げない: `putIntegrationKey` が断るので、その行は存在しえないため。
    const queryable = wanted.filter((id) => !hasNul(id));
    const unknownCount = async (executor: Pick<Db, 'select'>, lock: boolean): Promise<number> => {
      if (queryable.length === 0) return wanted.length;
      const query = executor
        .select()
        .from(integrationKeys)
        .where(inArray(integrationKeys.id, queryable));
      const rows = await (lock ? query.for('update') : query);
      const unreadable = new Set(
        rows
          .filter((row) => !integrationKeyRecordSchema.safeParse(this.#toRecord(row)).success)
          .map((row) => row.id),
      );
      return wanted.filter((id) => !unreadable.has(id)).length;
    };

    const before = await unknownCount(this.#db, false);
    if (before > 0) return { kind: 'unknown', count: before };
    await options.beforeRemove?.(wanted);
    return this.#db.transaction(async (tx) => {
      const unknown = await unknownCount(tx, true);
      if (unknown > 0) return { kind: 'unknown' as const, count: unknown };
      await tx.delete(integrationKeys).where(inArray(integrationKeys.id, wanted));
      return { kind: 'removed' as const, ids: wanted };
    });
  }

  async markIntegrationKeyUsed(id: string, at: string): Promise<void> {
    if (hasNul(id)) return;
    await this.#db
      .update(integrationKeys)
      .set({ lastUsedAt: new Date(at) })
      .where(and(eq(integrationKeys.id, id), isNull(integrationKeys.revokedAt)));
  }

  async revokeIntegrationKey(id: string, at: string): Promise<RevokeIntegrationKeyOutcome> {
    if (hasNul(id)) return { status: 'not_found' };
    if ((await this.getIntegrationKey(id)) === null) return { status: 'not_found' };
    const rows = await this.#db
      .update(integrationKeys)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(integrationKeys.id, id), isNull(integrationKeys.revokedAt)))
      .returning();
    const row = rows[0];
    const revoked = row === undefined ? null : this.#readable(row);
    if (revoked !== null) return { status: 'revoked', key: revoked };
    const existing = await this.getIntegrationKey(id);
    if (existing === null) return { status: 'not_found' };
    return { status: 'already_revoked', key: existing };
  }

  #readable(row: typeof integrationKeys.$inferSelect): IntegrationKeyRecord | null {
    const parsed = integrationKeyRecordSchema.safeParse(this.#toRecord(row));
    return parsed.success ? parsed.data : null;
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
