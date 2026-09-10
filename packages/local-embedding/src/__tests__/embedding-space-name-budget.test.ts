import { describe, expect, it } from "vitest";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "@mnemora/postgres";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/**
 * この provider の `EmbeddingSpaceId` から導かれる Postgres の識別子が、
 * **切り詰められずに** 63 バイトに収まることを固定する歯（ADR 0090・ADR 0002 D8）。
 *
 * 🔴 **なぜ「63バイト以内」だけでは歯にならないか。**
 *
 * `embeddingSpaceTableName` / `embeddingSpaceIndexName` は、63バイトを超える名前を
 * **切り詰めてハッシュ片を足すことで、必ず 63バイト以内に収める。**
 * ⟹ `byteLength <= 63` は導出関数の**事後条件そのもの**であり、
 * **どんな `model` を渡しても真になる。永久に緑の、嘘の歯である。**
 *
 * ⭐ **本当に固定したいのは「名前が化けていないこと」である。**
 * 切り詰めが起きると、導出関数は末尾を捨てて `_<sha256 の先頭8桁>` を足す
 * ⟹ **`dimensions`（3つ組の最後の要素）が名前の末尾から消える。**
 * だから `endsWith(`_${dimensions}`)` を見る。これは切り詰め形では成立しえない
 * （切り詰め形の最後の `_` の後ろは必ず16進8文字であり、`_256` にはならない）。
 * その「成立しえない」ことは、下の「化ける側」の歯で実際に確かめている
 * ——**検出器が壊れたら、そちらが赤くなる。**
 */

/**
 * ⚠ **逐語で持つ。`@mnemora/postgres` の `MAX_IDENTIFIER_BYTES` から組み立てないこと。**
 *
 * 定数を import すると、**その定数を書き換える変異とこの歯が自己整合し、素通りする**
 * （PostgreSQL の `NAMEDATALEN - 1` は外の世界が決めた値であって、この repo の変数ではない）。
 */
const POSTGRES_MAX_IDENTIFIER_BYTES = 63;

/** 既定の provider が名乗る space。**定数を並べ直すのではなく、実物から取る。** */
const space = new LocalEmbeddingProvider().space;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("packages/local-embedding の EmbeddingSpaceId から導かれる Postgres 識別子", () => {
  it("テーブル名が 63 バイトに収まる", () => {
    const table = embeddingSpaceTableName(space);
    expect(byteLength(table)).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_BYTES);
  });

  it("HNSW 索引名が 63 バイトに収まる", () => {
    const index = embeddingSpaceIndexName(space);
    expect(byteLength(index)).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_BYTES);
  });

  it("テーブル名が切り詰められていない（末尾に dimensions が残っている）", () => {
    const table = embeddingSpaceTableName(space);
    expect(table.endsWith(`_${String(space.dimensions)}`)).toBe(true);
  });

  it("HNSW 索引名が切り詰められていない（末尾に dimensions が残っている）", () => {
    const index = embeddingSpaceIndexName(space);
    expect(index.endsWith(`_${String(space.dimensions)}`)).toBe(true);
  });

  /**
   * 🔴 **索引名のほうが先に溢れる。**接頭辞が `idx_memory_embeddings_hnsw_`（27バイト）で、
   * テーブル名の `memory_embeddings_`（18バイト）より **9バイト長い。**
   *
   * ⟹ **テーブル名だけを見る歯は、索引名が化けている状態を緑で通す。**
   * この歯は「両方を見なければならない」という理由自体を固定する。
   */
  it("索引名はテーブル名より長い（＝先に溢れるのは索引名のほう。テーブル名だけ見ても足りない）", () => {
    expect(byteLength(embeddingSpaceIndexName(space))).toBeGreaterThan(
      byteLength(embeddingSpaceTableName(space)),
    );
  });
});

describe("上の歯が本当に赤くなれること（検出器そのものの検査）", () => {
  /**
   * ⚠ **`model` を長くしたら名前が化けることを、実際に化かして確かめる。**
   *
   * これが無いと、上の `endsWith` 4本は「たまたま通っている」のか
   * 「切り詰めを検出できる」のかが区別できない。
   * ⟹ **切り詰めの検出器が壊れたとき、赤くなるのはこの歯である。**
   */
  const tooLong = {
    provider: space.provider,
    model: "x".repeat(64),
    dimensions: space.dimensions,
  };

  it("長すぎる model は切り詰められ、末尾の dimensions が消える（テーブル名）", () => {
    const table = embeddingSpaceTableName(tooLong);
    expect(byteLength(table)).toBe(POSTGRES_MAX_IDENTIFIER_BYTES);
    expect(table.endsWith(`_${String(tooLong.dimensions)}`)).toBe(false);
  });

  it("長すぎる model は切り詰められ、末尾の dimensions が消える（HNSW 索引名）", () => {
    const index = embeddingSpaceIndexName(tooLong);
    expect(byteLength(index)).toBe(POSTGRES_MAX_IDENTIFIER_BYTES);
    expect(index.endsWith(`_${String(tooLong.dimensions)}`)).toBe(false);
  });
});
