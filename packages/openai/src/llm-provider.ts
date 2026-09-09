import OpenAI from "openai";
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import { OpenAILLMProviderError } from "./errors.js";
import { translateForOpenAIStructuredOutput } from "./json-schema.js";

/**
 * `packages/openai` の `LLMProvider` 実装（docs/architecture.md §5.4・§3.8）。
 *
 * `completeStructured` がこのパッケージの中心的な責務——zod スキーマを OpenAI の
 * Structured Output（`response_format: json_schema`, strict）へ翻訳し、返ってきた
 * JSON をもう一度 zod でパースして返す。**core・呼び出し側に OpenAI SDK の型は
 * 一切現れない**（`OpenAI`/`ChatCompletion` 等の型はこのファイルの外に出ない）。
 *
 * `client` を注入できるようにしてある（`OpenAIEmbeddingProvider` と同じ理由）。
 */
export interface OpenAILLMProviderOptions {
  apiKey?: string;
  model: string;
  client?: Pick<OpenAI, "chat">;
}

/**
 * OpenAI の strict モードは「省略可能」を `null` として返す（`json-schema.ts` の翻訳が
 * そう変換しているため）。しかし core の zod スキーマは `.optional()` を使っており、
 * **`null` を受け付けない**（`z.string().optional().safeParse(null)` は失敗する。
 * `undefined`/キー省略だけを許す）。そのため、OpenAI から返った JSON をそのまま
 * `req.schema.parse` に渡すと、モデルが「省略可能なので何も無い」と判断しただけの
 * フィールドで検証エラーになってしまう。
 *
 * ここでは再帰的に `null` を「キーが無い」状態へ変換してから core のスキーマでパースする。
 * **決めたこと（PR 本文にも記載）**: この変換は「`null` は常に『値が無い』を意味する」
 * という前提に立つ。将来 `completeStructured` へ渡すスキーマが `null` を意味のある値
 * として区別したくなった場合（`.nullable()` を意図的に使う場合）、この汎用的な変換は
 * 見直しが必要になる。Phase 1 で `completeStructured` に渡す実際のスキーマ
 * （`extraction.ts` の `ExtractionResultSchema`）にはそのような区別を要するフィールドが
 * 無いことを確認済み。
 */
function stripNulls(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const stripped = stripNulls(child);
      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }
    return result;
  }
  return value;
}

/**
 * ⭐ **`content` を読む前に、必ずこれを通す。**
 *
 * **拒否は HTTP 200 で返る。** `message.refusal` に拒否理由の文字列が入り、
 * このとき `message.content` は `null` になる。SDK は例外を投げない。
 * ⟹ **見ないと、拒否を「空の成功」として core へ渡す。**
 *
 * OpenAI は Anthropic の `stop_reason` 一本とは形が違い、**2つの独立した機構**を持つ
 * ——`message.refusal` と `finish_reason`。両方をここで見る。
 *
 * - `message.refusal` が非 null かつ空文字でなければ `kind: "refusal"`。
 * - `finish_reason === "content_filter"` も `kind: "refusal"` として扱う。
 *   **判断**: コンテンツフィルタで出力が省かれたのはモデル自身の拒否とは別機構だが、
 *   呼び出し側の次の一手は同じ（同じ入力で再試行しても意味が無い）。⟹ `kind` は
 *   増やさず、生の `finishReason` をフィールドに残すことで情報は潰さない。
 * - `finish_reason === "length"` は `kind: "truncated"`。**切り詰められた JSON は
 *   `JSON.parse` で `SyntaxError` になり、「モデルが壊れた JSON を吐いた」と
 *   区別が付かなくなる。** だから分ける。
 * - それ以外（`stop` / `tool_calls` / `function_call` / 未設定 / null）は素通しする
 *   ——「分からない」を「拒否された」と読まない（`@mnemora/anthropic` と同じ固定点）。
 *
 * **`choices` が空（choice 自体が無い）ときは、この門では投げない。** 既存の
 * `no_content` の経路（`complete` の `?? ""` / `completeStructured` の `if (!raw)`）に任せる。
 */
function assertNotRefusedOrTruncated(choice?: {
  finish_reason?: string | null;
  message?: { refusal?: string | null } | null;
}): void {
  if (!choice) {
    return;
  }
  const refusalMessage = choice.message?.refusal ?? null;
  if (refusalMessage != null && refusalMessage !== "") {
    throw new OpenAILLMProviderError({
      kind: "refusal",
      refusalMessage,
      finishReason: choice.finish_reason ?? null,
    });
  }
  const finishReason = choice.finish_reason ?? null;
  if (finishReason === "content_filter") {
    throw new OpenAILLMProviderError({ kind: "refusal", finishReason });
  }
  if (finishReason === "length") {
    throw new OpenAILLMProviderError({ kind: "truncated", finishReason });
  }
}

function toOpenAIMessages(
  prompt: PromptSpec,
): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
  if (prompt.system) {
    messages.push({ role: "system", content: prompt.system });
  }
  for (const message of prompt.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

export class OpenAILLMProvider implements LLMProvider {
  private readonly client: Pick<OpenAI, "chat">;
  private readonly model: string;

  constructor(options: OpenAILLMProviderOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(req),
    });
    assertNotRefusedOrTruncated(response.choices[0]);
    // ⚠ **ここの `?? ""` は残した。** ADR 0072「引き受けた負債」2 の通り、
    // `@mnemora/anthropic` も同じ形であり、片方だけ throw にすると差し替えられなくなる。
    // **ただし上の門を通した後なので、意味が変わっている**——ここへ来る空文字は
    // 「拒否された」でも「切り詰められた」でもなく、**モデルが本当に何も言わなかった**場合だけである。
    // ⟹ **「空文字は安全だ」と主張しているのではない。**望ましい姿でもない。
    // 直すなら両 provider 同時（＝公開 API の破壊的変更）なので、提起までにしてある。
    return { content: response.choices[0]?.message?.content ?? "" };
  }

  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const format = translateForOpenAIStructuredOutput("mnemora_structured_output", req.schema);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(req.prompt),
      response_format: { type: "json_schema", json_schema: format },
    });
    // ⭐ **`content` を読む前に拒否・切り詰めを見る。**順序が本質である
    // ——後ろに置くと、拒否が `no_content` に化けて種類が潰れる（拒否時は `content` が `null`）。
    assertNotRefusedOrTruncated(response.choices[0]);
    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      // メッセージは既存の文言のまま（差し替え可能性・provider-parity.test.ts を壊さない）。
      // 種類は `kind` で足しただけである。
      throw new OpenAILLMProviderError({ kind: "no_content" });
    }
    const parsedJson: unknown = JSON.parse(raw);
    // OpenAI の strict モードは JSON Schema としての形は保証するが、それが core の zod
    // スキーマとして意味的に妥当かは別問題。上の stripNulls で null → 省略へ変換してから
    // もう一度 zod でパースし、core・呼び出し側には常に検証済みの T を返す。
    return req.schema.parse(stripNulls(parsedJson));
  }
}
