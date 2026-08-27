/**
 * 「文脈窓（コンテキストウィンドウ）に当たった」ことの検知（Issue #318 P4）。
 *
 * ## なぜこれが要るのか
 *
 * `clone.ts` の `#reportFailure` は、失敗したターンの理由を
 * `内部ターンが失敗した: ${message}` の形で日誌へ残す。**`message` は
 * `String(error)` 等、プロバイダ・SDK・ストアのドライバが決める生の文言で、
 * 種別を持たない。** 文脈窓を超えて落ちた回も、認証切れで落ちた回も、
 * ネットワークが切れて落ちた回も、日誌の上では同じ「ターンが失敗した」に
 * しか見えない。
 *
 * クローンが `journal_read q="context"` / `q="too long"` で引いても
 * 0件だったことがある。**それは「起きていない」ではなく「この探し方では
 * 見えない」だった** — 実際の文言（下記）には `"context"` も `"too long"`
 * （スペース入り）も一致しない形が混ざっている（`"input is too long for
 * requested model"` は一致するが、`"prompt is too long"` の後に続く数字や
 * `"input length and \`max_tokens\` exceed context limit"` は `"context
 * window"` という並びを持たない）。**ここで作るのは「起きたら分かる」で
 * はなく「起きたかどうかを問える」ことである。**
 *
 * ## 検知は文言の型合わせでしかできない（構造化された印は無い）
 *
 * `sdk-failure.ts` は「応答ではない」を **構造化された印**（`assistant.error`
 * / `result.subtype` / `result.is_error`）で確定させ、文言には頼らない。
 * ここでも同じ選び方をしたかったが、**文脈窓超過には構造化された印が無い**。
 *
 * - `SDKAssistantMessageError`（`sdk.d.ts`）は `'authentication_failed' |
 *   'oauth_org_not_allowed' | 'account_on_hold' | 'billing_error' |
 *   'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' |
 *   'server_error' | 'unknown' | 'max_output_tokens'` の11値で、文脈窓専用の
 *   値は無い。
 * - `stop_reason` は `string | null`（型付けされた列挙ではない）。実際には
 *   ランタイムが `model_context_window_exceeded` という値を使うことがある
 *   （下記の実測）が、**公開された型には出てこない**ので、ここへ依存すると
 *   型チェックの外で静かに壊れる形になる。
 * - しかも実測では、文脈窓超過（`stop_reason ===
 *   "model_context_window_exceeded"`）が起きても、`assistant.error` に
 *   立つ印は `"max_output_tokens"` のまま（実際の最大出力トークン超過と
 *   同じ印）だった。**印だけでは実際の出力超過と文脈窓超過が区別できない。**
 *   区別できるのは、そのとき一緒に流れる文言（`"The model has reached
 *   its context window limit."`）のほうである。
 *
 * ⟹ 文言の型合わせを避けられない。**Claude Code CLI 自身も同じ理由で
 * 文言合わせをしている**（次の節）。前例が無い判断ではない。
 *
 * ## 既知の文言はどこから来たか
 *
 * このリポジトリが依存する Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）
 * は Claude Code CLI をラップしているだけで、実際に API を叩いて上のエラーを
 * 作るのはコンパイル済みの CLI バイナリ本体
 * （`@anthropic-ai/claude-agent-sdk-linux-x64`）である。**そのバイナリ自身が、
 * 同じ問題（プロバイダの文言から「文脈窓に当たったか」を判定する）を既に
 * 解いていた。** 以下は実測（2026-08-27、`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.245`。
 * `pnpm-lock.yaml` に固定された版）で、`command grep -a -o` でバイナリ本体
 * から見つけた逐語である（この版のバイナリはこのリポジトリの
 * `node_modules` に実在するので、以下のコマンドでいつでも再現できる）:
 *
 * ```sh
 * F=node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.245/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
 * command grep -a -o 'function c(n){[^}]*}function g(n){[^}]*}function h(n){[^}]*}' "$F"
 * ```
 *
 * 出力（ミニファイ後の関数名 `c` / `g` / `h`。読みやすさのため改行を足した
 * ——文字そのものは1文字も変えていない）:
 *
 * ```js
 * function c(n) {
 *   let e = n.toLowerCase();
 *   return e.includes("prompt is too long") ||
 *     e.includes("input is too long for requested model");
 * }
 * function g(n) {
 *   return n.toLowerCase().includes("context window");
 * }
 * function h(n) {
 *   return n.toLowerCase().includes("input length and `max_tokens` exceed context limit");
 * }
 * ```
 *
 * さらに `c` は `"prompt_too_long"`、`h` は `"max_tokens_context_overflow"`
 * という ASCII のタグへ分類され（`function jX(e){...jd(e.message,
 * "prompt_too_long")}` / `function cV(e){...jd(e.message,
 * "max_tokens_context_overflow"))}`）、CLI 内部のリトライ判定・エラー
 * メッセージのパース（`/input length and \`max_tokens\` exceed context
 * limit: (\d+) \+ (\d+) > (\d+)/` という正規表現も同じバイナリに実在する）
 * に使われている。**`g`（ゆるい `"context window"` 部分一致）はここでは
 * 採らない** — 文脈窓の話題に触れただけの地の文（例えば人間やクローンが
 * 「文脈窓が心配だ」と発言しただけの回）まで拾う恐れがあり、`c` / `h` より
 * 誤検知の幅が広い。
 *
 * `"The model has reached its context window limit."`
 * （ターン中に `stop_reason === "model_context_window_exceeded"` になった
 * 回の assistant content。上の実測と同じコマンドで見つかる）も同じ理由で
 * 含めた——実際に流れる文言として確認できている。
 *
 * ## ⚠️ 弱さ（取りこぼす）
 *
 * **この判定はプロバイダの文言の型合わせであって契約ではない。** 上の3パターンは
 * 2026-08-27 時点でバイナリに実在した文言で、Anthropic がいつ文言を変えても
 * 壊れうる——しかも壊れ方は「検知しなくなる」なので、静かに効かなくなる
 * （`usage-limits.ts` の同じ注記と同じ形）。**新しい言い回しは取りこぼす。**
 * 逆に、**この判定に当たらなかった失敗が「文脈窓ではなかった」ことも意味しない**
 * ——それは「この型に一致しなかった」だけである。呼び出し側・日誌の文言の
 * どちらでもこの2つを断定に読み替えないこと。
 */

