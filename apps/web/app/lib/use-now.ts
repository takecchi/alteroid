import { useEffect, useState } from 'react';

/**
 * `intervalMs` ごとに更新される現在時刻（`Date.now()`）。**`enabled` が偽のあいだは刻まない**
 * （見ていない値のために再描画しない）。
 *
 * **有効にした直後の最初の刻みまで（`intervalMs` 未満）は、前の値のまま**である（effect の中で
 * 同期に `setState` しない）。呼び手は「受け取った時刻より前の値」に備えること。
 *
 * 稼働状況の図が使う: デーモンは線の「最後に流れた時刻」を、変わったときだけ送る。
 * 「いま流れている」の窓（数秒）が過ぎても新しいスナップショットは来ないので、
 * 画面の側で時間を進めて光を消す。
 */
export function useNowMs(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}
