import Anthropic from "@anthropic-ai/sdk";
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import { translateForAnthropicStructuredOutput } from "./json-schema.js";

/**
 * `packages/anthropic` の `LLMProvider` 実装（docs/architecture.md §3.8・§5.4）。
 * `packages/openai` の `llm-provider.ts` と同じ構造・同じ契約で書く
 * （オーナーの決定: `LLMProvider` は差し替え可能でなければならない）。
 *
 * `completeStructured` がこのパッケージの中心的な責務——zod スキーマを Anthropic の
 * ネイティブ構造化出力（`output_config.format: json_schema`、`json-schema.ts` 参照）へ
 * 翻訳し、返ってきた JSON をもう一度 zod でパースして返す。**core・呼び出し側に
 * Anthropic SDK の型は一切現れない**（`Anthropic`/`Message` 等の型はこのファイルの外に出ない）。
 *
 * `client` を注入できるようにしてある（`@mnemora/openai` と同じ理由・同じ形。
 * `Pick<Anthropic, "messages">` は `OpenAILLMProviderOptions.client` の
 * `Pick<OpenAI, "chat">` に対応する）。
 */

/** Anthropic の `messages.create` は `max_tokens` が必須（OpenAI の chat completions と違う）。
 * 省略時のデフォルトをここに持つ。**確かめていないこと**: 16000 という値そのものの妥当性
 * ——`@mnemora/openai` 側に対応する既定値は無い（OpenAI 側は `max_tokens` 省略可）ため、
 * 比較対象が無い。要求された出力の長さに応じて呼び出し側が `maxTokens` で上書きすることを
 * 前提にしている。 */
export const DEFAULT_MAX_TOKENS = 16000;

export interface AnthropicLLMProviderOptions {
  apiKey?: string;
  /** ⚠ 必須。既定値を持たない（`@mnemora/openai` の `OpenAILLMProviderOptions.model` と
   * 同じ規律——どのモデルを使うかは呼び出し側が決める）。 */
  model: string;
  /** 省略時 {@link DEFAULT_MAX_TOKENS}。 */
  maxTokens?: number;
  client?: Pick<Anthropic, "messages">;
}

/** Anthropic の `messages` 配列は `role: "user" | "assistant"` のみ
 * （`role: "system"` は使えない。`system` は top-level パラメータ）。 */
interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string;
}

/** `toAnthropicRequest` の戻り値。`messages.create` にそのまま展開して渡す形。 */
export interface AnthropicRequest {
  system?: string;
  messages: AnthropicMessageParam[];
}

/**
 * `PromptSpec` → Anthropic 形式への変換。**テストから直接検査できるように export する**
 * （`json-schema.ts` の翻訳と同じ理由——擬似 provider ではこの変換の壊れに気づけない）。
 *
 * **OpenAI と違う点**: OpenAI の `toOpenAIMessages`（`@mnemora/openai/src/llm-provider.ts`）は
 * `system` を `role: "system"` のメッセージとして `messages` 配列の先頭に積むだけで済む
 * （OpenAI の chat completions は `role: "system"` を受け付けるため）。Anthropic はそれを
 * 受け付けず、`system` は独立した top-level パラメータになる。そのため、ここでは
 * (1) `prompt.system` を top-level `system` の先頭に置き、
 * (2) `prompt.messages` のうち `role === "system"` のものは**黙って捨てず**、
 *     top-level `system` へ改行区切りで連結し、
 * (3) 残りの `user`/`assistant` だけを `messages` に入れる。
 */
export function toAnthropicRequest(prompt: PromptSpec): AnthropicRequest {
  const systemParts: string[] = [];
  if (prompt.system) {
    systemParts.push(prompt.system);
  }

  const messages: AnthropicMessageParam[] = [];
  for (const message of prompt.messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }

  return systemParts.length > 0 ? { system: systemParts.join("\n"), messages } : { messages };
}

/** 応答の `content` は content block の配列。テキストは `{ type: "text", text: string }`
 * ブロック。`@mnemora/openai` の「最初の choice の content」に対応する規律として、
 * **最初に見つかったテキストブロック**を採用する（thinking 等の他ブロック型は無視する）。 */
function firstTextBlock(content: Anthropic.Messages.ContentBlock[]): string | undefined {
  return content.find((block) => block.type === "text")?.text;
}

export class AnthropicLLMProvider implements LLMProvider {
  private readonly client: Pick<Anthropic, "messages">;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicLLMProviderOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const { system, messages } = toAnthropicRequest(req);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(system !== undefined ? { system } : {}),
      messages,
    });
    // `@mnemora/openai` が `?? ""` としているのに揃える——テキストが取れなければ空文字。
    return { content: firstTextBlock(response.content) ?? "" };
  }

  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const format = translateForAnthropicStructuredOutput(req.schema);
    const { system, messages } = toAnthropicRequest(req.prompt);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(system !== undefined ? { system } : {}),
      messages,
      output_config: { format },
    });

    const raw = firstTextBlock(response.content);
    if (!raw) {
      throw new Error("AnthropicLLMProvider: structured completion returned no content");
    }
    // JSON.parse が失敗すれば SyntaxError をそのまま伝播させる（catch しない）。
    const parsedJson: unknown = JSON.parse(raw);
    // `json-schema.ts` 冒頭のコメントの通り、Anthropic 側は `required` を元のまま通すため
    // `.optional()` は optional のまま残る。`@mnemora/openai` の `stripNulls`
    // （strict モードが返す null を「省略」へ変換し戻す処理）に相当する処理は不要
    // ——モデルの生の JSON をそのまま core の zod スキーマへ渡してよい。
    // `.parse` が失敗すれば ZodError をそのまま伝播させる（`.safeParse` は使わない）。
    return req.schema.parse(parsedJson);
  }
}
