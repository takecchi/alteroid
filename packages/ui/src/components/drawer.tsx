import { useRef, type ReactNode } from 'react';

import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

// `aria-modal` を手で足さない: Radix はこの属性を出さず、面の外へ `aria-hidden` を配るため
// 開くかどうかの判断を持たない: `md:hidden` で隠す形にすると、jsdom は CSS を評価せず試験で確かめられなくなるため
export function Drawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  // 開く直前に焦点の居た要素（開いたボタン）を覚える: Dialog.Trigger を使わない作りで、Radix の閉じた後の焦点の戻しは trigger の ref を読むため、何も戻らず body に落ちる
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="left"
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          // 既定の戻し先（trigger の ref。ここでは空）に任せず、自分で戻す
          event.preventDefault();
          const target = opener.current;
          opener.current = null;
          if (target?.isConnected === true && target !== document.body) target.focus();
        }}
        // 閉じるボタンは出さない: 右上に既に「新しい会話」のボタンが居て、置く場所が無いため
        showCloseButton={false}
        // `w-` に `data-[side=left]:` を付ける: sheet の幅指定が同じ修飾子付きで、揃えないと tailwind-merge が衝突と見なせず sheet の 3/4 が勝つため
        className="data-[side=left]:w-[17rem] max-w-[85%] gap-0 border-r border-border bg-card text-base shadow-xl pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]"
      >
        {/* `aria-label` ではなく `Title` で名前を与える: Radix は `Title` が在るときだけ `aria-labelledby` を向けるため */}
        <SheetTitle className="sr-only">{label}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
