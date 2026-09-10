import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingExtractor } from "../pipeline.js";
import { isLocalEmbeddingProviderError } from "../errors.js";
import type { LocalEmbeddingProviderError } from "../errors.js";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/**
 * 入力トークン数の上限を超えたことが**分かる**ことを固定する歯（ADR 0090）。
 *
 * 🔴 **何を測っているか。**
 *
 * `sirasagi62/ruri-v3-30m-ONNX` は **8192 トークンで黙って切り捨てる**
 * （`tokenizer_config.json` の `model_max_length: 8192`。`@huggingface/transformers@4.2.0` の
 * `src/pipelines/feature-extraction.js:89-92` が `max_length` 無しで `truncation: true` を渡し、
 * `src/tokenization_utils.js:405,428,438` が `model_max_length` に丸めて
 * `truncateHelper` が配列を切る。**例外もログも戻り値の変化も無い**）。
 *
 * ⟹ 切り捨てそのものは直せない（モデルの上限は変えられない）。
 * **直せるのは「起きたことが分からない」ほうである。**
 *
 * ⚠ **ここでは 8192 という数字を測っていない。**それはモデルが持つ事実であり、
 * 本物のモデルを落とさないと確かめられない。**この数字を固定するのは
 * `live.local-embedding.test.ts`（opt-in）である。**
 * ここが測るのは「**上限をどう受け取り、超過をどう名乗るか**」という、
 * このパッケージ自身のロジックだけである。
 */

const ctx: Ctx = { tenantId: "t1" };

interface FakeExtractorHandle {
  readonly extractor: LocalEmbeddingExtractor;
  /** `extractor` が実際に呼ばれた回数。**推論の前に落ちることを測るための数である。** */
  readonly calls: () => number;
}

/**
 * 擬似の extractor。**トークン数は「1文字1トークン」と決めてある**——
 * 本物のトークナイザの比率を真似ることには意味が無く、
 * 測りたいのは「上限との比較」だけである。
 */
function fakeExtractor(modelMaxLength: number, dimensions = 256): FakeExtractorHandle {
  let calls = 0;
  const extractor = Object.assign(
    async (texts: string[]) => {
      calls += 1;
      return texts.map(() => Array.from({ length: dimensions }, () => 0.1));
    },
    {
      tokenizer: {
        model_max_length: modelMaxLength,
        encode: (text: string) => Array.from({ length: text.length }, (_, i) => i),
      },
    },
  ) as unknown as LocalEmbeddingExtractor;
  return { extractor, calls: () => calls };
}

describe("buildLocalEmbeddingPipeline: 上限の受け取り", () => {
  /**
   * ⚠ **`Infinity` は「上限が無い」ではなく「宣言されていない」である。**
   * transformers.js の `get model_max_length()` は宣言が無いとき `Infinity` を返す。
   * ⟹ そのまま通すと、**上限が分からないまま切り捨てが黙って起きる状態に戻る。**
   */
  it("model_max_length が Infinity（＝宣言されていない）なら、組み立て自体が失敗する", () => {
    expect(() => buildLocalEmbeddingPipeline(fakeExtractor(Infinity).extractor)).toThrow(
      /上限を宣言していない/,
    );
  });

  it("その失敗は kind: 'unknown_input_limit' を名乗る", () => {
    try {
      buildLocalEmbeddingPipeline(fakeExtractor(Infinity).extractor);
      expect.unreachable("組み立ては失敗しなければならない");
    } catch (error) {
      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["0", 0],
    ["負の数", -1],
    ["小数", 512.5],
  ])("model_max_length が %s でも組み立てが失敗する", (_label, value) => {
    expect(() => buildLocalEmbeddingPipeline(fakeExtractor(value).extractor)).toThrow(
      /上限を宣言していない/,
    );
  });
});

describe("buildLocalEmbeddingPipeline: 上限の境界", () => {
  /**
   * ⭐ **境界は `>` である。上限ちょうどは切り捨てられない。**
   *
   * transformers.js の `tokenization_utils.js` は
   * `else if (encodedTokens[i].input_ids.length > max_length)` で初めて切り詰める。
   * ⟹ **`>=` で落とすと、切り捨てられていない入力を拒否する**（誤検出）。
   */
  it("上限ちょうど（10トークン / 上限10）は通る", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const vectors = await pipeline(["あ".repeat(10)]);
    expect(vectors).toHaveLength(1);
    expect(handle.calls()).toBe(1);
  });

  it("上限を1トークン超える（11トークン / 上限10）と落ちる", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    await expect(pipeline(["あ".repeat(11)])).rejects.toThrow(/上限を超えている/);
  });

  /**
   * 🔴 **推論の前に落ちること。**
   *
   * 超過が確定している入力に、36MB のモデルを回す費用を払わせない。
   * **この歯が無いと「落ちてはいるが、落ちる前に推論している」形を緑で通す。**
   */
  it("落ちるとき、extractor（推論）は一度も呼ばれない", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    await expect(pipeline(["あ".repeat(11)])).rejects.toThrow();
    expect(handle.calls()).toBe(0);
  });
});

