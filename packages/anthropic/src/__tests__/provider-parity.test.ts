import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import { OpenAILLMProvider } from "@mnemora/openai";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * **「差し替えられる」の証明（ADR 0072 決定3）。**
 *
 * `docs/architecture.md` §4 は `packages/testkit` を置いた理由をこう書いている:
 *
 * > 「差し替え可能」という主張は、適合テストが無ければ願望に留まる。（…）**2つ目の
 * > adapter が書かれた瞬間に、型は同じでも振る舞いが違う実装が紛れ込む。**
 *
 * **⚠ この論法は Store 系にだけ適用されていた。**`packages/testkit` の適合テストは
 * `MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore` の
 * 5種だけを対象にしており、**provider（`LLMProvider` / `EmbeddingProvider`）向けの
 * 適合テストは1本も無い**（実測。testkit が provider について持っているのは
 * `Deterministic*` / `Recorded*` という**擬似実装＝テストの入力側**であって、
 * 他人の実装を検査するスイートではない）。
 *
 * **⟹ このファイルが、このリポジトリで「2つの `LLMProvider` 実装が同じ契約を満たす」ことを
 * 実際に測る最初の歯である。**同じ `Ctx` / 同じ `PromptSpec` / 同じ zod スキーマを
 * 両方に与え、**同じ形の値が返る**ことと、**異常系の契約も揃っている**ことを検査する。
 *
 * **⚠ これは適合テストの代わりではない。**`packages/anthropic` の中に在る歯なので、
 * 3つ目の provider が来ても自動的には効かない。ADR 0072「引き受けた負債」1 に置いた。
 *
 * **⚠ 検査していないこと**: どちらの client も手書きの偽物であり、
 * **実 API の応答が同じ形になることは検査していない**（そもそも LLM は非決定的であり、
 * ADR 0051 の arm C が実測でそれを示している）。ここで揃えているのは
 * **provider が守ると宣言している契約**——引数の型・戻り値の形・例外を投げる条件——だけである。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

/** core が実際に `completeStructured` へ渡すスキーマ（`packages/core/src/extraction.ts` の
 * `ExtractionResultSchema`）と同じ形——`.optional()` を含むことが要点。
 * **ここが両 provider の翻訳の差が最も出る箇所である**（OpenAI 側は optional を
 * required + nullable へ倒し、返りを `stripNulls` で戻す。Anthropic 側は optional のまま）。 */
const sharedSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/** 両 provider へ与える、同一の入力。 */
const sharedRequest: StructuredRequest<z.infer<typeof sharedSchema>> = {
  prompt: {
    system: "あなたは抽出器です。",
    messages: [{ role: "user", content: "来月、京都へ出張する。" }],
  },
  schema: sharedSchema,
};

/** 両 provider が返すことになる、同一の意味の JSON。
 * **`digest` は在り、`tags` は無い**——optional の扱いの差を踏ませるため。 */
const sharedJson = { content: "来月、京都へ出張する予定がある。", digest: "京都出張" };

function buildAnthropic(responseText: string | undefined) {
  const create = vi.fn().mockResolvedValue({
    content: responseText === undefined ? [] : [{ type: "text", text: responseText }],
  });
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { provider, create };
}

function buildOpenAI(responseText: string | undefined) {
  const create = vi.fn().mockResolvedValue({
    choices: responseText === undefined ? [] : [{ message: { content: responseText } }],
  });
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { provider, create };
}

