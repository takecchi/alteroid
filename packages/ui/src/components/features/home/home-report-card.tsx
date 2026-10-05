import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

import { Card } from '../../common';

/**
 * ホームの「最新の日報」。**小さなカードの1枚ではなく、全幅の独立した枠**（日報はホームの主役の
 * ひとつ。人間が最初に読むものなので、抜粋ではなく Markdown で本文を読ませる）。
 *
 * - 本文（`children`。呼び出し側が `Markdown` で描く）は **最大 {@link HOME_REPORT_MAX_HEIGHT}
 *   で切り**、切った下端は薄れさせる。長い日報でもホームが縦に伸びきらない。**切れているときだけ**
 *   本文の下に「全文を表示」ボタンを出し、押すとその場で全文へ広げる（`aria-expanded`。日報の
 *   ページへは移らない。「畳む」で元の高さへ戻る）。短くて切れていない日報には、フェードも
 *   ボタンも出さない（#2771）
 * - 広げるのは全幅の枠の高さだけで、並びは縦積みなので、下のカードは押し下がるだけで引き伸ばされない
 * - 文字は本文の標準より一段大きい（`text-base`）。日報は流し読みでなく読むもの
 * - `min-w-0` を枠にも本文にも置く（#295。広い表や長い行がある日報で、親の grid を押し広げない）
 */
export const HOME_REPORT_MAX_HEIGHT = '24rem';

export function HomeReportCard({
  icon: Icon,
  title,
  meta,
  action,
  footer,
  children,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  /** 見出しの隣の小さな字（日付など）。 */
  meta?: ReactNode;
  /** 右上の行き先。 */
  action?: ReactNode;
  /** 本文の下の行（常に出す行き先など）。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // 描くたびに測る（本文が差し替わる・読み込み後に伸びる）。値が同じなら state は動かない。
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    // 広げている間は枠が頭打ちでなく、はみ出しは測れない（ボタンは広げた間も残す）。
    const measure = () => {
      if (!expanded) setTruncated(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    // 幅の変化（折り返しの増減）・画像の読み込みで本文の高さが変わっても追う。
    // 枠自身は max-h で頭打ちなので、中身の側（子）を見る。
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [children, expanded]);

  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
        {meta !== undefined && <span className="shrink-0">{meta}</span>}
        <span className="flex-1" />
        {action}
      </div>
      <div className="relative min-w-0 px-4 pt-3 pb-2">
        <div
          ref={bodyRef}
          id={bodyId}
          data-slot="home-report-body"
          data-truncated={truncated ? 'true' : 'false'}
          className={`min-w-0 leading-relaxed [&>div]:text-base ${expanded ? '' : 'max-h-96 overflow-hidden'}`}
        >
          {children}
        </div>
        {truncated && !expanded && (
          <div
            aria-hidden
            data-slot="home-report-fade"
            className="pointer-events-none absolute inset-x-0 bottom-2 h-12"
            style={{ backgroundImage: 'linear-gradient(to top, var(--card), transparent)' }}
          />
        )}
      </div>
      {(truncated || expanded) && (
        <div className="px-4 pb-3 text-xs">
          <button
            type="button"
            data-slot="home-report-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
            className="rounded-sm text-primary hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {expanded ? '畳む' : '全文を表示'}
          </button>
        </div>
      )}
      {footer !== undefined && <div className="px-4 pb-3 text-xs">{footer}</div>}
    </Card>
  );
}
