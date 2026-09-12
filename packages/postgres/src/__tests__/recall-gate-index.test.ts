import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryStatus } from "@mnemora/core";
import { defaultDecayStrategy } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 誤り1の修正の検査（マネージャー指摘）:
 *
 * `docs/memory-model.md` §10 の原案は `idx_memories_recall_gate` の述語を
 * `WHERE status = 'active'` としていたが、これでは `contested` な Memory が段1の
 * 候補集合にそもそも入らず、「争われている主張を、争われていない顔で出さない」
 * （mandatory companion retrieval、docs/memory-model.md §5・docs/recall.md §8）が
 * 実装として成立しない。PR #3 で述語を `WHERE status IN ('active', 'contested')` に
 * 修正した（`migrations/0001_init.sql`）。
 *
 * ---
 *
 * ## 2026-09-12 の書き直し（Issue #150）——この歯は何を測るのをやめたか
 *
 * PR #3 のこのファイルは「`EXPLAIN` の出力に `idx_memories_recall_gate` という
 * **文字列が現れること**」を assert していた。これが CI で落ちた（2026-09-10T08:23Z、
 * `main` の run 34454868730、ジョブ `root-gate-db-stage`）。**落ちたときの計画全文**
 * （CI ログから。Issue #150 では先頭40文字しか見えていなかった部分）:
 *
 * ```
 * Limit  (cost=239.51..239.64 rows=50 width=33)
 *   ->  Sort  (cost=239.51..243.51 rows=1600 width=33)
 *         Sort Key: decay_floor_at
 *         ->  Bitmap Heap Scan on memories  (cost=16.36..186.36 rows=1600 width=33)
 *               Recheck Cond: ((tenant_id = 'recall-gate-tenant'::text) AND (status = ANY ('{active,contested}'::text[])))
 *               Filter: (decay_floor_at > (now() - '1000 days'::interval))
 *               ->  Bitmap Index Scan on idx_memories_lexical  (cost=0.00..15.96 rows=1600 width=0)
 *                     Index Cond: (tenant_id = 'recall-gate-tenant'::text)
 * ```
 *
 * 🔑 **プランナは索引を捨てていない。別の索引を選んだだけである。**
 * しかも選ばれた `idx_memories_lexical`（`migrations/0008_memories_lexical_index.sql`、
 * 2026-09-10T00:02Z に `main` へ着地）の部分述語は
 * `WHERE status IN ('active', 'contested')`——**この索引と同一**である。
 * ⟹ **その計画は、この歯が守りたかったことを何も壊していない。**候補集合には
 * `contested` が入っており、段1は `memories` を全走査してもいない。
 * 壊れたのは**歯の書き方**のほうであって、実装でも索引でもなかった。
 *
 * 🔑 **「プランナがこの索引を選んだ」と「この索引がこの述語に使える」は別の主張である。**
 * 前者はコスト見積り（行数・統計・行幅・版のコスト定数・**そして他にどんな索引が
 * 在るか**）に依存する。⟹ **同じ部分述語を持つ索引が1本足されるだけで、実装が
 * 正しいまま赤くなる。**実際そうなった（0008 の着地から8時間後に最初の失敗）。
 * 後者は索引と述語の性質であり、コストにも他の索引の有無にも依存しない。
 * **この歯が守りたかったのは後者**であって、前者はその代理でしかなかった。
 *
 * ⟹ 以下では性質の側だけを assert する:
 * - **歯1（形）**: `pg_index` から索引の列順と部分述語そのものを読む。プランナを通さない。
 * - **歯2（適用可能性）**: seq scan と bitmap scan を外したとき、プランナが
 *   **この索引を選べる**こと＝関門の述語 `status = ANY($2)` が部分述語
 *   `status IN ('active','contested')` を**含意する**こと。含意しなければ、
 *   どれだけコストを歪めてもこの索引は選ばれない。
 * - **歯3（同値）**: 自然な計画・索引を強制した計画・全走査を強制した計画の3経路が
 *   **同じ行集合**を返すこと。強制した側だけを測ると「索引経路が行を弾いていないこと」が
 *   測れない（マネージャー指摘）。
 *
 * ### ⛔ この歯が、もう保証しないこと
 *
 * **本番でこの索引が実際に選ばれること**を、この歯はもう保証しない。強制を入れた以上
 * それは当然であり、**名乗らずに緑にすることはしない。**
 *
 * ⚠ とくに **`enable_bitmapscan = off` は `idx_memories_lexical` を構造ごと候補から外す**
 * ——GIN 索引は bitmap 経由でしか使えないからである。つまり歯2は
 * 「**btree の索引経路に限れば**この索引が選ばれる」までしか言っていない。
 * 上の CI の計画が示すとおり、**本番のプランナは GIN のほうを選ぶことがある。**
 *
 * 段1のクエリでプランナが `memories` を全走査しないことを測っているのは
 * `vector-search-provenance.test.ts` の歯B（`memories` 本体の `Seq Scan` が現れないこと、
 * 選択性に依存しない不変だけを assert する形）である。**そちらが落ちたら、それは
 * 本番の経路が壊れた合図**であり、この歯が緑であることは何の慰めにもならない。
 *
 * ### ⚠ 自然な計画に `not.toMatch(/Seq Scan on memories/)` すら書かない理由
 *
 * 書きたくなるが、**この seed ではそれも保証できない。**seed は1テナント・4000行・
 * `decay_floor_at > now() - interval '1000 days'`（全行が通る）で、`status` は5値のうち
 * 2値＝**候補は全体の40%**。40%が散らばって当たるので、索引を使っても**ヒープのページは
 * ほぼ全部読む**——実測（PGlite 0.5.8 / PostgreSQL 18.3 相当、GIN 索引なしの条件）で
 * `Bitmap Heap Scan` の `Heap Blocks: exact=125` に対しテーブル全体も125ページ、
 * `Buffers: shared hit=134` 対 `Seq Scan` の `125` だった。**索引は I/O を1ページも
 * 節約していない。**コスト差も `202.23` 対 `255.00`（約1.2倍）しかなく、行幅・版の
 * コスト定数・統計が少し動けば順位が入れ替わる。**入れ替わっても実装は壊れていない。**
 * ⟹ この索引が本当に効くのは `tenant_id` が選択的なとき（多テナント）と、Phase 2 が
 * `WHERE decay_floor_at > now()` で大半を刈るときであって、**この seed の形ではない。**
 *
 * ### 測った版・測っていないこと
 *
 * - 上の CI の計画は **`pgvector/pgvector:pg17`**（run 34454868730 のログから逐語）。
 * - ページ数・コストの比較は **PGlite 0.5.8（PostgreSQL 18.3 相当、WASM）** での実測で、
 *   **本物の PostgreSQL でも CI でも実行していない。**コスト定数・並列度・行幅が
 *   本物と一致する保証は無い。**傍証であって証拠ではない。**
 * - **このファイルの assert が CI で通るかどうかは、次の CI 実行が唯一の実測経路である。**
 * - **この歯が実際に噛むことは、手で変異を当てて確かめた**（この repo に変異試験の
 *   ハーネスは無い）。`idx_memories_recall_gate` の定義に M1「述語を `status = 'active'` へ戻す」/
 *   M2「列順を入れ替える」/ M3「部分述語を落とす」/ M4「3列目を落とす」を1本ずつ当て、
 *   **4本とも赤くなること**を確認した。⭐ 陰性対照として N1「述語を
 *   `status = ANY (ARRAY['contested','active'])` と書き換える（**意味は同一、字面だけ違う**）」/
 *   N2「`CREATE INDEX` にコメントと改行を足す」/ N3「このファイルのコメント文言だけを変える」も
 *   当て、**3本とも生存する**ことを確認した。⟹ N1 が生きていることが、歯1が
 *   **式ではなく性質**（どの status が入るか）を測っている証拠である。詳細と逐語は ADR 0104。
 *
 * **自然な計画は `console.log` で CI ログに全文を残す**（assert はしない）。
 * Issue #150 が「落ちたときに計画全文を出す」を案に挙げたのはこれが理由で、失敗メッセージが
 * 計画を先頭40文字で切ってしまい、**何が選ばれたのか**が読めなかった。
 * **この出力を削らないこと**（`contested-with-index.test.ts` /
 * `lexical-store-index.test.ts` と同じ作法）。
 */

