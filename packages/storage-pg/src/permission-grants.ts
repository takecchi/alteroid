import { permissionGrantSchema } from '@alteroid/core';
import type { PermissionGrant, PermissionGrantStore } from '@alteroid/core';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { permissionGrants } from './schema.js';

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`jobs.ts` の `summarizeInvalidFields` と
 * 同じ理由・同じ形。パッケージ内でも共通化はしていない——ファイルごとに独立
 * させておくのが repo の既存の作法である）。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/**
 * `revoke()` / `markUsed()` が読めなかった行を stderr へ1行で要約する
 * （issue #2158）。**id 以外の値は絶対に載せない**——`record` の欄には人間の
 * 依頼文・承認の回答の原文がそのまま入りうる（`jobs.ts` の
 * `describeUnreadableJobRow` の doc、#52 と同じ理由）。
 */
function describeUnreadableGrantRow(params: { id: string; reason: string }): string {
  return (
    `alteroid: 許可の記録の行を読み出せませんでした` +
    `（id=${JSON.stringify(params.id)}、${params.reason}）`
  );
}

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
   * **1つのトランザクションの中で `select … for update` により行を押さえて
   * から読み直し、書く**（`PgJobStore.updateJob` と同じ形——issue #2051）。
   *
   * **読めない行（`permissionGrantSchema` に合わない。版ずれ・手編集）は
   * 「無い」と同じ `null` を返す。行にも触れない**（issue #2158）。
   * 以前は `record`（jsonb）の中身を一切見ずに `jsonb_set` ＋ `coalesce` の
   * 条件無し `UPDATE` で `revoked_at` / `record.revokedAt` を書き換えていた
   * ため、読めない行にも書いたうえで戻り値だけ `null` にしていた——`fs` 実装
   * （`FsPermissionGrantStore.revoke`。読めない行は `grants` に現れないので
   * 触らずに `null`）と食い違っていた。跡は `describeUnreadableGrantRow` で
   * stderr へ1行だけ残す（id とどの欄が不正かのみ。本文は出さない）。
   */
  async revoke(id: string, at: string): Promise<PermissionGrant | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ record: permissionGrants.record })
        .from(permissionGrants)
        .where(eq(permissionGrants.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      // 無い。**書かない。**
      if (row === undefined) return null;

      const parsed = permissionGrantSchema.safeParse(row.record);
      if (!parsed.success) {
        process.stderr.write(
          `${describeUnreadableGrantRow({ id, reason: summarizeInvalidFields(parsed.error.issues) })}\n`,
        );
        return null;
      }
      const current = parsed.data;
      // 既に取り消し済みなら元の revokedAt を保つ（上書きしない）。
      const revokedAt = current.revokedAt ?? at;
      const next = permissionGrantSchema.parse({ ...current, revokedAt });

      await tx
        .update(permissionGrants)
        .set({ revokedAt: new Date(revokedAt), record: next })
        .where(eq(permissionGrants.id, id));

      return next;
    });
  }

  /**
   * `PermissionGrantStore.markUsed` の doc。**`revoke` と同じ形**——1つの
   * トランザクションの中で `select … for update` により行を押さえてから
   * 読み直し、`lastUsedAt` の1本の欄だけを差し替える（`revokedAt` を含む
   * 他の欄には一切触れない）。既存より古い時刻では戻さない。
   *
   * **読めない行は「無い」と同じ `false` を返す。行にも触れない**
   * （issue #2158。`revoke` の doc と同じ理由）。
   */
  async markUsed(id: string, at: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ record: permissionGrants.record })
        .from(permissionGrants)
        .where(eq(permissionGrants.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      // 無い。**書かない。**
      if (row === undefined) return false;

      const parsed = permissionGrantSchema.safeParse(row.record);
      if (!parsed.success) {
        process.stderr.write(
          `${describeUnreadableGrantRow({ id, reason: summarizeInvalidFields(parsed.error.issues) })}\n`,
        );
        return false;
      }
      const current = parsed.data;
      // 取り消し済みなら記録しない（Issue #1687）。
      if (current.revokedAt !== undefined) return false;
      // 既存より古い時刻では戻さない。
      if (current.lastUsedAt !== undefined && current.lastUsedAt >= at) return true;

      const next = permissionGrantSchema.parse({ ...current, lastUsedAt: at });
      await tx.update(permissionGrants).set({ record: next }).where(eq(permissionGrants.id, id));
      return true;
    });
  }
}
