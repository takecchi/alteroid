/**
 * `issue-done-trailer.mjs` の判定だけを切り出したもの（Issue #1134。#1109 の裏返し）。
 *
 * ## 何を塞ぐために在るか
 *
 * PR 本文が日本語の散文で「閉じる」意思を書いても、GitHub のクローズキーワード
 * パーサはそれを解釈しない ⟹ 直っている Issue が open のまま残る（実例:
 * PR #1073 の「**#1072 を閉じる。**」は不活性で、#1072 は人間が手で閉じるまで
 * 約1日 open のままだった）。
 *
 * ⟹ **GitHub のパーサに預けない、opt-in の trailer** を書式として定義し、
 * マージ後の workflow（`issue-done-trailer.yml`）がこの trailer を読んで
 * `gh issue close` する。この判定（trailer の名前・値の書式・降りる口）が
 * この门の正本。ネットワークは一切持たない（`gh` を叩くのは `issue-done-trailer.mjs`）。
 *
 * ## trailer の名前を `Alteroid-Issue-Done` にした理由（`Alteroid-Closes` にしない理由）
 *
 * #1134 のコメントで `pr-closing-keywords` の判定器（`check-pr-closing-keywords-core.mjs`）
 * に実際に食わせて測った結果、**`Alteroid-Closes: #<番号>` は門を赤くする**——
 * キーワード照合が `\b`（単語境界）で見ており、`-` は単語文字ではないので、
 * `Alteroid-Closes` の中の `Closes` に境界が立ち、公式 doc がキーワードとして
 * 明記している「コロン付きの形」の部分文字列がそのまま現れる。**GitHub の
 * パーサが同じ部分文字列を拾うかは実測していない**（測るには本番の Issue を
 * 実際に閉じるしかない）が、**拾うなら trailer 案の要である「GitHub にとって
 * 不活性」が成り立たない。**
 *
 * ⭐ **もう1つの理由（これが本命）**: 名前にキーワードが在ると、GitHub 側が
 * `Alteroid-Closes: 993 (段1 のみ)` の後半（範囲限定の注記）を捨てて番号までしか
 * 読まない可能性が残る ⟹ **範囲限定を実現するはずの行から、#1109 の事故
 * （範囲限定が効かず段1のマージで#993が閉じた）がそのまま再発する。**
 *
 * ⟹ 閉じるキーワード9語（`close` `closes` `closed` `fix` `fixes` `fixed`
 * `resolve` `resolves` `resolved`）を**どれも部分文字列として含まない**名前
 * `Alteroid-Issue-Done` を採る。同じ原則をファイル名・workflow 名・pnpm
 * script 名にも当てる（PR 本文やコミットメッセージでファイル名に言及したときに
 * 既存の門 `pr-closing-keywords` へ当たる経路を作らないため）。
 *
 * ## 書式
 *
 * ```
 * Alteroid-Issue-Done: 1072
 * Alteroid-Issue-Done: 1072, 1085
 * Alteroid-Issue-Done: none
 * ```
 *
 * - 行頭（前後の空白は許す）から trailer 名で始まる行だけを見る。名前の照合は
 *   大小文字を区別しない。
 * - 値が**番号だけの並び**（`,` / 空白区切り。`#1072` のように `#` が付いていても
 *   受ける）→ その番号を**閉じる**。
 * - 値が `none`（大小文字区別しない）→ **何も閉じない。しかもこれが全体で勝つ**
 *   （下の「降りる口」）。
 * - ⭐ **値に、認識できる番号の並び以外の文字が混ざっていたら「閉じない」へ
 *   倒す。** 例: `Alteroid-Issue-Done: 993 (段1 のみ)` は**閉じない**。
 *   **これがこの設計の要である** —— GitHub のパーサは範囲限定を捨てて番号まで
 *   読んで閉じる（#1109 の事故）が、こちらは**分からなければ閉じない側へ倒す**。
 *   `evaluateIssueDoneTrailer` の返り値にこの理由を残す（`kind: 'unrecognized'`）。
 *
 * ## 降りる口（2つ。必ず作る。#1134 の⛔の節が名指しで要求している）
 *
 * 1. `Alteroid-Issue-Done: none` が本文のどこかに1行でも在れば、**他の行が
 *    番号を持っていても何も閉じない**（矛盾が在ることは `contradicts` に残す）。
 *    理由: 「この誤爆を説明する文章が、その誤爆の形を含む」現象は実物で起きて
 *    いる（#1134 のコメント: `pr-closing-keywords` を書いた側が、自分の説明
 *    コメントを門に落とされて書き直している）。
 * 2. **``` で囲まれたコードフェンスの中の行と、`>` で始まる引用行は見ない。**
 *    例を書くための形を、道具が拾わないようにする。
 *
 * 心配なら両方使ってよい（フェンスに入れて例を書き、かつ実際の値の行に
 * `none` を書く）。
 *
 * ## 読む先について（この core が決めていること）
 *
 * この core は文字列（PR 本文）だけを受け取る。**どのテキストを渡すかは
 * 呼び出し側（`issue-done-trailer.mjs`）が決める** —— そちらの doc に
 * 「PR 本文だけを読み、コミットメッセージや `main` の履歴は読まない」理由が
 * 在る。
 */

