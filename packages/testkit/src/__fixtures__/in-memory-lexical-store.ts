import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";

/**
 * `'simple'` dictionary の代わりに使う、素朴な語彙正規化。
 *
 * postgres 実装（Issue #106、[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)）は
 * `to_tsvector('simple', regexp_replace(text, '([[:ascii:]]+)', ' \1 ', 'g'))` の上に
 * `websearch_to_tsquery` を重ねる。**ここではそれを自前で再発明しない**——
 * `'simple'` dictionary は語幹処理（stemming）をしない、というその1点だけを借りて、
 * 「小文字化してから Unicode の英数字境界で分割し、トークンの完全一致を見る」という
 * 最小の実装にしてある（`'simple'` が語幹処理をしないからこそ、完全一致がその近似になる。
 * `'english'` 等の語幹処理をする config だったら、この近似は成り立たない）。
 *
 * **⚠ 正直に書く: 何が同じで何が違うか。**
 *
 * 同じだと確認したこと（このファイルの意図として揃えた点）:
 * - 語幹処理をしない（完全一致）。
 * - 大文字・小文字を区別しない。
 * - クエリの語のいずれか1つでも含むか（OR）で絞り、一致した語の割合（`coverage`）を返す
 *   （[ADR 0092](../../../../docs/decisions/0092-lexical-or-coverage.md)。
 *   postgres 実装の `mnemora_lexical_query_or` / `mnemora_lexical_coverage` と同じ向き）。
 *
 * **違う・確認していないこと**:
 * - `websearch_to_tsquery` の `"..."`（フレーズ）/ `OR` / `-`（NOT）はここでは一切解釈しない。
 *   空白区切りの語の集合としてしか読まない（各語を独立に OR で見る）。
 *   **⚠ ADR 0092 で postgres 側も各語を `"..."` で囲むようになり、生クエリ中の
 *   websearch 演算子を解釈しなくなった**——この差はむしろ縮む方向である
 *   （ADR 0092「採った副作用」）。
 * - CJK（分かち書きの無い日本語・中国語等）の扱いは確認していない。
 *   postgres 側の `regexp_replace(text, '([[:ascii:]]+)', ' \1 ', 'g')` は ascii の連続の前後に
 *   空白を挟むことで、CJK に埋め込まれた ascii の語（例: 日本語文中の英単語）を
 *   `to_tsvector` が別トークンとして切れるようにする一手だが、**CJK 自体を分かち書きする
 *   ものではない**（`'simple'` dictionary・既定の text search parser に形態素解析は無い）。
 *   ここでの実装（Unicode の「文字」境界で分割）が同じ挙動になるかは**確認していない**。
 * - `String.prototype.toLowerCase()` と postgres の `lower()` が全ロケール・全文字で
 *   一致する保証は無い（確認していない）。
 * - 数字・ハイフン・アポストロフィ等の細かいトークン化規則（postgres の text search parser の
 *   `word`/`numword`/`hword` 等の分類）は再現していない——ここでは
 *   Unicode の letter/number をひとまとめのトークンとして扱う、より粗い規則を使う。
 *
 * **適合テスト（`lexical-store-conformance.ts`）が両方の実装に対して通ることだけが、
 * 「同じである」の唯一の根拠である。**このコメントの主張ではない。
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * クエリ語の集合に対する `content` の一致度を、頻度の和として素朴に数える。
 *
 * **🔴 `ts_rank_cd` の近似ではない。**`LexicalHit.rank` の契約
 * （`interfaces/lexical-store.ts`）が明記する通り、`rank` の尺度は adapter ごとに違ってよく
 * 比較可能なのは同一 adapter の結果同士だけ——ここでの式（頻度の和）は、
 * 「頻度が高いほど大きい値になる」という向きだけを postgres 実装と共有する、
 * この in-memory 実装だけのローカルな規則である。
 */
function computeRank(contentTokens: string[], queryTerms: Set<string>): number {
  let rank = 0;
  for (const token of contentTokens) {
    if (queryTerms.has(token)) {
      rank += 1;
    }
  }
  return rank;
}

