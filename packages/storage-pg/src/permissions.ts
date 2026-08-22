import { permissionRuleSchema } from '@alteroid/core';
import type { PermissionRule, PermissionStore } from '@alteroid/core';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { permissions } from './schema.js';

/**
 * 行が読めなければ落とさずに投げる（`commitments.ts` の `parseCommitment` と同じ作法）。
 *
 * **飛ばしてはいけない理由がここは特に強い。** 読めない行を黙って落とすと、その規則は
 * 一覧からも、セッションへ渡す許可の全量からも消える ＝ **人間が許したはずの許可が、
 * 誰にも気づかれないまま効かなくなる。** しかも一覧に出ないので「許可を足したのに
 * 通らない」の原因が辿れない。壊れた永続状態は表に出す。
 */
function parsePermission(id: string, value: unknown): PermissionRule {
  const parsed = permissionRuleSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `実行許可 ${id} が読めない形で入っている（取り消されたのではない）: ${parsed.error.message}`,
  );
}

/**
 * 人間が開けた実行許可の台帳。
 *
 * fs 版と同じ IF を満たすための別の器であって、器の違いで能力差を作らない
 * （クラウドでだけ許可を開けられない、が起きない）。
 */
export class PgPermissionStore implements PermissionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 許可した順（古い順）。**件数で切らない。** */
  async list(): Promise<PermissionRule[]> {
    const rows = await this.#db
      .select({ id: permissions.id, permission: permissions.permission })
      .from(permissions)
      .orderBy(asc(permissions.grantedAt));
    return rows.map((row) => parsePermission(row.id, row.permission));
  }

  async get(id: string): Promise<PermissionRule | null> {
    const rows = await this.#db
      .select({ permission: permissions.permission })
      .from(permissions)
      .where(eq(permissions.id, id))
      .limit(1);
    const row = rows[0];
    // **無いこと（許していない）と、読めないことは別物である。** 前者だけが null。
    if (row === undefined) return null;
    return parsePermission(id, row.permission);
  }

  /**
   * 1件許す。**重複しないことを SQL 側で強制する。**
   *
   * 一意なのは `id` ではなく **`rule`** である（`permissions_rule_idx`）。「select して
   * 既に在るか見てから insert」に割ると、同じ規則の並行 grant が両方すり抜けて
   * **同じ規則が2行になる**。そうなると人間が1行消しても規則は効いたままで、
   * 「消したのに効き続ける」＝ 増やす口だけが片道で開く形になる。
   * `on conflict do nothing` は判定と書き込みが1操作なので、割り込む隙間が無い。
   *
   * 実際に入ったかは `returning` の行数で見る（衝突した回は0行で返る）。
   */
  async grant(entry: PermissionRule): Promise<boolean> {
    // 規則も note も人間が書いた自由文なので NUL が混ざりうる
    const value = stripNulls(permissionRuleSchema.parse(entry));
    const inserted = await this.#db
      .insert(permissions)
      .values({
        id: value.id,
        rule: value.rule,
        grantedAt: new Date(value.grantedAt),
        permission: value,
      })
      .onConflictDoNothing({ target: permissions.rule })
      .returning({ id: permissions.id });
    return inserted.length > 0;
  }

  /**
   * 1件取り消す。**行を消す**（残すと、効いていない規則が一覧に並ぶ）。
   *
   * 消えた記録は日誌が持つ（追記専用なので、いつ誰が外したかはそちらに残る）。
   */
  async revoke(id: string): Promise<boolean> {
    const deleted = await this.#db
      .delete(permissions)
      .where(eq(permissions.id, id))
      .returning({ id: permissions.id });
    return deleted.length > 0;
  }
}