const TENANT = "recall-gate-tenant";

/**
 * 4000行は PR #3 から変えていない——**理由は変わった。**
 * 元の理由は「btree の partial index をシーケンシャルスキャンより優先させるため」だったが、
 * 上のとおりこの形では 40% 選択性のせいで優先されるとは限らず、**その理由はもう成り立たない。**
 * いま行数を保っているのは (1) 自然な計画の観測を Issue #150 に記録された計画と
 * 比べられる形で残すため (2) 数行しかないテーブルの計画には読む価値が無いため、の2つ。
 * ⟹ **歯1・歯2・歯3 はいずれも行数に依存しない。**減らしたくなったら減らしてよい
 * （失うのはログの情報量だけである）。
 */
const ROW_COUNT = 4000;

/** 段1の関門が候補に含める status。索引の部分述語と同じ集合であること自体を歯1が測る。 */
const GATE_STATUSES = ["active", "contested"] as const;

/**
 * 段1の関門クエリ（`docs/memory-model.md` §10・`docs/recall.md` §5 から起こしたもの）。
 *
 * ⚠ **これは本番のコードが実際に発行している SQL ではない。**Phase 1 の実装に
 * この形の関門クエリを組み立てる関数は無い（2026-09-12 に
 * `grep -rn "^export function build.*Select" packages/postgres/src` で確認できるのは
 * `buildRequeueEmbedTargetSelect` と `buildLexicalSearchSelect` の2本だけ）。
 * ⟹ **Phase 2 でこの関門を本体が打ち始めたら、SQL は本体側へ移し、歯はその関数の
 * 返り値をそのまま `EXPLAIN` すること**——テスト側に SQL を写したままだと、本体の述語を
 * 直したときに歯だけが古い述語を測り続ける（`memories-requeue-embed-index.test.ts` の
 * `buildRequeueEmbedTargetSelect` がまさにそのために切り出されている）。
 * **この注意書きは、いま守れていない作法の借りである。**
 *
 * `ORDER BY` に `id` を足してある（PR #3 には無かった）。`buildNewMemoryFixture` は
 * `recordedAt` を固定値で返すので、**seed した4000行の `decay_floor_at` は全部同じ値**になる
 * ——同値が並ぶと `LIMIT 50` が返す50行は計画ごとに変わりうる。歯3が3つの計画の行集合を
 * 突き合わせる以上、順序は全順序でなければならない
 * （`buildRequeueEmbedTargetSelect` が `ORDER BY updated_at ASC, id ASC` と書くのと同じ理由）。
 */
