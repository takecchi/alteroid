import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge, Card, CardHeader } from '../../common';

/**
 * リンクを描く口（`AppSidebarRenderLink` と同じ考え方。**この層はルーターを知らない**）。
 * 画面が `Link` を置き、`className` と中身を受け取って描く。
 */
export type HomeRenderLink = (slot: { className: string; children: ReactNode }) => ReactNode;

/** カードの右上や末尾に置く、小さな文字のリンクの見た目。 */
export const HOME_LINK_CLASS = 'text-xs text-primary hover:underline';

/**
 * 「承認待ち一覧」の段。**人間が手を動かすものだけ**（承認待ち・未了の仕事）を置く。
 *
 * - `attention`（既定）—— 待っているものがあるとき。縁を `warn` にして目を引く
 * - `plain` —— 読み込み中・読めない・形が違うとき。**待っているものがあるように見せない**
 *   （読めていないのに警告色を出すと、中身の無い警告になる）
 *
 * 何も待っていないときは {@link AwaitingYouCalm}（1行に畳む。場所は空けたままにしない）。
 */
export function AwaitingYouCard({
  action,
  tone = 'attention',
  children,
}: {
  action?: ReactNode;
  tone?: 'attention' | 'plain';
  children: ReactNode;
}) {
  return (
    <Card className={cn('min-w-0', tone === 'attention' && 'border-warn/50')}>
      <CardHeader
        title="承認待ち一覧"
        subtitle="答えるまで、その仕事だけが止まる"
        action={action}
      />
      {children}
    </Card>
  );
}

/** 何も待っていないとき。1行で「無い」と言って畳む。 */
export function AwaitingYouCalm({ children }: { children?: ReactNode }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
        {children ?? '承認待ちはない'}
      </div>
    </Card>
  );
}

/**
 * 承認待ちの1行。質問は `line-clamp-2` で畳む（一覧の1行は Markdown 化の対象外。
 * `components/markdown.tsx` の doc）。**`line-clamp` の内側へブロック要素を入れない**——
 * 畳み方そのものが効かなくなる。
 */
export function AwaitingApprovalRow({
  question,
  meta,
  renderLink,
}: {
  question: ReactNode;
  meta: ReactNode;
  renderLink: HomeRenderLink;
}) {
  return (
    <li className="border-b border-border px-4 py-2.5 last:border-b-0">
      {renderLink({
        className: 'flex items-start gap-3 hover:text-primary',
        children: (
          <>
            <Badge tone="warn">承認</Badge>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-sm">{question}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{meta}</span>
            </span>
          </>
        ),
      })}
    </li>
  );
}

/** 札と説明と行き先を1行に並べる行（未了の仕事の件数など）。 */
export function AwaitingCountRow({
  label,
  children,
  action,
}: {
  label: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
      <Badge>{label}</Badge>
      <span className="min-w-0 flex-1 text-muted-foreground">{children}</span>
      {action}
    </li>
  );
}
