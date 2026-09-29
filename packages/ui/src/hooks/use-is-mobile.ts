/**
 * 狭い画面か。
 *
 * **境目は Tailwind の `md`（768px）と同じにしてある。** 判断をここで、見た目を
 * `md:` でやっている箇所が混在するので、片方だけ動かすと「畳んだのに隙間が空く」
 * 形で崩れる。動かすときは両方いっしょに動かすこと。
 *
 * 幅ではなく `matchMedia` を見るのは、画面の回転や分割表示で幅が変わったときに
 * 追いつくため（`window.innerWidth` を一度読むだけだと、そのまま固まる）。
 */
import { useSyncExternalStore } from 'react';

/** これ未満を狭い画面とする（Tailwind の `md` の下限）。 */
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
  /*
   * 3つ目（サーバ側の値）は SPA モードでは使われない — 静的成果物に焼かれるのは
   * root だけで、この部品はハイドレート後に初めて描かれる。それでも広い側を
   * 既定にしておく。狭い側にすると、万一この経路を通ったときに一瞬だけ
   * ドロワーの画面が出てから広い画面に組み替わる。
   */
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
