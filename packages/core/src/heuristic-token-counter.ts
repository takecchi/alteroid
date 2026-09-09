import type { TokenCounter } from "./interfaces/token-counter.js";

/**
 * CJK と判定するコードポイント範囲（閉区間、両端含む）。Unicode のブロック単位で切ってある。
 *
 * 参照: https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt
 * （このリポジトリでは自動生成していない——手で書き写した固定表。ブロック改定があっても
 * 追随しない。5行下のコメントで各範囲の中身を書いているので、増減はそこと突き合わせること。）
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff], // ハングル字母 (Hangul Jamo)
  [0x2e80, 0x2eff], // CJK部首補助 (CJK Radicals Supplement)
  [0x2f00, 0x2fdf], // 康熙部首 (Kangxi Radicals)
  [0x3000, 0x303f], // CJK記号・句読点 (CJK Symbols and Punctuation)
  [0x3040, 0x309f], // ひらがな (Hiragana)
  [0x30a0, 0x30ff], // カタカナ (Katakana)
  [0x3100, 0x312f], // 注音 (Bopomofo)
  [0x3130, 0x318f], // ハングル互換字母 (Hangul Compatibility Jamo)
  [0x31a0, 0x31bf], // 注音拡張 (Bopomofo Extended)
  [0x31f0, 0x31ff], // カタカナ音声拡張 (Katakana Phonetic Extensions)
  [0x3200, 0x33ff], // 囲みCJK・CJK互換 (Enclosed CJK Letters and Months, CJK Compatibility)
  [0x3400, 0x4dbf], // CJK統合漢字拡張A (CJK Unified Ideographs Extension A)
  [0x4e00, 0x9fff], // CJK統合漢字 (CJK Unified Ideographs)
  [0xa960, 0xa97f], // ハングル字母拡張A (Hangul Jamo Extended-A)
  [0xac00, 0xd7ff], // ハングル音節+拡張B (Hangul Syllables, Hangul Jamo Extended-B)
  [0xf900, 0xfaff], // CJK互換漢字 (CJK Compatibility Ideographs)
  [0xfe30, 0xfe4f], // CJK互換形 (CJK Compatibility Forms)
  [0xff00, 0xffdf], // 半角・全角形 (Halfwidth and Fullwidth Forms)
  [0x20000, 0x3ffff], // SIP（CJK統合漢字拡張B以降。Supplementary Ideographic Plane）
];

/** すべての CJK 範囲は 0x1100 以上から始まる。それ未満（ASCII を含む）なら判定するまでもなく非CJK。 */
const CJK_RANGE_FLOOR = 0x1100;

function isCjkCodePoint(codePoint: number): boolean {
  if (codePoint < CJK_RANGE_FLOOR) return false;
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

// 係数は「1コードポイントあたり何トークンか」を 20分率の整数比で表す
// （0.9 = 18/20、0.25 = 5/20）。浮動小数の乗算（0.9 * n など）を避けるため
// ——`0.1 + 0.2 !== 0.3` の類の丸め差が環境（V8 のバージョンや FPU）によって
// 出力を変える余地を、整数演算に落とすことで断つ。
const CJK_WEIGHT_NUMERATOR = 18; // 0.9 トークン/コードポイント
const NON_CJK_WEIGHT_NUMERATOR = 5; // 0.25 トークン/コードポイント（現行の 1/4 を据え置き）
const WEIGHT_DENOMINATOR = 20;

/**
 * 既定の `TokenCounter` 実装（docs/architecture.md §5.9）。
 *
 * モデル固有のトークナイザに依存しない、コードポイント数ベースの CJK 対応推定。
 * **常に `counter: 'heuristic'` を返す**——推定値を実測値の顔で返さない、という契約は
 * この実装でも変わらない。
 *
 * ## 係数の根拠（Issue #108）
 *
 * 従来は `Math.ceil(text.length / 4)`（全文字を 0.25 トークン/文字 として数える）だった。
 * 日本語では実測トークン数の 1/2.8〜1/3.8 しか数えず、`RecallBudget.maxMemoryTokens` が
 * これを基準に切り詰めを行うため、予算が静かに超過していた。
 *
 * 係数（CJK 0.9 トークン/コードポイント、非CJK 0.25 トークン/コードポイント）は
 * **js-tiktoken の `o200k_base`**（gpt-4o / gpt-4o-mini 系のトークナイザ）を使って、
 * 121件のコーパス（`src/__tests__/fixtures/token-count-reference.json`、日本語・中国語・
 * 韓国語・英語・混在・コード・タイ語・アラビア語・キリル文字・絵文字入り日本語を含む）を
 * 実測して決めた。一部は実 API（`text-embedding-3-small` / `gpt-4o-mini` の
 * `usage.prompt_tokens`）とも突き合わせて一致を確認している
 * （フィクスチャの `verifiedAgainstApi` を参照）。
 *
 * - CJK = 0.9: 121件全件の最小二乗回帰（切片なし）が `a=0.8885`（R²=0.990）。
 *   小数第1位に丸めて 0.9 とした。この値で 121件全体の 合計推定/合計実測(o200k_base) が
 *   **0.991**（グリッド `{0.7, 0.8, 0.85, 0.9, 0.95, 1.0}` の中で最も 1.00 に近い）になり、
 *   かつ `ja` クラス16件のうち **過小評価が1件も無い**。
 * - 非CJK = 0.25（据え置き）: 現行式でも `en` クラスの合計比は 1.128（13%過大評価、
 *   予算に対しては安全側）であり、壊れていない側は動かさなかった。この結果、
 *   **純ASCIIテキストは従来と完全に同じ値を返す**（下位互換）。
 *
 * ## ⚠ 直っていない範囲
 *
 * CJK **以外** の非ラテン文字（キリル文字・タイ文字・アラビア文字、絵文字）は
 * 「非CJK」として 0.25/字 で数えるため、**依然として過小評価する**。実測の合計比
 * （推定/o200k_base実測）は タイ語 0.564 / アラビア語 0.813 / キリル文字 0.864。
 * **厳密さが要る用途では `TokenCounter` を実測トークナイザに差し替えること。**
 *
 * ## ⚠ 対象トークナイザ
 *
 * 係数は `o200k_base`（gpt-4o / gpt-4o-mini 系）に合わせて調整してある。
 * **旧世代の `cl100k_base`**（gpt-4 / gpt-3.5-turbo / text-embedding-3-*）に対しては、
 * 日本語で約12%過小評価する（実測の合計比 0.878）。それでも現行式（旧式の合計比は
 * 0.353。フィクスチャ・歯を参照）よりは桁違いに近い。
 *
 * **Anthropic のトークナイザに対しては測っていない**（`packages/anthropic` あり）。
 * 使う場合は別途実測すること。
 */
export const heuristicTokenCounter: TokenCounter = {
  count(text: string): { tokens: number; counter: "heuristic" } {
    let cjkCount = 0;
    let nonCjkCount = 0;
    // for...of は文字列をコードポイント単位（サロゲートペアを1文字として）で走査する。
    // `text.length` は UTF-16 コード単位数であり、サロゲートペアを2として数えてしまうため
    // 使わない（例: SIP の漢字は length では2文字分になる）。
    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (isCjkCodePoint(codePoint)) {
        cjkCount++;
      } else {
        nonCjkCount++;
      }
    }
    const tokens = Math.ceil(
      (cjkCount * CJK_WEIGHT_NUMERATOR + nonCjkCount * NON_CJK_WEIGHT_NUMERATOR) /
        WEIGHT_DENOMINATOR,
    );
    return { tokens, counter: "heuristic" };
  },
};
