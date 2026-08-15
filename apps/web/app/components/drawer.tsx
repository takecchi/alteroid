/**
 * 狭い画面で、脇の面を本文の上へ覆いかぶせて出す。
 *
 * **閉じているあいだは中身を描かない。** 画面の外へ逃がすだけ（`-translate-x-full`）
 * にすると、見えていないリンクがそのまま Tab の順路に残り、キーボードの焦点が
 * どこにも無いところへ落ちる。
 *
 * **開くかどうかの判断はここに持たせていない。** 呼ぶ側が `useIsMobile` で決める
 * （`md:hidden` で隠す形にすると、jsdom は CSS を評価しないので「狭い画面では
 * 出ていない」ことを試験で確かめられなくなる）。
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';

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
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/*
        覆っている面。押したら閉じる。`button` にしてあるのは、指で押せる以外の
        手段（Tab して Enter）も要るからである。
      */}
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        // 切り欠き・ホームインジケータを避ける（`--safe-*` は app.css）。
        className="relative flex h-full w-[17rem] max-w-[85%] flex-col border-r border-border bg-surface pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}
