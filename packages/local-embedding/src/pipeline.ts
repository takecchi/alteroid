/**
 * `LocalEmbeddingProvider` が握る「モデルを1回だけ読み込んで、テキストの配列を
 * ベクトルの配列にする関数」の型と、その既定の作り方（transformers.js 経由）。
 *
 * **なぜ interface を1枚挟むか**: `packages/openai` の `OpenAIEmbeddingProvider` が
 * `client` を注入できるようにしてあるのと同じ理由である。ここを差せないと、
 * **provider の検査が毎回 36MB のモデルを落とすことになり、CI では走らせられない。**
 * 差せるようにしてあるおかげで、遅延ロードの共有・次元の検査・prefix の適用といった
 * 「このパッケージが本当に持っているロジック」は、ネットワーク無しで測れる。
 *
 * ⚠ **`createLocalEmbeddingPipeline`（既定の実装）自身は、ユニットテストで測っていない。**
 * ここだけは本物の onnxruntime を起動しないと意味が無いため、`src/__tests__/
 * live.local-embedding.test.ts`（opt-in）だけが通る。
 */

/** dtype（量子化の別）。transformers.js が受け付ける値のうち、ここで意味があるものを並べる。 */
export type LocalEmbeddingDtype = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16";

/** `createPipeline` に渡る、確定済みのモデル指定。 */
export interface LocalEmbeddingModelSpec {
  /** Hugging Face の repo id。 */
  readonly repo: string;
  readonly dtype: LocalEmbeddingDtype;
  /** モデルファイルの置き場所。未指定なら transformers.js の既定（`~/.cache/huggingface`）。 */
  readonly cacheDir: string | undefined;
  /** onnxruntime の intra-op スレッド数。 */
  readonly numThreads: number;
}

/**
 * テキストの配列を、そのままベクトルの配列にする関数。
 *
 * **prefix の付与は呼ぶ側（`LocalEmbeddingProvider`）の仕事であり、ここには無い。**
 * ここが受け取るのは既に prefix の付いた文字列である。
 */
export type LocalEmbeddingPipeline = (texts: string[]) => Promise<number[][]>;

/** モデルを読み込んで `LocalEmbeddingPipeline` を返す関数。**ここが注入点である。** */
export type CreateLocalEmbeddingPipeline = (
  spec: LocalEmbeddingModelSpec,
) => Promise<LocalEmbeddingPipeline>;

/**
 * transformers.js の feature-extraction が返すもの（`Tensor`）から `number[][]` を取り出す。
 *
 * **なぜ素直に `output.tolist() as number[][]` と書かないか**: `tolist()` の戻りは
 * テンソルの形に従う。pooling を指定し忘れれば `[batch][tokens][dim]` の3階になり、
 * `as` で黙らせると**「トークン列がベクトルとして DB に入る」**という、
 * 実行時まで気づけない壊れ方をする。ここで形を見て、違えば名前を付けて落とす。
 */
export function toVectors(output: unknown): number[][] {
  const raw = hasToList(output) ? output.tolist() : output;
  if (!Array.isArray(raw)) {
    throw new Error(
      `LocalEmbeddingProvider: 埋め込みの出力が配列ではない（${describe(raw)}）。` +
        `feature-extraction pipeline が Tensor 以外を返した可能性がある`,
    );
  }
  const vectors: number[][] = [];
  for (const [index, row] of raw.entries()) {
    if (!Array.isArray(row) || !row.every((value) => typeof value === "number")) {
      throw new Error(
        `LocalEmbeddingProvider: 埋め込みの出力の ${index} 番目が number[] ではない` +
          `（${describe(row)}）。mean pooling が効いていない（[batch][tokens][dim] のまま）` +
          `可能性がある`,
      );
    }
    vectors.push(row as number[]);
  }
  return vectors;
}

function hasToList(value: unknown): value is { tolist: () => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tolist?: unknown }).tolist === "function"
  );
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return `長さ ${value.length} の配列（要素は ${typeof value[0]}）`;
  return typeof value;
}

/**
 * 既定の `createPipeline`。transformers.js をプロセス内で走らせる。
 *
 * **`import()` で遅延させている理由**: `createPipeline` を注入した呼び出し側
 * （＝テスト）が、`@huggingface/transformers` とその先の onnxruntime を
 * **一度も読み込まずに済む**ようにするため。トップレベルの `import` にすると、
 * このモジュールを読んだだけで onnxruntime のネイティブバイナリが load される。
 *
 * pooling / 正規化は **mean pooling + L2 normalize** で固定する。
 * ruri v3 の `1_Pooling/config.json` が mean pooling であることを確認済み。
 * **呼び出し側から変えられるようにはしない**——pooling を変えるとベクトルは
 * 別物になるが `EmbeddingSpaceId` は変わらないため、**同じ space に非互換な
 * ベクトルが混ざる。**
 */
export const createLocalEmbeddingPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", spec.repo, {
    dtype: spec.dtype,
    ...(spec.cacheDir !== undefined ? { cache_dir: spec.cacheDir } : {}),
    // 32コア機での実測: 既定（コア数まかせ）819 文/秒 に対し、4スレッドで 985 文/秒。
    // スレッドを増やすほど速くなるわけではない——オーバーサブスクリプションのほうが高くつく。
    session_options: { intraOpNumThreads: spec.numThreads, interOpNumThreads: 1 },
  });
  return async (texts) => toVectors(await extractor(texts, { pooling: "mean", normalize: true }));
};
