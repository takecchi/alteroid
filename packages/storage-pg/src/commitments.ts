import {
  assertNoNul,
  CommitmentConflictError,
  commitmentSchema,
  commitmentVersionMatches,
  hasNul,
  UnreadableCommitmentError,
} from '@alteroid/core';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentEditedBy,
  CommitmentList,
  EditCommitmentBodyOptions,
  CommitmentOpenResult,
  CommitmentStore,
  UnreadableCommitment,
} from '@alteroid/core';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { commitments } from './schema.js';

// 読めない行を黙って飛ばさず投げる: 片付いた仕事と区別が付かなくなり、クローンが引き受けたことを二度と思い出さないため。
// `Error` ではなく `UnreadableCommitmentError` を投げる: 呼び出し側が器の障害と `instanceof` で見分けるため。
function parseCommitment(id: string, value: unknown): Commitment {
  const parsed = commitmentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new UnreadableCommitmentError(
    `引き受けた仕事 ${id} が読めない形で入っている（片付いたのではない）: ${parsed.error.message}`,
  );
}

// 1行が読めなくても投げない: 一覧が丸ごと落ちるため。
function splitReadableRows(rows: { id: string; at: Date; commitment: unknown }[]): {
  entries: Commitment[];
  unreadable: UnreadableCommitment[];
} {
  const entries: Commitment[] = [];
  const unreadable: UnreadableCommitment[] = [];
  for (const row of rows) {
    const parsed = commitmentSchema.safeParse(row.commitment);
    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      unreadable.push({
        id: row.id,
        at: row.at.toISOString(),
        reason: parsed.error.message,
      });
    }
  }
  return { entries, unreadable };
}

interface OpenProbeRow {
  inserted: string | null;
  folded_into: string | null;
  id_seen: boolean;
}

// 既定値へ倒さず投げる: 「判定できない」を静かに「既に在った」へ倒すと、記帳に失敗した回の警告も出ないため。
function readOpenProbeRow(result: unknown): OpenProbeRow {
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const row = rows[0];
  if (row === undefined)
    throw new Error('台帳への open が1行も返さなかった（ドライバの戻りの形が想定外）');
  return row as OpenProbeRow;
}

export class PgCommitmentStore implements CommitmentStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(options?: { includeClosed?: boolean }): Promise<CommitmentList> {
    const openRows = await this.#db
      .select({ id: commitments.id, at: commitments.at, commitment: commitments.commitment })
      .from(commitments)
      .where(isNull(commitments.closedAt))
      .orderBy(asc(commitments.at), asc(commitments.seq), asc(commitments.id));
    const open = splitReadableRows(openRows);
    // `includeClosed` が偽なら片付いた壊れ行を `unreadable` に入れない: 「未了の一覧」という前提が崩れるため。
    if (options?.includeClosed !== true) return { ...open, trimmedClosed: 0 };

