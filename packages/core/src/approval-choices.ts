/**
 * 承認待ちの質問を選択肢で答えられるようにする部品（issue #2525）。
 *
 * `ask_human` の任意の `questions`（設問と選択肢）を検査し、人間の `selections`
 * （どの設問でどの選択肢を選んだか）を設問と突き合わせて検証し、人間が読める文へ
 * 畳む。**純関数だけを置く**（ストアにも時計にも触らない）ので、道具（`tools.ts`）・
 * クローン（`clone.ts`）・デーモンの HTTP の口（400 の判定）が同じ関数を通る。
 *
 * 構造そのものは `PendingApproval.selections` に残り、畳んだ文は
 * `PendingApproval.answer` と日誌の `escalation` の回答に入る（`Clone#answerApproval`）。
 */
import { optionMarker } from './approval-questions-format.js';
import type { ApprovalQuestion, ApprovalSelection } from './schema.js';

export { describeQuestionLines, summarizeQuestions } from './approval-questions-format.js';

/**
 * `questions` の中身の検査（道具の入力）。問題が無ければ `null`、あれば人間・クローンが
 * 直せる1文。**id の一意性だけを見る**（形は zod が見ている）。
 *
 * - 設問の id は承認待ちの中で一意
 * - 選択肢の id は設問の中で一意（設問をまたいで同じでもよい）
 */
export function describeQuestionsViolation(questions: readonly ApprovalQuestion[]): string | null {
  const questionIds = new Set<string>();
  for (const question of questions) {
    if (questionIds.has(question.id)) {
      return `questions の設問 id "${question.id}" が重複している（設問の id は承認待ちの中で一意にする）。`;
    }
    questionIds.add(question.id);
    const optionIds = new Set<string>();
    for (const option of question.options) {
      if (optionIds.has(option.id)) {
        return `設問 "${question.id}" の選択肢 id "${option.id}" が重複している（選択肢の id は設問の中で一意にする）。`;
      }
      optionIds.add(option.id);
    }
  }
  return null;
}

/**
 * `selections` を `questions` と突き合わせる（HTTP の口と `Clone#answerApproval` が通る）。
 * 問題が無ければ `null`、あれば 400 の理由にする1文。**送られてきた値は文言へ混ぜない**
 * （id は混ぜる——どの設問のどの id かを言わないと直せない。本文 `other` は混ぜない）。
 *
 * 弾くもの:
 * - `questions` を持たない承認待ちへの `selections`
 * - 知らない設問 id・選択肢 id
 * - 同じ設問が2回出る・同じ選択肢が1つの設問の中で2回出る
 * - 単一選択（`multiple` でない）で選択肢が2つ以上
 * - `allowOther: false` なのに `other` がある
 * - **何も答えていない**（全部の selection で `optionIds` が空かつ `other` が trim で空、
 *   しかも補足 `supplement` も trim で空。`selections` が空配列も同じ。Web UI の `empty` と
 *   同じ線。issue #2582）
 *
 * **通すもの:** 一部の設問だけ答えの無い設問（`selections` に出てこない設問）。畳むときに
 * 「未回答」と出す。補足だけ付いた回答も通す。
 *
 * `supplement` は `selections` と併用する自由文（`answer`）。呼び手は必ず渡すこと。
 */
export function describeSelectionsViolation(
  questions: readonly ApprovalQuestion[] | undefined,
  selections: readonly ApprovalSelection[],
  supplement?: string,
): string | null {
  if (questions === undefined || questions.length === 0) {
    return 'この承認待ちは questions を持たないので、selections では答えられない（answer で答える）。';
  }
  const seen = new Set<string>();
  for (const selection of selections) {
    const question = questions.find((candidate) => candidate.id === selection.questionId);
    if (question === undefined) {
      return `selections に知らない設問 id "${selection.questionId}" がある。`;
    }
    if (seen.has(question.id)) {
      return `設問 "${question.id}" が selections に2回出ている。`;
    }
    seen.add(question.id);
    const chosen = new Set<string>();
    for (const optionId of selection.optionIds) {
      if (!question.options.some((option) => option.id === optionId)) {
        return `設問 "${question.id}" に知らない選択肢 id "${optionId}" がある。`;
      }
      if (chosen.has(optionId)) {
        return `設問 "${question.id}" の選択肢 "${optionId}" が2回出ている。`;
      }
      chosen.add(optionId);
    }
    if (question.multiple !== true && selection.optionIds.length > 1) {
      return `設問 "${question.id}" は単一選択なので、選択肢は1つしか選べない。`;
    }
    if (selection.other !== undefined && question.allowOther === false) {
      return `設問 "${question.id}" は allowOther が false なので、other は書けない。`;
    }
  }
  const answered = selections.some(
    (selection) =>
      selection.optionIds.length > 0 ||
      (selection.other !== undefined && selection.other.trim() !== ''),
  );
  if (!answered && (supplement === undefined || supplement.trim() === '')) {
    return '何も答えていない（選択肢・other・補足のどれかが要る）。';
  }
  return null;
}

/**
 * 回答を人間が読める文へ畳む。**設問・選んだ選択肢のラベル・その他の文・補足が全部読める**
 * こと、答えの無い設問は「未回答」と出すことが約束で、`PendingApproval.answer` と日誌の
 * `escalation` の回答はこの文である。
 *
 * ```
 * Q1 デプロイ先: (a) Railway［推奨］ / その他: Fly.io
 * Q2 通知: 未回答
 * 補足: 金曜は避けたい
 * ```
 *
 * 呼ぶ前に {@link describeSelectionsViolation} を通すこと（通っていない値でも落ちはしないが、
 * 知らない id は id のまま出す）。
 */
export function foldSelections(
  questions: readonly ApprovalQuestion[],
  selections: readonly ApprovalSelection[],
  supplement?: string,
): string {
  const lines = questions.map((question, index) => {
    const head = `Q${index + 1} ${question.prompt}:`;
    const selection = selections.find((candidate) => candidate.questionId === question.id);
    const parts: string[] = [];
    for (const optionId of selection?.optionIds ?? []) {
      const at = question.options.findIndex((option) => option.id === optionId);
      const option = question.options[at];
      parts.push(
        option === undefined
          ? optionId
          : `${optionMarker(at)} ${option.label}${option.recommended === true ? '［推奨］' : ''}`,
      );
    }
    // other の改行は空白 1 つに潰す（#2598）。残すと、畳んだ文の中で別の設問や補足の行に見える。
    // 保存する構造（selections[].other）は変えない。補足（supplement）は自由文なので改行を残す。
    const other = selection?.other?.trim().replace(/(?:\r\n|\r|\n)+/g, ' ');
    if (other !== undefined && other !== '') parts.push(`その他: ${other}`);
    return `${head} ${parts.length === 0 ? '未回答' : parts.join(' / ')}`;
  });
  const note = supplement?.trim();
  if (note !== undefined && note !== '') lines.push(`補足: ${note}`);
  return lines.join('\n');
}
