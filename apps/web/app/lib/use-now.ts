import { formatRelative } from '@alteroid/logic';
import { useEffect, useState, useSyncExternalStore } from 'react';

/** effect の中で同期に `setState` しない: 有効にした直後の最初の刻みまでは前の値のままで、呼び手が備える。 */
export function useNowMs(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

// 画面ごとに setInterval を持たせない: 承認カードや会話一覧の行は何十個も並びうるので、刻みは1本にして全員に同じ値を配る
// 分の境界へ丸めない: 丸めると、いま作ったばかりの行が「まもなく」（未来）になるため
const MINUTE_MS = 60_000;
const minuteListeners = new Set<() => void>();
let minuteSnapshot = Date.now();
// getSnapshot が毎回 Date.now() を返さない: 同じ描画の中の全員が同じ値を受け取り、店が変わらなければ同じ値を返すため
let minuteStale = true;
let minuteTimer: ReturnType<typeof setInterval> | undefined;
const minuteServerSnapshot = Date.now();

function refreshMinute(): void {
  minuteSnapshot = Date.now();
  for (const listener of [...minuteListeners]) listener();
}

function syncMinuteTimer(): void {
  const shouldRun = minuteListeners.size > 0 && document.visibilityState === 'visible';
  if (shouldRun && minuteTimer === undefined) {
    minuteTimer = setInterval(refreshMinute, MINUTE_MS);
  } else if (!shouldRun && minuteTimer !== undefined) {
    clearInterval(minuteTimer);
    minuteTimer = undefined;
  }
}

function onMinuteVisibility(): void {
  if (document.visibilityState === 'visible' && minuteListeners.size > 0) refreshMinute();
  syncMinuteTimer();
}

function subscribeMinute(listener: () => void): () => void {
  if (minuteListeners.size === 0) {
    document.addEventListener('visibilitychange', onMinuteVisibility);
    minuteSnapshot = Date.now();
    minuteStale = false;
  }
  minuteListeners.add(listener);
  syncMinuteTimer();
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0) {
      document.removeEventListener('visibilitychange', onMinuteVisibility);
      minuteStale = true;
    }
    syncMinuteTimer();
  };
}

function getMinuteSnapshot(): number {
  if (minuteStale && minuteListeners.size === 0) {
    minuteSnapshot = Date.now();
    minuteStale = false;
  }
  return minuteSnapshot;
}

function getMinuteSnapshotPassive(): number {
  // 購読しない呼び手は stale を下ろさない: 下ろすと、あとで購読する画面の最初の描画が古くなるため
  return minuteSnapshot;
}

function subscribeNothing(): () => void {
  return () => {};
}

export function useMinuteNow(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribeMinute : subscribeNothing,
    enabled ? getMinuteSnapshot : getMinuteSnapshotPassive,
    () => minuteServerSnapshot,
  );
}

/** 1分未満だけ先の時刻を now と見る: 分の時計の値は最大1分古く、更新直後の時刻が「まもなく」と出るため。 */
export function formatRelativeAtMinute(iso: string, now: number): string {
  const ahead = new Date(iso).getTime() - now;
  return formatRelative(iso, ahead > 0 && ahead < 60_000 ? now + ahead : now);
}
