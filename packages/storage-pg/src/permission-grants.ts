import {
  compareIsoInstant,
  createUnreadableRowOnce,
  hasNul,
  permissionGrantSchema,
  preparePermissionGrantForPut,
  UnreadablePermissionGrantError,
  unreadableRowKey,
} from '@alteroid/core';
import type {
  PermissionGrant,
  PermissionGrantStore,
  RemoveUnreadableRowsOptions,
  RemoveUnreadableRowsResult,
  UnreadablePermissionGrant,
  UnreadableRowOnce,
} from '@alteroid/core';
import { asc, eq, inArray } from 'drizzle-orm';

import type { Db } from './db.js';
import { permissionGrants } from './schema.js';

// `issue.message` を使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わっても値が漏れないようにするため。
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

// id 以外の値を載せない: `record` の欄には人間の依頼文・承認の回答の原文が入りうるため。
function describeUnreadableGrantRow(params: { id: string; reason: string }): string {
  return (
    `alteroid: 許可の記録の行を読み出せませんでした` +
    `（id=${JSON.stringify(params.id)}、${params.reason}）`
  );
}

export class PgPermissionGrantStore implements PermissionGrantStore {
  readonly #db: Db;

  // `revoke()` / `markUsed()` はこれを経由しない: 名指しで触った操作の結果は毎回知らせるため。
  readonly #unreadableOnce: UnreadableRowOnce = createUnreadableRowOnce();

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<PermissionGrant[]> {
    const rows = await this.#db
      .select({ id: permissionGrants.id, record: permissionGrants.record })
      .from(permissionGrants)
      .orderBy(asc(permissionGrants.grantedAt));
    const result: PermissionGrant[] = [];
    for (const row of rows) {
      const parsed = permissionGrantSchema.safeParse(row.record);
      const key = unreadableRowKey(row.id, row.record);
      if (parsed.success) {
        this.#unreadableOnce.sawReadable(key);
        result.push(parsed.data);
        continue;
      }
      if (this.#unreadableOnce.sawUnreadable(key)) {
        process.stderr.write(
          `${describeUnreadableGrantRow({ id: row.id, reason: summarizeInvalidFields(parsed.error.issues) })}\n`,
        );
      }
    }
    return result;
  }

  async listUnreadable(): Promise<UnreadablePermissionGrant[]> {
    const rows = await this.#db
      .select({ id: permissionGrants.id, record: permissionGrants.record })
      .from(permissionGrants)
      .orderBy(asc(permissionGrants.grantedAt));
    const result: UnreadablePermissionGrant[] = [];
    for (const row of rows) {
      const parsed = permissionGrantSchema.safeParse(row.record);
      if (parsed.success) continue;
      result.push({ id: row.id, reason: summarizeInvalidFields(parsed.error.issues) });
    }
    return result;
  }

  async get(id: string): Promise<PermissionGrant | null> {
    // NUL を含む id を DB に投げない: text が NUL を受け付けずエラーになるため。
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select({ record: permissionGrants.record })
      .from(permissionGrants)
      .where(eq(permissionGrants.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = permissionGrantSchema.safeParse(row.record);
    const key = unreadableRowKey(id, row.record);
    if (parsed.success) {
      this.#unreadableOnce.sawReadable(key);
      return parsed.data;
    }
    if (this.#unreadableOnce.sawUnreadable(key)) {
      process.stderr.write(
        `${describeUnreadableGrantRow({ id, reason: summarizeInvalidFields(parsed.error.issues) })}\n`,
      );
    }
    return null;
  }

  async put(grant: PermissionGrant): Promise<void> {
    const value = preparePermissionGrantForPut(permissionGrantSchema.parse(grant));
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

  // 読んでから書く形にしない: `select … for update` で押さえて lost update を防ぐため。
  // 読めない行は `null` ではなく投げる: fs 実装と同じ線で、投げても許可が余計に通ることは無い。
  async revoke(id: string, at: string): Promise<PermissionGrant | null> {
    if (hasNul(id)) return null;
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ record: permissionGrants.record })
        .from(permissionGrants)
        .where(eq(permissionGrants.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) return null;

      const parsed = permissionGrantSchema.safeParse(row.record);
      if (!parsed.success) {
        process.stderr.write(
          `${describeUnreadableGrantRow({ id, reason: summarizeInvalidFields(parsed.error.issues) })}\n`,
        );
        throw new UnreadablePermissionGrantError({ id });
      }
      const current = parsed.data;
      const revokedAt = current.revokedAt ?? at;
      const next = permissionGrantSchema.parse({ ...current, revokedAt });

      await tx
        .update(permissionGrants)
        .set({ revokedAt: new Date(revokedAt), record: next })
        .where(eq(permissionGrants.id, id));

      return next;
    });
  }

  // `beforeRemove` をトランザクションの外で呼ぶ: 日誌ストアが同じ接続を使う器で、開いたままのトランザクションが日誌の書き込みを待たせ続けるため。
  async removeUnreadable(
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions = {},
  ): Promise<RemoveUnreadableRowsResult> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return { kind: 'unknown', count: 0 };
    const queryable = wanted.filter((id) => !hasNul(id));
    const unknownCount = async (executor: Pick<Db, 'select'>, lock: boolean): Promise<number> => {
      if (queryable.length === 0) return wanted.length;
      const query = executor
        .select({ id: permissionGrants.id, record: permissionGrants.record })
        .from(permissionGrants)
        .where(inArray(permissionGrants.id, queryable));
      const rows = await (lock ? query.for('update') : query);
      const unreadable = new Set(
        rows
          .filter((row) => !permissionGrantSchema.safeParse(row.record).success)
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
      await tx.delete(permissionGrants).where(inArray(permissionGrants.id, wanted));
      return { kind: 'removed' as const, ids: wanted };
    });
  }

  async markUsed(id: string, at: string): Promise<boolean> {
    if (hasNul(id)) return false;
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ record: permissionGrants.record })
        .from(permissionGrants)
        .where(eq(permissionGrants.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) return false;

      const parsed = permissionGrantSchema.safeParse(row.record);
      if (!parsed.success) {
        process.stderr.write(
          `${describeUnreadableGrantRow({ id, reason: summarizeInvalidFields(parsed.error.issues) })}\n`,
        );
        return false;
      }
      const current = parsed.data;
      if (current.revokedAt !== undefined) return false;
      // 文字列で比べない: オフセット表記の `lastUsedAt` より実時刻で後の `Z` の時刻が「古い」と読まれるため。
      if (current.lastUsedAt !== undefined && compareIsoInstant(current.lastUsedAt, at) >= 0)
        return true;

      const next = permissionGrantSchema.parse({ ...current, lastUsedAt: at });
      await tx.update(permissionGrants).set({ record: next }).where(eq(permissionGrants.id, id));
      return true;
    });
  }
}
