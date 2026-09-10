import { describe, expect, it } from "vitest";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/**
 * live テスト（**本物のモデルを Hugging Face から落として、プロセス内で推論する**。
 * 明示的な opt-in が要る）。
 *
 * **`packages/openai` の `live.openai.test.ts` と同じ形にしてある。**
 * そちらは「鍵を持っていることは、いま課金してよいという意思表示ではない」
 * （[ADR 0019 §5c](../../../../docs/decisions/0019-real-openai-measurement-cost.md)）
 * を理由に、環境変数での opt-in を要求している。
 *
 * **⚠ ここで opt-in を要求する理由は課金ではない**——このパッケージは外部サービスへ
 * 繋がないので、API 料金は発生しない。要求するのは、**36MB のモデルのダウンロードと、
 * peak RSS 362MB の推論が、`pnpm run test` を1回打っただけで走る**からである。
 * ネットワークの無い環境ではダウンロードで固まり、CI では毎回同じものを落とし直す。
 * **「無料だから黙って走らせてよい」ではない。**
 *
 * ⟹ 走る条件は1つ: `MNEMORA_LIVE_LOCAL_EMBEDDING` が空でない値であること。
 * `packages/openai` の2条件（鍵 + opt-in）のうち、**鍵に当たるものがここには無い。**
 *
 * `MNEMORA_LIVE_LOCAL_EMBEDDING` は**空でない値なら何でも opt-in とみなす**
 * （`1` / `true` / `yes`）。特定の綴りだけを受け付けて他を黙って無視すると、
 * 「設定したのに走らない」という静かな罠を作る。
 *
 * **CI では走らない。**この変数を設定していないため、CI 上ではこの `describe` の
 * 各 it が常に `skipped` として表示される（`it.skipIf` を使う——`describe.skip` や
 * 「ファイル自体を読み込まない」形にはしない。テスト名を消してしまう
 * `if (!live) return` は採らない——それだと「1件パスした」という誤った印象を残す）。
 *
 * ローカルで実行するには（**モデルを落とす。初回は数十秒かかる**）:
 *   MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

/** cos 類似度。ベクトルは L2 正規化済みなので内積と一致するが、前提を置かずに割る。 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? 0;
    dot += value * other;
    na += value * value;
    nb += other * other;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("live: local embedding (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  it.skipIf(!live)(
    "日本語2文を埋め込むと、宣言どおり 256 次元のベクトルが返る",
    async () => {
      const provider = new LocalEmbeddingProvider();
      const vectors = await provider.embed({ tenantId: "live-test" }, [
        "今日は雨が降っている",
        "会議は水曜日に延期になった",
      ]);

      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(256);
      expect(vectors[1]).toHaveLength(256);
      // L2 正規化しているので、ノルムは 1 のはず。
      expect(cosine(vectors[0] ?? [], vectors[0] ?? [])).toBeCloseTo(1, 5);
    },
    120_000,
  );

  it.skipIf(!live)(
    "同義のペアのほうが、無関係なペアより cos が大きい",
    async () => {
      const provider = new LocalEmbeddingProvider();
      const [a, b, c] = await provider.embed({ tenantId: "live-test" }, [
        "猫が窓辺で眠っている",
        "ネコが窓のそばで寝ている",
        "為替相場が円安に振れた",
      ]);

      const synonymous = cosine(a ?? [], b ?? []);
      const unrelated = cosine(a ?? [], c ?? []);

      // ⚠ ここで測っているのは**その程度のことだけ**である。
      // 「否定・時制・矛盾を解ける」ことは測っていない——実際、解けない
      // （README「何が良くならないか」を見ること）。
      expect(synonymous).toBeGreaterThan(unrelated);
    },
    120_000,
  );
});
