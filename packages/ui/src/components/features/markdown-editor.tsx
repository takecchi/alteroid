import { Columns2, Eye, PenLine } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { Fragment, useState, type ReactNode } from 'react';

import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';

import { TAB_TRIGGER_ACTIVE_CLASS, TAB_TRIGGER_CLASS, SubmitHint, Textarea } from '../common';
import { Markdown } from '../markdown';

export type MarkdownEditorMode = 'edit' | 'preview' | 'split';

const DEFAULT_MODES: readonly MarkdownEditorMode[] = ['edit', 'preview', 'split'];
const SAVE_HINT = '⌘/Ctrl + S で保存';

// 既定のタブは中身で決める: 空のプレビューを既定で開くと真っ白な画面になるため
// 書きかけ（`value`）は呼ぶ側が持つ: タブを行き来しても、取得し直しが走っても書きかけを消さないため
export function MarkdownEditor({
  value,
  onChange,
  onSave,
  saveDisabled = false,
  mode: controlledMode,
  defaultMode,
  onModeChange,
  modes = DEFAULT_MODES,
  hint,
  saveHint = SAVE_HINT,
  placeholder = 'Markdown で書く',
  emptyPreview = 'まだ何も書いていない。「編集」で書く。',
  minHeight = '60vh',
  label = '本文',
  className,
  remoteImages,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  saveDisabled?: boolean;
  mode?: MarkdownEditorMode;
  defaultMode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  modes?: readonly MarkdownEditorMode[];
  hint?: ReactNode;
  saveHint?: ReactNode;
  placeholder?: string;
  emptyPreview?: ReactNode;
  minHeight?: string;
  label?: string;
  className?: string;
  /** プレビューの `Markdown` へそのまま渡す（省略は今までどおり外部の画像も描く）。 */
  remoteImages?: boolean;
}) {
  const isMobile = useIsMobile();
  const [innerMode, setInnerMode] = useState<MarkdownEditorMode | undefined>(undefined);
  const chosen =
    controlledMode ?? innerMode ?? defaultMode ?? (value.trim() === '' ? 'edit' : 'preview');
  // 狭い画面では並べてを出さず編集へ倒す: 幅 375px で2列にすると両方読めないため
  const shown = modes.filter((m) => !(isMobile && m === 'split'));
  const mode: MarkdownEditorMode = shown.includes(chosen)
    ? chosen
    : shown.includes('edit')
      ? 'edit'
      : (shown[0] ?? 'edit');

  const setMode = (next: string) => {
    const typed = next as MarkdownEditorMode;
    if (controlledMode === undefined) setInnerMode(typed);
    onModeChange?.(typed);
  };

  const editor = (
    <Textarea
      aria-label={label}
      className="font-mono text-xs leading-relaxed"
      maxHeight="60vh"
      onSubmitShortcut={onSave}
      submitDisabled={saveDisabled || onSave === undefined}
      style={{ minHeight }}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (onSave !== undefined && (event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault();
          // `saveDisabled` のあいだは呼ばない: 保存中の二重送信を防ぐため
          if (!saveDisabled) onSave();
        }
      }}
    />
  );

  const preview = (
    <div
      className="min-w-0 flex-1 overflow-y-auto rounded-md border border-dashed border-border p-4"
      style={{ minHeight }}
    >
      {value.trim() === '' && emptyPreview !== null ? (
        <p className="text-sm text-muted-foreground">{emptyPreview}</p>
      ) : (
        <Markdown remoteImages={remoteImages}>{value}</Markdown>
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

  const triggers: Record<MarkdownEditorMode, ReactNode> = {
    edit: trigger('edit', <PenLine className="size-3.5" aria-hidden />, '編集'),
    preview: trigger('preview', <Eye className="size-3.5" aria-hidden />, 'プレビュー'),
    split: trigger('split', <Columns2 className="size-3.5" aria-hidden />, '並べて'),
  };

  return (
    <Tabs.Root
      value={mode}
      onValueChange={setMode}
      className={cn('flex flex-1 flex-col', className)}
    >
      <Tabs.List className="mb-2 flex shrink-0 items-center gap-1 border-b border-border">
        {shown.map((m) => (
          <Fragment key={m}>{triggers[m]}</Fragment>
        ))}
        {onSave !== undefined && mode !== 'preview' && (
          <span className="ml-auto flex gap-3 pb-1.5 text-[11px] text-muted-foreground">
            {saveHint !== null && <span>{saveHint}</span>}
            <SubmitHint action="保存" />
          </span>
        )}
      </Tabs.List>

      {hint !== undefined && mode !== 'preview' && (
        <p className="mb-2 shrink-0 text-xs text-muted-foreground">{hint}</p>
      )}

      {shown.includes('edit') && (
        <Tabs.Content value="edit" className="flex min-h-0 flex-1 flex-col">
          {editor}
        </Tabs.Content>
      )}
      {shown.includes('preview') && (
        <Tabs.Content value="preview" className="flex min-h-0 flex-1 flex-col">
          {preview}
        </Tabs.Content>
      )}
      {shown.includes('split') && (
        <Tabs.Content value="split" className="grid min-h-0 flex-1 grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col">{editor}</div>
          <div className="flex min-w-0 flex-col">{preview}</div>
        </Tabs.Content>
      )}
    </Tabs.Root>
  );
}