/**
 * `LexicalStore` のインメモリ・プレースホルダ実装（[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)、
 * [ADR 0092](../../../../docs/decisions/0092-lexical-or-coverage.md)、Issue #106）。
 * 索引・pg の text search 機構を模さない最小実装であり、
 * `packages/testkit` の適合テストを実行できることを示すためだけのもの。
 *
 * **`memoryStore` を必須のコンストラクタ引数にしている（省略不可）。** `LexicalStore` は
 * `upsert`/`delete` を持たない（`interfaces/lexical-store.ts` のクラス doc）——postgres 実装は
 * `memories.content` そのものの上に式索引を張るので、索引は本体の書き込みに自動で追随し、
 * 同期の口が要らない。この in-memory 実装も同じ非対称を再現する: 自前の Map を持たず、
 * `memoryStore.listByTenant` を通じて `InMemoryMemoryStore` が保持する Memory を直接読む
 * （`InMemoryVectorStore` が `status`/`subjectId`/`decayFloorAt` のためだけに `memoryStore` を
 * 参照するのとは違い、こちらは `content` 自体の読み取りにも `memoryStore` を使う）。
 *
 * **省略可能にしなかった理由（ADR 0034 と同じ規律）**: 省略できると「filter/content を
 * 実際に検査できる adapter」と「検査できない adapter」が同じ緑色の出力になる。
 * `InMemoryVectorStore` のクラス doc が引いている ADR 0011/0025/0027/0028 の族の失敗を、
 * ここでも繰り返さない。
 *
 * **🔴 `search` が返す `LexicalHit` は毎回新しく組み立てる（`{ memoryId, coverage, rank }` の
 * オブジェクトリテラル）。**いずれもプリミティブなので Map の行を
 * そのまま返しても書き換えの経路自体は無いが、**内部表現（`Memory` 行やトークン配列）を
 * 返り値に混ぜないことを明示するためにここへ書いておく**——この repo では
 * 「Map の行の参照をそのまま返し、呼び出し側の書き換えが store の中身まで変えてしまい、
 * 歯が無力化された」前例があるため（`in-memory-vector-store.ts` の `cosineDistance` の doc、
 * ADR 0040 の周辺で踏まれた同族の穴）。
 */
export class InMemoryLexicalStore implements LexicalStore {
  constructor(private readonly memoryStore: InMemoryMemoryStore) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0) {
      // 契約: 語彙が1つも取れないクエリは0件（`lexical-store-conformance.ts` の歯）。
      return [];
    }

    // テナント分離は `opts.filter.tenantId` の一致だけで行う——`InMemoryVectorStore.search`
    // と同じ理由（docs/architecture.md §5.2: filter は索引で表現できる形に限る。
    // `ctx.tenantId` で二重に絞ると「filter.tenantId を無視しても壊れない」誤ったプレースホルダになる）。
    const memories = this.memoryStore.listByTenant({ tenantId: opts.filter.tenantId });

    const hits: LexicalHit[] = [];
    for (const memory of memories) {
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      if (opts.filter.subjectId !== undefined && memory.subjectId !== opts.filter.subjectId) {
        continue;
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0039: period（両端とも包含、`>=`/`<=`）。比較対象は `occurredAt ?? recordedAt`。
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }

      const contentTokens = tokenize(memory.content);
      // OR 意味論（ADR 0092）: クエリの語のうち、content に含まれるものを数える。
      // 1つも一致しなければ返さない——`matched === 0` は「一致した候補」ではない。
      const contentTokenSet = new Set(contentTokens);
      let matched = 0;
      for (const term of queryTerms) {
        if (contentTokenSet.has(term)) {
          matched += 1;
        }
      }
      if (matched === 0) {
        continue;
      }

      const coverage = matched / queryTerms.size;
      hits.push({
        memoryId: memory.id,
        coverage,
        rank: computeRank(contentTokens, queryTerms),
      });
    }

    // coverage 降順、同値なら rank 降順（ADR 0092: limit の窓は被覆率の高い候補から切る）。
    hits.sort((a, b) => b.coverage - a.coverage || b.rank - a.rank);
    return hits.slice(0, opts.limit);
  }
}
