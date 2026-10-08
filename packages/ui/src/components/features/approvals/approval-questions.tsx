import { useId, useRef, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useDisplayText } from '@/lib/display-text';

import { Badge, Button, FieldHint, Input, SubmitHint, Textarea } from '../../common';

// API の型を import せず構造だけ持つ: ui は logic を import しないため
export interface ApprovalOptionView {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ApprovalQuestionView {
  id: string;
  prompt: string;
  options: ApprovalOptionView[];
  multiple?: boolean;
  allowOther?: boolean;
}

export interface ApprovalSelectionView {
  questionId: string;
  optionIds: string[];
  other?: string;
}

export interface ApprovalQuestionsAnswer {
  selections: ApprovalSelectionView[];
  supplement?: string;
}

interface DraftOf {
  chosen: string[];
  other: string;
  otherOn: boolean;
}

export type ApprovalQuestionDraft = DraftOf;

export interface ApprovalQuestionsDraft {
  drafts: Readonly<Record<string, DraftOf>>;
  supplement: string;
}

export const EMPTY_QUESTIONS_DRAFT: ApprovalQuestionsDraft = { drafts: {}, supplement: '' };

const EMPTY: DraftOf = { chosen: [], other: '', otherOn: false };
// 空白を含める: 選択肢の id と衝突しない値にするため
const OTHER_VALUE = ' other ';

export function buildApprovalAnswer(
  questions: readonly ApprovalQuestionView[],
  drafts: Readonly<Record<string, DraftOf>>,
  supplement: string,
): ApprovalQuestionsAnswer {
  const selections: ApprovalSelectionView[] = [];
  for (const question of questions) {
    const draft = drafts[question.id] ?? EMPTY;
    const single = question.multiple !== true;
    const allowOther = question.allowOther !== false;
    const optionIds = draft.chosen.filter((id) => question.options.some((o) => o.id === id));
    const other = allowOther && (!single || draft.otherOn) ? draft.other.trim() : '';
    const ids = single && draft.otherOn ? [] : single ? optionIds.slice(0, 1) : optionIds;
    if (ids.length === 0 && other === '') continue;
    selections.push({
      questionId: question.id,
      optionIds: ids,
      ...(other === '' ? {} : { other }),
    });
  }
  const note = supplement.trim();
  return { selections, ...(note === '' ? {} : { supplement: note }) };
}

// 単一選択では「その他」もラジオの1つにして選択肢と排他にする: 1つの設問に答えが2つあるように読めるのを避けるため
export function ApprovalQuestionsForm({
  questions,
  busy = false,
  onSubmit,
  draft,
  onDraftChange,
  describedBy,
}: {
  questions: readonly ApprovalQuestionView[];
  describedBy?: string;
  busy?: boolean;
  onSubmit: (answer: ApprovalQuestionsAnswer) => void;
  draft?: ApprovalQuestionsDraft;
  onDraftChange?: (draft: ApprovalQuestionsDraft) => void;
}) {
  const [ownDraft, setOwnDraft] = useState<ApprovalQuestionsDraft>(EMPTY_QUESTIONS_DRAFT);
  const current = draft ?? ownDraft;
  const drafts = current.drafts;
  const supplement = current.supplement;
  const supplementId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const change = (next: ApprovalQuestionsDraft) => {
    if (onDraftChange !== undefined) onDraftChange(next);
    else setOwnDraft(next);
  };

  function update(id: string, patch: (current: DraftOf) => DraftOf): void {
    const base = current;
    change({ ...base, drafts: { ...base.drafts, [id]: patch(base.drafts[id] ?? EMPTY) } });
  }

  const answer = buildApprovalAnswer(questions, drafts, supplement);
  const empty = answer.selections.length === 0 && answer.supplement === undefined;

  return (
    <form
      ref={formRef}
      className="mt-3 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty && !busy) onSubmit(answer);
      }}
    >
      {questions.map((question, index) => (
        <QuestionField
          key={question.id}
          index={index}
          question={question}
          draft={drafts[question.id] ?? EMPTY}
          onChange={(patch) => update(question.id, patch)}
          disabled={busy}
        />
      ))}
      <div>
        <label htmlFor={supplementId} className="mb-1 block text-[11px] text-muted-foreground">
          補足（自由に書ける。選択肢だけでもよい）
        </label>
        <Textarea
          id={supplementId}
          rows={2}
          value={supplement}
          disabled={busy}
          maxHeight="10rem"
          aria-describedby={describedBy}
          onSubmitShortcut={() => formRef.current?.requestSubmit()}
          submitDisabled={empty || busy}
          refocusAfterSubmit
          onChange={(event) => change({ ...current, supplement: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          type="submit"
          loading={busy}
          disabled={empty}
          aria-describedby={describedBy}
        >
          回答
        </Button>
        <SubmitHint action="回答" />
        {empty && (
          <span className="text-[11px] text-muted-foreground">
            選ぶか書くかしてから送る（答えない設問があってもよい）
          </span>
        )}
      </div>
    </form>
  );
}

function QuestionField({
  index,
  question,
  draft,
  onChange,
  disabled,
}: {
  index: number;
  question: ApprovalQuestionView;
  draft: DraftOf;
  onChange: (patch: (current: DraftOf) => DraftOf) => void;
  disabled: boolean;
}) {
  const { body } = useDisplayText();
  const baseId = useId();
  const single = question.multiple !== true;
  const allowOther = question.allowOther !== false;
  const legendId = `${baseId}-legend`;
  const otherId = `${baseId}-other`;
  const otherLabel = `設問 ${index + 1} のその他`;
  const otherNoteId = `${baseId}-other-note`;
  // 選択肢を選んでも書いた文字は消さない（黙って失わない）。代わりに、送られないことを見た目と文で示す。
  const otherPickedEmpty = single && draft.otherOn && draft.other.trim() === '';
  const otherWrittenNotSent = single && !draft.otherOn && draft.other.trim() !== '';
  const otherNote = otherPickedEmpty
    ? 'その他を選んだが、まだ書いていない'
    : otherWrittenNotSent
      ? 'その他は選ばれていないので、この文字は送られない'
      : undefined;

  const otherInput = (
    <Input
      id={otherId}
      aria-label={otherLabel}
      aria-describedby={otherNote === undefined ? undefined : otherNoteId}
      className={otherWrittenNotSent ? 'opacity-60' : undefined}
      placeholder="その他（自由に書く）"
      value={draft.other}
      disabled={disabled}
      onChange={(event) => {
        const text = event.target.value;
        onChange((current) =>
          single
            ? {
                chosen: text === '' && !current.otherOn ? current.chosen : [],
                other: text,
                otherOn: text !== '' || current.otherOn,
              }
            : { ...current, other: text },
        );
      }}
    />
  );

  const hasAnswer = draft.chosen.length > 0 || draft.otherOn || draft.other !== '';

  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend id={legendId} className="mb-2 text-sm font-medium break-words">
        <span className="mr-1 text-muted-foreground">Q{index + 1}</span>
        {body(question.prompt)}
        <Badge tone="neutral" className="ml-2 align-middle">
          {single ? '1つ選ぶ' : '複数選べる'}
        </Badge>
      </legend>

      {single ? (
        <RadioGroup
          aria-labelledby={legendId}
          value={draft.otherOn ? OTHER_VALUE : (draft.chosen[0] ?? '')}
          disabled={disabled}
          onValueChange={(value) =>
            onChange((current) =>
              value === OTHER_VALUE
                ? { ...current, chosen: [], otherOn: true }
                : { ...current, chosen: [value], otherOn: false },
            )
          }
        >
          {question.options.map((option) => {
            const id = `${baseId}-o-${option.id}`;
            return (
              <div key={option.id} className="flex items-start gap-2">
                <RadioGroupItem id={id} value={option.id} className="mt-0.5" />
                <OptionLabel htmlFor={id} option={option} />
              </div>
            );
          })}
          {allowOther && (
            <div className="flex items-center gap-2">
              <RadioGroupItem
                id={`${baseId}-other-radio`}
                value={OTHER_VALUE}
                aria-label={`${otherLabel}を選ぶ`}
              />
              <div className="min-w-0 flex-1">
                {otherInput}
                {otherNote !== undefined && (
                  <FieldHint
                    id={otherNoteId}
                    className={otherPickedEmpty ? 'text-warn' : undefined}
                  >
                    {otherNote}
                  </FieldHint>
                )}
              </div>
            </div>
          )}
        </RadioGroup>
      ) : (
        <div role="group" aria-labelledby={legendId} className="flex flex-col gap-2">
          {question.options.map((option) => {
            const id = `${baseId}-o-${option.id}`;
            return (
              <div key={option.id} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  disabled={disabled}
                  checked={draft.chosen.includes(option.id)}
                  onCheckedChange={(checked) =>
                    onChange((current) => ({
                      ...current,
                      chosen:
                        checked === true
                          ? [...current.chosen.filter((c) => c !== option.id), option.id]
                          : current.chosen.filter((c) => c !== option.id),
                    }))
                  }
                />
                <OptionLabel htmlFor={id} option={option} />
              </div>
            );
          })}
          {allowOther && otherInput}
        </div>
      )}

      {single && hasAnswer && (
        <Button
          size="sm"
          className="mt-1"
          disabled={disabled}
          aria-label={`設問 ${index + 1} の選択を外す`}
          onClick={() => {
            onChange(() => EMPTY);
            // 押したボタンはこの再描画で消える。フォーカスを移さないと body へ落ちる。disabled で残す形は採らない: 無効のボタンにフォーカスが残るため
            const first = question.options[0];
            const targetId = first === undefined ? otherId : `${baseId}-o-${first.id}`;
            document.getElementById(targetId)?.focus();
          }}
        >
          選択を外す
        </Button>
      )}
    </fieldset>
  );
}

function OptionLabel({ htmlFor, option }: { htmlFor: string; option: ApprovalOptionView }) {
  const { body } = useDisplayText();
  return (
    <label htmlFor={htmlFor} className="min-w-0 cursor-pointer text-sm break-words">
      {body(option.label)}
      {option.recommended === true && (
        <Badge tone="ok" className="ml-2 align-middle">
          推奨
        </Badge>
      )}
      {option.description !== undefined && option.description !== '' && (
        <span className="block text-[11px] text-muted-foreground">{body(option.description)}</span>
      )}
    </label>
  );
}
