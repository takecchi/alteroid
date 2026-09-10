import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0084（Issue #106）の核心の実測: `simple` 辞書は ASCII と非ASCII が混在した塊を
 * 1語として拾ってしまい、日本語の文に埋め込まれた `PROJ-1234` のような識別子を素の
 * `to_tsvector` では引けない（`migrations/0008_memories_lexical_index.sql` の doc に
 * 実測が全文ある）。`mnemora_lexical_normalize` の正規化がこれを解決していることを、
 * 索引式ではなく `PostgresLexicalStore.search`（本体のクエリ経路）で確認する。
 *
 * ⚠ **偽陽性の点検**（マネージャー指摘の作法）: このフィクスチャは意図的に
 * `PROJ-1234`/`PROJ-5678`/`TASK-1234` という似た識別子を複数用意し、かつ
 * **識別子を `content` に置かず `tags` にだけ置いた decoy** も用意する。
 * `PostgresLexicalStore.search` が実際に見るのは `content` 列だけ
 * （`lexical-store.ts` の `buildLexicalSearchSelect`）——`tags` は `WHERE` に一切現れない。
 * decoy が返らないことを確認することで、「緑になった経路が `content` の語彙一致以外の
 * 何か（例: 別の列にたまたま同じ文字列が入っていた）ではない」ことを別立てで示す。
 */

const TENANT = "lexical-identifier-tenant";

describe("PostgresLexicalStore.search — 日本語の文に埋め込まれた識別子を引ける", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PROJ-1234 で引くと、日本語の文に埋め込まれた PROJ-1234 だけが見つかる（PROJ-5678 / TASK-1234 / tags だけの decoy は誤爆しない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-target",
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
      }),
    );
    // 似た識別子（番号違い）——正規化後も websearch のフレーズ演算子（<->）により
    // 'proj' <-> '-1234' と 'proj' <-> '-5678' は別物として扱われるはず。
    const similarNumber = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-similar-number",
        content: "サブシステムの担当はPROJ-5678の方です",
      }),
    );
    // 似た識別子（接頭辞違い）。
    const similarPrefix = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-similar-prefix",
        content: "TASK-1234はまだ着手していません",
      }),
    );
    // decoy: 識別子は tags にだけ置き、content には置かない。search が content 以外の
    // 列を見ていたら誤ってこれも返ってしまう。
    const tagsOnlyDecoy = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-tags-only-decoy",
        content: "サーバー移行の計画について話し合いました",
        tags: ["PROJ-1234"],
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(target.id);
    expect(ids).not.toContain(similarNumber.id);
    expect(ids).not.toContain(similarPrefix.id);
    expect(ids).not.toContain(tagsOnlyDecoy.id);
    // target 以外は一切混ざらない——ちょうど1件であることまで確認する。
    expect(ids).toEqual([target.id]);
  });

  /**
   * 🔴 **この歯は、変異試験で見つけた欠陥のために足した。**
   *
   * 当初の実装はクエリ側にも `mnemora_lexical_normalize` を通していた。それだと
   * 日本語の残り全体が1語彙（`'について前に何か言ってたっけ'`）になって AND で結ばれ、
   * **Issue #106 の報告者が書いた問いの形そのものが1件も引けなかった。**
   * 既存の歯は「識別子だけを渡す」呼び出ししか測っておらず、この穴を通していた。
   *
   * ⚠ 偽陽性の点検: このクエリが緑になる経路が「識別子の語彙一致」だけであることを、
   * 同じ問いの形で**識別子だけ差し替えた**否定側（PROJ-5678 を含む文が返らないこと）で確かめる。
   */
  it("報告者が実際に投げる形の問い（日本語の自然文 + 識別子）でも引ける", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-nl-target",
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
      }),
    );
    const other = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-nl-other",
        content: "サブシステムの担当はPROJ-5678の方です",
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-1234について前に何か言ってたっけ？", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((hit) => hit.memoryId)).toEqual([target.id]);
    expect(hits.map((hit) => hit.memoryId)).not.toContain(other.id);
  });

  /**
   * 🔴 **この歯も、変異試験で見つけた穴のために足した。**
   *
   * `websearch_to_tsquery` を `plainto_tsquery` に落とす変異を当てても、
   * 既存の歯は1本も赤くならなかった——**「誤爆しない」という主張が、コメントと
   * マイグレーションの中にしか無く、検査されていなかった。**
   *
   * `plainto_tsquery` は隣接を要求しない AND を作るので、識別子を2つ含む本文に対して
   * **片方の接頭辞ともう片方の番号**の組み合わせが偽陽性で一致する。
   */
  it("識別子を2つ含む本文に対して、接頭辞と番号を取り違えた識別子は一致しない（plainto_tsquery に落とすと赤くなる）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // 本文には PROJ-1234 と TASK-5678 が在る。PROJ-5678 という識別子はどこにも無い。
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-two-identifiers",
        content: "本日の連携: PROJ-1234 and TASK-5678 の両方を確認しました",
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(hits).toEqual([]);

    // 対照: 本文に実在する組み合わせは、同じ経路でちゃんと引ける（この歯が
    // 「常に0件」で緑になっているのではないことを、同じ本文で示す）。
    const present = await lexicalStore.search(ctx, "TASK-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(present).toHaveLength(1);
  });

  it("正規化を通さない素の to_tsvector では PROJ-1234 を引けない（この索引/クエリが要る理由そのものの実測）", async () => {
    const { pool } = await getTestClient();
    const content = "四半期レビューでPROJ-1234の納期が来週まで延びました";
    const result = await pool.query(
      `SELECT to_tsvector('simple', $1) @@ websearch_to_tsquery('simple', $2) AS matches`,
      [content, "PROJ-1234"],
    );
    expect((result.rows[0] as { matches: boolean }).matches).toBe(false);

    const normalizedResult = await pool.query(
      `SELECT to_tsvector('simple', mnemora_lexical_normalize($1))
         @@ websearch_to_tsquery('simple', mnemora_lexical_normalize($2)) AS matches`,
      [content, "PROJ-1234"],
    );
    expect((normalizedResult.rows[0] as { matches: boolean }).matches).toBe(true);
  });
});
