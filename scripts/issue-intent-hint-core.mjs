/**
 * `issue-intent-hint.mjs` の判定だけを切り出したもの（Issue #1134 の案3。
 * #1109 / #1134 が積んだ trailer 方式の「まだ塞がっていない穴」を塞ぐ）。
 *
 * ## 何を塞ぐために在るか
 *
 * PR 本文が**日本語の散文**で「閉じる」意思を書いても、GitHub の閉じる
 * キーワードパーサはそれを解釈しない。実例（doc は `issue-done-trailer-core.mjs`
 * が持つ。ここでは要点だけ）: PR #1073 の本文冒頭「**#1072 を閉じる。**」は
 * 不活性のまま残り、#1072 は人間が手で閉じるまで約1日 open のままだった。
 *
 * #1134 は opt-in の trailer（`Alteroid-Issue-Done`。正本は
 * `issue-done-trailer-core.mjs`）でこれに対処したが、**trailer を書き忘れた
 * PR は元の穴にそのまま落ちる。** この门はその「書き忘れ」を検出して促す
 * ——promoteするだけで、PR を落とさない（下の「終了コードには関わらない」）。
 *
 * ## なぜファイル名・関数名・出力文に閉じるキーワード9語を使わないか
 *
 * `close` `closes` `closed` `fix` `fixes` `fixed` `resolve` `resolves`
 * `resolved` のどれも部分文字列として含めない——`Alteroid-Issue-Done` という
 * trailer 名が選ばれたのと同じ理由（`issue-done-trailer-core.mjs` の doc に
 * 経緯が逐語である）。この门自身が英語の閉じるキーワードを名乗ると、
 * `pr-closing-keywords`（既存の门）へ自分で当たる経路を作ってしまう
 * ——この门の出力（`::warning::` 注釈や通常のログ）は PR 本文にもコミット
 * メッセージにも入らないので実害は無いはずだが、**「入らないはず」を前提に
 * 設計しない**（doc の逐語や表がそのまま PR 本文へコピー＆ペーストされた
 * 実例が #1134 のコメント自身に在る——書いた側が自分の説明を門に落とされて
 * 書き直している）。
 *
 * ## 測定（実測、2026-09-17 観測。`main` の直近マージ済み PR 200本）
 *
 * `gh pr list --repo takecchi/alteroid --state merged --limit 200 --json
 * number,title,body` で取得した200本に候補の検出器を当てた。
 *
 * ### 調整前（素朴な候補: 「閉じる」「閉じた」「閉じます」「クローズ」を含む行
 * ＋ Issue 参照が同じ行に在れば拾う。否定形は語のリストで除外）
 *
 * **25/200 本が発火。** 内訳を全件読んで判定した結果、**大半が誤爆**である
 * ——この repo は GitHub の Issue/PR の「閉じる」挙動そのものを日常的に議論して
 * いる（#1109 / #1134 自身のような門の実装 PR）うえ、台帳（`commitments`）の
 * 「未クローズ」という状態語や、`⛔ Closes にしていない — 閉じる判断は依頼者が
 * 持つ` のような**明示的に閉じない宣言**、`#123 を閉じるかどうかは人間が
 * 決める` のような**保留の言い回し**が同じ語彙を使う。実際の誤爆の例
 * （逐語。全部 `main` の実在する PR 本文）:
 *
 * - PR #1011: 「未クローズ」（ステータスのラベル。`クローズ` を部分文字列に
 *   持つだけで意図は無い）
 * - PR #892 / #881 / #989: 「Refs #785（⛔ `Closes` にしていない — 閉じる
 *   判断は依頼者が持つ）」（明示的に**閉じない**と言っている）
 * - PR #907: 「この PR は Issue を閉じない。閉じるかどうかは人間が決める」
 *   （同上。しかも「閉じる」が保留の文脈に2回現れる）
 * - PR #1127 / #1107: `pr-closing-keywords` 自身の実装・説明 PR。「閉じる」
 *   「クローズ」が議論の対象として大量に出る（自己参照の族。#785 と同型）
 *
 * ### 調整後（この実装。文単位でスコープを絞り、文末が「を＋動詞」で終わる
 * ときだけ拾う）
 *
 * **3/200 本が発火**（下の「検出の形」）。**全3件を読んで判定した結果、
 * 3件とも真陽性**——PR #1073（`**#1072 を閉じる。**`。この Issue が実例として
 * 挙げているもの）、PR #1074（`**#1058 を閉じる。**`。同型）、PR #1106
 * （`Issue #1097 が指摘していた…を閉じる。`）。**3件とも `Alteroid-Issue-Done`
 * trailer を持たない**（trailer 方式が着地する前の PR なので当然だが、
 * 「trailer が在れば静かになる」経路の分母がここでは0件だったことも実測して
 * おく）。
 *
 * ⚠️ **これは200件という標本の中で誤爆が0件だった、という意味でしかない。**
 * 「この形なら誤爆しない」と一般化してはいない——この门も #1134 自身の
 * ⛔ の節が警告する「自分自身の議論で誤爆する」を免れない（下の「降りる口」
 * が唯一の担保である）。
 *
 * ## 検出の形（文単位。行単位ではない）
 *
 * なぜ行単位ではなく文単位か——この repo の PR 本文は改行を挟まない長い段落
 * （1行に複数の文）が多く、行単位で「同居」を見ると無関係な文どうしが同じ
 * 行に同居して誤爆する。**`。` で区切った文の中に、Issue への参照と、文末の
 * 述語としての閉じる意思の両方が在る**ときだけ拾う。
 *
 * 1. **参照**: `check-pr-closing-keywords-core.mjs` の `REFERENCE_SOURCE`
 *    と同じ形（`#123` / `GH-123` / `owner/repo#123` / issue の URL）。
 *    正規表現を2箇所に持たないため import して使い回す。
 * 2. **閉じる意思**: 文が `を` の後に閉じる動詞（`閉じる` `閉じた` `閉じます`
 *    `閉じました` `クローズする` `クローズします` `クローズした`
 *    `クローズしました` `クローズ`）で終わっている（強調記号 `**` / `*` /
 *    `__` / `_` と句点 `。`/`.` は前後に許す）。
 *
 * **なぜ「文末の述語」に絞ったか——これが否定形・保留・仮定を機械的に除外する
 * 唯一の軸である。** 日本語の否定・保留・仮定は動詞の**後ろ**に付く
 * （`〜ない` `〜かどうか` `〜判断は…が持つ` `〜わけではない` `〜のを避ける`
 * `〜たくない` 等）。動詞を文の**最後**に固定すると、これらの接続表現は
 * 構造的に「動詞の後に何か続く」形になり、パターンが文末まで届かず自動的に
 * 落ちる——個々の否定・保留表現を語のリストとして列挙する必要が無い
 * （列挙は必ず漏れる。#1134 のコメントが警告する「散文を検出する門は自分
 * 自身の議論で誤爆する」の裏返しで、**否定の語彙も同じだけ豊かである**）。
 * 実測で確認した具体例（すべて拾わない。上の「調整前」に挙げた誤爆の実例と
 * 同じ語彙を、人工的な文でも確認した）:
 *
 * - `#123 を閉じない。` / `#123 を閉じていない。` / `#123 を閉じられない。` /
 *   `#123 を閉じません。` / `#123 をクローズしない。`（明示的な否定）
 * - `#123 を閉じるかどうかは人間が決める。`（保留）
 * - `#123 を閉じる判断は依頼者が持つ。`（保留）
 * - `#123 を閉じたくない。`（願望の否定的な向き）
 * - `#123 を閉じるのを避ける。` / `#123 を閉じるわけではない。`（婉曲な否定）
 *
 * これらはいずれも動詞（`閉じる` 等）の直後に文字が続くため、文末アンカー
 * （下の `SENTENCE_END_INTENT_PATTERN`）まで到達せず、パターン全体が
 * マッチしない。**否定形の専用リストは持っていない**——構造がそれを不要に
 * している。
 *
 * ## 除外（コードフェンス・引用・インラインコード・HTML コメント）
 *
 * `check-pr-closing-keywords-core.mjs` の `computeFenceIntervals` /
 * `computeInlineCodeIntervals` / `computeCommentIntervals` / `QUOTE_LINE_PATTERN`
 * を import して使い回す（同じ除外を書き写さない）。除外はマスク方式
 * ——対象区間を同じ長さの空白へ置き換えてから文分割・パターン判定を行う。
 * こうすると「除外された区間をまたいで文がつながる」ことも「除外区間の中の
 * `。` を文区切りとして数える」ことも同時に防げる（区間の中身がそもそも
 * 消えているので、`。` があってもなくても判定に影響しない）。
 *
 * ⚠️ **文字列の走査は `Array.from` ではなく `split('')` を使う。** `Array.from`
 * は絵文字などの astral 面の文字（サロゲートペア、例: 🔑 U+1F511）を1つの
 * 要素にまとめてしまい、`String#length` / 正規表現の `.index`（どちらも
 * UTF-16 コード単位で数える）と要素数がずれる。実測（2026-09-17）:
 * 直近マージ済み PR 200本中 **59本**の本文・タイトルに astral 面の文字が
 * 含まれていた（`codePointAt(0) > 0xFFFF` で判定）。`split('')` は UTF-16
 * コード単位で割るので、他の場所（`computeLineStarts` 等）が使っている
 * オフセットの数え方とずれない。
 *
 * ## 降りる口（最優先。必ず最初に見る）
 *
 * `body` に `issue-done-trailer-core.mjs` の `extractIssueDoneTrailerLines`
 * が1行でも見つければ、**その値（`close` / `none` / `unrecognized` のどれか）
 * を問わず無条件で静か**（`verdict: 'quiet'`、`reason: 'trailer-present'`）。
 * 判定はあちらの export をそのまま使う——同じ抽出（フェンス・引用の除外を
 * 含む）を書き写さない。
 *
 * なぜ値を問わないか——この门は「trailer を書いたか」だけを見る。値が
 * `none` でも `unrecognized` でも、**書き手は既に trailer という機構の存在を
 * 知っていて、意図的にそれを使っている**。この门が促したいのはその手前
 * ——trailer の存在を知らずに散文だけで意思を表明している状態——だけである。
 *
 * ## verdict は2値
 *
 * `quiet` | `hint`。**どちらであっても終了コードは変えない**
 * （呼び出し側 `issue-intent-hint.mjs` の責務。#1134 が「PR を落とすのでは
 * なく警告して trailer を促す」「门は hard fail にせず降りられる口を必ず
 * 付けること」と明記している）。
 */

