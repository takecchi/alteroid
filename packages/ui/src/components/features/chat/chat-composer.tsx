import { Send, Square } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

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
 * `error` には送信・中断の失敗を渡す（入力欄の上に出る）。渡すと `mb-2` の `div` で
 * 包む。**失敗が無いときは `undefined` を渡す**（空の `div` の余白が残る）。
 * `opaque` を偽にすると、帯に背景色を敷かない（既定は敷く）。
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  sending = false,
  onStopReceiving,
  error,
  placeholder = 'クローンに話しかける（⌘/Ctrl + Enter で送信）',
  opaque = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** 受信中か。真のとき「受信をやめる」と但し書きを出す。 */
  sending?: boolean;
  onStopReceiving?: () => void;
  error?: ReactNode;
  placeholder?: string;
  /** 偽なら帯に `bg-background` を敷かない（背後の面の色をそのまま見せる）。既定は敷く。 */
  opaque?: boolean;
}) {
  const empty = value.trim() === '';
  return (
    <div
      className={cn(
        'shrink-0 border-t border-border pt-3 pb-[calc(0.75rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]',
        opaque && 'bg-background',
      )}
    >
      {error !== undefined && <div className="mb-2">{error}</div>}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          {/*
            **受信中も打てる。** 塞ぐと、順番待ちのあいだに言い足したいことが
            あっても待つしかなく、サーバ側にある「まとめて1ターンで読む」機構
            （`followUp` の doc）へ一度も届かない。
          */}
          <Textarea
            rows={2}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              /*
                **IME で変換している最中の Enter では送らない。**（判定は `isSubmitShortcut`
                が持つ。`ime.ts` の `isImeConfirmEnter`）

                ⭐ **いまこの門を踏む経路は無い。** 送信条件は `⌘/Ctrl + Enter` だけで、
                Enter 単体で送る道がまだ存在しないからである（#247 の 2）。それでも
                先に置くのは、**Enter 単体送信を足した瞬間に、この門が無いと IME の
                「変換を確定する Enter」がそのまま誤送信になる**からで、しかも足す人が
                そのときに門の不在へ気づく契機を持たない（この Issue を読む理由が無い）。
                ＝ **後から足すものではなく、Enter 単体送信の前提条件として先に満たして
                おくものである。** `apps/web/app/routes/chat.ime-enter.test.tsx` の
                「Enter 単体では送らない」が、Enter 単体送信を足した人をここへ連れてくる網である。

                **いま既に効く分もある** — `⌘/Ctrl + Enter` を変換中に打った場合である。
                変換中でも `input` は飛ぶ（Chrome）ので `draft` には確定前の途中の文字列
                （「こんにちh」のような）が入っており、そのまま投函されていた。

                `event.isComposing` ではなく **`event.nativeEvent.isComposing` を見る** —
                React の合成イベントの型は `isComposing` を持たない（DOM の
                `KeyboardEvent` の側にしか無い）。

                **`keyCode === 229` を併せて見るのは、`isComposing` が false のまま
                変換確定の Enter を配る実装が在るからである**（Android の IME や古い
                WebKit で報告されている形。229 は「IME が処理中」を表す慣用の値）。
                PR #53 がこの項目を予告したときに挙げた既存実装（virchamate の
                `isIMEActive`）も、この2つを併用している。⚠️ **実機での確認はしていない**
                — 229 を配るブラウザをこの器から触れないので、ここで測れているのは
                「229 が来たら送らない」という分岐の存在だけである。
              */
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                onSend();
              }
            }}
          />
        </div>
        {/*
          **「受信をやめる」は「送る」の代わりではない。** 並べて出す —
          受信中でも続けて送れるので、送る口を消してしまうと、追送するには
          いったん受信を捨てるしかなくなる（捨てているあいだに届いた応答は画面に出ない）。

          **狭い画面ではラベルだけ畳み、アイコンは常に出す**（`hidden md:inline`）。
          2つ並ぶと入力欄と幅を取り合うため、本3 で `h-11` になったこのボタンは
          アイコン化しないと狭い画面で収まらない。`aria-label` は明示する —
          ラベルの `<span>` を隠しても中の文字は DOM から消えないので付けなくても
          アクセシブルネームは保たれるが、実機（Tailwind が効く環境）で見出しの
          文字が本当に消えたときに備え、頼らない形にしてある。
        */}
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
  );
}
