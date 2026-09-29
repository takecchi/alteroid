/**
 * 要素の実測の高さを追う。
 *
 * 日誌画面（`routes/journal.tsx`）が `virtua` の `Virtualizer` へ渡す
 * `startMargin`（「virtualizer の手前に置いた要素の高さ」— virtua の doc:
 * 「If you put an element before virtualizer, you have to set its height to
 * this prop.」）のために書いた。チップ帯は選択数や画面幅で折り返して高さが
 * 変わるので、固定値では `startMargin` がすぐ実物とずれる。
 *
 * **`ResizeObserver` が無い環境では何もしない**（初期値のまま止まる）。
 * jsdom がそれで、`apps/web/app/test-support.tsx` の no-op スタブを足しても
 * 実測は来ない（`journal.test.tsx` の冒頭コメント、`virtua` 自体が jsdom で
 * 描けない理由と同じ）。**投げない** — `startMargin` は「無いよりはズレていた
 * ほうがまし」な補助値であって、無いと動作そのものが止まる値ではないため、
 * matchMedia のような「対応していない入力は投げる」までは要らないと判断した。
 */
import { useEffect, useState } from 'react';

export function useMeasuredHeight(): [React.RefCallback<HTMLElement>, number] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (node === null) return;
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
