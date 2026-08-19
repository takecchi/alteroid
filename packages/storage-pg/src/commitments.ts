import { commitmentSchema } from '@alteroid/core';
import type { Commitment, CommitmentStore } from '@alteroid/core';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { commitments } from './schema.js';

/**
 * 行が読めなければ落とさずに投げる。
 *
 * **他のストア（jobs / journal）と作法が違うのは意図的である。** あちらは1行壊れても
 * 一覧が返るべき記録だが、こちらは「まだ片付いていない仕事」そのものなので、読めない
 * 行を黙って飛ばすと**片付いた仕事と区別が付かなくなる**。
 *
 * 区別が消えると具体的にこう壊れる: その依頼は未了の一覧からも digest からも消え、
 * クローンは引き受けたことを二度と思い出さない ＝ **この器が塞いでいる穴がそのまま
 * 開く**（しかも「忘れた」ことに誰も気づけない。fs 版なら例外で表に出る）。
 * fs 版（ファイル全体を `parse` する）と同じく、壊れた永続状態は表に出す。
 */
function parseCommitment(id: string, value: unknown): Commitment {
  const parsed = commitmentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `引き受けた仕事 ${id} が読めない形で入っている（片付いたのではない）: ${parsed.error.message}`,
  );
}

/**
 * 引き受けたまま終わっていない仕事の台帳。
 *
 * fs 版と同じ IF を満たすための別の器であって、器の違いで能力差を作らない
 * （クラウドでだけ引き受けた仕事を忘れる、が起きない）。
 */
export class PgCommitmentStore implements CommitmentStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(options?: { includeClosed?: boolean }): Promise<Commitment[]> {
    // 未了は古い順。齢が判断の材料なので、放置されているものから見せる
    const openRows = await this.#db
      .select({ id: commitments.id, commitment: commitments.commitment })
      .from(commitments)
      .where(isNull(commitments.closedAt))
      .orderBy(asc(commitments.at));
    const open = openRows.map((row) => parseCommitment(row.id, row.commitment));
    if (options?.includeClosed !== true) return open;

    const closedRows = await this.#db
      .select({ id: commitments.id, commitment: commitments.commitment })
      .from(commitments)
      .where(isNotNull(commitments.closedAt))
      .orderBy(desc(commitments.closedAt));
    return [...open, ...closedRows.map((row) => parseCommitment(row.id, row.commitment))];
  }

  async get(id: string): Promise<Commitment | null> {
    const rows = await this.#db
      .select({ commitment: commitments.commitment })
      .from(commitments)
      .where(eq(commitments.id, id))
      .limit(1);
    const row = rows[0];
    // **無いこと（そもそも引き受けていない）と、読めないことは別物である。** 前者だけが null。
    if (row === undefined) return null;
    return parseCommitment(id, row.commitment);
  }

  /**
   * 未了として開く。**冪等性は SQL 側で強制する。**
   *
   * 「select して既に在るか見てから insert」に割ると、同じ id の並行 open が両方
   * 「無い」を読んですり抜け、後の書き込みが先の行を上書きする。受信箱の合図は
   * 配り直されうる（`InboxStore` の取引）ので、その id を使う自動 open は**同じ id で
   * 二度呼ばれるのが普通**であり、上書きすれば一度片付けた仕事が開き直る。
   * `on conflict do nothing` は判定と書き込みが1操作なので、割り込む隙間が無い。
   *
   * 実際に入ったかは `returning` の行数で見る（衝突した回は0行で返る）。
   */
  async open(entry: Commitment): Promise<boolean> {
    // 依頼の本文は人間かクローンが書いた自由文なので NUL が混ざりうる
    const value = stripNulls(commitmentSchema.parse(entry));
    const inserted = await this.#db
      .insert(commitments)
      .values({
        id: value.id,
        at: new Date(value.at),
        closedAt: value.closedAt === undefined ? null : new Date(value.closedAt),
        commitment: value,
      })
      .onConflictDoNothing({ target: commitments.id })
      .returning({ id: commitments.id });
    return inserted.length > 0;
  }

  /**
   * 片付いたことを記録する。**行は消さない**（何を片付けたかが日報の材料から落ちる）。
   *
   * `where ... and closed_at is null` で「まだ閉じていない」の検査を更新そのものへ
   * 畳んである。読んでから書く形にすると、二重に届いた片付けが両方 `true` を返し、
   * 呼び出し側が「いま自分が閉じた」と誤って二重に報告する（AGENTS.md「不変条件は
   * ストアの1操作に閉じること」）。
   *
   * jsonb の中も一緒に直す。読み出しは `commitment` からなので、列だけ直しても
   * クローンが見る値は未了のままになる。
   */
  async close(id: string, at: string, reason: string): Promise<boolean> {
    const closedReason = stripNulls(reason);
    const closed = sql`jsonb_set(jsonb_set(${commitments.commitment}, '{closedAt}', ${JSON.stringify(at)}::jsonb, true), '{closedReason}', ${JSON.stringify(closedReason)}::jsonb, true)`;

    const updated = await this.#db
      .update(commitments)
      .set({ closedAt: new Date(at), commitment: closed })
      .where(and(eq(commitments.id, id), isNull(commitments.closedAt)))
      .returning({ id: commitments.id });
    return updated.length > 0;
  }
}
