import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Toaster as ShadcnToaster } from '@/components/ui/sonner';

/**
 * 操作の結果を短く知らせる（「承認した」「失効させた」）。画面の根に1つ置き、
 * 知らせる側は `toast` を呼ぶ。
 *
 * - **明暗は `<html>` の `.dark` から読む。** shadcn の sonner は next-themes の
 *   `useTheme` を読むが、画面は next-themes を使わず `<html class="dark">` で決めて
 *   いる（`apps/web/app/root.tsx`）。だから `theme` をここで明示して渡す
 * - **失敗をトーストだけで言わない。** トーストは消えるので、読み逃した失敗が残らない。
 *   失敗は `ErrorNote` で画面に残し、トーストは成功の確認だけに使う
 * - 位置は右下（狭い画面では下端いっぱい）。操作した場所から目を大きく動かさない
 */
export function Toaster() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return (
    // 切り欠き・ホームバー・横向きの角を避ける（standalone で `black-translucent` のとき、下端と右端が
    // 画面の端まで描かれるため）。`mobileOffset` は狭い画面（下端いっぱい）の余白。
    <ShadcnToaster
      theme={theme}
      position="bottom-right"
      offset={{
        right: 'calc(1rem + var(--safe-right))',
        bottom: 'calc(1rem + var(--safe-bottom))',
      }}
      mobileOffset={{
        left: 'calc(1rem + var(--safe-left))',
        right: 'calc(1rem + var(--safe-right))',
        bottom: 'calc(1rem + var(--safe-bottom))',
      }}
    />
  );
}

export { toast };
