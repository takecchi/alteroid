import type { ReactNode } from 'react';

import { Badge, Button, Card, Textarea } from '../../common';
import { Markdown } from '../../markdown';
import { isSubmitShortcut } from '../chat/ime';
import { Timestamp } from '../timestamp';

export type ApprovalState = 'unanswered' | 'answered' | 'withdrawn';

/** 「許可」「却下」で送る文言。画面の既存の文言のまま（変えると回答の記録が変わる）。 */
export const APPROVAL_QUICK_ANSWERS = {
  allow: 'はい、進めてよい',
  deny: 'いいえ、やらないで',
} as const;

/**
 * 承認待ちの1件（クローンが人間に確かめたいこと）。
 *
 * - **クローンが書いた文字列（`question` / `context`）だけを Markdown で描く。**
 *   人間の回答（`answer`）は素のテキストのまま（自分が書いた文字が勝手に化けない
 *   ため。`chat-message.tsx` と同じ線）
 * - 状態の札は3つ: 未回答（注意）・回答済・取り下げ済。回答済みと取り下げ済みを
 *   混ぜない——前者は人間が応えた終端、後者はクローンが不要と判断した終端である
 * - 未回答のときだけ回答欄を出す。⌘/Ctrl + Enter で送る。IME の確定の Enter では
 *   送らない（`chat/ime.ts`）
 * - `jobLink` はどのマネージャーの件かへのリンク（画面が `<Link>` で渡す）
 * - `footer` は回答済みのときの経緯（画面の `TracePanel`）などを置く口
 */
export function ApprovalCard({
  state,
  createdAt,
  createdLabel,
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
}: {
  state: ApprovalState;
  createdAt: string;
  /** 「3 分前」（整形は呼ぶ側）。 */
  createdLabel: string;
  jobLink?: ReactNode;
  question: string;
  context?: string;
  answer?: string;
  /** 回答経路の説明（記録が無い古い行では渡さない）。 */
  answeredVia?: string;
  withdrawnReason?: string;
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  busy?: boolean;
  error?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge tone={state === 'withdrawn' ? 'accent' : state === 'answered' ? 'neutral' : 'warn'}>
          {state === 'withdrawn' ? '取り下げ済' : state === 'answered' ? '回答済' : '未回答'}
        </Badge>
        <Timestamp at={createdAt} label={createdLabel} />
        {jobLink !== undefined && <span className="font-mono">{jobLink}</span>}
      </div>

      <Markdown>{question}</Markdown>

      {context !== undefined && context !== '' && (
        <div className="mt-2 max-h-48 min-w-0 overflow-y-auto rounded-md border border-border bg-background p-2 text-muted-foreground">
          <Markdown>{context}</Markdown>
        </div>
      )}

      {state === 'withdrawn' ? (
        <p className="mt-3 rounded-md border border-border bg-background p-2 text-sm break-words whitespace-pre-wrap">
          <span className="mr-2 text-[11px] text-muted-foreground">取り下げた理由</span>
          {withdrawnReason ?? '（理由の記録なし）'}
        </p>
      ) : state === 'answered' ? (
        <>
          <p className="mt-3 rounded-md border border-border bg-background p-2 text-sm break-words whitespace-pre-wrap">
            <span className="mr-2 text-[11px] text-muted-foreground">回答</span>
            {answer}
          </p>
          {answeredVia !== undefined && (
            <p className="mt-1 text-[11px] text-muted-foreground">回答経路: {answeredVia}</p>
          )}
        </>
      ) : (
        <div className="mt-3">
          <Textarea
            rows={2}
            value={draft}
            placeholder="答える（書いておくと「まとめて送る」の対象になる。この場ですぐ送ってもよい）"
            onChange={(event) => onDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                if (draft.trim() !== '') onSubmit?.(draft);
              }
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={draft.trim() === ''}
              onClick={() => onSubmit?.(draft)}
            >
              回答する
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onSubmit?.(APPROVAL_QUICK_ANSWERS.allow)}
            >
              許可
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onSubmit?.(APPROVAL_QUICK_ANSWERS.deny)}
            >
              却下
            </Button>
            <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter</span>
          </div>
        </div>
      )}

      {footer}
      {error !== undefined && <div className="mt-2">{error}</div>}
    </Card>
  );
}
