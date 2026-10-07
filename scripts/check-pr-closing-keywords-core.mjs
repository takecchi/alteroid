// キーワードと参照のあいだにコロン無しの空白（`Closes #10`）もコロン（`Closes: #10`）も許す、`GH-123` と issue URL も拾う: GitHub が閉じる形の見逃しのほうが実害があるため。
// コード・引用・HTML コメントの中を安全とは扱わない: GitHub はバッククォートで囲んだ形でも閉じるため。
// タイトル・本文・コミットメッセージのどれかが読めなかったら赤くする（`unreadable`）: 「無い」と区別するため。
// repo のファイルも git の履歴も走査しない: この門のテストの fixture が逐語を持つため、走査すると自己参照で誤検出する。

export const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

const KEYWORD_ALTERNATION = 'closed|closes|close|fixed|fixes|fix|resolved|resolves|resolve';
const KEYWORD_SOURCE = `\\b(?:${KEYWORD_ALTERNATION})\\b`;

const GAP_SOURCE = '(?:\\s*:\\s*|\\s+)';

export const REFERENCE_SOURCE =
  '(?:https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+' +
  '|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#\\d+' +
  '|GH-\\d+' +
  '|#\\d+)';

const PAIR_SOURCE = `${KEYWORD_SOURCE}${GAP_SOURCE}${REFERENCE_SOURCE}`;

const OCCURRENCE_PATTERN = new RegExp(PAIR_SOURCE, 'gi');

// `**` を `*` より先に、`__` を `_` より先に置く: 先に `*` が試されると1文字だけ消費してしまうため。
const WRAP_SOURCE = '(\\*\\*|\\*|__|_)';

const PURE_LINE_PATTERN = new RegExp(
  `^\\s*${WRAP_SOURCE}?` +
    `${PAIR_SOURCE}(?:\\s*[,、]\\s*${PAIR_SOURCE})*` +
    `\\1` +
    `\\s*[.。]?\\s*$`,
  'i',
);

const FENCE_DELIMITER_PATTERN = /^\s*`{3,}/;

export const QUOTE_LINE_PATTERN = /^\s*>/;

export function computeLineStarts(lines) {
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

// 閉じられていないフェンスは末尾までをコードとして扱う: 読めなかった分を「無い」と扱わないため。
export function computeFenceIntervals(lines, lineStarts) {
  const intervals = [];
  let inFence = false;
  let openStart = null;
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_DELIMITER_PATTERN.test(lines[i])) continue;
    if (!inFence) {
      inFence = true;
      openStart = lineStarts[i];
    } else {
      inFence = false;
      intervals.push([openStart, lineStarts[i] + lines[i].length]);
      openStart = null;
    }
  }
  if (inFence && openStart !== null) {
    const last = lines.length - 1;
    intervals.push([openStart, lineStarts[last] + lines[last].length]);
  }
  return intervals;
}

export function computeInlineCodeIntervals(lines, lineStarts) {
  const intervals = [];
  const re = /`[^`\n]*`/g;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      intervals.push([lineStarts[i] + m.index, lineStarts[i] + m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return intervals;
}

export function computeCommentIntervals(text) {
  const intervals = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    intervals.push([m.index, m.index + m[0].length]);
  }
  return intervals;
}

function overlapsAny(intervals, start, end) {
  return intervals.some(([a, b]) => start < b && end > a);
}

function analyzeLine(lineText, lineIndex, ctx) {
  const findings = [];
  const isPure = PURE_LINE_PATTERN.test(lineText);
  const lineStart = ctx.lineStarts[lineIndex];

  OCCURRENCE_PATTERN.lastIndex = 0;
  let match;
  while ((match = OCCURRENCE_PATTERN.exec(lineText)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const absoluteStart = lineStart + matchStart;
    const absoluteEnd = lineStart + matchEnd;

    let category = null;
    if (overlapsAny(ctx.codeIntervals, absoluteStart, absoluteEnd)) {
      category = 'in-code';
    } else if (overlapsAny(ctx.commentIntervals, absoluteStart, absoluteEnd)) {
      category = 'in-html-comment';
    } else if (ctx.quoteLines.has(lineIndex)) {
      category = 'in-quote';
    } else if (!isPure) {
      const leadingSegment = lineText.slice(0, matchStart);
      const trailingSegment = lineText.slice(matchEnd);
      const hasTrailing = !/^\s*[.。]?\s*$/.test(trailingSegment);
      if (hasTrailing) {
        category = 'trailing-text';
      } else if (/\S/.test(leadingSegment)) {
        category = 'leading-text';
      } else {
        // 理論上は通らない経路だが削らない: 未知の形は見逃さない側へ倒すため。
        category = 'trailing-text';
      }
    }

    if (category !== null) {
      findings.push({ category, line: lineText });
    }

    if (match[0].length === 0) OCCURRENCE_PATTERN.lastIndex++;
  }

  return findings;
}

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

export function findClosingKeywordOccurrences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const lines = text.split('\n');
  const lineStarts = computeLineStarts(lines);
  const codeIntervals = [
    ...computeFenceIntervals(lines, lineStarts),
    ...computeInlineCodeIntervals(lines, lineStarts),
  ];
  const commentIntervals = computeCommentIntervals(text);
  const quoteLines = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_LINE_PATTERN.test(lines[i])) quoteLines.add(i);
  }

  const ctx = { lineStarts, codeIntervals, commentIntervals, quoteLines };
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    findings.push(...analyzeLine(lines[i], i, ctx));
  }
  return findings;
}

