import { ArrowUp, Plus, Square } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useId, useLayoutEffect, useRef, useState } from 'react';

import { Button, Textarea } from '../../common';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';

import type { ComposerAttachment } from './attachment-tray';
import { isPlatformSubmitShortcut } from './ime';
import { isMacPlatform, submitShortcutLabel } from './platform';

export type { ComposerAttachment } from './attachment-tray';

/**
 * 送る前の添付のチップ。**添付があるときだけ読み込む**（別チャンク。バンドル予算 1.125 MiB の
 * 内側に収めるため、入力欄の本体には入れない）。
 */
const AttachmentTray = lazy(() => import('./attachment-tray'));

/**
 * 入力欄の高さの上限。画面の高さの 40% と 15rem の小さいほう。
 *
 * スマホでソフトキーボードが出ると見える領域は 844px の端末でも 500px 前後になる
 * （Chrome は dvh ごと縮む。iOS は縮まないので上限を 40% に抑えて余裕を見る）。
 * 15rem は 1 行 24px で約 10 行、デスクトップ（1 行 20px）で 12 行。これを超えたら内側をスクロールする。
 */
const MAX_HEIGHT_CLASS = 'max-h-[min(40dvh,15rem)]';

/**
 * 中身に合わせて `textarea` の高さを決める。`field-sizing: content` は Firefox などが
 * 対応していないので使わず、`scrollHeight` から決める（上限は CSS の `max-height`）。
 * 空に戻れば `auto` から測り直すので元の高さに戻る。
 */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
}

/**
 * ボタンのヒント（ホバーとキーボードのフォーカスで出る）。
 *
 * 押せないボタン（`disabled`）はポインタの事象を受けないので、**トリガーは外側の `span`** にする
 * （子のフォーカスは React では `span` へ伝わるので、キーボードでも出る）。
 */
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

/** 枠の下段の丸いボタンの大きさ（狭い画面では指で押せる 44px、広い画面は 32px）。 */
const ROUND_BUTTON = 'size-11 rounded-full p-0 md:size-8';

