import { formatRelative } from '@alteroid/logic';
import { useEffect, useState, useSyncExternalStore } from 'react';

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

/*
 * **分単位で更新される「いま」（相対の時刻「たった今」「N分前」の再計算用。#3596）。**
 *
 * 画面ごとに `setInterval` を持たせない。承認カードや会話一覧の行は何十個も並びうるので、
 * 刻みは**1本だけ**（購読者が1つでもいて、タブが見えているあいだだけ）にして、全員に同じ値を配る。
 *
 * - 購読者が0になれば刻みを止める。**タブが隠れているあいだも止める**（見えていない値のために
 *   起きない）。見えるようになった（`visibilitychange`）瞬間に、止まっていた分を追いつかせて、刻みを再開する。
 * - `enabled` が偽なら購読しない（相対の時刻を出していないときに回さない）。
 * - 値は呼び出しの時点の `Date.now()` で、分の境界へ丸めない。丸めると、いま作ったばかりの
 *   行（作成時刻が丸めた値より後）が「まもなく」（未来）になる。
 */
const MINUTE_MS = 60_000;
const minuteListeners = new Set<() => void>();
let minuteSnapshot = Date.now();
// 値が古いかもしれない印。誰も購読していないあいだは時計が止まっているので、最初と、購読者が0に
// なったときに立てる。立っているあいだの最初の getSnapshot が1度だけ読み直して下ろす
// （毎回 Date.now() を返さない。同じ描画の中の全員が同じ値を受け取り、店が変わらなければ同じ値を返す）。
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
  // 隠れていたあいだに進んだ分を、見えた瞬間に追いつかせる。
  if (document.visibilityState === 'visible' && minuteListeners.size > 0) refreshMinute();
  syncMinuteTimer();
}

function subscribeMinute(listener: () => void): () => void {
  if (minuteListeners.size === 0) {
    document.addEventListener('visibilitychange', onMinuteVisibility);
    // 描画から購読までのあいだに進んだ分に備えて読み直す
    // （値が変わっていれば、購読の直後に React が読み直して描き直す）。
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
  // 購読しない呼び手は、印を下ろさない（下ろすと、あとで購読する画面の最初の描画が古くなる）。
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

/**
 * 分の時計（`useMinuteNow`）の値で相対の時刻を出す（#3828）。**分の時計の値は最大 1 分古い**ので、更新した
 * 直後の時刻（端末の `Date.now()`・取り直したサーバの `updatedAt`）はその値より少し後になり、
 * `formatRelative` は「まもなく」「1分後」と出してしまう。**1分未満だけ先の時刻は、いまと見て「たった今」と出す。**
 * それより先の本当に未来の時刻は、`formatRelative` のまま。
 */
export function formatRelativeAtMinute(iso: string, now: number): string {
  const ahead = new Date(iso).getTime() - now;
  return formatRelative(iso, ahead > 0 && ahead < 60_000 ? now + ahead : now);
}