function describeCommit(commit) {
  const oidShort =
    typeof commit?.oid === 'string' && commit.oid.length > 0 ? commit.oid.slice(0, 7) : '(sha不明)';
  const headline =
    typeof commit?.headline === 'string' && commit.headline.length > 0
      ? ` "${commit.headline}"`
      : '';
  return `commit ${oidShort}${headline}`;
}

export function evaluatePrClosingKeywords({ title, body, commits }) {
  if (typeof title !== 'string' || body === null || commits === null) {
    return { verdict: 'unreadable', findings: [] };
  }

  const findings = [];

  for (const occ of findClosingKeywordOccurrences(title)) {
    findings.push({ source: 'PR のタイトル', ...occ });
  }

  for (const occ of findClosingKeywordOccurrences(body)) {
    findings.push({ source: 'PR 本文', ...occ });
  }

  for (const commit of commits) {
    const occurrences = findClosingKeywordOccurrences(commit?.message);
    if (occurrences.length === 0) continue;
    const source = describeCommit(commit);
    for (const occ of occurrences) {
      findings.push({ source, ...occ });
    }
  }

  return { verdict: findings.length > 0 ? 'found' : 'ok', findings };
}

export function formatVerdict(prNumber, result) {
  const header = `check-pr-closing-keywords(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR のタイトル・本文・コミットメッセージの` +
        'いずれかを読めなかった（fail-closed。「見つからなかった」ではなく赤くする）'
      );
    case 'found':
      return [
        `${header} NG —— 閉じるキーワードと参照の組が、GitHub に解釈される形で見つかった`,
        ...result.findings.map((f) => `  ${f.source} [${f.category}]: ${f.line}`),
        '  次の一手:',
        '   - 参照だけしたいなら番号だけ書く（キーワードを同じ行に置かない）',
        '   - 閉じたいならキーワードと参照だけの行にする、または手で閉じる（gh issue close <N>）',
        '   - GitHub のパーサに預けずに閉じたいなら `Alteroid-Issue-Done: <番号>` を' +
          ' PR 本文へ書く（書式は scripts/issue-done-trailer-core.mjs の doc。#1134）',
        '  ⚠️ バッククォートで囲んでも GitHub は閉じる',
      ].join('\n');
    case 'ok':
      return (
        `${header} OK —— 閉じるキーワードと参照の組は無いか、通す形` +
        '（キーワードと参照だけの単独行、または強調で囲んだ同じ形）だけである'
      );
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
