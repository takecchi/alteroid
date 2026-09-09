/**
 * `OpenAILLMProvider` が投げる失敗を、**呼び出し側が種類として区別できる形**にする。
 *
 * **なぜ要るか**
 *
 * `@mnemora/anthropic` の `errors.ts`（ADR 0072 の追記「実測で見つかった穴」）と同じ穴が
 * `@mnemora/openai` 側にも残っていた。**「モデルが拒否した」と「応答が空だった」が
 * 同じ `Error` になっていた。**
 *
 * これはこのリポジトリの固定点——**「無い」の種類を潰さない**（`docs/recall.md`・
 * ADR 0008 / 0013 / 0026 / 0027 / 0044 が一貫して守ってきた線）——に正面から当たる。
 * `packages/core/src/extraction.ts` の `extractCandidates` はこの例外を `try/catch` で飲み、
 * **`ExtractionOutcome: "llm_failed_whole_observation"` へ倒す。**⟹ 種類を潰したまま
 * 投げると、「モデルが拒否した」という情報はそこで完全に消える。
 *
 * **⚠ OpenAI の機構は Anthropic と形が違う。** Anthropic は `stop_reason` 一本で拒否・
 * 切り詰めを表すが、OpenAI は**2つの独立した機構**を持つ:
 * - `message.refusal: string | null` — 拒否したとき `content` は `null` になり、
 *   `refusal` に拒否理由の文字列が入る。**拒否も HTTP 200 で返る。**
 * - `finish_reason: "length" | "content_filter" | ...` — `length` は max tokens 到達、
 *   `content_filter` はコンテンツフィルタで出力が省かれたことを示す。
 * **`content` を読む前にこの2つを見ないと、拒否・切り詰めを「空の成功」として
 * core へ渡すことになる**（`llm-provider.ts` の `assertNotRefusedOrTruncated` 参照）。
 *
 * `Error` を継承しているので、`@mnemora/anthropic` と揃えた既存の契約
 * （`rejects.toThrow(/.../)` でメッセージを見る形）はそのまま通る。
 * **揃えるためにこちらを弱くはしない**——種類は足すだけである。
 */

/**
 * 失敗の種類。**増やすときは、呼び出し側が本当に区別したい単位かを先に問うこと**
 * ——区別できない種類を増やしても「無い」の分類は増えない。
 */
export type OpenAILLMFailureKind =
  /** `message.refusal` が非 null かつ空文字でない。または `finish_reason === "content_filter"`
   * （コンテンツフィルタでの省略はモデル自身の拒否とは別機構だが、呼び出し側の次の一手は
   * 同じ——同じ入力で再試行しても意味が無い。`kind` は増やさず `finishReason` に生の値を残す）。 */
  | "refusal"
  /** `finish_reason === "length"`。応答が max tokens で途中で切れた */
  | "truncated"
  /** 上記のどちらでもないのに、`content` が空/欠落だった */
  | "no_content";

export interface OpenAILLMProviderErrorOptions {
  kind: OpenAILLMFailureKind;
  /** SDK が返した生の `finish_reason`。分からなければ `null`（偽 client など） */
  finishReason?: string | null;
  /** `message.refusal` の中身（拒否理由の文面）。無ければ `null` */
  refusalMessage?: string | null;
  /** 人が読むためのメッセージ。省略時は `kind` から組み立てる */
  message?: string;
}

function defaultMessage(options: OpenAILLMProviderErrorOptions): string {
  switch (options.kind) {
    case "refusal":
      return (
        "OpenAILLMProvider: the model refused to answer" +
        (options.refusalMessage != null ? ` (${options.refusalMessage})` : "") +
        (options.finishReason != null ? ` (finish_reason: ${options.finishReason})` : "") +
        " — this is a successful HTTP 200 response, not an empty answer"
      );
    case "truncated":
      return (
        "OpenAILLMProvider: the response was cut off before it finished" +
        (options.finishReason != null ? ` (finish_reason: ${options.finishReason})` : "") +
        " — raise max_tokens or shorten the prompt"
      );
    case "no_content":
      return "OpenAILLMProvider: structured completion returned no content";
  }
}

/**
 * ⚠ **`instanceof` で分岐せず、`kind` で分岐すること。**
 * bundler が同じクラスを二重に読み込むと `instanceof` は落ちる。
 * `kind` は値なのでその影響を受けない。
 */
export class OpenAILLMProviderError extends Error {
  readonly kind: OpenAILLMFailureKind;
  readonly finishReason: string | null;
  readonly refusalMessage: string | null;

  constructor(options: OpenAILLMProviderErrorOptions) {
    super(options.message ?? defaultMessage(options));
    this.name = "OpenAILLMProviderError";
    this.kind = options.kind;
    this.finishReason = options.finishReason ?? null;
    this.refusalMessage = options.refusalMessage ?? null;
  }
}
