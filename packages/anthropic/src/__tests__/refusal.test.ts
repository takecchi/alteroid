import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import type { AnthropicLLMProviderError } from "../errors.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * **拒否（`stop_reason: "refusal"`）を「空の成功」にしないための歯。**
 *
 * **⚠ この穴は ADR 0072 の初版に実在した。**`content` を読む前に `stop_reason` を
 * 見ていなかったため、**「モデルが拒否した」と「応答が空だった」が同じ `Error`** になり、
 * `complete()` に至っては `?? ""` で**空文字を成功として返していた**。
 * 拒否は HTTP 200 で返るので、SDK は何も教えてくれない。
 *
 * **⭐ この歯が測るのは「赤くなること」ではなく「区別が付くこと」である。**
 * どちらの入力でも同じように赤くなる歯は、区別を測っていない。
 * ⟹ 下の歯は必ず**対で**書く: 拒否のときに `kind === "refusal"` になり、
 * **かつ `kind === "no_content"` ではない**こと。逆も同じ。
 *
 * **⚠ 検査していないこと**: 実 API が本当に `stop_reason: "refusal"` を返すところは
 * 見ていない（`ANTHROPIC_API_KEY` がこの器に無い）。ここで固定しているのは
 * **SDK の型定義（`StopReason` に `'refusal'` が在り、`Message.stop_details` が
 * `RefusalStopDetails | null` である）に対して、こちらが正しく反応すること**である。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const schema = z.object({ content: z.string() });
const structuredRequest = {
  prompt: { messages: [{ role: "user" as const, content: "なにか教えて" }] },
  schema,
};

/** 応答を丸ごと差し込める偽 client（`stop_reason` を自由に設定するため）。 */
function buildWithResponse(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { provider, create };
}

const refusalResponse = {
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "cyber" },
  content: [],
};
/** 拒否ではないが、テキストブロックが無い応答。 */
const emptyResponse = { stop_reason: "end_turn", stop_details: null, content: [] };

/** 実際に投げられた `AnthropicLLMProviderError` を取り出す。 */
async function captureError(run: () => Promise<unknown>): Promise<AnthropicLLMProviderError> {
  try {
    await run();
  } catch (error) {
    return error as AnthropicLLMProviderError;
  }
  // ⚠ `expect.fail` を使う（素の `throw new Error` にしない）——変異試験で
  // 「AssertionError の件数」を数えるとき、歯が噛んだのか器が転んだのかを
  // 区別できる形にしておくため。
  return expect.fail("例外が投げられなかった（黙って成功した＝歯が意味を失っている）");
}

describe("completeStructured: 拒否と空応答を区別する", () => {
  it("拒否のとき kind は 'refusal' であり、'no_content' ではない", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    // ⭐ 区別を測る側。ここが無いと「どちらでも赤い」歯になる。
    expect(error.kind).not.toBe("no_content");
    expect(error.stopReason).toBe("refusal");
  });

  it("空応答のとき kind は 'no_content' であり、'refusal' ではない", async () => {
    const { provider } = buildWithResponse(emptyResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("no_content");
    // ⭐ 対になる側。
    expect(error.kind).not.toBe("refusal");
  });

  it("拒否と空応答は、別のメッセージになる（kind を見ない呼び出し側にも区別が届く）", async () => {
    const { provider: refusing } = buildWithResponse(refusalResponse);
    const { provider: empty } = buildWithResponse(emptyResponse);

    const refusalError = await captureError(() =>
      refusing.completeStructured(ctx, structuredRequest),
    );
    const emptyError = await captureError(() => empty.completeStructured(ctx, structuredRequest));

    expect(refusalError.message).not.toBe(emptyError.message);
    expect(refusalError.message).toMatch(/refused/);
    // `@mnemora/openai` と揃えた既存の契約は壊さない（provider-parity.test.ts が依存している）。
    expect(emptyError.message).toMatch(/structured completion returned no content/);
  });

  it("拒否の分類（stop_details.category）を落とさない", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.refusalCategory).toBe("cyber");
  });

  it("stop_details が無い拒否でも、拒否として扱う（分類は null）", async () => {
    const { provider } = buildWithResponse({
      stop_reason: "refusal",
      stop_details: null,
      content: [],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    expect(error.refusalCategory).toBeNull();
  });

  it("⚠ 拒否の判定は content より先に走る（テキストが在っても拒否は拒否）", async () => {
    // **順序を測る歯。**`content` を先に読む実装だと、この応答は「普通の成功」に化ける。
    const { provider } = buildWithResponse({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "bio" },
      content: [{ type: "text", text: JSON.stringify({ content: "answered anyway" }) }],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
  });
});

describe("completeStructured: 切り詰めを『壊れた JSON』と混ぜない", () => {
  it("max_tokens で切れたら kind は 'truncated'（SyntaxError にしない）", async () => {
    // 切り詰められた JSON はそのまま `JSON.parse` へ渡すと SyntaxError になり、
    // 「モデルが壊れた JSON を吐いた」と区別が付かなくなる。
    const { provider } = buildWithResponse({
      stop_reason: "max_tokens",
      stop_details: null,
      content: [{ type: "text", text: '{"content":"途中で切れ' }],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("truncated");
    expect(error.stopReason).toBe("max_tokens");
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it("model_context_window_exceeded も 'truncated' として扱う", async () => {
    const { provider } = buildWithResponse({
      stop_reason: "model_context_window_exceeded",
      stop_details: null,
      content: [],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("truncated");
  });

  it("正常な stop_reason は素通りする（門が広すぎないこと）", async () => {
    const { provider } = buildWithResponse({
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "text", text: JSON.stringify({ content: "ok" }) }],
    });
    await expect(provider.completeStructured(ctx, structuredRequest)).resolves.toEqual({
      content: "ok",
    });
  });

  it("stop_reason が無くても素通りする（『分からない』を『拒否された』と読まない）", async () => {
    // 偽 client や streaming の message_start では null になる。
    const { provider } = buildWithResponse({
      content: [{ type: "text", text: JSON.stringify({ content: "ok" }) }],
    });
    await expect(provider.completeStructured(ctx, structuredRequest)).resolves.toEqual({
      content: "ok",
    });
  });
});

describe("complete: 拒否を空文字で握り潰さない", () => {
  const prompt = { messages: [{ role: "user" as const, content: "なにか教えて" }] };

  it("拒否のとき例外を投げる（空文字を成功として返さない）", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.complete(ctx, prompt));

    expect(error.kind).toBe("refusal");
  });

  it("⚠ 拒否ではない空応答では、いまも空文字を返す（望ましい姿ではない）", async () => {
    // **この歯は「安全である」と主張していない。**
    // ADR 0072「引き受けた負債」2 の通り、`@mnemora/openai` も同じ形であり、
    // 直すなら両 provider 同時（公開 API の破壊的変更）になる。
    // ⟹ **これは「いまはこうだが望ましい姿ではない」を固定する歯であり、
    // 改善を禁じる意味ではない。**直すときは、この歯ごと書き換えること。
    const { provider } = buildWithResponse(emptyResponse);
    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "" });
  });
});