    const closedRows = await this.#db
      .select({ id: commitments.id, at: commitments.at, commitment: commitments.commitment })
      .from(commitments)
      .where(isNotNull(commitments.closedAt))
      .orderBy(desc(commitments.closedAt), asc(commitments.seq), asc(commitments.id));
    const closed = splitReadableRows(closedRows);
    return {
      entries: [...open.entries, ...closed.entries],
      unreadable: [...open.unreadable, ...closed.unreadable],
      trimmedClosed: 0,
    };
  }

  async get(id: string): Promise<Commitment | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select({ commitment: commitments.commitment })
      .from(commitments)
      .where(eq(commitments.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return parseCommitment(id, row.commitment);
  }

  // select してから insert する形にしない: 並行 open が両方「無い」を読んですり抜け、後の書き込みが先の行を上書きして片付けた仕事が開き直るため。
  // トランザクションで直そうとしない: READ COMMITTED では、まだ存在しない行に対する排他にならず両方が insert するため。
  // 索引の鍵を全文にしない: btree の行サイズ上限（約2.7KB）で、長い報告だけが記帳できなくなるため。`md5(body)` の衝突は同時に来た2件でだけ依頼を1件落とす。鍵を変えるならこの代償ごと読み直すこと。
  async open(entry: Commitment): Promise<CommitmentOpenResult> {
    // `stripNulls` の前に見る: id の NUL を落とすと別の行を指すため。
    assertNoNul('commitment.id', entry.id);
    const value = stripNulls(commitmentSchema.parse(entry));
    const foldable = value.origin === 'manager' && value.source !== undefined;
    const closedAt = value.closedAt === undefined ? null : new Date(value.closedAt);
    const result = await this.#db.execute(sql`
      with existing as (
        select id from ${commitments}
        where ${sql.raw(foldable ? 'true' : 'false')}
          -- **自分自身を畳む相手にしない。** 同じ id の2回目は「畳んだ」ではなく
          -- 「既に在る」である（in-memory / fs は id を先に見るので最初からこの順）。
          and id <> ${value.id}
          and closed_at is null
          and commitment->>'origin' = 'manager'
          and commitment->>'source' = ${value.source ?? ''}
          and commitment->>'body' = ${value.body}
        limit 1
      ),
      ins as (
        insert into ${commitments} (id, at, closed_at, commitment)
        select
          ${value.id}::text,
          ${new Date(value.at)}::timestamptz,
          ${closedAt}::timestamptz,
          ${JSON.stringify(value)}::jsonb
        where not exists (select 1 from existing)
        on conflict do nothing
        returning id
      )
      select
        (select id from ins) as inserted,
        (select id from existing) as folded_into,
        exists (select 1 from ${commitments} where id = ${value.id}) as id_seen
    `);
    const row = readOpenProbeRow(result);
    if (row.inserted !== null) return { opened: true, folded: false };
    // `id_seen` を `folded_into` より先に見る: in-memory / fs は id の判定を先に置いており、順序が違うとここだけ答えが変わるため。
    if (row.id_seen) return { opened: false, folded: false };
    if (row.folded_into !== null)
      return { opened: false, folded: true, foldedInto: row.folded_into };
    // 区別せずに「畳んだ」と返さない: 主キーの衝突か索引の衝突か分からず、同じ id の並行 open が「畳んだ」と誤報されるため。別の文で読み直す。
    const reread = readOpenProbeRow(
      await this.#db.execute(sql`
        select
          null::text as inserted,
          (
            select id from ${commitments}
            where ${sql.raw(foldable ? 'true' : 'false')}
              and id <> ${value.id}
              and closed_at is null
              and commitment->>'origin' = 'manager'
              and commitment->>'source' = ${value.source ?? ''}
              and commitment->>'body' = ${value.body}
            limit 1
          ) as folded_into,
          exists (select 1 from ${commitments} where id = ${value.id}) as id_seen
      `),
    );
    if (reread.id_seen) return { opened: false, folded: false };
    if (reread.folded_into !== null)
      return { opened: false, folded: true, foldedInto: reread.folded_into };
    return { opened: false, folded: true };
  }

  // 行を消さない: 何を片付けたかが日報の材料から落ちるため。
  // 読んでから書く形にしない: 二重に届いた片付けが両方 `true` を返し、呼び出し側が二重に報告するため。
  // jsonb の中も直す: 読み出しは `commitment` からなので、列だけ直してもクローンが見る値は未了のままになるため。
  async close(id: string, at: string, reason: string, by: CommitmentClosedBy): Promise<boolean> {
    if (hasNul(id)) return false;
    const closedReason = stripNulls(reason);
    const closed = sql`jsonb_set(jsonb_set(jsonb_set(${commitments.commitment}, '{closedAt}', ${JSON.stringify(at)}::jsonb, true), '{closedReason}', ${JSON.stringify(closedReason)}::jsonb, true), '{closedBy}', ${JSON.stringify(by)}::jsonb, true)`;

    const updated = await this.#db
      .update(commitments)
      .set({ closedAt: new Date(at), commitment: closed })
      .where(and(eq(commitments.id, id), isNull(commitments.closedAt)))
      .returning({ id: commitments.id });
    return updated.length > 0;
  }

  // `close()` をこの薄い包みにしない: 動いている単票の `close()` を書き換えるリスクを増やさないため。
  // 空配列を `inArray` へ渡さない: 方言によって `WHERE id IN ()` が構文として不正になりうるため。
  async closeMany(
    ids: readonly string[],
    at: string,
    reason: string,
    by: CommitmentClosedBy,
  ): Promise<string[]> {
    const queryable = ids.filter((id) => !hasNul(id));
    if (queryable.length === 0) return [];
    const closedReason = stripNulls(reason);
    const closed = sql`jsonb_set(jsonb_set(jsonb_set(${commitments.commitment}, '{closedAt}', ${JSON.stringify(at)}::jsonb, true), '{closedReason}', ${JSON.stringify(closedReason)}::jsonb, true), '{closedBy}', ${JSON.stringify(by)}::jsonb, true)`;

    const updated = await this.#db
      .update(commitments)
      .set({ closedAt: new Date(at), commitment: closed })
      .where(and(inArray(commitments.id, [...queryable]), isNull(commitments.closedAt)))
      .returning({ id: commitments.id });
    return updated.map((row) => row.id);
  }

  // 読んでから書く形にしない: 「編集」と「片付け」の競合で後勝ちが黙って先の書き込みを踏み消すため。
  // `origin` の判定を `where` へ畳まない: `origin` は開いたときから変わらず、並行 UPDATE と競合しないため。
  // 例外: `ifMatch` ありのときだけ、行ロック（`for update`）の中で読んで比べる。照合と書き込みのあいだに別の書き込みが入らないため。
  async editBody(
    id: string,
    body: string,
    at: string,
    by: CommitmentEditedBy,
    options?: EditCommitmentBodyOptions,
  ): Promise<boolean> {
    const ifMatch = options?.ifMatch;
    if (hasNul(id)) {
      if (ifMatch !== undefined) throw new CommitmentConflictError(id, null);
      return false;
    }
    const editedBody = stripNulls(body);
    const edited = sql`jsonb_set(jsonb_set(jsonb_set(${commitments.commitment}, '{body}', ${JSON.stringify(editedBody)}::jsonb, true), '{editedAt}', ${JSON.stringify(at)}::jsonb, true), '{editedBy}', ${JSON.stringify(by)}::jsonb, true)`;

    // `ifMatch` 省略も行ロックの後に読めるかを確かめる: 1文の update だと読めない行の JSON へ黙って書き、「編集できた」と答えるため。
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select({ closedAt: commitments.closedAt, commitment: commitments.commitment })
        .from(commitments)
        .where(eq(commitments.id, id))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        if (ifMatch !== undefined) throw new CommitmentConflictError(id, null);
        return false;
      }
      if (row.closedAt !== null) return false;
      const current = parseCommitment(id, row.commitment);
      if (ifMatch !== undefined && !commitmentVersionMatches(current, ifMatch)) {
        throw new CommitmentConflictError(id, current);
      }
      await tx.update(commitments).set({ commitment: edited }).where(eq(commitments.id, id));
      return true;
    });
  }

  // `origin` / `source` は jsonb の欄をそのまま見る: 読めない形の行も同じ条件で消え、fs と答えが揃うため。
  async removeForConversation(conversationId: string): Promise<number> {
    if (hasNul(conversationId)) return 0;
    const removed = await this.#db
      .delete(commitments)
      .where(
        // クローンが載せた行（`self`）も消す:その会話から生まれた仕事で、本文は人間の発言の言い換えを含みうるため
        sql`${commitments.commitment}->>'origin' in ('human', 'self') and ${commitments.commitment}->>'source' = ${conversationId}`,
      )
      .returning({ id: commitments.id });
    return removed.length;
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(commitments).returning({ id: commitments.id });
    return removed.length;
  }
}
