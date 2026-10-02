import {
  createUnreadableRowOnce,
  permissionGrantSchema,
  UnreadablePermissionGrantError,
  unreadableRowKey,
} from '@alteroid/core';
import type {
  PermissionGrant,
  PermissionGrantStore,
  RemoveUnreadableRowsOptions,
  RemoveUnreadableRowsResult,
  UnreadableRowOnce,
} from '@alteroid/core';
import { asc, eq, inArray } from 'drizzle-orm';

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
 * 読めなかった行を stderr へ1行で要約する（issue #2158。`list()` / `get()`
 * からも呼ぶようになったのは issue #2191）。**id 以外の値は絶対に載せない**
 * ——`record` の欄には人間の依頼文・承認の回答の原文がそのまま入りうる
 * （`jobs.ts` の `describeUnreadableJobRow` の doc、#52 と同じ理由）。
 *
 * **呼び出し元によって「1回だけ」の扱いが違う。** `list()` / `get()` は
 * `#unreadableOnce`（`UnreadableRowOnce`）を通してから呼ぶので、同じ行には
 * インスタンスの生存中1回しか出ない。`revoke()` / `markUsed()` は素通しで
 * 毎回呼ぶ——名指しで触った操作の結果は、たとえ直前の `list()` で同じ行を
 * 知らせていても、その場で確実に知らせる（issue #2191 の要件）。
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

  /**
   * `list()` / `get()` が読めなかった行を、インスタンスの生存中「1回だけ」
   * 知らせるための追跡器（issue #2191）。**`revoke()` / `markUsed()` の
   * `describeUnreadableGrantRow` の呼び出しはこれを経由しない**——あちらは
   * 名指しで触った操作の結果を毎回知らせる、という別の約束のままにしてある
   * （このファイル冒頭の各メソッドの doc）。
   */
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

  async get(id: string): Promise<PermissionGrant | null> {
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
   * 行に触れない**（issue #2158）。**戻りは `null`（無い）ではなく
   * `UnreadablePermissionGrantError` を投げる**（issue #2425。fs 実装と同じ線。
   * 投げても許可が余計に通ることは無い——読めない行は `list()` / `get()` に
   * 現れない）。
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
        throw new UnreadablePermissionGrantError({ id });
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
   * 読めない行を id で指して消す（`PermissionGrantStore.removeUnreadable` の doc。issue #2440）。
   * **pg の許可の記録も同じ穴を持つ**——`record`（jsonb）が `permissionGrantSchema` に合わない行を
   * 作れ、`revoke` は `UnreadablePermissionGrantError` を投げて触らない（#2425）。
   *
   * 1. 指された id がすべて読めない行か確かめる（1つでも違えば何も消さず `unknown`）。
   * 2. 日誌（`beforeRemove`）を呼ぶ。**投げたら何も消さずに投げ直す。** トランザクションの
   *    外で呼ぶ——日誌ストアが同じ接続を使う器（PGlite など）で、開いたままのトランザクションが
   *    日誌の書き込みを待たせ続ける形を作らない。
   * 3. **1つのトランザクションの中で、指された行を `select … for update` で押さえ直し、まだ全部が
   *    読めない行なら、その id だけを `delete` する。** 1と3のあいだに変わっていたら何も消さずに
   *    `unknown`（読める行は消さない）。
   *
   * **値は返さない（id だけ）。** 読める行には触れない。
   */
  async removeUnreadable(
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions = {},
  ): Promise<RemoveUnreadableRowsResult> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return { kind: 'unknown', count: 0 };
    const unknownCount = async (executor: Pick<Db, 'select'>, lock: boolean): Promise<number> => {
      const query = executor
        .select({ id: permissionGrants.id, record: permissionGrants.record })
        .from(permissionGrants)
        .where(inArray(permissionGrants.id, wanted));
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