/**
 * 分類した種別。**CLI 自身が使っているタグをそのまま採る（言い換えない）。**
 *
 * - `prompt_too_long` / `max_tokens_context_overflow` は、送る前に判定される
 *   もの（`jX` / `cV` が返すタグ、上の doc 参照）。
 * - `model_context_window_exceeded` は、送った後・生成の途中で文脈窓に
 *   当たったときの `stop_reason` の値そのもの（上の doc の実測）。**この値は
 *   `assistant.error` には出ない**（そちらは実際の出力上限超過と同じ
 *   `"max_output_tokens"` になる）ので、ここでしか区別できない。
 */
export const CONTEXT_WINDOW_FAILURE_KINDS = [
  /** プロンプト（入力）自体が文脈窓に収まらない。送信前に分かる。 */
  'prompt_too_long',
  /** 入力は収まるが、入力 + 要求した `max_tokens` の合計が文脈窓を超える。送信前に分かる。 */
  'max_tokens_context_overflow',
  /** 生成の途中で文脈窓に当たり、そこで打ち切られた。 */
  'model_context_window_exceeded',
] as const;

export type ContextWindowFailureKind = (typeof CONTEXT_WINDOW_FAILURE_KINDS)[number];

export interface ContextWindowFailure {
  kind: ContextWindowFailureKind;
  /** 当たった文言そのまま。**言い換えない**（`usage-limits.ts` と同じ約束）。 */
  text: string;
}

/**
 * 既知の文言パターン（大文字小文字を区別しない部分一致）。
 *
 * **由来と根拠はこのファイル冒頭の doc にある。** ここへ新しい文言を足すときは
 * 同じ水準の根拠（実測 or SDK の型定義）を doc に書き足すこと——「たぶんこうだろう」
 * で足すと、この判定自体の信頼性が「型合わせであって契約ではない」から
 * 「型合わせですらない」へ落ちる。
 */
const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'input is too long for requested model',
] as const;

const MAX_TOKENS_CONTEXT_OVERFLOW_PATTERNS = [
  'input length and `max_tokens` exceed context limit',
] as const;

/** ターン中に文脈窓へ当たったときの assistant content（実測、doc 参照）。 */
const MID_TURN_PATTERNS = ['the model has reached its context window limit'] as const;

function includesAny(lowerText: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => lowerText.includes(pattern));
}

/**
 * 失敗の文言が「文脈窓の超過」に当たるかを判定する。当たらなければ
 * `undefined`。
 *
 * **投げない。文字列以外を渡されても例外にしない**（`classifyUsageNotice` と
 * 同じ形——観測であって仕事ではない）。
 */
export function classifyContextWindowFailure(text: string): ContextWindowFailure | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const lower = text.toLowerCase();
  if (includesAny(lower, PROMPT_TOO_LONG_PATTERNS)) return { kind: 'prompt_too_long', text };
  if (includesAny(lower, MAX_TOKENS_CONTEXT_OVERFLOW_PATTERNS)) {
    return { kind: 'max_tokens_context_overflow', text };
  }
  if (includesAny(lower, MID_TURN_PATTERNS)) {
    return { kind: 'model_context_window_exceeded', text };
  }
  return undefined;
}

/**
 * 日誌へ付け足す1文。**`#reportFailure` が既存の
 * `内部ターンが失敗した: ${message}` / `人間との対話ターンが失敗した:
 * ${message}` の末尾へ足す形で使う**——先頭を変えると、既存の
 * `text.startsWith(...)` の歯（`clone.test.ts`）を壊す。
 *
 * 3つ全部を満たす:
 *
 * 1. **ASCII の検索語を含む**（`context_window_failure` / `kind` の値。
 *    日本語の言い回しだけだと表記ゆれで `journal_read q=` から引けなくなる
 *    ——このファイル冒頭の doc が書いている実例そのもの）
 * 2. **弱さを1文で書く**——「該当した」とだけ書くと、該当しなかった失敗が
 *    「文脈窓ではなかった」と読める（それは嘘になりうる）ので、この判定が
 *    文言の型合わせでしかないことと、当たらなかった場合の含意の否定を
 *    ここにも書く
 * 3. **生の文言はここでは繰り返さない**——呼び出し側が組み立てる
 *    `${message}` に既に逐語で乗っているので、二重に持たない
 *    （`usage-limits.ts` の `text` と同じ理由で、繰り返すこと自体は
 *    禁止ではないが、ここでは呼び出し側の形に合わせて重複を避けた）
 */
export function describeContextWindowFailure(failure: ContextWindowFailure): string {
  return (
    `（文脈窓（コンテキストウィンドウ）に当たった可能性がある: ` +
    `context_window_failure kind=${failure.kind}。` +
    `⚠️ この判定は文言の型合わせであって契約ではない — ` +
    `新しい言い回しは取りこぼす。同じ理由で、この目印が無い失敗が` +
    `「文脈窓ではない」とも限らない）`
  );
}