/** trailer の名前。閉じるキーワード9語のどれも部分文字列として含まない。 */
export const TRAILER_NAME = 'Alteroid-Issue-Done';

/** フェンス区切り行（`` ``` `` を3つ以上、先頭の空白は許す）。 */
const FENCE_DELIMITER_PATTERN = /^\s*`{3,}/;

/** 引用行（先頭の空白を許した上で `>` で始まる）。 */
const QUOTE_LINE_PATTERN = /^\s*>/;

/** trailer 行そのもの（行頭からトレーラ名、コロン、値の順）。大小文字を区別しない。 */
const TRAILER_LINE_PATTERN = new RegExp(`^\\s*${TRAILER_NAME}\\s*:\\s*(.*?)\\s*$`, 'i');

/** 番号1つの形（`#` は在っても無くてもよい）。 */
const NUMBER_TOKEN_SOURCE = '#?\\d+';

/** 値全体が「番号だけの並び（`,` / 空白区切り）」であることの完全一致。 */
const NUMBER_LIST_PATTERN = new RegExp(
  `^${NUMBER_TOKEN_SOURCE}(?:[,\\s]+${NUMBER_TOKEN_SOURCE})*$`,
);

/**
 * フェンス・引用行を除いた「見える行」だけを返す（元の行番号は失うが、この
 * 门の判定は行番号を必要としない——`issue-done-trailer.mjs` 側のログは
 * 逐語の行そのものを出す）。
 *
 * 閉じられていないフェンスは fail-closed で末尾までフェンスの中として扱う
 * （`check-pr-closing-keywords-core.mjs` の `computeFenceIntervals` と同じ
 * 判断）。
 */
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

/**
 * trailer の値1つを分類する。
 *
 * @returns {{ kind: 'none', numbers: [] } | { kind: 'close', numbers: number[] } | { kind: 'unrecognized', numbers: [] }}
 */
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
  // ⭐ ここが要——番号の並びとして完全一致しない値は、範囲限定の注記
  // （`993 (段1 のみ)` 等）を含め、すべて「閉じない」へ倒す。
  return { kind: 'unrecognized', numbers: [] };
}

/**
 * テキスト（PR 本文を想定）から、フェンス・引用を除いた trailer 行を全部抽出する。
 * `text` が文字列でない・空文字なら空配列。
 *
 * @returns {{ raw: string, value: string, kind: 'none'|'close'|'unrecognized', numbers: number[] }[]}
 */
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

/**
 * PR 本文から、閉じるべき Issue 番号を決める。
 *
 * @param {string|null|undefined} body
 * @returns {{
 *   verdict: 'close'|'none'|'absent',
 *   issues: { number: number, sourceLine: string }[],
 *   lines: { raw: string, value: string, kind: string, numbers: number[] }[],
 *   contradicts: boolean,
 * }}
 *
 * - `absent`: trailer 行が1つも無い（何もしない——この PR は trailer の対象外）
 * - `none`: `none` 行が在る（他に close 行があっても勝つ。`contradicts` で
 *   矛盾の有無を示す）、または trailer 行はあるが全部 `unrecognized`
 *   （番号を1つも認識できなかった）
 * - `close`: 閉じるべき Issue 番号が1件以上ある（`issues` に、番号と、その
 *   番号を最初に述べた trailer 行の逐語を持つ）
 */
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
    // 全部 unrecognized（none も close も無い）——番号を1つも認識できなかった
    // ので、フェイルセーフとして「閉じない」へ倒す。
    return { verdict: 'none', issues: [], lines, contradicts: false };
  }

  const issues = [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, sourceLine]) => ({ number, sourceLine }));

  return { verdict: 'close', issues, lines, contradicts: false };
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-pr-closing-keywords-core.mjs`
 * の `formatVerdict` と同じ方針。ネットワークを持たないここでは PR 番号・
 * マージ時刻を知らないので、それらは呼び出し側（`issue-done-trailer.mjs`）が
 * 別に組み立てる。ここが返すのは「本文からの判定」だけの文である）。
 */
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
