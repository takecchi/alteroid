/**
 * Codex の単価表と、使用量から USD を計算する純粋な関数（#486 M7 段 S6 PR-C）。
 *
 * Codex（app-server）は費用を返さず、トークン数だけを返す。alteroid が単価表を持って
 * USD を計算する（オーナー決定）。**表に無いモデルでは `undefined` を返す**——推測の値で
 * 埋めない。呼び出し側は「取れなかった」に倒す（`AGENTS.md`「取れない軸に 0 の行を作る」）。
 *
 * **これは Codex 固有の語彙であり、中立の語彙へ漏らさない。** 使うのは `codex-*.ts` だけ。
 *
 * ## 出典
 *
 * 原典は https://developers.openai.com/api/docs/pricing 。確認日 2026-10-02（UTC）。
 * 取得は同ページの markdown 版（`Accept: text/markdown`、または URL に `.md`）。
 * 単位は 100 万トークンあたりの USD。
 *
 * ## 表に載せた層（標準だけ）
 *
 * 載せたのは **Standard** の単価だけ。Batch / Flex / Fast（旧 Priority）/ Ultrafast、
 * data residency・FedRAMP の 10% 上乗せ、サブスクリプション（ChatGPT ログイン）の枠は
 * 計算しない。ゆえに層が違う実行では実費とずれる（見積もりであって請求額ではない）。
 * `*-pro` / `*-cyber` / `gpt-rosalind-research` など Codex の通常経路で使わないものは省いた。
 * `gpt-5.6-sol` の表の値は販促価格（ページ記載で 2026-11-21 まで有効）。切れたら表を直すこと。
 *
 * ## 長いコンテキストの単価
 *
 * 1リクエストの入力が 272K トークンを**超える**と、そのリクエスト全体が長い側の単価になる
 * （ページ: 「Short context: ≤272K input tokens. Long context: >272K input tokens.」）。
 * 長い側を持つモデルは `long` を持つ。持たないモデルは超えても短い側のまま。
 * ⚠️ 閾値はリクエスト単位だが、app-server の使用量は複数リクエストを足したもの
 * （`total`、または1ターン内の複数回の呼び出し）でありうる。**閾値を正しく判定するには
 * 1リクエスト分の使用量を渡すこと**。足し込んだ値を渡すと長い側へ寄りすぎうる。
 *
 * ## cached / reasoning の扱い（二重に数えない）
 *
 * - `cachedInputTokens` は `inputTokens` の**内数**。Codex は Responses API の
 *   `input_tokens` / `input_tokens_details.cached_tokens` をそのまま写し
 *   （codex-api `sse/responses.rs`）、自前の集計も `input - cached` を「非キャッシュ入力」
 *   とする（tui `token_usage.rs` の `non_cached_input`）。
 * - `reasoningOutputTokens` は `outputTokens` の**内数**（`output_tokens_details.reasoning_tokens`）。
 *   推論トークンは出力単価で課金され、`outputTokens` に既に入っているので足さない。
 *   （どちらも openai/codex rust-v0.160.0 のソースによる。）
 * - `cacheWriteInputTokens`（0.160.0 のスキーマにある欄。無ければ 0）は非キャッシュ入力の
 *   内数と仮定して、書き込み単価（表にあるモデルだけ。無ければ入力単価）で課金する。
 *   この仮定は実機で未確認。
 */

/** 100 万トークンあたりの USD。 */
interface CodexRates {
  readonly input: number;
  /** 無いモデル（キャッシュ割引なし）は入力単価で課金する。 */
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

interface CodexModelPricing extends CodexRates {
  /** 入力が `CODEX_LONG_CONTEXT_THRESHOLD_TOKENS` を超えたときの単価。 */
  readonly long?: CodexRates;
}

export const CODEX_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export const CODEX_PRICING: Readonly<Record<string, CodexModelPricing>> = {
  'gpt-6-astra': {
    input: 10,
    cachedInput: 1,
    cacheWrite: 12.5,
    output: 50,
    long: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 },
  },
  'gpt-6.1-sol': {
    input: 2,
    cachedInput: 0.1,
    cacheWrite: 2.5,
    output: 10,
    long: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
  },
  'gpt-6-sol': {
    input: 2,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 10,
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 },
  },
  'gpt-6-luna': {
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  'gpt-5.6-sol': {
    input: 4,
    cachedInput: 0.4,
    cacheWrite: 5,
    output: 20,
    long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 },
  },
  'gpt-5.6-terra': {
    input: 2,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 12,
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
  },
  'gpt-5.6-luna': {
    input: 0.2,
    cachedInput: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
    long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  'gpt-5.5': {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    long: { input: 10, cachedInput: 1, output: 45 },
  },
  'gpt-5.4': {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    long: { input: 5, cachedInput: 0.5, output: 22.5 },
  },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
};

/** app-server の `TokenUsageBreakdown` のうち、計算に使う欄。 */
export interface CodexUsageForPricing {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  cacheWriteInputTokens?: number;
}

const PER_MILLION = 1_000_000;

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * 使用量から USD を計算する。モデルが分からない・表に無い（または使用量が数として読めない）
 * ときは `undefined`。モデル名は完全一致で引く（日付付きの別名などを推測で寄せない）。
 * **モデルが分からないときに Codex の既定を仮定しない。** 既定はサーバーのカタログで変わり
 * うるので、呼び出し側は app-server が返した実際のモデル名を渡す。
 */
export function computeCodexCostUSD(
  model: string | undefined,
  usage: CodexUsageForPricing,
): number | undefined {
  // 継承したプロパティ（`toString` など）を表の行と取り違えない。
  if (model === undefined || !Object.hasOwn(CODEX_PRICING, model)) return undefined;
  const pricing = CODEX_PRICING[model]!;
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  if (
    !isCount(inputTokens) ||
    !isCount(cachedInputTokens) ||
    !isCount(outputTokens) ||
    !isCount(cacheWriteInputTokens)
  ) {
    return undefined;
  }
  const rates =
    pricing.long && inputTokens > CODEX_LONG_CONTEXT_THRESHOLD_TOKENS ? pricing.long : pricing;
  // cached は input の内数、reasoning は output の内数（上の説明）。差し引くだけで足さない。
  const cached = Math.min(cachedInputTokens, inputTokens);
  const uncached = inputTokens - cached;
  const written = Math.min(cacheWriteInputTokens, uncached);
  const usd =
    ((uncached - written) * rates.input +
      written * (rates.cacheWrite ?? rates.input) +
      cached * (rates.cachedInput ?? rates.input) +
      outputTokens * rates.output) /
    PER_MILLION;
  return usd;
}
