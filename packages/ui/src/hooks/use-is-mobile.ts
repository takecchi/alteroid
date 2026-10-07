import { useSyncExternalStore } from 'react';

// Tailwind の `md`（768px）と同じにする: 見た目を `md:` でやっている箇所と片方だけ動かすと、畳んだのに隙間が空く形で崩れるため
export const MOBILE_BREAKPOINT = 768;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

export function useIsMobile(): boolean {
  // サーバ側の値は狭い側にしない: 通ったときに一瞬だけドロワーの画面が出てから組み替わるため
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