/**
 * 話しかける欄（画面の下端）。**1つの枠**の中にテキストエリアと下段のボタンが入る。
 *
 * ```
 * ┌────────────────────────────────┐
 * │ [添付のチップ]                 │
 * │ テキストエリア（内容で伸びる） │
 * │ [+]  ⌘ + Enter で送信      [▶] │
 * └────────────────────────────────┘
 * ```
 *
 * - **⌘ + Enter（macOS）／ Ctrl + Enter（それ以外）で送る。** Enter 単体・Shift + Enter は
 *   textarea の既定（改行）のまま。IME の変換を確定する Enter では送らない（`ime.ts`）。
 *   案内の文はその OS の修飾キーで出す（`platform.ts`）
 * - [+]（ファイルを添付）と [▶]（メッセージを送信）は、ホバーとキーボードのフォーカスでヒントを出す。
 *   読み上げの名前は `aria-label` で持つ
 * - **受信中も送れる。**「受信をやめる」は「送る」の代わりではないので並べて出す——
 *   送る口を消すと、続けて送るにはいったん受信を捨てるしかなくなる
 * - 「受信をやめる」は画面の購読を切るだけで、クローンのターンは止まらない
 *   （止めるのは見出しの「ターンを止める」）
 * - **入力に合わせて高さが伸びる**（上限つき。超えたら内側をスクロール）。伸びるので
 *   リサイズのつまみは出さない（タッチでは掴めず、デスクトップでも自動の高さと競う）
 * - 狭い画面では「受信をやめる」の文言を隠して記号だけにする。読み上げの名前は `aria-label` で持つ
 *
 * - **添付**（`onAttach` を渡したときだけ有効）— [+]・貼り付け（クリップボードのファイル）・
 *   ドラッグ＆ドロップのどれからも `onAttach(files)` が呼ばれる。個数や大きさの検査・上げる処理は
 *   呼ぶ側が持つ。`uploading` のあいだは送れない
 * - `disabled` — 欄ぜんたいを使えなくする（入力・添付・送信）
 *
 * `error` には送信・中断の失敗を渡す（枠の上に出る）。渡すと `mb-2` の `div` で
 * 包む。**失敗が無いときは `undefined` を渡す**（空の `div` の余白が残る）。
 */
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** 受信中か。真のとき「受信をやめる」と但し書きを出す。 */
  sending?: boolean;
  onStopReceiving?: () => void;
  error?: ReactNode;
  placeholder?: string;
  attachments?: readonly ComposerAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (key: string) => void;
  /** 添付を上げている最中か。真のあいだは送れない（二重に上げない）。 */
  uploading?: boolean;
  /** 欄ぜんたいを使えなくする。 */
  disabled?: boolean;
}) {
  // 本文が空でも、添付が1件以上あれば送れる（サーバも添付のある空本文を受ける。Issue #3111）。
  const empty = value.trim() === '' && attachments.length === 0;
  const cannotSend = empty || disabled || uploading;
  const mac = isMacPlatform();
  const shortcut = submitShortcutLabel(mac);
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasFiles = (types: readonly string[] | undefined) => types?.includes('Files') === true;
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current?.querySelector('textarea');
    if (el == null) return;
    fitHeight(el);
    // 幅が変わると折り返しが変わるので、向きの変更や窓の大きさの変更でも測り直す。
    const refit = () => fitHeight(el);
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, [value]);
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
        className="shrink-0 border-t border-border bg-background pt-3 pb-[calc(0.75rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]"
      >
        {error !== undefined && <div className="mb-2">{error}</div>}
        {/* 枠。フォーカスの輪とドロップ先の強調は、テキストエリアでなくこの枠に付ける。 */}
        <div
          data-slot="chat-composer-frame"
          className={`rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 ${dragging ? 'border-primary bg-primary/5' : 'border-input'} ${disabled ? 'opacity-60' : ''}`}
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
          <div ref={box}>
            {/*
              **受信中も打てる。** 塞ぐと、順番待ちのあいだに言い足したいことが
              あっても待つしかなく、サーバ側にある「まとめて1ターンで読む」機構
              （`followUp` の doc）へ一度も届かない。
            */}
            <Textarea
              rows={1}
              disabled={disabled}
              aria-describedby={hintId}
              className={`min-h-11 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent ${MAX_HEIGHT_CLASS}`}
              value={value}
              placeholder={placeholder}
              onChange={(event) => onChange(event.target.value)}
              onPaste={(event) => {
                // 画像のスクリーンショットなど、ファイルだけが入っているときだけ引き取る
                // （表計算のコピーのように文字も入っているときは、文字の貼り付けを邪魔しない）。
                const files = [...event.clipboardData.files];
                if (onAttach === undefined || files.length === 0) return;
                if (event.clipboardData.getData('text/plain') !== '') return;
                event.preventDefault();
                onAttach(files);
              }}
              onKeyDown={(event) => {
                /*
                  **IME で変換している最中の ⌘/Ctrl + Enter では送らない**（判定は `isPlatformSubmitShortcut` が持つ。
                  `ime.ts` の `isImeConfirmEnter`）。変換中でも `input` は飛ぶので、門が無いと
                  確定前の途中の文字列がそのまま投函される。Enter 単体・Shift + Enter は既定（改行）に任せる。
                */
                if (isPlatformSubmitShortcut(event, mac)) {
                  event.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <div className="flex items-center gap-2 px-2 pb-2">
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
                    // 同じファイルをもう一度選べるよう、選び終えたら空へ戻す。
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
            <span
              id={hintId}
              className="min-w-0 truncate text-[11px] text-muted-foreground select-none"
            >
              {shortcut} で送信
            </span>
            <div className="ml-auto flex items-center gap-2">
              {/*
                **「受信をやめる」は「送る」の代わりではない。** 並べて出す —
                受信中でも続けて送れるので、送る口を消してしまうと、追送するには
                いったん受信を捨てるしかなくなる（捨てているあいだに届いた応答は画面に出ない）。

                **狭い画面ではラベルだけ畳み、アイコンは常に出す**（`hidden md:inline`）。
                `aria-label` は明示する — 実機で文字が本当に消えたときに備え、頼らない形にしてある。
              */}
              {sending && onStopReceiving !== undefined && (
                <Hint label="読むのをやめる。クローンのターンは止まらない">
                  <Button
                    variant="default"
                    onClick={onStopReceiving}
                    aria-label="受信をやめる"
                    className="rounded-full md:h-8"
                  >
                    <Square className="size-3.5" aria-hidden />
                    <span className="hidden md:inline">受信をやめる</span>
                  </Button>
                </Hint>
              )}
              <Hint label={uploading ? '添付を上げている' : `メッセージを送信（${shortcut}）`}>
                <Button
                  variant="primary"
                  className={ROUND_BUTTON}
                  disabled={cannotSend}
                  loading={uploading}
                  onClick={send}
                  aria-label={uploading ? '添付を上げている' : 'メッセージを送信'}
                  aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
                >
                  {!uploading && <ArrowUp className="size-4" aria-hidden />}
                </Button>
              </Hint>
            </div>
          </div>
        </div>
        {/*
          進行中かどうかは、やりとりの中の「考えている…」と「受信をやめる」で
          既に見えている。ここに残すのは**他に書いてある場所が無い事実**だけ。
        */}
        {sending && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            画面を閉じてもクローンは考え続ける。順番待ちのあいだに続けて送った分は、まとめて1つの応答になる
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
