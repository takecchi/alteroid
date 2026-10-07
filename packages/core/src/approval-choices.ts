import { optionMarker } from './approval-questions-format.js';
import type { ApprovalQuestion, ApprovalSelection } from './schema.js';

export { describeQuestionLines, summarizeQuestions } from './approval-questions-format.js';

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

// 送られてきた値を文言へ混ぜない（id は混ぜる）: 本文 `other` は混ぜない
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
    // other の改行を空白に潰す: 残すと畳んだ文の中で別の設問や補足の行に見えるため
    const other = selection?.other?.trim().replace(/(?:\r\n|\r|\n)+/g, ' ');
    if (other !== undefined && other !== '') parts.push(`その他: ${other}`);
    return `${head} ${parts.length === 0 ? '未回答' : parts.join(' / ')}`;
  });
  const note = supplement?.trim();
  if (note !== undefined && note !== '') lines.push(`補足: ${note}`);
  return lines.join('\n');
}
