// `schema.ts` を引かない: zod を実行時に持ち込まない軽い口にするため
interface ApprovalOptionLike {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly recommended?: boolean | undefined;
}

export interface ApprovalQuestionLike {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly ApprovalOptionLike[];
  readonly multiple?: boolean | undefined;
  readonly allowOther?: boolean | undefined;
}

export function optionMarker(index: number): string {
  return index < 26 ? `(${String.fromCharCode(97 + index)})` : `(${index + 1})`;
}

export function describeQuestionLines(questions: readonly ApprovalQuestionLike[]): string[] {
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

export function summarizeQuestions(questions: readonly ApprovalQuestionLike[]): string {
  const multiple = questions.filter((question) => question.multiple === true).length;
  return (
    `設問 ${questions.length} 件` +
    (multiple === 0 ? '' : `（うち複数選択 ${multiple}）`) +
    '（選択肢つき）'
  );
}
