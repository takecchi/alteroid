/**
 * `AnthropicLLMProvider` が投げる失敗を、**呼び出し側が種類として区別できる形**にする。
 *
 * **なぜ要るか（ADR 0072 の追記「実測で見つかった穴」）**
 *
 * ADR 0072 の初版は「構造化出力が返らなかったら例外を投げる」までしか決めていなかった。
 * その結果、**「モデルが拒否した」と「応答が空だった」が同じ `Error` になっていた。**
 *
 * これはこのリポジトリの固定点——**「無い」の種類を潰さない**（`docs/recall.md`・
 * ADR 0008 / 0013 / 0026 / 0027 / 0044 が一貫して守ってきた線）——に正面から当たる。
 * `packages/core/src/extraction.ts` の `extractCandidates` はこの例外を `try/catch` で飲み、
 * **`ExtractionOutcome: "llm_failed_whole_observation"` へ倒す。**⟹ 種類を潰したまま
 * 投げると、「モデルが拒否した」という情報はそこで完全に消える。
 *
 * **⚠ 拒否は HTTP 200 で返る。** `stop_reason: "refusal"` が付いた成功応答であり、
 * SDK は例外を投げない。**`content` を読む前に `stop_reason` を見ないと、
 * 空文字を「成功」として core へ渡すことになる。**
 *
 * `Error` を継承しているので、`@mnemora/openai` と揃えた既存の契約
 * （`rejects.toThrow(/.../)` でメッセージを見る形）はそのまま通る。
 * **揃えるためにこちらを弱くはしない**——種類は足すだけである。
 */

/**
 * 失敗の種類。**増やすときは、呼び出し側が本当に区別したい単位かを先に問うこと**
 * ——区別できない種類を増やしても「無い」の分類は増えない。
 */
export type AnthropicLLMFailureKind =
  /** `stop_reason: "refusal"`。安全性の分類器が介入した。`refusalCategory` に分類が入る */
  | "refusal"
  /** `stop_reason: "max_tokens"` / `"model_context_window_exceeded"`。応答が途中で切れた */
  | "truncated"
  /** 上記のどれでもないのに、テキストブロックが1つも無かった */
  | "no_content";

export interface AnthropicLLMProviderErrorOptions {
  kind: AnthropicLLMFailureKind;
  /** SDK が返した生の `stop_reason`。分からなければ `null`（偽 client・streaming の途中など） */
  stopReason?: string | null;
  /** `stop_details.category`（`cyber` / `bio` / `frontier_llm` / `reasoning_extraction` …）。
   * **開いた集合である**——SDK の型は将来値が増えることを前提にしているので、
   * ここでも文字列のまま持ち、列挙に押し込めない。 */
  refusalCategory?: string | null;
  /** 人が読むためのメッセージ。省略時は `kind` から組み立てる */
  message?: string;
}

function defaultMessage(options: AnthropicLLMProviderErrorOptions): string {
  switch (options.kind) {
    case "refusal":
      return (
        "AnthropicLLMProvider: the model refused to answer" +
        (options.refusalCategory != null ? ` (category: ${options.refusalCategory})` : "") +
        " — this is a successful HTTP 200 response with stop_reason=refusal, not an empty answer"
      );
    case "truncated":
      return (
        "AnthropicLLMProvider: the response was cut off before it finished" +
        (options.stopReason != null ? ` (stop_reason: ${options.stopReason})` : "") +
        " — raise maxTokens or shorten the prompt"
      );
    case "no_content":
      return "AnthropicLLMProvider: structured completion returned no content";
  }
}

/**
 * ⚠ **`instanceof` で分岐せず、`kind` で分岐すること。**
 * bundler が同じクラスを二重に読み込むと `instanceof` は落ちる。
 * `kind` は値なのでその影響を受けない。
 */
export class AnthropicLLMProviderError extends Error {
  readonly kind: AnthropicLLMFailureKind;
  readonly stopReason: string | null;
  readonly refusalCategory: string | null;

  constructor(options: AnthropicLLMProviderErrorOptions) {
    super(options.message ?? defaultMessage(options));
    this.name = "AnthropicLLMProviderError";
    this.kind = options.kind;
    this.stopReason = options.stopReason ?? null;
    this.refusalCategory = options.refusalCategory ?? null;
  }
}