describe("provider parity: AnthropicLLMProvider と OpenAILLMProvider", () => {
  it("両方が LLMProvider として同じ変数に入る（型としての差し替え可能性）", () => {
    const { provider: anthropic } = buildAnthropic("{}");
    const { provider: openai } = buildOpenAI("{}");

    // ⚠ これは実行時の assertion ではなく、**型検査が通ること自体**が主張である。
    // 片方が `LLMProvider` を満たさなくなれば `pnpm run typecheck` が赤くなる。
    const providers: LLMProvider[] = [anthropic, openai];

    expect(providers).toHaveLength(2);
    for (const provider of providers) {
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.completeStructured).toBe("function");
    }
  });

  it("同じ入力・同じ応答に対して completeStructured が同じ値を返す", async () => {
    const { provider: anthropic } = buildAnthropic(JSON.stringify(sharedJson));
    const { provider: openai } = buildOpenAI(JSON.stringify(sharedJson));

    const fromAnthropic = await anthropic.completeStructured(ctx, sharedRequest);
    const fromOpenAI = await openai.completeStructured(ctx, sharedRequest);

    expect(fromAnthropic).toEqual(fromOpenAI);
    expect(fromAnthropic).toEqual(sharedJson);
    // 省略された optional は、どちらでも「キーが無い」になる（`null` にならない）。
    expect("tags" in fromAnthropic).toBe(false);
    expect("tags" in fromOpenAI).toBe(false);
  });

  it("complete も同じ入力・同じ応答に対して同じ値を返す", async () => {
    const { provider: anthropic } = buildAnthropic("こんにちは");
    const { provider: openai } = buildOpenAI("こんにちは");

    const fromAnthropic = await anthropic.complete(ctx, sharedRequest.prompt);
    const fromOpenAI = await openai.complete(ctx, sharedRequest.prompt);

    expect(fromAnthropic).toEqual(fromOpenAI);
    expect(fromAnthropic).toEqual({ content: "こんにちは" });
  });

  it("構造化出力が返らなかったとき、両方が例外を投げる（黙って空を返さない）", async () => {
    const { provider: anthropic } = buildAnthropic(undefined);
    const { provider: openai } = buildOpenAI(undefined);

    await expect(anthropic.completeStructured(ctx, sharedRequest)).rejects.toThrow(
      /structured completion returned no content/,
    );
    await expect(openai.completeStructured(ctx, sharedRequest)).rejects.toThrow(
      /structured completion returned no content/,
    );
  });

  it("スキーマに適合しない JSON が返ったとき、両方が ZodError を投げる", async () => {
    // `content` が number（スキーマは string を要求する）。
    const invalid = JSON.stringify({ content: 42 });
    const { provider: anthropic } = buildAnthropic(invalid);
    const { provider: openai } = buildOpenAI(invalid);

    await expect(anthropic.completeStructured(ctx, sharedRequest)).rejects.toThrow(z.ZodError);
    await expect(openai.completeStructured(ctx, sharedRequest)).rejects.toThrow(z.ZodError);
  });

  it("JSON として壊れた応答が返ったとき、両方が SyntaxError を投げる", async () => {
    const { provider: anthropic } = buildAnthropic("{ これは JSON ではない");
    const { provider: openai } = buildOpenAI("{ これは JSON ではない");

    await expect(anthropic.completeStructured(ctx, sharedRequest)).rejects.toThrow(SyntaxError);
    await expect(openai.completeStructured(ctx, sharedRequest)).rejects.toThrow(SyntaxError);
  });

  it("complete のテキストが取れないとき、両方が空文字を返す（契約の非対称を固定する）", async () => {
    // ⚠ **これは望ましい振る舞いではない。**ADR 0072「引き受けた負債」2 に記録した通り、
    // `completeStructured` は throw するのに `complete` は黙って空を返す。
    // **両 provider が同じように壊れていること**を、ここで固定しておく——
    // 片方だけ直すと差し替えられなくなるため、直すなら両方同時である。
    const { provider: anthropic } = buildAnthropic(undefined);
    const { provider: openai } = buildOpenAI(undefined);

    await expect(anthropic.complete(ctx, sharedRequest.prompt)).resolves.toEqual({ content: "" });
    await expect(openai.complete(ctx, sharedRequest.prompt)).resolves.toEqual({ content: "" });
  });

  it("両 provider が、ベンダー固有の型を戻り値に漏らしていない", async () => {
    // core の契約は `LLMResponse { content: string }` と検証済みの `T` だけである。
    const { provider: anthropic } = buildAnthropic(JSON.stringify(sharedJson));
    const { provider: openai } = buildOpenAI(JSON.stringify(sharedJson));

    const a = await anthropic.complete(ctx, sharedRequest.prompt);
    const o = await openai.complete(ctx, sharedRequest.prompt);
    expect(Object.keys(a)).toEqual(["content"]);
    expect(Object.keys(o)).toEqual(["content"]);

    const as = await anthropic.completeStructured(ctx, sharedRequest);
    const os = await openai.completeStructured(ctx, sharedRequest);
    // スキーマに宣言されたキーだけが返る（SDK の応答メタ情報が混ざらない）。
    expect(Object.keys(as).sort()).toEqual(["content", "digest"]);
    expect(Object.keys(os).sort()).toEqual(["content", "digest"]);
  });
});

