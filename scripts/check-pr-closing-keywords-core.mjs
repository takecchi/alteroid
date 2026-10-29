// キーワードと参照のあいだにコロン無しの空白（`Closes #10`）もコロン（`Closes: #10`）も許す、`GH-123` と issue URL も拾う: GitHub が閉じる形の見逃しのほうが実害があるため。
// コード・引用・HTML コメントの中を安全とは扱わない: GitHub はバッククォートで囲んだ形でも閉じるため。

const KEYWORD_ALTERNATION = 'closed|closes|close|fixed|fixes|fix|resolved|resolves|resolve';
const KEYWORD_SOURCE = `\\b(?:${KEYWORD_ALTERNATION})\\b`;

const GAP_SOURCE = '(?:\\s*:\\s*|\\s+)';

const REFERENCE_SOURCE =
  '(?:https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+' +
  '|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#\\d+' +
  '|GH-\\d+' +
  '|#\\d+)';

const PAIR_SOURCE = `${KEYWORD_SOURCE}${GAP_SOURCE}${REFERENCE_SOURCE}`;

const OCCURRENCE_PATTERN = new RegExp(PAIR_SOURCE, 'gi');

// 行ごとに走査する: `GAP_SOURCE` が `\s` を含むため、全体に回すと行末のキーワードと次の行頭の参照が偶然つながる。
export function extractClosingKeywordReferences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const numbers = new Set();
  const trailingDigits = /(\d+)$/;
  for (const line of text.split('\n')) {
    OCCURRENCE_PATTERN.lastIndex = 0;
    let match;
    while ((match = OCCURRENCE_PATTERN.exec(line)) !== null) {
      const digitsMatch = trailingDigits.exec(match[0]);
      if (digitsMatch) numbers.add(Number(digitsMatch[1]));
      if (match[0].length === 0) OCCURRENCE_PATTERN.lastIndex++;
    }
  }
  return [...numbers].sort((a, b) => a - b);
}
