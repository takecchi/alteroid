import { Columns2, Eye, PenLine } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { Fragment, useState, type ReactNode } from 'react';

import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';

import { TAB_TRIGGER_ACTIVE_CLASS, TAB_TRIGGER_CLASS, Textarea } from '../common';
import { Markdown } from '../markdown';

export type MarkdownEditorMode = 'edit' | 'preview' | 'split';

const DEFAULT_MODES: readonly MarkdownEditorMode[] = ['edit', 'preview', 'split'];
const SAVE_HINT = '⌘/Ctrl + S で保存';

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
 *
 * **省略可能な口（既定の振る舞いは変えない）。** 画面が今の表示をそのまま出せるように
 * 足した: `modes`（出すタブとその並び。既定は編集・プレビュー・並べて）・
 * `saveHint`（`null` で「⌘/Ctrl + S で保存」を出さない）・`emptyPreview`（`null` で
 * 空でもそのまま `Markdown` を描く）・`placeholder`（空文字で何も出さない）。
 */
export function MarkdownEditor({
  value,
  onChange,
  onSave,
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  mode?: MarkdownEditorMode;
  /** 最初に開くタブ（渡さなければ中身で決める）。 */
  defaultMode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  /**
   * 出すタブとその並び（左から）。既定は編集・プレビュー・並べて。`split` は狭い画面では
   * 入れていても出さない。
   */
  modes?: readonly MarkdownEditorMode[];
  /** 編集欄の上に出す一文（「ここで書き換えたものは日誌に残る」など）。 */
  hint?: ReactNode;
  /** 保存できる（`onSave` を渡した）ときに、タブの行の右に出す一言。`null` で出さない。 */
  saveHint?: ReactNode;
  /** 空文字なら何も出さない。 */
  placeholder?: string;
  /** プレビューが空のときの一言。`null` なら一言を出さず、空のまま `Markdown` を描く。 */
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
  // 狭い画面では並べてを出さない。選んでいたもの（または既定）が出ていないタブなら、編集へ倒す
  // （編集を出さない並びなら先頭へ）。
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
      {value.trim() === '' && emptyPreview !== null ? (
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
        {onSave !== undefined && saveHint !== null && mode !== 'preview' && (
          <span className="ml-auto pb-1.5 text-[11px] text-muted-foreground">{saveHint}</span>
        )}
      </Tabs.List>

      {hint !== undefined && mode !== 'preview' && (
        <p className="mb-2 shrink-0 text-xs text-muted-foreground">{hint}</p>
      )}

      {/*
        画面 `memory-detail.tsx` の `Tabs.Root` に在ったコメントをそのまま移した。この部品では
        `draft` は `value`（呼ぶ側が持つ）、`Tabs.Root` はこの部品自身に読み替える。

        **`draft` はこの `Tabs.Root` の外（コンポーネント自身）に在る。**
        非活性の `Tabs.Content` は既定で unmount されるが、書きかけの実体は
        state 側に残るので、タブを行き来しても消えない。プレビューが映すのは
        保存前の `value`（= draft ?? loaded）そのもの — 本文を書き換えない。
      */}
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
