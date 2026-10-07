// ファイル名・関数名・出力文に閉じるキーワード9語を部分文字列として含めない: 含めると既存の門 `pr-closing-keywords` へ自分で当たる経路を作るため。
// 行単位ではなく `。` で区切った文単位で判定する: PR 本文は1行に複数の文を書く長い段落が多く、行単位だと無関係な文どうしが同居して誤爆するため。
// 文末の述語に絞る: 日本語の否定・保留・仮定は動詞の後ろに付き、動詞を文末に固定すれば否定形の専用リストを持たずに落とせるため。
// 文字列の走査は `Array.from` ではなく `split('')` を使う: `Array.from` は astral 面の文字を1要素にまとめ、UTF-16 コード単位のオフセットとずれるため。
// trailer が1行でも在れば値を問わず静かにする: 書き手は既に trailer の存在を知っており、促したいのはそれを知らない状態だけのため。
// 終了コードは変えない: PR を落とさず、警告して trailer を促すため。

import { extractIssueDoneTrailerLines } from './issue-done-trailer-core.mjs';
import {
  REFERENCE_SOURCE,
  QUOTE_LINE_PATTERN,
  computeLineStarts,
  computeFenceIntervals,
  computeInlineCodeIntervals,
  computeCommentIntervals,
} from './check-pr-closing-keywords-core.mjs';

const REFERENCE_PATTERN = new RegExp(REFERENCE_SOURCE);

const MARK_SOURCE = '(?:\\*\\*|\\*|__|_)';

const INTENT_VERB_SOURCE =
  'クローズしました|クローズします|クローズした|クローズする|' +
  '閉じました|閉じます|閉じた|閉じる|クローズ';

// `(?!(?:ない|ません))` を残す: 理論上は不要だが、将来語を足したとき活用形どうしの部分文字列衝突（`閉じます` の中の `閉じ`）で事故を起こさないため。
const SENTENCE_END_INTENT_PATTERN = new RegExp(
  `を\\s*${MARK_SOURCE}?(?:${INTENT_VERB_SOURCE})(?!(?:ない|ません))${MARK_SOURCE}?` +
    `\\s*[。.]?\\s*${MARK_SOURCE}?\\s*$`,
);

function maskExcludedRegions(text) {
  const lines = text.split('\n');
  const lineStarts = computeLineStarts(lines);
  const intervals = [
    ...computeFenceIntervals(lines, lineStarts),
    ...computeInlineCodeIntervals(lines, lineStarts),
    ...computeCommentIntervals(text),
  ];
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_LINE_PATTERN.test(lines[i])) {
      intervals.push([lineStarts[i], lineStarts[i] + lines[i].length]);
    }
  }

  const chars = text.split('');
  for (const [start, end] of intervals) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return { masked: chars.join(''), excludedIntervals: intervals };
}

// 除外区間の境界も文の区切りにする: マスクは中身を空白にするだけで、除外区間をまたいで前後の地の文が1つの文になり、手前の参照と後ろの動詞が同居して誤爆するため。
function splitSentenceRanges(text, excludedIntervals) {
  const breakpoints = new Set([0, text.length]);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '。') breakpoints.add(i + 1);
  }
  for (const [start, end] of excludedIntervals) {
    breakpoints.add(Math.max(0, Math.min(start, text.length)));
    breakpoints.add(Math.max(0, Math.min(end, text.length)));
  }

  const sorted = [...breakpoints].sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

export function findIssueIntentHintSentences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const { masked, excludedIntervals } = maskExcludedRegions(text);
  const hits = [];
  for (const [start, end] of splitSentenceRanges(masked, excludedIntervals)) {
    const maskedSentence = masked.slice(start, end);
    if (!REFERENCE_PATTERN.test(maskedSentence)) continue;
    if (!SENTENCE_END_INTENT_PATTERN.test(maskedSentence.trim())) continue;
    hits.push(text.slice(start, end).trim());
  }
  return hits;
}

export function evaluateIssueIntentHint({ title, body }) {
  const trailerLines = extractIssueDoneTrailerLines(body);
  if (trailerLines.length > 0) {
    return { verdict: 'quiet', reason: 'trailer-present', findings: [] };
  }

  const findings = [];
  for (const sentence of findIssueIntentHintSentences(title)) {
    findings.push({ source: 'PR のタイトル', sentence });
  }
  for (const sentence of findIssueIntentHintSentences(body)) {
    findings.push({ source: 'PR 本文', sentence });
  }

  if (findings.length === 0) {
    return { verdict: 'quiet', reason: 'no-hint', findings: [] };
  }
  return { verdict: 'hint', reason: 'hint-found', findings };
}

export function formatIssueIntentHintEvaluation(result) {
  const header = 'issue-intent-hint:';
  switch (result.reason) {
    case 'trailer-present':
      return `${header} 静か —— PR 本文に Alteroid-Issue-Done trailer が在る（値は問わない）`;
    case 'no-hint':
      return `${header} 静か —— 日本語の散文による閉じる意思は見つからなかった`;
    case 'hint-found':
      return [
        `${header} ヒント —— Issue への参照と、閉じる意思の文が同居している（trailer 無し）`,
        ...result.findings.map((f) => `  ${f.source}: ${f.sentence}`),
        '  次の一手（このヒントはマージを止めない。参考情報である）:',
        '   - 本当に閉じたいなら、PR 本文に独立した行で `Alteroid-Issue-Done: <番号>` を書く' +
          '（マージ後に workflow が閉じる。書式は scripts/issue-done-trailer-core.mjs の doc）',
        '   - 閉じないなら `Alteroid-Issue-Done: none` を書く（降りる口。何も閉じない）',
        '   - 単なる言及で閉じる意図が無いなら、何もしなくてよい（このヒントは参考情報であり、マージを妨げない）',
      ].join('\n');
    default:
      return `${header} 未知の reason: ${result.reason}`;
  }
}
