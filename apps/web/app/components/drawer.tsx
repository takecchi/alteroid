/**
 * 狭い画面で、脇の面を本文の上へ覆いかぶせて出す。
 *
 * **中身は shadcn の `sheet`（Radix Dialog）である。** 以前はここに自前で
 * `role="dialog"` / `aria-modal` / Escape / 「閉じているあいだは描かない」を書いて
 * いた。Radix はそれに加えて**焦点の閉じ込め**（開いているあいだ Tab が外へ出ない）・
 * **開いたときに中へ焦点を移すこと**・**背後のスクロールの固定**・**背後を読み上げ
 * から外すこと**（`aria-hidden`）・**閉じたときに元の場所へ焦点を戻すこと**を持つ。
 * 自前で書き足すには量が多く、しかも「書き忘れても画面上は正常に見える」ものばかり
 * である（マウスで触っているかぎり気づけない）。
 *
 * **「閉じているあいだは中身を描かない」は消していない — Radix 側が担保する。**
 * 画面の外へ逃がすだけにすると、見えていないリンクがそのまま Tab の順路に残り、
 * キーボードの焦点がどこにも無いところへ落ちる。Radix は閉じたら中身ごと外す
 * （出入りの動きが終わってから外す）ので、同じことが起きない。
 *
 * **開くかどうかの判断はここに持たせていない。** 呼ぶ側が `useIsMobile` で決める
 * （`md:hidden` で隠す形にすると、jsdom は CSS を評価しないので「狭い画面では
 * 出ていない」ことを試験で確かめられなくなる）。
 */
import type { ReactNode } from 'react';

import { Sheet, SheetContent, SheetTitle } from '~/components/shadcn/sheet';

export function Drawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 何の面か。読み上げに出る。 */
  label: string;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // 開ける側は呼ぶ側が持っている（`open` を渡すのは親）。ここで拾うのは閉じるときだけ。
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="left"
        /*
         * 閉じるボタンは出さない。**押せる場所が要らないからではなく、置く場所が
         * 無いからである** — この中に入るのは脇の面（`shell.tsx` の Nav /
         * `chat.tsx` の会話一覧）で、右上には既に「新しい会話」のボタンが居る。
         * 閉じる手は覆いを押す・Escape・行き先を押すの3つが残る（前2つは Radix）。
         */
        showCloseButton={false}
        /*
         * **`aria-describedby` を明示的に空にする。** Radix は説明文（`Description`）が
         * 無いと「無いか、明示的に切るか」を警告で促す。ここに出るのは面そのもの
         * なので説明文は要らない。
         */
        aria-describedby={undefined}
        /*
         * 見え方は以前の drawer のまま。**`w-` だけは `data-[side=left]:` を付けて
         * 上書きする** — sheet 側の幅指定が同じ修飾子付き（`data-[side=left]:w-3/4`）
         * なので、修飾子を揃えないと `cn`（tailwind-merge）が衝突と見なせず、両方
         * 残って属性セレクタのぶん強い側（sheet の 3/4）が勝つ。
         *
         * `text-base` は sheet 既定の `text-sm` を打ち消して、以前と同じ「body から
         * 継いだ大きさ」に戻すためのもの（中の部品はどれも自分で大きさを持っている
         * ので今は差が出ないが、持たない子を足した日に静かにずれる）。
         */
        className="data-[side=left]:w-[17rem] max-w-[85%] gap-0 border-r border-border bg-surface text-base shadow-xl pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]"
      >
        {/*
          読み上げ用の名前。**`aria-label` ではなく `Title` で与える** — Radix は
          `Title` を名前の出どころとして扱い、無ければ警告する。見た目には出さない
          （`sr-only`）ので、以前と同じく面の中身だけが見える。
        */}
        <SheetTitle className="sr-only">{label}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