describe("provider divergence: 翻訳の形は同じではない（そこがベンダーの差である）", () => {
  it("Anthropic は output_config.format、OpenAI は response_format で送る", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    const anthropicArg = anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const openaiArg = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;

    // Anthropic 側: output_config.format = { type, schema }。name も strict も無い。
    const format = (anthropicArg["output_config"] as { format: Record<string, unknown> }).format;
    expect(format["type"]).toBe("json_schema");
    expect(format).not.toHaveProperty("name");
    expect(format).not.toHaveProperty("strict");
    expect(anthropicArg).not.toHaveProperty("response_format");

    // OpenAI 側: response_format.json_schema = { name, strict: true, schema }。
    const jsonSchema = (openaiArg["response_format"] as { json_schema: Record<string, unknown> })
      .json_schema;
    expect(jsonSchema["strict"]).toBe(true);
    expect(jsonSchema).toHaveProperty("name");
    expect(openaiArg).not.toHaveProperty("output_config");
  });

  it("optional の扱いが違う: Anthropic は required に足さない、OpenAI は足す", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    const anthropicSchema = (
      (anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>)["output_config"] as {
        format: { schema: { required?: string[] } };
      }
    ).format.schema;
    const openaiSchema = (
      (openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>)["response_format"] as {
        json_schema: { schema: { required?: string[] } };
      }
    ).json_schema.schema;

    // Anthropic: `.optional()` は required に入らない。
    expect(anthropicSchema.required).toEqual(["content"]);
    // OpenAI: strict モードの要求により、全キーが required に入る。
    expect(openaiSchema.required?.slice().sort()).toEqual(["content", "digest", "tags"]);

    // ⟹ **これが「同じ入力でも翻訳は同じにならない」の実測である。**
    // それでも上の describe の通り、`completeStructured` の戻り値は同じになる。
    expect(anthropicSchema.required).not.toEqual(openaiSchema.required);
  });

  it("enum の扱いが違う: OpenAI は enum キーとして送る、Anthropic は description へ降格する", async () => {
    // ⚠ **これは契約の差ではなく、強制力の差である。**core が実際に渡す
    // `ExtractionResultSchema` は `provenanceKind: z.enum(["stated", "inferred"])` を持つ。
    // OpenAI 側は JSON Schema の `enum` としてそのまま送る（生成時に制約される）。
    // Anthropic の公式ヘルパ（`transformJSONSchema`）は `enum` を素通りさせず、
    // **`description` に JSON 文字列として埋め込む**——つまり制約ではなく説明文として送る。
    // ⟹ 列挙から外れた値が返ってきた場合、OpenAI 側は生成段で防がれるが、
    // Anthropic 側は `req.schema.parse` の ZodError で初めて弾かれる。
    // **どちらも「黙って通す」ことはしない**が、止まる場所が違う。ADR 0072 に記録した。
    const enumSchema = z.object({ provenanceKind: z.enum(["stated", "inferred"]) });
    const enumJson = JSON.stringify({ provenanceKind: "stated" });
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(enumJson);
    const { provider: openai, create: openaiCreate } = buildOpenAI(enumJson);
    const req = { prompt: sharedRequest.prompt, schema: enumSchema };

    await anthropic.completeStructured(ctx, req);
    await openai.completeStructured(ctx, req);

    const aProp = (
      (anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>)["output_config"] as {
        format: {
          schema: { properties: Record<string, { enum?: unknown; description?: string }> };
        };
      }
    ).format.schema.properties["provenanceKind"]!;
    const oProp = (
      (openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>)["response_format"] as {
        json_schema: {
          schema: { properties: Record<string, { enum?: unknown; description?: string }> };
        };
      }
    ).json_schema.schema.properties["provenanceKind"]!;

    // OpenAI: enum キーが制約として残る。
    expect(oProp.enum).toEqual(["stated", "inferred"]);
    // Anthropic: enum キーは無く、description に降格している。
    expect(aProp.enum).toBeUndefined();
    expect(aProp.description).toContain("stated");
  });

  it("列挙から外れた値は、どちらの provider でも黙って通らない", async () => {
    const enumSchema = z.object({ provenanceKind: z.enum(["stated", "inferred"]) });
    const bad = JSON.stringify({ provenanceKind: "guessed" });
    const { provider: anthropic } = buildAnthropic(bad);
    const { provider: openai } = buildOpenAI(bad);
    const req = { prompt: sharedRequest.prompt, schema: enumSchema };

    // ⟹ 強制力の差は在るが、**呼び出し側から見た契約は同じ**（例外になる）。
    await expect(anthropic.completeStructured(ctx, req)).rejects.toThrow(z.ZodError);
    await expect(openai.completeStructured(ctx, req)).rejects.toThrow(z.ZodError);
  });

  it("Anthropic は max_tokens を必須で送る（OpenAI は送らない）", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    expect(anthropicCreate.mock.calls[0]?.[0]).toHaveProperty("max_tokens");
    expect(openaiCreate.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
  });

  it("system の渡し方が違う: Anthropic は top-level、OpenAI は messages の一員", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    const anthropicArg = anthropicCreate.mock.calls[0]?.[0] as {
      system?: string;
      messages: { role: string }[];
    };
    const openaiArg = openaiCreate.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };

    expect(anthropicArg.system).toBe("あなたは抽出器です。");
    expect(anthropicArg.messages.map((m) => m.role)).toEqual(["user"]);

    expect(openaiArg.messages[0]).toEqual({ role: "system", content: "あなたは抽出器です。" });
    expect(openaiArg.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
