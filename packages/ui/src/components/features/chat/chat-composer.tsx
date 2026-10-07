import { ArrowUp, Pencil, Plus, Square } from 'lucide-react';
import { lazy, type ReactNode, useId, useRef, useState } from 'react';

import { isMacPlatform, submitShortcutLabel } from '@/lib/platform';

import { LazyBoundary } from '../../lazy-boundary';
import { Button, SubmitHint, Textarea, useKeyboardHintsVisible } from '../../common';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';

import type { ComposerAttachment } from './attachment-tray';

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
const MAX_HEIGHT = 'min(40dvh,15rem)';

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
 * - **⌘ + Enter / Ctrl + Enter（どちらでも）で送る。** Enter 単体・Shift + Enter は
 *   textarea の既定（改行）のまま。IME の変換を確定する Enter では送らない（`ime.ts`）。
 *   案内の文は OS に合わせた修飾キーで出し、指だけの端末では隠す（`SubmitHint`）
 * - [+]（ファイルを添付）・[▶]（メッセージを送信）・[■]（受信をやめる。受信中だけ）は、ホバーとキーボードのフォーカスでヒントを出す。
 *   読み上げの名前は `aria-label` で持つ
 * - **受信中も送れる。**「受信をやめる」は「送る」の代わりではないので並べて出す——
 *   送る口を消すと、続けて送るにはいったん受信を捨てるしかなくなる
 * - 「受信をやめる」は画面の購読を切るだけで、クローンのターンは止まらない
 *   （止めるのは見出しの「ターンを止める」）
 * - **入力に合わせて高さが伸びる**（上限つき。超えたら内側をスクロール）。伸びるので
 *   リサイズのつまみは出さない（タッチでは掴めず、デスクトップでも自動の高さと競う）
 * - 「受信をやめる」は記号（■）だけのボタンで、文字のラベルは持たない。ヒントと `aria-label` は同じ文
 *   「受信をやめる（クローンのターンは止まらない）」（■ がクローンを止めるボタンに見えないよう、止まらないことを添える）
 *
 * - **添付**（`onAttach` を渡したときだけ有効）— [+]・貼り付け（クリップボードのファイル）・
 *   ドラッグ＆ドロップのどれからも `onAttach(files)` が呼ばれる。個数や大きさの検査・上げる処理は
 *   呼ぶ側が持つ。`uploading` のあいだは送れない
 * - `disabled` — 欄ぜんたいを使えなくする（入力・添付・送信）
 *
 * - `editContinuation` — 渡すと、いま入力欄にあるのが**発言の編集の続き**（編集の送信が失敗して戻った文）で、
 *   送ると元の発言を置き換えることを枠の上に言う。「編集をやめる」で、ただの新しい発言に戻す
 *   （文はそのまま残す。#3393）
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
  editContinuation,
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
  /** 入力欄が発言の編集の続きであるとき。押すと「編集」をやめ、文はただの新しい発言として残る。 */
  editContinuation?: { onCancel: () => void };
}) {
  // 本文が空でも、添付が1件以上あれば送れる（サーバも添付のある空本文を受ける。Issue #3111）。
  const empty = value.trim() === '' && attachments.length === 0;
  const cannotSend = empty || disabled || uploading;
  const mac = isMacPlatform();
  const hintsVisible = useKeyboardHintsVisible();
  const shortcut = submitShortcutLabel(mac);
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
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
        className="shrink-0 border-t border-border bg-background pt-3 pb-[calc(0.75rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]"
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
        {/* 枠。フォーカスの輪とドロップ先の強調は、テキストエリアでなくこの枠に付ける。 */}
        <div
          data-slot="chat-composer-frame"
          className={`rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 ${dragging ? 'border-primary bg-primary/5' : 'border-input'} ${disabled ? 'opacity-60' : ''}`}
        >
          {attachments.length > 0 && (
            <div className="px-3 pt-3">
              <LazyBoundary what="添付" note="（入力欄に添えた添付は再読み込みで外れる）">
                <AttachmentTray
                  attachments={attachments}
                  onRemove={onRemoveAttachment}
                  disabled={uploading || disabled}
                />
              </LazyBoundary>
            </div>
          )}
          <div>
            {/*
              **受信中も打てる。** 塞ぐと、順番待ちのあいだに言い足したいことが
              あっても待つしかなく、サーバ側にある「まとめて1ターンで読む」機構
              （`followUp` の doc）へ一度も届かない。
            */}
            <Textarea
              rows={1}
              data-chat-input
              disabled={disabled}
              aria-describedby={hintsVisible ? hintId : undefined}
              maxHeight={MAX_HEIGHT}
              className="min-h-11 rounded-none border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
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
              // ⌘/Ctrl + Enter で送る。IME の変換中は送らない（`Textarea` の `onSubmitShortcut`）。
              onSubmitShortcut={onSend}
              submitDisabled={cannotSend}
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
            <SubmitHint action="送信" id={hintId} className="min-w-0 truncate" />
            <div className="ml-auto flex items-center gap-2">
              {/*
                **「受信をやめる」は「送る」の代わりではない。** 並べて出す —
                受信中でも続けて送れるので、送る口を消してしまうと、追送するには
                いったん受信を捨てるしかなくなる（捨てているあいだに届いた応答は画面に出ない）。

                **送信ボタンと同じ形にそろえる** — アイコンだけの丸いボタン（`ROUND_BUTTON`）で、
                説明はホバー・フォーカスのヒントが担う。`aria-label` はヒントと同じ文にする。
                文字のラベルは持たない。
              */}
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
