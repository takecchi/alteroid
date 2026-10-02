import { useId, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useDisplayText } from '@/lib/display-text';

import { Badge, Button, Input, Textarea } from '../../common';

/** 設問の選択肢（API の `ApprovalOption` と同じ形。ui は logic を import しないので構造だけ持つ）。 */
export interface ApprovalOptionView {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** 設問（API の `ApprovalQuestion` と同じ形）。 */
export interface ApprovalQuestionView {
  id: string;
  prompt: string;
  options: ApprovalOptionView[];
  /** 既定 false（単一選択）。 */
  multiple?: boolean;
  /** 既定 true（その他の自由入力を出す）。 */
  allowOther?: boolean;
}

/** 設問ごとの回答（API の `ApprovalSelection` と同じ形）。 */
export interface ApprovalSelectionView {
  questionId: string;
  optionIds: string[];
  other?: string;
}

/** 「回答」で送るもの。`supplement` は補足の自由文（無ければ undefined）。 */
export interface ApprovalQuestionsAnswer {
  selections: ApprovalSelectionView[];
  supplement?: string;
}

/** 設問1つぶんの入力の状態。 */
interface DraftOf {
  /** 選んだ選択肢の id（単一選択では高々1つ）。 */
  chosen: string[];
  /** 「その他」の文。 */
  other: string;
  /** 単一選択だけ使う: 「その他」のラジオを選んでいるか（選択肢と排他）。 */
  otherOn: boolean;
}

const EMPTY: DraftOf = { chosen: [], other: '', otherOn: false };
/** 単一選択の RadioGroup で「その他」を表す値。選択肢の id と衝突しない（空白を含む）。 */
const OTHER_VALUE = ' other ';

/**
 * 入力の状態から、送る回答を作る。**空の設問は出さない**（未回答の設問があっても送れる。
 * 畳むときにサーバが「未回答」と書く）。単一選択で「その他」を選んでいれば `other` だけ送る。
 */
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

/**
 * 承認待ちの設問を、選択肢を押して答えるフォーム（issue #2525）。
 *
 * - 単一選択はラジオ、複数選択はチェック。推奨には印（［推奨］）、`description` は選択肢の下に添える
 * - 各設問の最後に「その他」の自由入力（`allowOther !== false` のとき）。**単一選択では「その他」も
 *   ラジオの1つ**で、選択肢と排他にする（1つの設問に答えが2つあるように読めるのを避ける。
 *   入力欄へ書き始めると「その他」が選ばれ、選択肢を押すと外れる）。複数選択では、選択肢とは別に
 *   書ける（API は選択肢1つ＋other も受けるが、排他は画面の側の選択である）
 * - 補足の自由文欄は常に出す。最後の「回答」で一括送信する
 * - **何も選ばず、その他も補足も空なら「回答」は押せない。** 未回答の設問が残っていても送れる
 */
export function ApprovalQuestionsForm({
  questions,
  busy = false,
  onSubmit,
}: {
  questions: readonly ApprovalQuestionView[];
  busy?: boolean;
  onSubmit: (answer: ApprovalQuestionsAnswer) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, DraftOf>>({});
  const [supplement, setSupplement] = useState('');
  const supplementId = useId();

  function update(id: string, patch: (current: DraftOf) => DraftOf): void {
    setDrafts((current) => ({ ...current, [id]: patch(current[id] ?? EMPTY) }));
  }

  const answer = buildApprovalAnswer(questions, drafts, supplement);
  const empty = answer.selections.length === 0 && answer.supplement === undefined;

  return (
    <form
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
          onChange={(event) => setSupplement(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" type="submit" loading={busy} disabled={empty}>
          回答
        </Button>
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

  const otherInput = (
    <Input
      id={otherId}
      aria-label={otherLabel}
      placeholder="その他（自由に書く）"
      value={draft.other}
      disabled={disabled}
      onChange={(event) => {
        const text = event.target.value;
        // 単一選択: 書き始めたら「その他」を選んだことにする（選択肢とは排他）。
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
              <div className="min-w-0 flex-1">{otherInput}</div>
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
          onClick={() => onChange(() => EMPTY)}
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