const GATE_SELECT = `SELECT id, status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[]) AND decay_floor_at > now() - interval '1000 days'
       ORDER BY decay_floor_at, id
       LIMIT 50`;

const GATE_PARAMS: [string, string[]] = [TENANT, [...GATE_STATUSES]];

async function insertManyMemories(
  store: PostgresMemoryStore,
  ctx: Ctx,
  statuses: MemoryStatus[],
  pool: Pool,
) {
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const status = statuses[i % statuses.length]!;
    await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, status }));
  }
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引を選んでしまう
  // （実測: ANALYZE 無しでは idx_memories_provenance_kind が選ばれることがあった）。
  // ⚠ `ANALYZE` は GIN の pending list を片付けない（それは VACUUM /
  //   gin_clean_pending_list の仕事である）。競合する索引 idx_memories_lexical が
  //   GIN であることと合わせて、**自然な計画は run ごとに揺れうる**——これが
  //   Issue #150 の「同じコスト値なのに毎回は落ちない」の説明になりうる（⚠ 未検証の見立て）。
  await pool.query("ANALYZE memories");
}

/**
 * プランナに何を禁じるか。
 * - `none`: 既定＝本番と同じ条件。**assert には使わない**（観測とログのため）。
 * - `btreeIndex`: seq scan と bitmap scan を外す。bitmap を外すのは、GIN 索引
 *   （`idx_memories_lexical`）が bitmap 経由でしか使えず、外さないとそちらが選ばれるため
 *   ——**CI で実際にそうなった**（このファイル冒頭の計画）。
 * - `seqscan`: 索引経路を全部外す。歯3の**基準**（索引の形に一切依存しない答え）。
 */
type Forcing = "none" | "btreeIndex" | "seqscan";

/**
 * 別接続・別トランザクションで `SET LOCAL` し、`ROLLBACK` で設定を後に残さない
 * （`count-over-window.test.ts` の `countWithSeqScanDisabled` と同じ形。プールを
 * 共有しているので、設定が接続に残ると他のテストの計画まで変えてしまう）。
 *
 * ⚠ `enable_seqscan = off` は seq scan を**禁止しない**——莫大なコストを足して後回しに
 * するだけである。だから歯2は「seq scan が出ないこと」だけでなく「**この索引の名前が
 * 出ること**」も見る。述語が含意されず索引が適用できないとき、プランナは（高コストを
 * 承知で）seq scan へ戻るか、`tenant_id` を先頭に持つ別の btree へ逃げる
 * （`idx_memories_by_subject` / `idx_memories_provenance_kind`）——どちらでも赤くなる。
 */
