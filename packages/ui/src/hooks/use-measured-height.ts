import { useEffect, useState } from 'react';

export function useMeasuredHeight(): [React.RefCallback<HTMLElement>, number] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (node === null) return;
    // `ResizeObserver` が無くても投げない: 高さは無くても動作が止まらない補助値のため
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, height];
}
