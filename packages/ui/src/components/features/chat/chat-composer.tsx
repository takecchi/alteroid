import { ArrowUp, Pencil, Plus, Square } from 'lucide-react';
import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { isMacPlatform, submitShortcutLabel } from '@/lib/platform';
import { cn } from '@/lib/utils';

import { Button, SubmitHint, Textarea, useKeyboardHintsVisible } from '../../common';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';

import type { ComposerAttachment } from './attachment-tray';

export type { ComposerAttachment } from './attachment-tray';

// 入力欄の本体に入れず添付があるときだけ読み込む: バンドル予算 1.125 MiB の内側に収めるため
const AttachmentTray = lazy(() => import('./attachment-tray'));

// 上限を 40% に抑える: iOS はソフトキーボードが出ても dvh が縮まないため
const MAX_HEIGHT = 'min(40dvh,15rem)';

// トリガーは外側の `span` にする: 押せないボタン（`disabled`）はポインタの事象を受けないため
function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const ROUND_BUTTON = 'size-11 rounded-full p-0 md:size-8';

// 狭い画面だけ、1行に収まる間は `[+] 入力 [送信]` を1行に並べる（ChatGPT の形）。広い画面は常に2段のまま
// 並びは `max-md:` の CSS だけで切り替える: JS で幅を見ると、`matchMedia` の無い試験の足場で部品ごと描けなくなるため
const STACKED_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 [grid-template-areas:'input_input'_'start_end']";
const ONE_LINE_GRID =
  "max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:items-end max-md:gap-1 max-md:p-1 max-md:[grid-template-areas:'start_input_end']";

/**
 * 入力が「1行の並びのときの入力欄の幅」に1行で収まらないかを返す。
 *
 * 入力欄そのものの高さでは決めない: 2段にすると欄が広がって1行に収まり、1行に戻すとまた折り返して、
 * 並びが行き来し続けるため。見えない写しに同じ文字の組み方で流し込み、その高さで決める。
 * 1行の並びのときの「両脇の道具とすき間の幅」は、1行の並びのときにだけ測って覚える（2段のときは欄の幅が違うため）。
 * 道具そのものの幅は毎回測る: 受信中は「受信をやめる」が並び、道具の幅が変わるため。
 * （参考: virchamate/virchamate の `chat-input.tsx` の `useOverflowsOneLine`）
 */
function useOverflowsOneLine(
  value: string,
  sending: boolean,
  boxRef: RefObject<HTMLDivElement | null>,
  startRef: RefObject<HTMLDivElement | null>,
  endRef: RefObject<HTMLDivElement | null>,
  mirrorRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [overflows, setOverflows] = useState(false);
  // 並びの切り替えそのものでは測り直さない（測り直すと止まらなくなる）ので、いまの並びは ref で読む
  const overflowsRef = useRef(false);
  useLayoutEffect(() => {
    overflowsRef.current = overflows;
  }, [overflows]);
  const gapsRef = useRef<number | undefined>(undefined);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef]);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const textarea = box?.querySelector('textarea');
    const start = startRef.current;
    const end = endRef.current;
    const mirror = mirrorRef.current;
    if (box == null || textarea == null || start === null || end === null || mirror === null) {
      return;
    }
    const style = window.getComputedStyle(textarea);
    const tools = start.offsetWidth + end.offsetWidth;
    if (!overflowsRef.current) {
      const content =
        textarea.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      gapsRef.current = box.clientWidth - tools - content;
    }
    const width = box.clientWidth - tools - (gapsRef.current ?? 0);
    // 幅が取れない（描かれていない・試験の足場）ときは決めない: 0 幅で測ると、どの入力も溢れて見えるため
    if (!(width > 0)) return;
    mirror.style.width = `${width}px`;
    mirror.style.font = style.font;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.lineHeight = style.lineHeight;
    // 末尾の改行も1行と数えるため、幅の無い文字を足す
    mirror.textContent = value + String.fromCodePoint(0x200b);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    setOverflows(mirror.scrollHeight > lineHeight * 1.5);
  }, [value, sending, boxWidth, boxRef, startRef, endRef, mirrorRef]);
  return overflows;
}

