import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0084（Issue #106）の中心: 日本語の文に埋め込まれた `PROJ-1234` のような識別子を、
 * `mnemora_lexical_normalize` を通した索引式・クエリ式でなら引けること。**この主張は
 * `server_encoding` に依らない**（ADR 0103 で 2ビルド × 2版 × 2エンコーディングを実測）。
 * まずそれを索引式ではなく `PostgresLexicalStore.search`（本体のクエリ経路）で確認する。
 *
 * ⚠ **「素の `to_tsvector` では引けない」という否定は、このファイルの前提ではない。**
 * その否定は `server_encoding` で反転する（Issue #145 / ADR 0103）。最後の2本が、
 * 「実装が動くこと」と「正規化が要る理由」を**別々の歯に分けて**引き受ける。
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

  /**
   * 🔴 **この歯が守っているのは「実装が動いていること」である。**上の3本が
   * `PostgresLexicalStore.search`（配線ごと）で見ているのに対し、ここでは
   * **索引式とクエリ式そのもの**を SQL で直接当てる——`migrations/0008` の
   * `idx_memories_lexical` の左辺と、`migrations/0009`（ADR 0092）の
   * `mnemora_lexical_query_or` の組である。
   *
   * ⚠ 以前ここに在った歯は、クエリ側を `websearch_to_tsquery('simple',
   * mnemora_lexical_normalize($2))` と**手で書き写していた**——これは 0009 以前の式であり、
   * 本番経路はもう通らない。式を写すとずれる（`migrations/0008` の
   * 「なぜ SQL 関数として切り出すか」と同じ理由）。
   *
   * ⚠ **この歯は環境に依らない。**`server_encoding` が UTF8 でも SQL_ASCII でも
   * 同じ結論になることを実測してある（ADR 0103「測ったこと」）。
   * ⟹ **これが赤くなったなら、疑うのは実装のほうである。**
   */
  it("本番の索引式とクエリ式なら、日本語の文に埋め込まれた識別子を引ける（server_encoding に依らない）", async () => {
    const { pool } = await getTestClient();
    const content = "四半期レビューでPROJ-1234の納期が来週まで延びました";

    // 誤爆側は、**識別子を2つ含む本文**で測る。隣接（'proj' <-> '-5678'）を落とすと
    // 'proj' と '-5678' が別々の位置で拾われて偽陽性になる本文であり、
    // 単一の識別子しか無い本文では、この主張は自明に成り立ってしまって何も測らない
    // （migrations/0008 の「plainto_tsquery は使わない」の実測と同じ本文）。
    const twoIdentifiers = "本日の連携: PROJ-1234 and TASK-5678 の両方を確認しました";
    const result = await pool.query(
      `SELECT to_tsvector('simple', mnemora_lexical_normalize($1))
                @@ mnemora_lexical_query_or($2) AS "hit",
              to_tsvector('simple', mnemora_lexical_normalize($3))
                @@ mnemora_lexical_query_or($4) AS "falsePositive"`,
      [content, "PROJ-1234", twoIdentifiers, "PROJ-5678"],
    );
    const row = result.rows[0] as { hit: boolean; falsePositive: boolean };

    expect(
      row.hit,
      "本番の索引式・クエリ式が PROJ-1234 を引けなかった。この主張は server_encoding に" +
        "依らないことを実測してある（ADR 0103）——⟹ 疑うのは mnemora_lexical_normalize / " +
        "mnemora_lexical_query_or の実装のほうであって、環境ではない。",
    ).toBe(true);
    expect(
      row.falsePositive,
      "本文のどこにも無い PROJ-5678 が、PROJ-1234 と TASK-5678 を含む本文に一致した。" +
        "誤爆を防いでいるのは正規化ではなく検索側の隣接演算子（'proj' <-> '-5678'）である" +
        "——mnemora_lexical_query_tsqueries が websearch_to_tsquery を使っているかを見ること" +
        "（migrations/0008 と 0009 の doc）。",
    ).toBe(false);
  });

  /**
   * 🔴 **この歯が守っているのは「実装が正しいこと」ではなく、`mnemora_lexical_normalize`
   * が*要る理由*そのものである。**そして ⚠ **その理由は、どの環境でも同じ形では
   * 成り立たない。**
   *
   * Issue #145 の実測（ADR 0103）——素の `to_tsvector('simple', …)` が日本語の文に
   * 埋め込まれた識別子を引けるかどうかは、**`server_encoding` で反転する**:
   *
   * | server_encoding | 素の tsvector | 素の経路で PROJ-1234 を引けるか |
   * |---|---|---|
   * | UTF8（マルチバイト） | `'1234の納期が…':3 '四半期レビューでproj':2 '四半期レビューでproj-1234の納期が…':1` | **引けない（f）** |
   * | SQL_ASCII / LATIN1 | `'-1234':2 'proj':1` | **引けてしまう（t）** |
   *
   * ⚠ **版でもビルドでもロケールでもない。**PostgreSQL 17.11 / 18.6 × PGDG(Debian) /
   * conda-forge × libc(`C` / `C.UTF-8` / `en_US.UTF-8` / `ja_JP.UTF-8`) / builtin / ICU を
   * 総当たりして、分岐したのは `server_encoding` だけだった（ADR 0103）。
   * `LANG` を持たないシェルで `initdb` を打つとロケール `C` が選ばれ、それに連れて
   * encoding が `SQL_ASCII` になる——**これが Issue #145 の報告者の環境である。**
   *
   * ⟹ **だからこの歯は、自分が置いている前提を先に測って名乗る。**前提が破れている
   * 環境では反対側の結論を主張し、**どちらの分岐でも「日本語の語そのものは素の経路で
   * 引けない」**ことを、regime に依らない錨として最後に置く（Issue #139 と同じ根）。
   *
   * ⛔ **この歯を「環境依存だから」と消さないこと。**消すと、`mnemora_lexical_normalize`
   * が要る理由そのものが repo から消える。
   */
  it("素の to_tsvector で識別子を引けるかどうかは server_encoding で反転する（歯が自分の前提を測って名乗る）", async () => {
    const { pool } = await getTestClient();
    const content = "四半期レビューでPROJ-1234の納期が来週まで延びました";

    const probe = await pool.query(
      `SELECT current_setting('server_version')  AS "version",
              current_setting('server_encoding') AS "encoding",
              length(to_tsvector('simple', '日本語')) > 0 AS "nonAsciiIsIndexed",
              to_tsvector('simple', $1)::text AS "rawTsvector",
              to_tsvector('simple', $1) @@ websearch_to_tsquery('simple', $2) AS "rawIdentifierHit",
              to_tsvector('simple', $1) @@ websearch_to_tsquery('simple', $3) AS "rawJapaneseWordHit"`,
      [content, "PROJ-1234", "レビュー"],
    );
    const row = probe.rows[0] as {
      version: string;
      encoding: string;
      nonAsciiIsIndexed: boolean;
      rawTsvector: string;
      rawIdentifierHit: boolean;
      rawJapaneseWordHit: boolean;
    };

    const observed =
      `【この環境の実測】server_version=${row.version} / server_encoding=${row.encoding} / ` +
      `非ASCIIが語彙として残るか=${row.nonAsciiIsIndexed} / ` +
      `to_tsvector('simple', 本文)=${row.rawTsvector}`;

    if (row.nonAsciiIsIndexed) {
      expect(
        row.rawIdentifierHit,
        "素の to_tsvector が PROJ-1234 を引けてしまった。" +
          "⚠ ここで疑うのは mnemora_lexical_normalize の実装ではなく、この歯が置いている" +
          "前提のほうである。この分岐は「素の parser が非ASCIIを語の文字として扱い、隣の " +
          "ASCII と癒着した1語にする」regime でだけ成り立つ。前提が破れたなら、正規化が" +
          "要る理由はこの環境では別の形をしている（ADR 0103 / Issue #145 を読むこと）。" +
          `${observed}`,
      ).toBe(false);
    } else {
      expect(
        row.rawIdentifierHit,
        "素の to_tsvector が PROJ-1234 を引けなかった。" +
          "⚠ ここで疑うのは実装ではなく、この歯が置いている前提のほうである。" +
          "この環境は非ASCIIが語彙として一切残らない regime（SQL_ASCII / LATIN1 など）であり、" +
          "日本語が丸ごと落ちた結果 'proj' と '-1234' が隣接して残るため、素の経路でも" +
          "引けるはずだった。引けなかったなら parser の非ASCIIの扱いが実測時と変わっている" +
          `（ADR 0103 / Issue #145 を読むこと）。${observed}`,
      ).toBe(true);
    }

    expect(
      row.rawJapaneseWordHit,
      "素の to_tsvector が日本語の語『レビュー』を引けてしまった。これは上の2つの regime の" +
        "**どちらでも false になる**ことを実測した不変である（UTF8 側では文ごと1語に癒着し、" +
        "SQL_ASCII 側では非ASCIIが丸ごと落ちる——引けない理由が違うだけで、引けないことは同じ）。" +
        "true になったなら、素の parser の日本語の扱いそのものが変わっている" +
        `——Issue #139 の根が動いた可能性がある。${observed}`,
    ).toBe(false);
  });
});
