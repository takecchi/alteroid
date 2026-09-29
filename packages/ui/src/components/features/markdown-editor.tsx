import { Columns2, Eye, PenLine } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';

import { TAB_TRIGGER_ACTIVE_CLASS, TAB_TRIGGER_CLASS, Textarea } from '../common';
import { Markdown } from '../markdown';

export type MarkdownEditorMode = 'edit' | 'preview' | 'split';

/**
 * Markdown を書く欄（編集 | プレビュー）。**編集できる Markdown はすべてこれで書く**
 * （記憶・やり方・実行環境プロファイルの説明など）。
 *
 * 画面（`apps/web/app/routes/memory-detail.tsx` / `practice-detail.tsx`）が別々に
 * 持っていた作法をここへ寄せた:
 *
 * - **既定のタブは中身で決める**: 中身があればプレビュー、空なら編集。空のプレビューを
 *   既定で開くと真っ白な画面になる
 * - **書きかけ（`value`）は呼ぶ側が持つ**（この部品は写さない）。タブを行き来しても、
 *   取得し直しが走っても書きかけは消えない
 * - プレビューが映すのは保存前の `value` そのもの（本文を書き換えない）
 * - ⌘ / Ctrl + S で `onSave`（渡したときだけ）
 *
 * 足したもの:
 *
 * - **並べて**（広い画面だけ）: 左に編集、右にプレビュー。狭い画面では出さず、
 *   並べてを選んでいたら編集へ倒す（幅 375px で2列にすると両方読めない）
 * - プレビューが空なら「まだ何も書いていない」と言う（真っ白にしない）
 *
 * 開いているタブは `mode` / `onModeChange` で呼ぶ側が持ってもよい（持たなければ
 * 中で持つ）。
 */
export function MarkdownEditor({
  value,
  onChange,
  onSave,
  mode: controlledMode,
  defaultMode,
  onModeChange,
  hint,
  placeholder = 'Markdown で書く',
  emptyPreview = 'まだ何も書いていない。「編集」で書く。',
  minHeight = '60vh',
  label = '本文',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  mode?: MarkdownEditorMode;
  /** 最初に開くタブ（渡さなければ中身で決める）。 */
  defaultMode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  /** 編集欄の上に出す一文（「ここで書き換えたものは日誌に残る」など）。 */
  hint?: ReactNode;
  placeholder?: string;
  emptyPreview?: ReactNode;
  /** 編集欄とプレビューの最低の高さ（CSS の長さ）。 */
  minHeight?: string;
  /** 編集欄の読み上げの名前。 */
  label?: string;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const [innerMode, setInnerMode] = useState<MarkdownEditorMode | undefined>(undefined);
  const chosen =
    controlledMode ?? innerMode ?? defaultMode ?? (value.trim() === '' ? 'edit' : 'preview');
  const mode: MarkdownEditorMode = isMobile && chosen === 'split' ? 'edit' : chosen;

  const setMode = (next: string) => {
    const typed = next as MarkdownEditorMode;
    if (controlledMode === undefined) setInnerMode(typed);
    onModeChange?.(typed);
  };

  const editor = (
    <Textarea
      aria-label={label}
      className="flex-1 font-mono text-xs leading-relaxed"
      style={{ minHeight }}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (onSave !== undefined && (event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault();
          onSave();
        }
      }}
    />
  );

  const preview = (
    <div
      className="min-w-0 flex-1 overflow-y-auto rounded-md border border-dashed border-border p-4"
      style={{ minHeight }}
    >
      {value.trim() === '' ? (
        <p className="text-sm text-muted-foreground">{emptyPreview}</p>
      ) : (
        <Markdown>{value}</Markdown>
      )}
    </div>
  );

  const trigger = (value: MarkdownEditorMode, icon: ReactNode, text: string) => (
    <Tabs.Trigger
      value={value}
      className={cn(
        TAB_TRIGGER_CLASS,
        'inline-flex items-center gap-1.5',
        mode === value && TAB_TRIGGER_ACTIVE_CLASS,
      )}
    >
      {icon}
      {text}
    </Tabs.Trigger>
  );

  return (
    <Tabs.Root
      value={mode}
      onValueChange={setMode}
      className={cn('flex flex-1 flex-col', className)}
    >
      <Tabs.List className="mb-2 flex shrink-0 items-center gap-1 border-b border-border">
        {trigger('edit', <PenLine className="size-3.5" aria-hidden />, '編集')}
        {trigger('preview', <Eye className="size-3.5" aria-hidden />, 'プレビュー')}
        {!isMobile && trigger('split', <Columns2 className="size-3.5" aria-hidden />, '並べて')}
        {onSave !== undefined && mode !== 'preview' && (
          <span className="ml-auto pb-1.5 text-[11px] text-muted-foreground">
            ⌘/Ctrl + S で保存
          </span>
        )}
      </Tabs.List>

      {hint !== undefined && mode !== 'preview' && (
        <p className="mb-2 shrink-0 text-xs text-muted-foreground">{hint}</p>
      )}

      <Tabs.Content value="edit" className="flex min-h-0 flex-1 flex-col">
        {editor}
      </Tabs.Content>
      <Tabs.Content value="preview" className="flex min-h-0 flex-1 flex-col">
        {preview}
      </Tabs.Content>
      <Tabs.Content value="split" className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col">{editor}</div>
        <div className="flex min-w-0 flex-col">{preview}</div>
      </Tabs.Content>
    </Tabs.Root>
  );
}
