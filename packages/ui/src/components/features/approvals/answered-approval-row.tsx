import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge } from '../../common';

/**
 * 回答済みの画面（日ごとの一覧）の1行。**行のどこを押しても詳細へ行ける**（行全体がリンク）。
 *
 * この層はルーターを知らないので、リンクは `renderLink` で受ける（`ListDetailItems` と同じ形）。
 * 画面は `<Link to={…} className={className}>{children}</Link>` を返す。
 *
 * - 回答済みと取り下げ済みは札の色を分ける（`ApprovalCard` と同じ: 回答済 = neutral・取り下げ済 = accent）
 * - 本文は**抜粋だけ**（問い・答え・取り下げた理由を各 2 行で切る）。全文は詳細で読む
 * - 渡す文は呼ぶ側が整形・伏せ字済みであること（この部品は文字を足さず、切るだけ）
 */
export function AnsweredApprovalRow({
  state,
  time,
  question,
  answer,
  withdrawnReason,
  renderLink,
}: {
  state: 'answered' | 'withdrawn';
  /** 決着の日時（呼ぶ側が閲覧者の端末の時間帯で整形する）。 */
  time: ReactNode;
  question: string;
  /** 回答済みの答え（無ければ出さない）。 */
  answer?: string;
  /** 取り下げた理由（無ければ「理由の記録なし」とは言わず、何も出さない。詳細が言う）。 */
  withdrawnReason?: string;
  renderLink: (props: { className: string; children: ReactNode }) => ReactNode;
}) {
  return renderLink({
    className: cn(
      'block rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors',
      'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    ),
    children: (
      <>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge tone={state === 'withdrawn' ? 'accent' : 'neutral'}>
            {state === 'withdrawn' ? '取り下げ済' : '回答済'}
          </Badge>
          <span>{time}</span>
        </span>
        <span className="mt-1 line-clamp-2 block break-words whitespace-pre-line">{question}</span>
        {state === 'answered' && answer !== undefined && (
          <span className="mt-1 line-clamp-2 block break-words whitespace-pre-line text-xs text-muted-foreground">
            <span className="mr-1">答え</span>
            {answer}
          </span>
        )}
        {state === 'withdrawn' && withdrawnReason !== undefined && (
          <span className="mt-1 line-clamp-2 block break-words whitespace-pre-line text-xs text-muted-foreground">
            <span className="mr-1">取り下げた理由</span>
            {withdrawnReason}
          </span>
        )}
      </>
    ),
  });
}
