import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';

import { Badge, Button, Card, SubmitHint, Textarea } from '../../common';
import { Markdown } from '../../markdown';
import { Timestamp } from '../timestamp';
import {
  ApprovalQuestionsForm,
  type ApprovalQuestionView,
  type ApprovalQuestionsAnswer,
  type ApprovalQuestionsDraft,
} from './approval-questions';

function questionHead(question: string): string {
  const text = (question.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

export type ApprovalState = 'unanswered' | 'answered' | 'withdrawn';

// 文言を変えない: 回答の記録が変わるため
export const APPROVAL_QUICK_ANSWERS = {
  allow: 'はい、進めてよい',
  deny: 'いいえ、やらないで',
} as const;

// 設問つきの未回答に許可・却下の定型文を出さない: 複数の設問への「はい」は意味を持たないため
export function ApprovalCard({
  state,
  createdAt,
  createdLabel,
  time,
  jobLink,
  question,
  context,
  answer,
  answeredVia,
  withdrawnReason,
  draft = '',
  onDraftChange,
  onSubmit,
  busy = false,
  error,
  footer,
  trailing,
  questions,
  questionsSummary,
  onSubmitQuestions,
  questionsDraft,
  onQuestionsDraftChange,
}: {
  state: ApprovalState;
  createdAt?: string;
  createdLabel?: string;
  time?: ReactNode;
  jobLink?: ReactNode;
  question: string;
  context?: string;
  answer?: string;
  answeredVia?: string;
  withdrawnReason?: string;
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  busy?: boolean;
  error?: ReactNode;
  footer?: ReactNode;
  trailing?: ReactNode;
  questions?: readonly ApprovalQuestionView[];
  // 要約の文言は呼ぶ側が作る: ui は logic も core も import しないため
  questionsSummary?: string;
  onSubmitQuestions?: (answer: ApprovalQuestionsAnswer) => void;
  questionsDraft?: ApprovalQuestionsDraft;
  onQuestionsDraftChange?: (draft: ApprovalQuestionsDraft) => void;
}) {
  const { body } = useDisplayText();
  const questionId = useId();
  const [questionsOpen, setQuestionsOpen] = useState(
    () =>
      questionsDraft !== undefined &&
      (questionsDraft.supplement !== '' || Object.keys(questionsDraft.drafts).length > 0),
  );
  const hasQuestions = questions !== undefined && questions.length > 0;
  return (
    <Card className="p-4">
      {/* `flex-wrap` を外さない: `job {jobId}` は長さの上限が無く、他のバッジ・時刻表示を押し出すため */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge
          // 取り下げ済みを回答済みと別のトーンにする: 混同すると「答えたのに何も起きていない」ように見えるため
          tone={state === 'withdrawn' ? 'accent' : state === 'answered' ? 'neutral' : 'warn'}
        >
          {state === 'withdrawn' ? '取り下げ済' : state === 'answered' ? '回答済' : '未回答'}
        </Badge>
        {time !== undefined ? (
          time
        ) : createdAt !== undefined ? (
          <Timestamp at={createdAt} label={createdLabel} />
        ) : null}
        {jobLink !== undefined && <span className="font-mono">{jobLink}</span>}
      </div>

      <div id={questionId}>
        <Markdown headingOffset={2}>{body(question)}</Markdown>
      </div>

      {context !== undefined && context !== '' && (
        // スクロールの箱（`max-h-48 overflow-y-auto`）を外さない: 長い背景が回答欄を画面外へ押し出すため
        <div className="mt-2 max-h-48 min-w-0 overflow-y-auto rounded-md border border-border bg-background p-2 text-muted-foreground">
          <Markdown headingOffset={2}>{body(context)}</Markdown>
        </div>
      )}

      {state === 'withdrawn' ? (
        <p className="mt-3 rounded-md border border-border bg-background p-2 text-sm break-words whitespace-pre-wrap">
          <span className="mr-2 text-[11px] text-muted-foreground">取り下げた理由</span>
          {withdrawnReason === undefined ? '（理由の記録なし）' : body(withdrawnReason)}
        </p>
      ) : state === 'answered' ? (
        // `answer` を Markdown にしない: 人間が打った文字が勝手に化けないため
        <>
          <p className="mt-3 rounded-md border border-border bg-background p-2 text-sm break-words whitespace-pre-wrap">
            <span className="mr-2 text-[11px] text-muted-foreground">回答</span>
            {answer === undefined ? undefined : body(answer)}
          </p>
          {answeredVia !== undefined && (
            <p className="mt-1 text-[11px] text-muted-foreground">回答経路: {answeredVia}</p>
          )}
        </>
      ) : hasQuestions ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {questionsSummary === undefined ? undefined : body(questionsSummary)}
            </span>
            <Button
              size="sm"
              aria-expanded={questionsOpen}
              aria-describedby={questionId}
              onClick={() => setQuestionsOpen((open) => !open)}
            >
              {questionsOpen ? '閉じる' : '選択肢を開いて答える'}
            </Button>
          </div>
          {/* unmount せず隠す: 閉じても入力を捨てないため */}
          <div hidden={!questionsOpen}>
            <ApprovalQuestionsForm
              questions={questions}
              describedBy={questionId}
              busy={busy}
              onSubmit={(answer) => onSubmitQuestions?.(answer)}
              {...(questionsDraft === undefined || onQuestionsDraftChange === undefined
                ? {}
                : { draft: questionsDraft, onDraftChange: onQuestionsDraftChange })}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Textarea
            rows={2}
            value={draft}
            aria-label={`「${questionHead(body(question))}」への回答`}
            aria-describedby={questionId}
            placeholder="答える（書いておくと「まとめて送る」の対象になる。この場ですぐ送ってもよい）"
            onChange={(event) => onDraftChange?.(event.target.value)}
            maxHeight="12rem"
            // Enter は改行のまま: 長文になりうるため
            onSubmitShortcut={() => onSubmit?.(draft)}
            submitDisabled={draft.trim() === '' || busy}
          />
          {/* `flex-wrap` を外さない: ボタン3つとショートカット表示が折り返さないと画面外へ出るため */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              aria-describedby={questionId}
              disabled={draft.trim() === '' || busy}
              onClick={() => onSubmit?.(draft)}
            >
              回答する
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-describedby={questionId}
              onClick={() => onSubmit?.(APPROVAL_QUICK_ANSWERS.allow)}
            >
              許可
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-describedby={questionId}
              onClick={() => onSubmit?.(APPROVAL_QUICK_ANSWERS.deny)}
            >
              却下
            </Button>
            <SubmitHint action="回答" />
          </div>
        </div>
      )}

      {footer}
      {error !== undefined && <div className="mt-2">{error}</div>}
      {trailing}
    </Card>
  );
}
