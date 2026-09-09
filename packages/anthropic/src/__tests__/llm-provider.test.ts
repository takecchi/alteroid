import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ZodError } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider, DEFAULT_MAX_TOKENS, toAnthropicRequest } from "../llm-provider.js";

/**
 * **正直に書く**: `client` は手書きの偽物であり、本物の Anthropic API を叩かない。
 * ここで検査しているのは (a) `completeStructured` が正しい `output_config.format` を
 * 組み立てて渡すこと、(b) `system` の扱い（`prompt.system` と `role: "system"` の
 * メッセージが top-level `system` へ連結され、`messages` に残らないこと）、
 * (c) `model`/`maxTokens` が正しく渡ること、(d) 異常系で例外を投げること。
 * 「LLM が実際に良い抽出結果を返すか」はここでは検査できない（live テスト参照）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const sampleSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("toAnthropicRequest", () => {
  it("prompt.system を top-level system に入れる", () => {
    const result = toAnthropicRequest({
      system: "あなたは要約器です。",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.system).toBe("あなたは要約器です。");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("role: 'system' のメッセージは黙って捨てず、top-level system へ連結する", () => {
    const result = toAnthropicRequest({
      messages: [
        { role: "system", content: "運用者の指示1" },
        { role: "user", content: "hi" },
        { role: "system", content: "運用者の指示2" },
      ],
    });
    expect(result.system).toBe("運用者の指示1\n運用者の指示2");
    // messages には role: "system" が残らない。
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prompt.system と role: 'system' のメッセージが両方あれば、system の後ろに連結する", () => {
    const result = toAnthropicRequest({
      system: "基本指示",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "追加指示" },
      ],
    });
    expect(result.system).toBe("基本指示\n追加指示");
  });

  it("system が無ければ system キー自体を持たない", () => {
    const result = toAnthropicRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(result.system).toBeUndefined();
    expect("system" in result).toBe(false);
  });
});

describe("AnthropicLLMProvider.complete", () => {
  it("最初のテキストブロックの text を返す", async () => {
    const create = vi.fn().mockResolvedValue(textResponse("こんにちは"));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "こんにちは" });
  });

  it("テキストブロックが無ければ空文字を返す（例外にしない）", async () => {
    const create = vi.fn().mockResolvedValue({ content: [] });
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "" });
  });

  it("model と maxTokens（省略時 DEFAULT_MAX_TOKENS）を渡す", async () => {
    const create = vi.fn().mockResolvedValue(textResponse("ok"));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.model).toBe("claude-test");
    expect(callArgs.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("maxTokens を指定すればそれが渡る", async () => {
    const create = vi.fn().mockResolvedValue(textResponse("ok"));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      maxTokens: 512,
      client: { messages: { create } } as never,
    });
    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.max_tokens).toBe(512);
  });
});

describe("AnthropicLLMProvider.completeStructured", () => {
  it("output_config.format に翻訳済みの json_schema を渡す", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(textResponse(JSON.stringify({ content: "本文", tags: ["a"] })));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema: sampleSchema,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.output_config.format.type).toBe("json_schema");
    // name/strict は無い（OpenAI との差。json-schema.test.ts が翻訳自体を直接検査する）。
    expect("name" in callArgs.output_config.format).toBe(false);
    expect("strict" in callArgs.output_config.format).toBe(false);
    // content は required（.optional() を付けていない）、digest/tags は required に無い。
    expect(callArgs.output_config.format.schema.required).toEqual(["content"]);
  });

  it("system と role: 'system' のメッセージを正しく組み立てて渡す", async () => {
    const create = vi.fn().mockResolvedValue(textResponse(JSON.stringify({ content: "本文" })));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    await provider.completeStructured(ctx, {
      prompt: {
        system: "基本指示",
        messages: [
          { role: "system", content: "追加指示" },
          { role: "user", content: "hi" },
        ],
      },
      schema: sampleSchema,
    });

    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.system).toBe("基本指示\n追加指示");
    expect(callArgs.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("Anthropic が返した JSON をそのまま zod でパースする（stripNulls 相当は無い。optional は省略のまま通る）", async () => {
    // Anthropic 側は required を元のままにするため、モデルが digest/tags を省略した
    // JSON をそのまま返してくる想定（OpenAI の strict モードのように null で埋めない）。
    const create = vi.fn().mockResolvedValue(textResponse(JSON.stringify({ content: "本文" })));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    const result = await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema: sampleSchema,
    });

    expect(result).toEqual({ content: "本文" });
    expect("digest" in result).toBe(false);
  });

  it("content が空/欠落なら Error を投げる", async () => {
    const create = vi.fn().mockResolvedValue({ content: [] });
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toThrow("AnthropicLLMProvider: structured completion returned no content");
  });

  it("JSON として壊れていれば SyntaxError をそのまま伝播する", async () => {
    const create = vi.fn().mockResolvedValue(textResponse("{ not json"));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it("スキーマに適合しなければ ZodError をそのまま伝播する（必須フィールド欠落）", async () => {
    const create = vi.fn().mockResolvedValue(textResponse(JSON.stringify({ digest: "要旨だけ" })));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
