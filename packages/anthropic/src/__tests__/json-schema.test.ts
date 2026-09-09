import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtractedMemoryCandidateSchema, ExtractionResultSchema } from "@mnemora/core";
import { translateForAnthropicStructuredOutput } from "../json-schema.js";

/**
 * 「zod スキーマ → Anthropic のネイティブ構造化出力への翻訳」だけを直接検査する歯
 * （`@mnemora/openai` の json-schema.test.ts と同じ理由: 擬似 provider ではこの翻訳の
 * 壊れに気づけないため、翻訳結果そのものを見るテストを別に持つ）。
 *
 * `@mnemora/core` から `ExtractedMemoryCandidateSchema`/`ExtractionResultSchema` を
 * import できることを確認済み（`packages/core/src/index.ts` が `extraction.js` を
 * re-export している）。
 */
describe("translateForAnthropicStructuredOutput", () => {
  it("type: 'json_schema' を返し、name も strict も生えていない（OpenAI との差）", () => {
    const schema = z.object({ content: z.string() });
    const result = translateForAnthropicStructuredOutput(schema);
    expect(result.type).toBe("json_schema");
    expect("name" in result).toBe(false);
    expect("strict" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["schema", "type"]);
  });

  it("すべての object に additionalProperties: false が付く（SDK 側が強制する）", () => {
    const schema = z.object({ content: z.string(), nested: z.object({ a: z.string() }) });
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(schema);
    expect(jsonSchema.additionalProperties).toBe(false);
    const nested = (jsonSchema.properties as Record<string, Record<string, unknown>>).nested!;
    expect(nested.additionalProperties).toBe(false);
  });

  it("optional なフィールドは required に入らない（OpenAI 側の nullable 化が起きていないこと。翻訳の違いの核心）", () => {
    const schema = z.object({
      content: z.string(),
      digest: z.string().optional(),
    });
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(schema);
    expect(jsonSchema.required).toEqual(["content"]);
    // digest は optional のまま——type が ["string", "null"] のような null 許容化はされない。
    const digestSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>).digest!;
    expect(digestSchema.type).toBe("string");
  });

  it("必須フィールドはそのまま required に入る", () => {
    const schema = z.object({ content: z.string() });
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(schema);
    expect(jsonSchema.required).toEqual(["content"]);
  });

  it("配列の要素（items）も再帰的に変換される", () => {
    const schema = z.object({
      memories: z.array(
        z.object({
          content: z.string(),
          digest: z.string().optional(),
        }),
      ),
    });
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(schema);
    const memoriesSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .memories!;
    const itemSchema = memoriesSchema.items as Record<string, unknown>;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.required).toEqual(["content"]);
  });

  /**
   * **実測で分かったこと（json-schema.ts 冒頭のコメント参照）**: Anthropic 公式ヘルパの
   * `transformJSONSchema` は `type`/`description`/`title` と type 別の少数キーしか
   * 素通りさせない。`z.enum(...)` が生む `enum` キーはそのまま残らず、`description` へ
   * JSON 文字列として埋め込まれる。OpenAI 側（`z.enum` が `enum` キーのまま残る）と
   * 明確に違うため、ここで実際の形を固定しておく。
   */
  it("z.enum で作った列挙型は enum キーとしては残らず、description に埋め込まれる（OpenAI と違う。実測）", () => {
    const schema = z.object({
      provenanceKind: z.enum(["stated", "inferred"]),
    });
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(schema);
    const kindSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .provenanceKind!;
    expect(kindSchema.enum).toBeUndefined();
    expect(kindSchema.type).toBe("string");
    expect(typeof kindSchema.description).toBe("string");
    expect(kindSchema.description as string).toContain("enum");
    expect(kindSchema.description as string).toContain("stated");
  });

  it("返り値は関数を含まない純データである（JSON.stringify で往復しても壊れない）", () => {
    const schema = z.object({ content: z.string(), digest: z.string().optional() });
    const result = translateForAnthropicStructuredOutput(schema);
    const roundtripped: unknown = JSON.parse(JSON.stringify(result));
    expect(roundtripped).toEqual(result);
  });

  it("実際に core の ExtractedMemoryCandidateSchema（extraction.ts）を翻訳できる", () => {
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(
      ExtractedMemoryCandidateSchema,
    );
    expect(jsonSchema.type).toBe("object");
    // content と provenanceKind だけが required（digest/tags/confidence は optional のまま）。
    expect(jsonSchema.required).toEqual(["content", "provenanceKind"]);
  });

  it("実際に core の ExtractionResultSchema（completeStructured へ実際に渡す形）を翻訳できる", () => {
    const { schema: jsonSchema } = translateForAnthropicStructuredOutput(ExtractionResultSchema);
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.required).toEqual(["memories"]);
    const memoriesSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .memories!;
    const itemSchema = memoriesSchema.items as Record<string, unknown>;
    expect(itemSchema.required).toEqual(["content", "provenanceKind"]);
  });
});
