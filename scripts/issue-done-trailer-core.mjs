// trailer の名前に閉じるキーワード9語を部分文字列として含めない: 含めると門が赤くなり、GitHub が範囲限定の注記を捨てて番号まで読んで閉じる事故が再発しうるため。
// 値に認識できる番号の並び以外が混ざっていたら「閉じない」へ倒す: 分からなければ閉じない側へ倒すため。
// `none` の行が1行でも在れば他の行が番号を持っていても何も閉じない: 降りる口を必ず作るため。コードフェンス内と `>` 引用行は例を書くための形なので見ない。

export const TRAILER_NAME = 'Alteroid-Issue-Done';

const FENCE_DELIMITER_PATTERN = /^\s*`{3,}/;

const QUOTE_LINE_PATTERN = /^\s*>/;

const TRAILER_LINE_PATTERN = new RegExp(`^\\s*${TRAILER_NAME}\\s*:\\s*(.*?)\\s*$`, 'i');

const NUMBER_TOKEN_SOURCE = '#?\\d+';

const NUMBER_LIST_PATTERN = new RegExp(
  `^${NUMBER_TOKEN_SOURCE}(?:[,\\s]+${NUMBER_TOKEN_SOURCE})*$`,
);

// 閉じられていないフェンスは末尾までフェンスの中として扱う: fail-closed にするため。
function visibleLines(text) {
  const lines = text.split('\n');
  const result = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_DELIMITER_PATTERN.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (QUOTE_LINE_PATTERN.test(line)) continue;
    result.push(line);
  }
  return result;
}

function parseTrailerValue(rawValue) {
  const value = rawValue.trim();
  if (value.length === 0) {
    return { kind: 'unrecognized', numbers: [] };
  }
  if (value.toLowerCase() === 'none') {
    return { kind: 'none', numbers: [] };
  }
  if (NUMBER_LIST_PATTERN.test(value)) {
    const numbers = value
      .split(/[,\s]+/)
      .filter((token) => token.length > 0)
      .map((token) => Number(token.replace(/^#/, '')));
    return { kind: 'close', numbers };
  }
  return { kind: 'unrecognized', numbers: [] };
}

export function extractIssueDoneTrailerLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = visibleLines(text);
  const found = [];
  for (const line of lines) {
    const match = TRAILER_LINE_PATTERN.exec(line);
    if (!match) continue;
    const parsed = parseTrailerValue(match[1]);
    found.push({ raw: line, value: match[1].trim(), ...parsed });
  }
  return found;
}

export function evaluateIssueDoneTrailer(body) {
  const lines = extractIssueDoneTrailerLines(body);

  if (lines.length === 0) {
    return { verdict: 'absent', issues: [], lines: [], contradicts: false };
  }

  const hasNone = lines.some((line) => line.kind === 'none');
  const hasClose = lines.some((line) => line.kind === 'close');

  if (hasNone) {
    return { verdict: 'none', issues: [], lines, contradicts: hasClose };
  }

  const seen = new Map();
  for (const line of lines) {
    if (line.kind !== 'close') continue;
    for (const number of line.numbers) {
      if (!seen.has(number)) seen.set(number, line.raw);
    }
  }

  if (seen.size === 0) {
    // 全部 unrecognized なら「閉じない」へ倒す: 番号を1つも認識できなかったため。
    return { verdict: 'none', issues: [], lines, contradicts: false };
  }

  const issues = [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, sourceLine]) => ({ number, sourceLine }));

  return { verdict: 'close', issues, lines, contradicts: false };
}

export function formatEvaluation(result) {
  const header = 'issue-done-trailer:';
  switch (result.verdict) {
    case 'absent':
      return `${header} trailer 無し —— 何も閉じない（この PR は対象外）`;
    case 'none': {
      const lines = result.lines.map((line) => `  [${line.kind}] ${line.raw}`);
      const contradictionNote = result.contradicts
        ? '  ⚠️ none と番号の並びが同じ本文に同居している。none が勝つ（何も閉じない）'
        : '  （番号を認識できる行が無かった、または none が明示されている）';
      return [`${header} none —— 何も閉じない`, ...lines, contradictionNote].join('\n');
    }
    case 'close':
      return [
        `${header} close —— ${result.issues.length}件の Issue を閉じる候補にする`,
        ...result.issues.map((issue) => `  #${issue.number} <- "${issue.sourceLine}"`),
      ].join('\n');
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
