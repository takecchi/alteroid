import { commitmentSchema, UnreadableCommitmentError } from '@alteroid/core';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentEditedBy,
  CommitmentList,
  CommitmentStore,
  UnreadableCommitment,
} from '@alteroid/core';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { commitments } from './schema.js';

/**
 * 行が読めなければ落とさずに投げる。**`get(id)` 専用**（issue #296 以降。下記）。
 *
 * **他のストア（jobs / journal）と作法が違うのは意図的である。** あちらは1行壊れても
 * 一覧が返るべき記録だが、こちらは「まだ片付いていない仕事」そのものなので、読めない
 * 行を黙って飛ばすと**片付いた仕事と区別が付かなくなる**。
 *
 * 区別が消えると具体的にこう壊れる: その依頼は未了の一覧からも digest からも消え、
 * クローンは引き受けたことを二度と思い出さない ＝ **この器が塞いでいる穴がそのまま
 * 開く**（しかも「忘れた」ことに誰も気づけない。fs 版なら例外で表に出る）。
 * fs 版（ファイル全体を `parse` する）と同じく、壊れた永続状態は表に出す。
 *
 * **⚠️ throw そのものは意図的である（理由は上の段落）。問題はそこではなく、
 * 未知の enum 値（例えば `origin`）でもここへ落ちること。** `list()`（下）は
 * try/catch なしで `map` しているため、未知の enum 値が1件でも入ると、
 * 1行ではなく一覧が丸ごと落ちる。→ issue #296
 *
 * **issue #296 で直したのは `list()` 側であって、この関数ではない。**
 * `get(id)` は単票であり、守るべき一覧が無い。「無い（`null`）」と「読めない
 * （throw）」の区別は `get` にとって依然として意味があるので、ここはそのまま
 * throw する。1行読めなくても一覧は返る、という直しは `list()` が
 * `commitmentSchema.safeParse` を行ごとに使う形で別に持つ（下の
 * `splitReadableRows`）。
 *
 * **投げる型は `Error` ではなく `UnreadableCommitmentError`（`@alteroid/core`）
 * である。** 呼び出し側（`commitment_list` ツールの全文モード、`tools.ts`）が
 * 「行が読めない」と「器そのものの障害（DB 接続断など）」を `instanceof` で
 * 見分けられるようにするため（`UnreadableCommitmentError` の doc）。
 */
function parseCommitment(id: string, value: unknown): Commitment {
  const parsed = commitmentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new UnreadableCommitmentError(
    `引き受けた仕事 ${id} が読めない形で入っている（片付いたのではない）: ${parsed.error.message}`,
  );
}

