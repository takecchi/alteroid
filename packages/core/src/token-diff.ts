/**
 * 全文置換の前後で、本文に埋まった**数字とバッククォートの識別子**の増減を拾う
 * （issue #1306 案B）。
 *
 * ## なぜ要るか
 *
 * 長い文書を「読んでから書き戻す」とき、書き手（クローン）は元の文字列を
 * コピーしているのではなく、読んだ内容から**再生成している**。実例（#1306）では
 * UUID の真ん中だけが、同じ文脈に在った別の断片で埋まった —— 形式は妥当なので
 * 目視の検算を通る。`memory_write` の差分の要約（前後の文字数・消えた見出し）は、
 * **見出しが全部残ったまま本文の数字が1つ入れ替わった場合に何も言わない。**
 *
 * ## 何を拾うか
 *
 * - 数字の並び（`\d+`。小数点・区切りを含む `4` / `8,159` / `0.5`）
 * - バッククォートで囲まれた短い識別子（`` `pr-title-type` `` のような1行内のもの）
 *
 * 前後の**多重集合**で比べ、減った・増えたものを返す。意図した書き換えでも出るので
 * **これは警告ではなく検算の材料である** —— 呼び手（応答）は「意図した変更か確かめる
 * こと」とだけ言い、弾かない。
 *
 * 記憶（`memory_write`）とやり方（`practice_write`）の両方が使う（#1306 のコメント:
 * 同じ計算を2つの器で別々に持たない）。
 */

/** 1行に並べる件数の上限（それ以上は「ほか N 件」）。 */
export const TOKEN_DIFF_SHOWN = 10;

const TOKEN_PATTERN = /`[^`\n]{1,80}`|\d+(?:[.,]\d+)*/g;

function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

/** `a` にあって `b` に（その回数ぶん）無いものを、出現順を保たず辞書順で返す。 */
function surplus(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [token, count] of a) {
    const extra = count - (b.get(token) ?? 0);
    for (let i = 0; i < extra; i += 1) out.push(token);
  }
  return out.sort();
}

export interface TokenDiff {
  removed: string[];
  added: string[];
}

/** 前後の本文から、消えた・増えた数字と識別子を返す（どちらも辞書順）。 */
export function diffTokens(before: string, after: string): TokenDiff {
  const b = countTokens(before);
  const a = countTokens(after);
  return { removed: surplus(b, a), added: surplus(a, b) };
}

function listTokens(tokens: readonly string[]): string {
  const shown = tokens.slice(0, TOKEN_DIFF_SHOWN).join(' / ');
  const rest = tokens.length - TOKEN_DIFF_SHOWN;
  return rest > 0 ? `${shown}（ほか ${rest} 件）` : shown;
}

/**
 * 全文置換の応答に添える1行。**増減が無ければ `null`**（応答に1文字も足さない）。
 * 新規作成（`before === null`）でも `null` —— 比べる相手が無い。
 */
export function describeTokenDiff(before: string | null, after: string): string | null {
  if (before === null) return null;
  const { removed, added } = diffTokens(before, after);
  if (removed.length === 0 && added.length === 0) return null;
  const parts = [
    ...(removed.length === 0 ? [] : [`消えた: ${listTokens(removed)}`]),
    ...(added.length === 0 ? [] : [`増えた: ${listTokens(added)}`]),
  ];
  return (
    `本文の数字・識別子の増減（#1306）: ${parts.join('。')}。` +
    '意図した書き換えか確かめること —— 読んでから書き戻すと、書き換えていない箇所の値が入れ替わることがある'
  );
}