async function withForcing<T>(
  pool: Pool,
  forcing: Forcing,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (forcing === "btreeIndex") {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    } else if (forcing === "seqscan") {
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    }
    return await fn(client);
  } finally {
    // ⚠ `release()` を `ROLLBACK` の外側へ出してある。`count-over-window.test.ts` は
    //   同じ finally の中に並べて書いているが、**`ROLLBACK` が投げると `release()` に
    //   到達せず、その接続はプールへ戻らないまま失われる**（プールは共有なので、
    //   詰まったときに落ちるのはこのファイルではなく後続のテストである）。
    //   ここは1テストにつき最大3回通るので、取りこぼしの機会も3倍になる。
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function explainGate(pool: Pool, forcing: Forcing): Promise<string> {
  return withForcing(pool, forcing, async (client) => {
    const result = await client.query(`EXPLAIN (FORMAT TEXT) ${GATE_SELECT}`, GATE_PARAMS);
    return result.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
  });
}

async function gateRowIds(pool: Pool, forcing: Forcing): Promise<string[]> {
  return withForcing(pool, forcing, async (client) => {
    const result = await client.query<{ id: string }>(GATE_SELECT, GATE_PARAMS);
    return result.rows.map((row) => row.id);
  });
}

describe("idx_memories_recall_gate (誤り1の修正)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /**
   * 歯1（形）: プランナを一切通さずに、索引が**誤り1の修正後の形**をしているかを
   * catalog から読む。行数にも統計にも他の索引の有無にも依存しない。
   *
   * 列の判定に `pg_indexes.indexdef`（DDL 文字列）の部分一致を使わない——PR #3 の旧・
   * 第2テストは `indexdef` に `"status"` が含まれることを見ていたが、これは**部分述語の中の
   * `status`** にも当たるため、「列から `status` を落として述語にだけ残す」という壊れ方を
   * 検出できなかった。`pg_index.indkey` が指す `pg_attribute.attnum` は表記に依存しない実体である
   * （`contested-with-index.test.ts` の「索引の形」の歯と同じ作法）。
   *
   * 述語の突き合わせは `pg_get_expr` の**全体一致**ではなく**現れるリテラルの集合**で行う。
   * `status IN ('active','contested')` が `(status = ANY (ARRAY['active'::text, ...]))` と
   * 展開されるかどうかは版の表記の都合であり、**測りたいのは「どの status が入るか」**だからである。
   */
  it("形: idx_memories_recall_gate は (tenant_id, status, decay_floor_at) の3列で、部分述語が拾う status は active と contested の2つちょうど", async () => {
    const { pool } = await getTestClient();

    const shape = await pool.query<{
      col0: string | null;
      col1: string | null;
      col2: string | null;
      natts: number;
      is_partial: boolean;
      pred_expr: string | null;
      is_valid: boolean;
    }>(
      `SELECT
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) AS col0,
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[1]) AS col1,
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[2]) AS col2,
         i.indnatts AS natts,
         i.indpred IS NOT NULL AS is_partial,
         pg_get_expr(i.indpred, i.indrelid) AS pred_expr,
         i.indisvalid AS is_valid
       FROM pg_index i
       WHERE i.indexrelid = 'idx_memories_recall_gate'::regclass`,
    );

    expect(shape.rows).toHaveLength(1);
    const row = shape.rows[0]!;
    // 列順（docs/memory-model.md §10 / docs/recall.md §5 が要求する形）。
    expect([row.col0, row.col1, row.col2]).toEqual(["tenant_id", "status", "decay_floor_at"]);
    expect(row.natts).toBe(3);
    expect(row.is_valid).toBe(true);

    // 部分索引であること。述語を丸ごと落として無条件索引にする壊れ方は
    // 「contested を拾う」を偶然満たしてしまうので、中身とは別に「部分索引である」ことも見る。
    expect(row.is_partial).toBe(true);
    const pred = row.pred_expr ?? "";
    const literals = [...pred.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    // 🔴 誤り1そのもの: ここが ["active"] に戻ったら赤くなる。
    expect([...new Set(literals)].sort(), pred).toEqual([...GATE_STATUSES].sort());
  });

  /**
   * 歯2（適用可能性）: btree の索引経路だけを残したとき、プランナがこの索引を**選べる**こと。
   *
   * 測っているのは「部分索引の述語が、関門の述語から**含意される**こと」である。
   * 述語を `status = 'active'` へ戻すと、`status = ANY(['active','contested'])` からは
   * それが含意されないので、**この索引は適用できない**——コストの話ではなく適用可能性の
   * 話なので、seq scan を外しても索引は選ばれず赤くなる。
   *
   * ⚠ **「強制すれば緑になる」ことを目的にした強制ではない。**強制は、コスト比較という
   * *揺れる軸*を外して、含意という*揺れない軸*だけを残すために入れている。
   * ⚠ それでもこの歯は「**どの**索引を選ぶか」という選択を残している——`memories` には
   * `tenant_id` を先頭に持つ btree が他にも在る（`idx_memories_by_subject` /
   * `idx_memories_provenance_kind`）。主張できるのは「bitmap と seq scan を外せば
   * この索引が選ばれる」までであって、「他の索引より常に良い」ではない。
   * ⟹ **将来、同じ部分述語を持つ btree が足されたら、この歯も赤くなりうる。**
   * そのときは「実装が壊れた」ではなく「この歯がまた代理を測り始めた」と読むこと
   * ——`idx_memories_lexical`（0008）で一度そうなった。
   */
  it("適用可能性: btree 経路だけに絞ると、修正後の述語 (status IN ('active','contested')) でも idx_memories_recall_gate が引ける", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await insertManyMemories(
      store,
      ctx,
      ["active", "contested", "superseded", "archived", "forgotten"],
      pool,
    );

    // 自然な計画は assert せず、全文をログへ残す（Issue #150: 落ちたときに計画が読めなかった）。
    const naturalPlan = await explainGate(pool, "none");
    console.log(`=== EXPLAIN（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`);

    const forcedPlan = await explainGate(pool, "btreeIndex");
    console.log(
      `=== EXPLAIN（enable_seqscan = off, enable_bitmapscan = off。歯2が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  /**
   * 歯3（同値）: 索引経路が行を弾いていないこと。
   *
   * 索引を強制した計画だけを見ていると「索引は引けるが、拾うべき行を落としている」を
   * 見逃す（マネージャー指摘: 片方だけでは「弾いていないこと」が測れない）。だから3経路
   * ——自然・btree強制・全走査強制——を同じ問いに当てて**同じ答え**が返ることを見る。
   * 全走査の答えは索引の形に一切依存しないので、**基準**として使える。
   *
   * ⚠ この歯が検出できないもの: PostgreSQL は部分索引の述語が含意されないときその索引を
   * 使わないので、「索引を使ったせいで行が落ちる」は本来起こらない。⟹ この歯が実際に
   * 守っているのは **歯2の強制が測定そのものを歪めていないこと**と、**関門の述語が拾う
   * status の集合**（下半分）である。
   * ⭐ **緑のまま動かない歯になりうることを承知で置いている**——「強制しても答えは
   * 変わらない」という主張を、誰かが言葉で書くのではなく歯に名乗らせるために。
   */
  it("同値: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行を返す（contested を含み、他の status を含まない）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await insertManyMemories(
      store,
      ctx,
      ["active", "contested", "superseded", "archived", "forgotten"],
      pool,
    );

    const natural = await gateRowIds(pool, "none");
    const viaBtree = await gateRowIds(pool, "btreeIndex");
    const viaSeqScan = await gateRowIds(pool, "seqscan");

    expect(viaBtree).toEqual(viaSeqScan);
    expect(natural).toEqual(viaSeqScan);
    expect(natural).toHaveLength(50);

    // 索引の話とデータの話、両方を検査する（「索引はあるが述語を書き間違えて何も
    // 拾えていない」を見逃さないため）。こちらは LIMIT を外した全件で見る。
    const dataResult = await pool.query<{ status: string }>(
      `SELECT status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[])`,
      GATE_PARAMS,
    );
    const statusesReturned = new Set(dataResult.rows.map((row) => row.status));
    expect(statusesReturned.has("active")).toBe(true);
    expect(statusesReturned.has("contested")).toBe(true);
    expect(statusesReturned.has("superseded")).toBe(false);
    expect(statusesReturned.has("archived")).toBe(false);
    expect(statusesReturned.has("forgotten")).toBe(false);
  }, 60_000);

  it("decay_floor_at は Phase 1 では読み取りフィルタに使わない（roadmap.md、誤り3の整理）が、索引の3列目としては持つ", async () => {
    // Phase 1 は decay_floor_at を書き込むだけで、段1の WHERE には使わない
    // （roadmap.md「Phase 2 で WHERE decay_floor_at > now() を使い始めるだけ」）。
    // 索引が (tenant_id, status, decay_floor_at) の3列構成であることは歯1が catalog で
    // 見ている。ここで見るのは「書き込み時に decay_floor_at が計算されている」ことだけ
    // ——列が在っても値が入っていなければ、Phase 2 の WHERE は何も刈れない。
    const ctx: Ctx = { tenantId: TENANT };
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    const expected = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: null,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    expect(memory.decayFloorAt.getTime()).toBe(expected.getTime());
  });
});