import { extractIssueDoneTrailerLines } from './issue-done-trailer-core.mjs';
import {
  REFERENCE_SOURCE,
  QUOTE_LINE_PATTERN,
  computeLineStarts,
  computeFenceIntervals,
  computeInlineCodeIntervals,
  computeCommentIntervals,
} from './check-pr-closing-keywords-core.mjs';

/** Issue への参照を含むかどうかの判定用（`g` 無し。文単位で1回だけ見る）。 */
const REFERENCE_PATTERN = new RegExp(REFERENCE_SOURCE);

/** 対の並び全体を囲んでよい強調記号（`check-pr-closing-keywords-core.mjs` の `WRAP_SOURCE` と同じ考え方）。 */
const MARK_SOURCE = '(?:\\*\\*|\\*|__|_)';

/**
 * 閉じる意思の動詞（長い活用形を先に置く）。**閉じるキーワード9語
 * （close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved）は
 * どれも部分文字列として含まない——日本語（`閉じる` の活用）とカタカナ
 * （`クローズ` の活用）だけで構成している。
 */
const INTENT_VERB_SOURCE =
  'クローズしました|クローズします|クローズした|クローズする|' +
  '閉じました|閉じます|閉じた|閉じる|クローズ';

/**
 * 「を」＋閉じる動詞が、（強調記号・句点を除いて）文の終わりに来ていること。
 * 動詞の直後に否定・保留の接尾（`ない` `ません` 等）が続く形は、これらの
 * 接尾が続くぶんパターンが文末まで届かず自然に落ちる（doc の「なぜ文末の
 * 述語に絞ったか」）。`(?!(?:ない|ません))` は自己参照ではなく、動詞の
 * 活用形どうしの部分文字列衝突（例: `閉じます` の中に `閉じ` が含まれる）を
 * 避けるための保険——実際には活用形の語尾が異なるため理論上は不要だが、
 * 将来語を足したときの事故を防ぐために残す。
 */
