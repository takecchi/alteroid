import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Badge } from '../../common';
import { CodeBlock } from '../code-block';
import { Timestamp } from '../timestamp';

export type JournalEntryTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

/**
 * 日誌の1件（日誌の画面・ダッシュボードの「最近の動き」）。
 *
 * 閉じているときは1行（時刻・種別・要旨・どれだけ前か）。押すと開いて、
 * **行が指している実体へのリンク**（`links`）と**生の中身**（`raw` の JSON）を出す。
 * 要約で止めず、掘れば生の中身まで降りられること（PRD 可観測性）。
 *
 * - 要旨は広い幅では1行で切り（`truncate`）、スマホ幅では2段目で3行まで折り返す。**一覧の1行は Markdown にしない**
 *   （`markdown.tsx` の doc）
 * - 種別の札の色（`tone`）は画面が決める（種別ごとの重さは画面側の知識）
 * - 開閉は矢印・日時・種別の `<button>`（要旨は外に置き、選択・コピーできる）。リンクは開いた後の領域に置く（ボタンの中にリンクを
 *   入れない）
 * - **省略可能な口（既定の振る舞いは変えない）。** 画面が今の表示をそのまま出せるように
 *   足した: `time`（右端の「どれだけ前か」の位置に差し込む。渡すと `Timestamp` は出ない。
 *   `Timestamp` は焦点を受ける `<time>` を持つので、Tab の停止点が
 *   増える）・`rawBar`（`false` で生の中身の上の帯——種別の名前と「写す」ボタン——を
 *   出さない）
 */
export function JournalEntryRow({
  at,
  atLabel,
  relativeLabel,
  time,
  type,
  tone = 'neutral',
  summary,
  links,
  raw,
  isLast = false,
  defaultOpen = false,
  rawBar = true,
}: {
  /** `time` を渡すときは要らない（渡しても使わない）。 */
  at?: string;
  /** 行頭の時刻の表示（整形は呼ぶ側。`formatDateTime`）。 */
  atLabel: string;
  /** 右端の「3 分前」（整形は呼ぶ側。`formatRelative`）。`time` を渡すときは要らない。 */
  relativeLabel?: string;
  /** 右端に差し込むもの。渡すと `Timestamp`（相対の表示と JST/UTC の tooltip）の代わりに出る。 */
  time?: ReactNode;
  type: string;
  tone?: JournalEntryTone;
  summary: string;
  links?: ReactNode;
  /** 開いたときに JSON で出す生の中身。 */
  raw: unknown;
  isLast?: boolean;
  defaultOpen?: boolean;
  /**
   * 既定は `true`。`false` にすると生の中身の上の帯（`type` の名前と「写す」ボタン）を
   * 出さない。種別は行の頭に既に出ているので、同じ名前が2箇所に出るのを避けたい画面と、
   * 写す操作を持たない画面のための口。
   */
  rawBar?: boolean;
}) {
  const { body } = useDisplayText();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn('px-4 py-2', !isLast && 'border-b border-border')}>
      {/*
        **開閉の `<button>` は矢印・日時・種別だけ。** 要旨は button の外に置く
        （Chromium は button の中の文字をドラッグ選択できない。issue #2756）。
        スマホ幅では 1 段目＝矢印・日時・種別・どれだけ前か、2 段目＝要旨（3 行まで折り返す。
        issue #2775）。`sm` 以上は 1 行（要旨は `truncate`）。
      */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1 sm:flex-nowrap">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex shrink-0 items-start gap-3 rounded-sm text-left"
        >
          <ChevronRight
            className={cn(
              'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">
            {atLabel}
          </span>
          <Badge tone={tone}>{type}</Badge>
        </button>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground sm:order-3 sm:ml-0">
          {time !== undefined ? (
            time
          ) : at !== undefined ? (
            <Timestamp at={at} label={relativeLabel} />
          ) : null}
        </span>
        {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
        <span
          data-testid="journal-row-summary"
          className="line-clamp-3 w-full min-w-0 break-words pl-[1.625rem] text-sm text-muted-foreground sm:order-2 sm:w-auto sm:flex-1 sm:truncate sm:pl-0"
        >
          {body(summary)}
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-2 pl-6">
          {/*
            **行が指している実体の詳細へつなぐ（issue #2064）。** 要旨は選択できるよう button の外にあり、
            リンクは要旨の中ではなく開いた後の領域に置く
            （どれをつなぐかは `journalEntryLinks` の doc）。
          */}
          {links}
          {/* 掘れば生の中身まで降りられること（PRD 可観測性）。要約で止めない。 */}
          <CodeBlock label={rawBar ? type : undefined} copyable={rawBar} maxHeight="24rem">
            {body(JSON.stringify(raw, null, 2))}
          </CodeBlock>
        </div>
      )}
    </div>
  );
}