// リサイズのつまみを出さない: タッチでは掴めず、デスクトップでも自動の高さと競うため
// `error` が無いときは `undefined` を渡す: 空の `div` の余白が残るため
export function ChatComposer({
  value,
  onChange,
  onSend,
  sending = false,
  onStopReceiving,
  error,
  placeholder = 'クローンに話しかける',
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploading = false,
  disabled = false,
  editContinuation,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending?: boolean;
  onStopReceiving?: () => void;
  error?: ReactNode;
  placeholder?: string;
  attachments?: readonly ComposerAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (key: string) => void;
  uploading?: boolean;
  disabled?: boolean;
  editContinuation?: { onCancel: () => void };
}) {
  const empty = value.trim() === '' && attachments.length === 0;
  const cannotSend = empty || disabled || uploading;
  const mac = isMacPlatform();
  const hintsVisible = useKeyboardHintsVisible();
  const shortcut = submitShortcutLabel(mac);
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const oneLine = !useOverflowsOneLine(value, sending, boxRef, startRef, endRef, mirrorRef);
  const hasFiles = (types: readonly string[] | undefined) => types?.includes('Files') === true;
  const send = () => {
    if (!cannotSend) onSend();
  };
  return (
    <TooltipProvider delayDuration={200}>
      <div
        onDragOver={(event) => {
          if (disabled || onAttach === undefined || !hasFiles(event.dataTransfer?.types)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (disabled || onAttach === undefined || !hasFiles(event.dataTransfer?.types)) return;
          event.preventDefault();
          onAttach([...event.dataTransfer.files]);
        }}
        // 下はセーフエリアと余白の大きいほうだけを取る: 足すと、ホームインジケータの取り分（約 34px）の上にさらに 12px 空くため
        className="shrink-0 border-t border-border bg-background pt-3 pb-[max(0.75rem,var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]"
      >
        {error !== undefined && <div className="mb-2">{error}</div>}
        {editContinuation !== undefined && (
          <div
            data-slot="chat-composer-edit-continuation"
            className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <Pencil className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              発言の編集の続き。送ると、元の発言を置き換える
            </span>
            <Button size="sm" variant="ghost" onClick={editContinuation.onCancel}>
              編集をやめる
            </Button>
          </div>
        )}
        {/* フォーカスの輪とドロップ先の強調は、テキストエリアでなくこの枠に付ける */}
        <div
          data-slot="chat-composer-frame"
          className={cn(
            'relative rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
            dragging ? 'border-primary bg-primary/5' : 'border-input',
            disabled && 'opacity-60',
            // 1行の並びの高さ（44px＋上下 4px＋線）の半分で丸める
            oneLine && attachments.length === 0 && 'max-md:rounded-[27px]',
          )}
        >
          {attachments.length > 0 && (
            <div className="px-3 pt-3">
              <Suspense fallback={null}>
                <AttachmentTray
                  attachments={attachments}
                  onRemove={onRemoveAttachment}
                  disabled={uploading || disabled}
                />
              </Suspense>
            </div>
          )}
          {/* 並びを替えても入力欄は同じ要素のまま置く（作り直すとカーソルと IME の変換が外れる）。順番は入力欄 → [+] → 送信のまま、見た目の位置だけを grid で替える */}
          <div
            ref={boxRef}
            data-slot="chat-composer-row"
            data-layout={oneLine ? 'one-line' : 'stacked'}
            className={cn(STACKED_GRID, oneLine && ONE_LINE_GRID)}
          >
            <div className="min-w-0 [grid-area:input]">
              {/* 受信中も打てる: 塞ぐと、順番待ちのあいだに言い足したいことがあっても待つしかないため */}
              <Textarea
                rows={1}
                data-chat-input
                disabled={disabled}
                aria-describedby={hintsVisible ? hintId : undefined}
                maxHeight={MAX_HEIGHT}
                className={cn(
                  'min-h-11 rounded-none border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent',
                  // 1行の並びでは欄の高さをボタン（44px）にそろえる: 1行 24px ＋ 上下 10px
                  oneLine && 'max-md:px-1 max-md:py-2.5',
                )}
                value={value}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
                onPaste={(event) => {
                  // ファイルだけが入っているときだけ引き取る: 表計算のコピーのように文字も入っているときは、文字の貼り付けを邪魔しないため
                  const files = [...event.clipboardData.files];
                  if (onAttach === undefined || files.length === 0) return;
                  if (event.clipboardData.getData('text/plain') !== '') return;
                  event.preventDefault();
                  onAttach(files);
                }}
                onSubmitShortcut={onSend}
                submitDisabled={cannotSend}
              />
            </div>
            <div
              ref={startRef}
              className={cn(
                'flex min-w-0 items-center gap-2 pb-2 pl-2 [grid-area:start]',
                oneLine && 'max-md:p-0',
              )}
            >
              {onAttach !== undefined && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    aria-label="添えるファイルを選ぶ"
                    onChange={(event) => {
                      const files = [...(event.target.files ?? [])];
                      // 選び終えたら空へ戻す: 同じファイルをもう一度選べるようにするため
                      event.target.value = '';
                      if (files.length > 0) onAttach(files);
                    }}
                  />
                  <Hint label="ファイルを添付">
                    <Button
                      variant="ghost"
                      className={ROUND_BUTTON}
                      disabled={uploading || disabled}
                      onClick={() => fileInput.current?.click()}
                      aria-label="ファイルを添付"
                    >
                      <Plus className="size-4" aria-hidden />
                    </Button>
                  </Hint>
                </>
              )}
              <SubmitHint
                action="送信"
                id={hintId}
                className={cn('min-w-0 truncate', oneLine && 'max-md:hidden')}
              />
            </div>
            <div
              ref={endRef}
              className={cn(
                'flex items-center gap-2 pr-2 pb-2 [grid-area:end]',
                oneLine && 'max-md:p-0',
              )}
            >
              {/* 「受信をやめる」は「送る」の代わりにせず並べて出す: 送る口を消すと、追送するにはいったん受信を捨てるしかなくなるため */}
              {sending && onStopReceiving !== undefined && (
                <Hint label="受信をやめる（クローンのターンは止まらない）">
                  <Button
                    variant="default"
                    className={ROUND_BUTTON}
                    onClick={onStopReceiving}
                    aria-label="受信をやめる（クローンのターンは止まらない）"
                  >
                    <Square className="size-3.5" aria-hidden />
                  </Button>
                </Hint>
              )}
              <Hint
                label={
                  uploading
                    ? '添付を上げている'
                    : hintsVisible
                      ? `メッセージを送信（${shortcut}）`
                      : 'メッセージを送信'
                }
              >
                <Button
                  variant="primary"
                  className={ROUND_BUTTON}
                  disabled={cannotSend}
                  loading={uploading}
                  onClick={send}
                  aria-label={uploading ? '添付を上げている' : 'メッセージを送信'}
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                >
                  {!uploading && <ArrowUp className="size-4" aria-hidden />}
                </Button>
              </Hint>
            </div>
          </div>
          {/* 1行に収まるかを測るための見えない写し。高さ 0 で切っておく: 長文で下へ伸びて、まわりにスクロールを作らないため */}
          <div
            ref={mirrorRef}
            aria-hidden
            className="pointer-events-none invisible absolute top-0 left-0 h-0 overflow-hidden break-words whitespace-pre-wrap"
          />
        </div>
        {sending && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            画面を閉じてもクローンは考え続ける。順番待ちのあいだに続けて送った分は、まとめて1つの応答になる
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
