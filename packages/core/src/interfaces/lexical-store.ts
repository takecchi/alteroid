import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { ProvenanceKind } from "../provenance.js";

/**
 * `search` の `filter`。`VectorFilter` と**同じ絞りを、同じ意味で**持つ
 * （[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)）。
 *
 * **⚠ `VectorFilter` を再利用せず、別の型として書いている。**
 * 名前が意味を運ぶからである——`VectorFilter` は「ベクタ索引に降ろせる絞り」という
 * 文脈を持っており、語彙索引の adapter がそれを実装するのは読み手を惑わせる。
 * **⟹ 欄が同じであることは、型が同じであるべきことを意味しない。**
 *
 * **`decayFloorAtAfter` は持たない。**`VectorFilter` はこれを持つが、
 * [ADR 0011](../../../../docs/decisions/0011-no-window-count-in-ann-stage.md) の通り
 * Phase 1 では読み取りフィルタとして使われていない——`recall-runtime.ts` は
 * ANN 段にもこの欄を渡していない。**使われていない欄を、新しい契約に写さない。**
 *
 * **各フィールドは adapter が実際に適用しなければならない**
 * （`VectorFilter` と同じ契約。ADR 0034）。`packages/testkit` の
 * `lexical-store-conformance.ts` が adapter 非依存の歯として検査する。
 */
export interface LexicalFilter {
  tenantId: string;
  status?: MemoryStatus[];
  subjectId?: string;
  excludeProvenanceKinds?: ProvenanceKind[];
  occurredAfter?: Date;
  occurredBefore?: Date;
}

export interface LexicalHit {
  memoryId: MemoryId;
  /**
   * **一致したクエリ語彙の数 ÷ クエリから作れた語彙の総数**
   * （[ADR 0092](../../../../docs/decisions/0092-lexical-or-coverage.md)）。
   *
   * 値域は `(0, 1]`——分子が 0（＝一致した語彙が無い）候補はそもそも `search` が
   * 返さない（下の `LexicalStore` の doc「クエリ語彙のいずれかと一致する候補を返す
   * （OR 意味論）」参照）。
   *
   * **🔴 `recall` の段2 は `ScoreBreakdown.lexicalMatch` にこの値をそのまま入れる**
   * （`recall-runtime.ts`）。**⚠ ADR 0084 が定めた旧仕様（`lexicalMatch` は候補集合の上で
   * 常に `1` の二値）は ADR 0092 で置き換わった。**旧仕様はクエリ語彙を AND で結ぶ契約の
   * 上に立っており、英語の自然文（`what did we say about PROJ-1234`）のような複数語の
   * クエリでは「全語を含む記憶しか返らない」という負債を抱えていた（ADR 0084 §2.1.1・§8）。
   */
  coverage: number;
  /**
   * **`coverage` が同値の候補どうしを adapter がどう並べたか、というタイブレークの値。
   * 大きいほど上位。**
   *
   * **🔴 この値はスコアに入らない。**`recall` の段2 が使うのは `coverage`
   * （`ScoreBreakdown.lexicalMatch`）であり、`rank` ではない（ADR 0084 §5、ADR 0092）。
   * 理由: `rank` の尺度は adapter ごとに違い（postgres 実装は `ts_rank_cd`）、
   * **コサイン類似度と比較可能な量ではない。**
   * 比較してよいのは**同一クエリ・同一 adapter が返した `LexicalHit` 同士だけ**である。
   *
   * **⟹ ではなぜ返すのか。**返さないと、adapter が同着の候補をどう並べたかが
   * 呼び出し側からも適合テストからも見えなくなる。`explain` にもこの値が出る
   * （ADR 0084 §6）。
   */
  rank: number;
}

/**
 * LexicalStore — recall の**語彙候補生成チャンネル**（[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)、Issue #106）。
 *
 * 契約:
 * - **`MemoryStore` が真実の源であり、語彙索引は再構築可能な派生索引である**
 *   （`VectorStore` と同じ非対称。`packages/core/src/interfaces/vector-store.ts` 参照）。
 * - **クエリ語彙は OR で結ばれる**（[ADR 0092](../../../../docs/decisions/0092-lexical-or-coverage.md)）。
 *   クエリから作れる語彙のうち**どれか1つでも一致すれば**候補になる——
 *   ADR 0084 が定めた旧仕様（AND：すべての語彙を含む候補しか返さない）は ADR 0092 で
 *   置き換わった。**⟹ 一致した語彙が1つも無い候補は返さない**（`LexicalHit.coverage`
 *   は常に `(0, 1]`）。
 * - **返り値は `coverage` の降順である。同値なら `rank` の降順でタイブレークする。**
 *   `limit` はその上位から切る。**⚠ ADR 0084 の旧契約（`rank` の降順）は ADR 0092 で
 *   置き換わった**——`limit` の窓を切るときに、被覆率の高い候補を、被覆率の低い
 *   高 `rank` の候補に押し出させてはならないため。
 * - `filter` の各フィールドを adapter が実際に適用する（`LexicalFilter` の doc）。
 * - **`query` は正規化前の生のクエリ文字列である。**どう分かち書きするかは adapter の責務で
 *   あり、core は一切関与しない——**core は「語彙的に引く」としか言っていない。**
 *   **⟹ adapter は、自分の索引では原理的に一致しえない種類の語を query から落としてよい。**
 *   postgres 実装は実際にそうしている（日本語の語を落とす。ADR 0084 §2.1.1）——
 *   残しても真陽性を1件も生まず、日本語の語だけを理由に他の一致を薄めるためである。
 *   **⚠ ただし「落としてよい」は「落とすべき」ではない。**何を落としたかは adapter が説明できること。
 *
 * **🔴 書き込み口（`upsert` / `delete`）を持たない。**`VectorStore` との最大の違いである。
 * Phase 1 の postgres 実装は `memories.content` そのものの上に式索引を張るので、
 * **索引は本体の書き込みに自動で追随し、同期の口が要らない。**
 * **⟹ これは「外部の検索エンジンを語彙 adapter にできる」ことを意味しない。**
 * `memories` の外に索引を持つ実装は、この interface だけでは同期できない。
 * **その口が要るようになったら足す。いまは要る実装が存在しないので足さない**
 * （ADR 0084 §8 の負債）。
 */
export interface LexicalStore {
  search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]>;
}
