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
 * ⚠ **`createLocalEmbeddingPipeline`（既定の実装）のうち、`@huggingface/transformers` を
 * 呼ぶ2行だけは、ユニットテストで測っていない。**ここだけは本物の onnxruntime を
 * 起動しないと意味が無いため、`src/__tests__/live.local-embedding.test.ts`（opt-in）だけが通る。
 * **それ以外（上限の読み取り・トークン数の検査・出力の形の検査）は
 * {@link buildLocalEmbeddingPipeline} に切り出してあり、擬似の extractor で CI から測っている**
 * （ADR 0090）。
 */

import { LocalEmbeddingProviderError } from "./errors.js";

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
 * トークナイザのうち、**上限を知り、切り詰めずに数えるために必要なぶんだけ**を写した形。
 *
 * ⚠ **`@huggingface/transformers` の型をそのまま公開の型に出さない**
 * （`docs/architecture.md` §3.8——core にも呼び出し側にも transformers.js の型を漏らさない）。
 * 構造だけを写すことで、擬似の extractor を注入して CI から測れるようにしてある。
 */
export interface LocalEmbeddingTokenizer {
  /**
   * `tokenizer_config.json` の `model_max_length`。
   *
   * ⚠ **宣言が無いとき、transformers.js はここに `Infinity` を返す**
   * （`src/tokenization_utils.js` の `get model_max_length()` は
   * `this._tokenizerConfig.model_max_length ?? Infinity`）。
   * ⟹ **`Infinity` は「上限が無い」ではなく「宣言されていない」である。**
   * その2つを潰さないために、{@link buildLocalEmbeddingPipeline} は
   * 有限でない値を受け取ったら組み立て自体を失敗させる。
   */
  readonly model_max_length: number;
  /** **切り詰めずに**、特殊トークンを含めて符号化する。 */
  encode(text: string): number[];
}

/** transformers.js の feature-extraction pipeline のうち、ここで使うぶんだけを写した形。 */
export interface LocalEmbeddingExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<unknown>;
  readonly tokenizer: LocalEmbeddingTokenizer;
}

/**
 * extractor から `LocalEmbeddingPipeline` を組み立てる**純関数**（ADR 0090）。
 *
 * 🔴 **なぜここに切り出すか。**
 *
 * 上限の判定に必要な知識（`model_max_length` と、切り詰めない符号化）は
 * **トークナイザだけが持っている。**そしてトークナイザは
 * `createLocalEmbeddingPipeline` の中、つまり**本物のモデルを落とさないと触れない場所**に居る。
 * ⟹ そこへ検査を書くと、**検査が CI から測れなくなり、歯にならない。**
 *
 * だから「extractor を受け取って pipeline を組み立てる」ところだけを純関数にし、
 * **擬似の extractor を注入して CI から測る。**残る未測定は
 * 「`pipeline("feature-extraction", ...)` が返すものが、本当にこの形をしているか」だけであり、
 * それは live テスト（opt-in）が見る。
 *
 * 🔴 **上限の検査は推論の前に行う。**超過が確定している入力に、
 * 36MB のモデルを回す費用を払わせない。
 */
export function buildLocalEmbeddingPipeline(
  extractor: LocalEmbeddingExtractor,
): LocalEmbeddingPipeline {
  const maxInputTokens = extractor.tokenizer.model_max_length;

  // ⚠ `Number.isInteger` は `Infinity` と `NaN` を弾く。**「宣言されていない」を
  // 「上限が無い」として通さない**——通せば、切り捨ては再び黙る。
  if (!Number.isInteger(maxInputTokens) || maxInputTokens <= 0) {
    throw new LocalEmbeddingProviderError(
      "unknown_input_limit",
      `LocalEmbeddingProvider: モデルが入力トークン数の上限を宣言していない` +
        `（tokenizer の model_max_length = ${String(maxInputTokens)}）。` +
        `上限が分からないと、入力が黙って切り捨てられたことを検出できない。` +
        `tokenizer_config.json に model_max_length を持つモデルを options.repo に指すか、` +
        `options.createPipeline で pipeline を注入すること`,
    );
  }

  return async (texts) => {
    for (const [index, text] of texts.entries()) {
      const tokens = extractor.tokenizer.encode(text).length;
      if (tokens > maxInputTokens) {
        throw new LocalEmbeddingProviderError(
          "input_too_long",
          `LocalEmbeddingProvider: ${index} 番目の入力が上限を超えている` +
            `（${tokens} トークン > 上限 ${maxInputTokens} トークン、${text.length} 文字）。` +
            `このまま埋め込むと、上限より後ろは黙って捨てられ、` +
            `切り捨てられたことが分からないベクトルが返る` +
            `（transformers.js は truncation: true で呼ぶため、例外もログも出ない）。` +
            `入力を分割するか短くすること——同じ入力で再試行しても永久に失敗する`,
          { index, tokens, maxInputTokens, characters: text.length },
        );
      }
    }
    return toVectors(await extractor(texts, { pooling: "mean", normalize: true }));
  };
}

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
  // ⚠ **ここが、このパッケージで唯一ユニットテストに載らない場所である。**
  // `pipeline()` が返すものが `LocalEmbeddingExtractor` の形（呼べて、`tokenizer` を持つ）を
  // していることは、**型では確かめられない**（transformers.js の戻りは全 pipeline 種の union）。
  // ⟹ 形が違えば live テストが落ちる。**cast はここ1箇所に閉じてある。**
  return buildLocalEmbeddingPipeline(extractor as unknown as LocalEmbeddingExtractor);
};
