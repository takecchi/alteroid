import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import type { OpenAILLMProviderError } from "../errors.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * **拒否（`message.refusal`）を「空の成功」にしないための歯。**
 *
 * **⚠ この穴は `@mnemora/anthropic` の `refusal.test.ts` が塞いだのと同じ形で、
 * `@mnemora/openai` 側に残っていた**（`refusal` / `finish_reason` / `content_filter` の
 * grep が `packages/openai/src` 全体で 0 件だった）。`content` を読む前に
 * `message.refusal` / `finish_reason` を見ていなかったため、拒否が `no_content` に
 * 化ける（拒否時は `content` が `null` になるため）。
 *
 * **⚠ OpenAI は Anthropic の `stop_reason` 一本とは形が違う。** 機構は2つ独立している:
 * `message.refusal`（拒否理由の文字列）と `finish_reason`（`"length"` / `"content_filter"` 等）。
 * 「`stop_reason` を見ろ」をそのまま持ち込んでいない——両方をそれぞれ見る。
 *
 * **⭐ この歯が測るのは「赤くなること」ではなく「区別が付くこと」である。**
 * どちらの入力でも同じように赤くなる歯は、区別を測っていない。
 * ⟹ 下の歯は必ず**対で**書く: 拒否のときに `kind === "refusal"` になり、
 * **かつ `kind === "no_content"` ではない**こと。逆も同じ。
 *
 * **⚠ 検査していないこと**: 実 API が本当にこの形（`message.refusal` / `finish_reason`）を
 * 返すところは見ていない（`OPENAI_API_KEY` を使わない偽 client のみ）。ここで固定して
 * いるのは **openai SDK 7.10.0 の型定義（`ChatCompletionMessage.refusal: string | null`、
 * `ChatCompletion.Choice.finish_reason`）に対して、こちらが正しく反応すること**である。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const schema = z.object({ content: z.string() });
const structuredRequest = {
  prompt: { messages: [{ role: "user" as const, content: "なにか教えて" }] },
  schema,
};

/** 応答を丸ごと差し込める偽 client（`llm-provider.test.ts` と同じ組み立て方）。 */
function buildWithResponse(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { provider, create };
}

const refusalResponse = {
  choices: [
    {
      finish_reason: "stop",
      message: { refusal: "I can't help with that request.", content: null },
    },
  ],
};
/** 拒否ではないが、content が空の応答。 */
const emptyResponse = {
  choices: [{ finish_reason: "stop", message: { refusal: null, content: "" } }],
};

/** 実際に投げられた `OpenAILLMProviderError` を取り出す。 */
async function captureError(run: () => Promise<unknown>): Promise<OpenAILLMProviderError> {
  try {
    await run();
  } catch (error) {
    return error as OpenAILLMProviderError;
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
    // `@mnemora/anthropic` と揃えた既存の契約は壊さない（provider-parity.test.ts が依存している）。
    expect(emptyError.message).toMatch(/structured completion returned no content/);
  });

  it("拒否理由の文面（refusalMessage）を落とさない", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.refusalMessage).toBe("I can't help with that request.");
  });

  it("⚠ 拒否の判定は content より先に走る（正常っぽい JSON が在っても拒否は拒否）", async () => {
    // **順序を測る歯。**`content` を先に読む実装だと、この応答は「普通の成功」に化ける。
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            refusal: "I can't help with that request.",
            content: JSON.stringify({ content: "answered anyway" }),
          },
        },
      ],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
  });

  it("finish_reason: 'content_filter' も 'refusal' として扱う（情報は潰さない）", async () => {
    const { provider } = buildWithResponse({
      choices: [{ finish_reason: "content_filter", message: { refusal: null, content: null } }],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    // ⭐ 生の finish_reason が落ちていないこと（コンテンツフィルタと拒否メッセージは別機構）。
    expect(error.finishReason).toBe("content_filter");
  });
});

describe("completeStructured: 切り詰めを『壊れた JSON』と混ぜない", () => {
  it("finish_reason: 'length' で切れたら kind は 'truncated'（SyntaxError にしない）", async () => {
    // 切り詰められた JSON はそのまま `JSON.parse` へ渡すと SyntaxError になり、
    // 「モデルが壊れた JSON を吐いた」と区別が付かなくなる。
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "length",
          message: { refusal: null, content: '{"content":"途中で切れ' },
        },
      ],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("truncated");
    expect(error.finishReason).toBe("length");
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it("正常な finish_reason: 'stop' は素通りする（門が広すぎないこと）", async () => {
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "stop",
          message: { refusal: null, content: JSON.stringify({ content: "ok" }) },
        },
      ],
    });
    await expect(provider.completeStructured(ctx, structuredRequest)).resolves.toEqual({
      content: "ok",
    });
  });

  it("finish_reason が無くても素通りする（『分からない』を『拒否された』と読まない）", async () => {
    const { provider } = buildWithResponse({
      choices: [{ message: { refusal: null, content: JSON.stringify({ content: "ok" }) } }],
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
    // ADR 0072「引き受けた負債」2 の通り、`@mnemora/anthropic` も同じ形であり、
    // 直すなら両 provider 同時（公開 API の破壊的変更）になる。
    // ⟹ **これは「いまはこうだが望ましい姿ではない」を固定する歯であり、
    // 改善を禁じる意味ではない。**直すときは、この歯ごと書き換えること。
    const { provider } = buildWithResponse(emptyResponse);
    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "" });
  });
});
