import { Send, Square } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button, Textarea } from '../../common';

import { isSubmitShortcut } from './ime';

/**
 * 話しかける欄（画面の下端）。
 *
 * - 送るのは ⌘ / Ctrl + Enter だけ。**Enter 単体では送らない**（改行になる）。
 *   IME の変換を確定する Enter でも送らない（`ime.ts`）
 * - **受信中も送れる。**「受信をやめる」は「送る」の代わりではないので並べて出す——
 *   送る口を消すと、続けて送るにはいったん受信を捨てるしかなくなる
 * - 「受信をやめる」は画面の購読を切るだけで、クローンのターンは止まらない
 *   （止めるのは見出しの「ターンを止める」）
 * - 狭い画面ではボタンの文言を隠して記号だけにする（入力欄と幅を取り合うため）。
 *   読み上げの名前は `aria-label` で持つ
 *
 * `error` には送信・中断の失敗を渡す（入力欄の上に出る）。
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  sending = false,
  onStopReceiving,
  error,
  placeholder = 'クローンに話しかける（⌘/Ctrl + Enter で送信）',
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** 受信中か。真のとき「受信をやめる」と但し書きを出す。 */
  sending?: boolean;
  onStopReceiving?: () => void;
  error?: ReactNode;
  placeholder?: string;
}) {
  const empty = value.trim() === '';
  return (
    <div className="shrink-0 border-t border-border bg-background pt-3 pb-[calc(0.75rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]">
      {error !== undefined && <div className="mb-2">{error}</div>}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Textarea
            rows={2}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                onSend();
              }
            }}
          />
        </div>
        {sending && onStopReceiving !== undefined && (
          <Button
            variant="default"
            onClick={onStopReceiving}
            title="読むのをやめる。クローンのターンは止まらない"
            aria-label="受信をやめる"
          >
            <Square className="size-3.5" aria-hidden />
            <span className="hidden md:inline">受信をやめる</span>
          </Button>
        )}
        <Button variant="primary" disabled={empty} onClick={onSend} aria-label="送る">
          <Send className="size-3.5" aria-hidden />
          <span className="hidden md:inline">送る</span>
        </Button>
      </div>
      {sending && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          画面を閉じてもクローンは考え続ける。順番待ちのあいだに続けて送った分は、まとめて1つの応答になる
        </p>
      )}
    </div>
  );
}