/**
 * `list()` の行ごとの読み出し。**`parseCommitment` と違い、1行が読めなくても
 * 投げない** — 読めた行は `entries` へ、読めなかった行は `unreadable` へ回す
 * （issue #296）。
 *
 * **id と at は列（`commitments.id` / `commitments.at`）から取る。** jsonb の
 * 中身（`value`）が読めなくても、この2列は別に読めるという pg 版の強みを使う
 * — id が取れないことがある fs 版（本体が id を持たない生の値のとき）とは
 * ここが違う。
 */
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

  async list(options?: { includeClosed?: boolean }): Promise<CommitmentList> {
    // 未了は古い順。齢が判断の材料なので、放置されているものから見せる
    const openRows = await this.#db
      .select({ id: commitments.id, at: commitments.at, commitment: commitments.commitment })
      .from(commitments)
      .where(isNull(commitments.closedAt))
      .orderBy(asc(commitments.at));
    const open = splitReadableRows(openRows);
    // **`includeClosed` が偽なら未了の行しか読まないので、`unreadable` にも
    // 未了の行しか入らない。これは意図どおりである** — 片付いた壊れ行まで
    // 見せると「未了の一覧」という前提が崩れる。fs 版は逆に、読めない行を
    // 常に未了扱いで安全側へ倒すため `includeClosed` の真偽に関わらず出す
    // （`storage-fs/src/commitments.ts` の doc に差を明記してある）。
    //
    // **`trimmedClosed` は常に `0`（issue #416）。** pg 版は片付いた行を
    // 物理削除する経路を1つも持たない——`close()` の契約（「行は消さない」）
    // を破っていないので、0 は「削除を数えていない」ではなく「削除が
    // 起きていない」を正しく表す（`CommitmentList.trimmedClosed` の doc、
    // `packages/core/src/store.ts`）。
    if (options?.includeClosed !== true) return { ...open, trimmedClosed: 0 };

    const closedRows = await this.#db
      .select({ id: commitments.id, at: commitments.at, commitment: commitments.commitment })
      .from(commitments)
      .where(isNotNull(commitments.closedAt))
      .orderBy(desc(commitments.closedAt));
    const closed = splitReadableRows(closedRows);
    return {
      entries: [...open.entries, ...closed.entries],
      unreadable: [...open.unreadable, ...closed.unreadable],
      trimmedClosed: 0,
    };
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
   * **ここは `CommitmentStore.close` の契約をそのまま守っている。** 保持上限も
   * 削除経路も1つも持たないので、`list()` が返す `trimmedClosed` は常に `0`
   * である。**fs 版（`storage-fs/src/commitments.ts`）はこの契約を守れていない
   * ——`CLOSED_HISTORY_LIMIT` を超えた古い片付き行を物理削除する**（issue #416）。
   *
   * `where ... and closed_at is null` で「まだ閉じていない」の検査を更新そのものへ
   * 畳んである。読んでから書く形にすると、二重に届いた片付けが両方 `true` を返し、
   * 呼び出し側が「いま自分が閉じた」と誤って二重に報告する（AGENTS.md「不変条件は
   * ストアの1操作に閉じること」）。
   *
   * jsonb の中も一緒に直す。読み出しは `commitment` からなので、列だけ直しても
   * クローンが見る値は未了のままになる。
   *
   * **⚠️ 読めない行（`commitment` が `commitmentSchema` に合わない行）に対する
   * 挙動は、fs 版とここで割れる（issue #296。「言えないこと」として書く）。**
   * ここ（pg 版）は `closed_at` が **jsonb（`commitment`）とは独立した列**
   * なので、`commitment` が読めない形でも `jsonb_set` は素の JSON 操作として
   * 通り、`where ... and closed_at is null` も列だけを見て判定できる。
   * **＝ 読めない行でも `close()` は `true` を返し、実際に `closed_at` が
   * 進む。** fs 版は `closed_at` に当たる独立した列を持たず、「閉じている
   * かどうか」の判定材料が読めなかった行の中身（`closedAt`）そのものしか
   * 無いため、読めない行は `close()` の対象として見つけられず常に `false`
   * を返す（`storage-fs/src/commitments.ts` の `close` の doc）。
   *
   * **これは north_star 禁止1（器の違いで能力差を作らない）への違反では
   * ない。** fs 版に pg のこの列に当たるものが無い以上、同じ検査を書きようが
   * ない — 揃えたふりをして無理に合わせるほうが、無いものをあるかのように
   * 見せることになる。
   *
   * **実際にこの差を踏む経路は `POST /commitments/:id/close`（`apps/daemon/
   * src/app.ts`）だけである。** MCP の `commitment_close` ツール（`tools.ts`）
   * は `close()` の前に必ず `stores.commitments.get(id)` を呼ぶので、読めない
   * 行では `get` が先に throw し、`close()` へは到達しない — **こちらは
   * pg / fs のどちらでも同じ結末（throw）になる。** 割れるのは HTTP の口が
   * `close()` を先に呼び、失敗したときだけ理由を求めて `get()` を呼ぶ
   * 作りになっている、その一点だけである。
   */
  async close(id: string, at: string, reason: string, by: CommitmentClosedBy): Promise<boolean> {
    const closedReason = stripNulls(reason);
    const closed = sql`jsonb_set(jsonb_set(jsonb_set(${commitments.commitment}, '{closedAt}', ${JSON.stringify(at)}::jsonb, true), '{closedReason}', ${JSON.stringify(closedReason)}::jsonb, true), '{closedBy}', ${JSON.stringify(by)}::jsonb, true)`;

    const updated = await this.#db
      .update(commitments)
      .set({ closedAt: new Date(at), commitment: closed })
      .where(and(eq(commitments.id, id), isNull(commitments.closedAt)))
      .returning({ id: commitments.id });
    return updated.length > 0;
  }

  /**
   * `body` を書き換える。**`close()` と同じく、条件付き UPDATE 1本へ畳む**
   * （`where ... and closed_at is null`）——読んでから書く形にすると、並行
   * 編集や「編集」と「片付け」の競合で後勝ちが黙って先の書き込みを踏み消す
   * （AGENTS.md「不変条件はストアの1操作に閉じること」）。
   *
   * **`origin` が `'human'` かどうかの判定はここでは行わない**
   * （`CommitmentStore.editBody` の doc）。`origin` は開いたときから決して
   * 変わらない値なので並行 UPDATE と競合せず、SQL の `where` へ畳む必要が
   * ない——判定は呼び出し側（`apps/daemon/src/app.ts` の
   * `PATCH /commitments/:id`）が `get()` の結果を見て行う。
   *
   * jsonb の中も一緒に直す。読み出しは `commitment` からなので、`body` の
   * 実体（jsonb 側）を直さないとクローンが見る値は古いままになる。列
   * （`commitments.id` 等）には `body` に対応するものが無いので、`set()`
   * では `commitment` だけを更新する（`closedAt` 列は触らない）。
   *
   * 依頼の本文は人間が書いた自由文なので、`open()` と同じ理由で
   * `stripNulls` を通す（NUL が混ざりうる）。
   */
  async editBody(id: string, body: string, at: string, by: CommitmentEditedBy): Promise<boolean> {
    const editedBody = stripNulls(body);
    const edited = sql`jsonb_set(jsonb_set(jsonb_set(${commitments.commitment}, '{body}', ${JSON.stringify(editedBody)}::jsonb, true), '{editedAt}', ${JSON.stringify(at)}::jsonb, true), '{editedBy}', ${JSON.stringify(by)}::jsonb, true)`;

    const updated = await this.#db
      .update(commitments)
      .set({ commitment: edited })
      .where(and(eq(commitments.id, id), isNull(commitments.closedAt)))
      .returning({ id: commitments.id });
    return updated.length > 0;
  }
}
