/**
 * 承認待ちの設問を人間・クローンが読む行にする、**実行時の import を1つも持たない**軽い口
 * （issue #2558。`@alteroid/core/approval-questions-format`）。
 *
 * もとは `approval-choices.ts` に在った（文言・ロジックは1文字も変えていない。`approval-choices.ts` は
 * ここから再 export する）。CLI・道具（`tools.ts`）・Web（`@alteroid/logic` 経由）が同じ定義を読む
 * （`journal-diagnostics-format.ts` と同じ形）。引数の型は、API の `ApprovalQuestion` が満たす
 * 構造だけを書いた最小の型にして、`schema.ts`（zod）を引かない。
 */

interface ApprovalOptionLike {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly recommended?: boolean | undefined;
}

/** `ApprovalQuestion`（`schema.ts`）が構造的に満たす、この口が読む形。 */
export interface ApprovalQuestionLike {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly ApprovalOptionLike[];
  readonly multiple?: boolean | undefined;
  readonly allowOther?: boolean | undefined;
}

/** `(a)` `(b)` … `(z)`、27 番目以降は `(27)` と数字にする。 */
export function optionMarker(index: number): string {
  return index < 26 ? `(${String.fromCharCode(97 + index)})` : `(${index + 1})`;
}

/**
 * 設問と選択肢を人間・クローンが読む行にする（`approvals_list id=…` の詳細と CLI の詳細が
 * 通る。一覧には使わない——一覧は件数だけを出す: {@link summarizeQuestions}）。
 * 推奨の印・単一か複数か・その他を書けるか・答えるときの id を全部出す。
 */
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

/** 一覧に出す1行ぶんの要約（件数と、単一・複数の内訳だけ。本文は出さない）。 */
export function summarizeQuestions(questions: readonly ApprovalQuestionLike[]): string {
  const multiple = questions.filter((question) => question.multiple === true).length;
  return (
    `設問 ${questions.length} 件` +
    (multiple === 0 ? '' : `（うち複数選択 ${multiple}）`) +
    '（選択肢つき）'
  );
}
