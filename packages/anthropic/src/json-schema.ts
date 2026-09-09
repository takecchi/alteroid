import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/**
 * zod スキーマ → Anthropic のネイティブ構造化出力（`output_config.format: json_schema`）への
 * 翻訳（docs/architecture.md §3.8）。**この翻訳がこのパッケージの本体である**
 * ——`packages/openai` の `json-schema.ts` と対になる位置づけ。
 *
 * `@mnemora/openai` との違い（`@anthropic-ai/sdk@0.124.0` の `.d.ts` を実際に読んで確認済み。
 * 実測は `resources/messages/messages.d.ts` の `JSONOutputFormat`/`OutputConfig` と
 * `helpers/zod.ts`・`lib/transform-json-schema.ts` の実装本体）:
 *
 * 1. **`name` も `strict` も無い。** OpenAI の `response_format.json_schema` は
 *    `{ name, strict: true, schema }` だが、Anthropic の `JSONOutputFormat` は
 *    `{ type: 'json_schema', schema }` だけ——`name` を持たせる場所が無い。
 * 2. **`additionalProperties: false` は SDK 側（`transformJSONSchema`）が全 object に
 *    強制で付ける。** ここは OpenAI と同じ効果になる。
 * 3. **`required` は元のまま通る。** `transformJSONSchema` は `required` を popup して
 *    そのまま `strictSchema.required` に代入するだけで、「properties の全キーを required に
 *    足す」処理を一切しない。⟹ **`.optional()` は optional のまま残る**。
 *    ⟹ `@mnemora/openai` の `hardenForStrictMode`（全キーを required にして省略可能を
 *    nullable にする）と `stripNulls`（返ってきた null を省略へ戻す）に相当する処理は、
 *    Anthropic 側では**不要**——`req.schema.parse(...)` にモデルの生の JSON をそのまま渡せる。
 *
 * **実測で分かった、ここでは扱わない差**（`@mnemora/openai` の json-schema.test.ts と
 * 同じ観点の歯を Anthropic 側にも置こうとして気づいたもの。設計判断ではなく事実の記録）:
 * `transformJSONSchema` は `type`/`description`/`title` と、type 別に決まった少数のキー
 * （object の `properties`/`additionalProperties`/`required`、string の `format`
 * （サポート済みの値のみ）、array の `items`/`minItems`（0 か 1 のみ））しか素通ししない。
 * `enum`・`minLength`・`minimum`/`maximum` 等、それ以外に残ったキーは**削除されるのではなく、
 * `description` に JSON 文字列として埋め込まれる**（例: `z.enum(["a","b"])` は
 * `{ type: "string", description: "{enum: [\"a\",\"b\"]}" }` になる。実際に
 * `zodOutputFormat` を呼んで確認した）。これは OpenAI 側の `z.toJSONSchema` の出力
 * （`enum` キーがそのまま残る）と違う——**Anthropic 側は enum を JSON Schema の制約としては
 * 送っておらず、プロンプト相当の説明文として送っている**ことになる。翻訳を「直す」ことは
 * しない（公式ヘルパの変換をそのまま使う、という上位の決定を優先した）が、
 * `json-schema.test.ts` はこの実際の形を検査する。
 *
 * **自前で JSON Schema を作り直さない。** 公式ヘルパ `zodOutputFormat` の変換
 * （内部で `transformJSONSchema(z.toJSONSchema(zodObject, { reused: 'ref' }))` を呼ぶ）を
 * そのまま使う。
 */

export interface AnthropicJsonSchemaFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

/**
 * `zodOutputFormat` の引数型は `ZodInput extends z.ZodType`（`zod/v4` からの import）。
 * `@mnemora/core` の `z.ZodType<T>` は `"zod"`（トップレベルの再エクスポート）からの import で、
 * 型アサーションが要るかもしれないと想定していたが、**実際に `tsc --strict` で検査したところ
 * アサーション無しで通った**（zod 4.5.4 では `"zod"` のトップレベル export と `"zod/v4"` は
 * 同じ v4 実装を指しており、`ZodType` は構造的に同一のため）。よってここでは
 * 型アサーションを入れていない——「合わなければ入れる」という前提が、今回は成立しなかった。
 */
export function translateForAnthropicStructuredOutput<T>(
  schema: z.ZodType<T>,
): AnthropicJsonSchemaFormat {
  const format = zodOutputFormat(schema);
  // `format` は `{ type, schema, parse }` で、`parse` は関数を持つ。リクエストに載るのは
  // `{ type, schema }` だけであり、関数を持ったまま渡すと「何を送ったか」を JSON として
  // 検査できなくなる（テストで `JSON.stringify` の往復を検査する狙いもここにある）ため、
  // ここで `parse` を落として純データにする。
  return { type: "json_schema", schema: format.schema };
}
