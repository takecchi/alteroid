/**
 * このパッケージが投げる、**種類の付いた**エラー（ADR 0090）。
 *
 * 🔴 **なぜ素の `Error` ではなく `kind` を持たせるか。**
 *
 * このリポジトリの固定点は**「無い」の種類を潰さない**である
 * （ADR 0008 / 0013 / 0026 / 0027 / 0044）。そして種類を割る判定基準は
 * ADR 0008 の**「その区別があると、呼び出し側の次の一手が変わるか」**である。
 *
 * ここで区別している2種は、次の一手が実際に違う:
 *
 * | `kind` | 次の一手 |
 * |---|---|
 * | `"input_too_long"` | **同じ入力で再試行しても永久に失敗する。**入力を分割・短縮するしかない |
 * | `"unknown_input_limit"` | 入力の問題ではない。**モデル（`repo`）か注入点（`createPipeline`）の問題**である |
 *
 * ⚠ **`instanceof` ではなく `kind` で分岐させること。**bundler が同じクラスを
 * 二重に読み込むと `instanceof` は落ちるが、`kind` は値なので影響を受けない
 * （[ADR 0075](../../../docs/decisions/0075-openai-refusal-and-truncation.md) と同じ理由）。
 */
export type LocalEmbeddingProviderErrorKind = "input_too_long" | "unknown_input_limit";

/** {@link LocalEmbeddingProviderErrorKind} が `"input_too_long"` のときに付く欄。 */
export interface LocalEmbeddingInputTooLongDetail {
  /** `embed(ctx, texts)` に渡された配列の何番目か。 */
  readonly index: number;
  /** 切り詰め**前**に数えたトークン数（特殊トークンを含む）。 */
  readonly tokens: number;
  /** モデルが受け付ける上限トークン数。 */
  readonly maxInputTokens: number;
  /**
   * その入力の文字数。
   * ⚠ **トークン数と文字数の比は文章によって変わる。**この値は原因を追うための参考であり、
   * **判定に使っている値ではない**（判定は `tokens` と `maxInputTokens` の比較である）。
   */
  readonly characters: number;
}

export class LocalEmbeddingProviderError extends Error {
  override readonly name = "LocalEmbeddingProviderError";
  readonly kind: LocalEmbeddingProviderErrorKind;
  /** `kind` が `"input_too_long"` のときだけ入る。 */
  readonly detail: LocalEmbeddingInputTooLongDetail | null;

  constructor(
    kind: LocalEmbeddingProviderErrorKind,
    message: string,
    detail: LocalEmbeddingInputTooLongDetail | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * 受け取ったものが {@link LocalEmbeddingProviderError} かを、**`instanceof` を使わずに**判定する。
 *
 * `kind` の値を見るので、クラスが二重に読み込まれていても効く。
 */
export function isLocalEmbeddingProviderError(
  value: unknown,
): value is LocalEmbeddingProviderError {
  if (!(typeof value === "object" && value !== null)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "input_too_long" || kind === "unknown_input_limit";
}
