export const TOKEN_DIFF_SHOWN = 10;

const TOKEN_PATTERN = /`[^`\n]{1,80}`|\d+(?:[.,]\d+)*/g;

function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

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

// 警告として弾かない: 意図した書き換えでも増減は出るため
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
