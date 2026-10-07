import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Toaster as ShadcnToaster } from '@/components/ui/sonner';

// 明暗は `<html>` の `.dark` から読んで `theme` を明示する: shadcn の sonner は next-themes を読むが、画面は next-themes を使わないため
// 失敗をトーストだけで言わない: トーストは消えるので、読み逃した失敗が残らないため
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