describe("buildLocalEmbeddingPipeline: 超過の名乗り方", () => {
  it("kind: 'input_too_long' と、原因を追える欄を持つ", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const error = await pipeline(["あ".repeat(25)]).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(isLocalEmbeddingProviderError(error)).toBe(true);
    const typed = error as LocalEmbeddingProviderError;
    expect(typed.kind).toBe("input_too_long");
    expect(typed.detail).toEqual({
      index: 0,
      tokens: 25,
      maxInputTokens: 10,
      characters: 25,
    });
  });

  /**
   * ⚠ **どの入力が長すぎたのかが分かること。**
   * `embed(ctx, texts)` は配列を受け取る。**番号が出ないと、呼び出し側は
   * どれを分割すればよいか分からない。**
   */
  it("複数件のうち何番目が長すぎたのかを名乗る", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const error = await pipeline(["短い", "あ".repeat(30), "これも短い"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as LocalEmbeddingProviderError).detail?.index).toBe(1);
    expect((error as LocalEmbeddingProviderError).detail?.tokens).toBe(30);
  });

  /**
   * ⚠ **文字数は「参考」であって「判定に使った値」ではない。**
   * トークン数と文字数の比は文章によって変わる。
   * この歯は、**両方が欄として残っていて、混同されていないこと**を固定する。
   */
  it("トークン数と文字数を、別の欄として残す", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const error = await pipeline(["x".repeat(12)]).then(
      () => null,
      (reason: unknown) => reason,
    );
    const detail = (error as LocalEmbeddingProviderError).detail;
    expect(detail?.tokens).toBe(12);
    expect(detail?.characters).toBe(12);
    expect(detail?.maxInputTokens).toBe(10);
  });
});

describe("LocalEmbeddingProvider 越しに見たとき", () => {
  it("上限を超えた入力で embed() が reject する", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(10).extractor),
    });
    await expect(provider.embed(ctx, ["あ".repeat(11)])).rejects.toThrow(/上限を超えている/);
  });

  it("prefix を足したぶんも数える（prefix で上限を超えたら落ちる）", async () => {
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(10).extractor),
    });
    // 本文は 5 文字。prefix（6文字）を足して 11 トークンになる。
    await expect(provider.embed(ctx, ["あいうえお"])).rejects.toThrow(/上限を超えている/);
  });

  /**
   * 🔴 **種類を潰さない歯。**
   *
   * `#startLoad` は `createPipeline` の失敗を
   * 「モデルを読み込めなかった（repo が消えたなら再変換できる）」で包む。
   * **`unknown_input_limit` をそれで包むと、嘘の助言になる**
   * ——repo は取得できているし、再変換しても上限は宣言されない。
   */
  it("unknown_input_limit は「モデルを読み込めなかった」で包まれない", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(Infinity).extractor),
    });
    const error = await provider.embed(ctx, ["あ"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).not.toMatch(/モデルを読み込めなかった/);
    expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
  });

  /**
   * ⚠ **種類が分かっていない失敗は、今までどおり包む。**
   * 上の歯が「何でも包まない」に化けていないことを、反対側から押さえる。
   */
  it("種類の付いていない失敗は、今までどおり「モデルを読み込めなかった」で包まれる", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("ネットワークが落ちた");
      },
    });
    await expect(provider.embed(ctx, ["あ"])).rejects.toThrow(/モデルを読み込めなかった/);
  });
});

describe("isLocalEmbeddingProviderError", () => {
  /**
   * ⚠ **`instanceof` ではなく `kind` の値で判定していること**（ADR 0075 と同じ理由）。
   * bundler がクラスを二重に読み込んでも効くことを、**クラスを一切使わない値**で測る。
   */
  it("クラスを経由していない素のオブジェクトでも、kind が合えば真になる", () => {
    expect(isLocalEmbeddingProviderError({ kind: "input_too_long" })).toBe(true);
    expect(isLocalEmbeddingProviderError({ kind: "unknown_input_limit" })).toBe(true);
  });

  it("関係のない値には偽を返す", () => {
    expect(isLocalEmbeddingProviderError(new Error("素の Error"))).toBe(false);
    expect(isLocalEmbeddingProviderError({ kind: "something_else" })).toBe(false);
    expect(isLocalEmbeddingProviderError(null)).toBe(false);
    expect(isLocalEmbeddingProviderError("input_too_long")).toBe(false);
  });
});