const SENTENCE_END_INTENT_PATTERN = new RegExp(
  `を\\s*${MARK_SOURCE}?(?:${INTENT_VERB_SOURCE})(?!(?:ない|ません))${MARK_SOURCE}?` +
    `\\s*[。.]?\\s*${MARK_SOURCE}?\\s*$`,
);

/**
 * `text` 中の、フェンス・インラインコード・HTML コメント・引用行を空白へ
 * マスクした写しと、その除外区間の一覧を返す。オフセットは UTF-16 コード
 * 単位で扱う（`split('')`。doc の「astral 面の文字」を見よ）。
 *
 * @returns {{ masked: string, excludedIntervals: [number, number][] }}
 */
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

/**
 * `。` を区切りに文単位の `[start, end)`（絶対オフセット）を返す。区切り文字
 * 自身は手前の文に含める。末尾に `。` が無い残りも1文として含める。
 *
 * **除外区間（フェンス・引用・インラインコード・HTML コメント）の境界も
 * 文の区切りとして扱う。** マスクは中身を空白へ置き換えるだけなので、
 * 除外区間の中に在った `。` はもう区切りとして機能しない——そのままでは
 * 「除外区間をまたいで前後の地の文が1つの文として合成される」形になり、
 * 除外区間の手前に在る参照と、除外区間の後ろに在る動詞が同居してしまう
 * （実測でこの形の誤爆を作れたため、境界を区切りとして足した）。
 */
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

/**
 * `text` から「Issue への参照と、文末の述語としての閉じる意思が同居する文」
 * を全部拾う。フェンス・引用・インラインコード・HTML コメントの中は見ない。
 * `text` が文字列でない・空文字なら空配列。
 *
 * @returns {string[]} 見つかった文の逐語（元テキストからそのまま切り出し、
 *   前後の空白のみ trim したもの）
 */
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

/**
 * PR の `title` と `body` から、trailer の降りる口を最優先で見たうえで、
 * 日本語の散文による閉じる意思のヒントを判定する。
 *
 * @param {{ title: string|null|undefined, body: string|null|undefined }} input
 * @returns {{
 *   verdict: 'quiet'|'hint',
 *   reason: 'trailer-present'|'no-hint'|'hint-found',
 *   findings: { source: 'PR のタイトル'|'PR 本文', sentence: string }[],
 * }}
 */
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

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-pr-closing-keywords-core.mjs`
 * / `issue-done-trailer-core.mjs` の `formatVerdict` / `formatEvaluation` と
 * 同じ方針）。**降りる口を必ず明記する**（#1134 の要求）。
 */
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
