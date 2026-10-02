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
import type { ApprovalQuestion, ApprovalSelection } from './schema.js';

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
 *
 * **通すもの:** 答えの無い設問（`selections` に出てこない設問）。畳むときに「未回答」と出す。
 */
export function describeSelectionsViolation(
  questions: readonly ApprovalQuestion[] | undefined,
  selections: readonly ApprovalSelection[],
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
  return null;
}

/** `(a)` `(b)` … `(z)`、27 番目以降は `(27)` と数字にする。 */
function optionMarker(index: number): string {
  return index < 26 ? `(${String.fromCharCode(97 + index)})` : `(${index + 1})`;
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
    const other = selection?.other?.trim();
    if (other !== undefined && other !== '') parts.push(`その他: ${other}`);
    return `${head} ${parts.length === 0 ? '未回答' : parts.join(' / ')}`;
  });
  const note = supplement?.trim();
  if (note !== undefined && note !== '') lines.push(`補足: ${note}`);
  return lines.join('\n');
}

/**
 * 設問と選択肢を人間・クローンが読む行にする（`approvals_list id=…` の詳細と CLI の詳細が
 * 通る。一覧には使わない——一覧は件数だけを出す: {@link summarizeQuestions}）。
 * 推奨の印・単一か複数か・その他を書けるか・答えるときの id を全部出す。
 */
export function describeQuestionLines(questions: readonly ApprovalQuestion[]): string[] {
  const lines: string[] = [];
  questions.forEach((question, index) => {
    const kind = question.multiple === true ? '複数選択可' : '単一選択';
    const other = question.allowOther === false ? 'その他は書けない' : 'その他を書ける';
    lines.push(`Q${index + 1} [id=${question.id}] ${question.prompt}（${kind}・${other}）`);
    question.options.forEach((option, at) => {
      lines.push(
        `  ${optionMarker(at)} [id=${option.id}] ${option.label}` +
          (option.recommended === true ? '［推奨］' : '') +
          (option.description === undefined ? '' : ` — ${option.description}`),
      );
    });
  });
  return lines;
}

/** 一覧に出す1行ぶんの要約（件数と、単一・複数の内訳だけ。本文は出さない）。 */
export function summarizeQuestions(questions: readonly ApprovalQuestion[]): string {
  const multiple = questions.filter((question) => question.multiple === true).length;
  return (
    `設問 ${questions.length} 件` +
    (multiple === 0 ? '' : `（うち複数選択 ${multiple}）`) +
    '（選択肢つき）'
  );
}
