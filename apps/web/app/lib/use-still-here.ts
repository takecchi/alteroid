import { useContext } from 'react';
import { UNSAFE_DataRouterContext } from 'react-router';

/**
 * 「いまもこの項目を見ているか」を、応答が返った時点で確かめる道具（issue #3802）。
 *
 * 詳細は項目ごとに作り直される（`key={slug}`）ので、削除・停止の応答待ちに別の項目へ移ると、
 * 古い詳細は消えている。それでも古い詳細が起こした Promise の `.then` は残るため、いまの URL を
 * 確かめずに `navigate` すると、いま見ている別の項目を閉じてしまう。**消えた後の画面の
 * `useLocation` は古いままなので、ルーターの「いま」を直接読む。**
 *
 * 使い方: 要求を打つ時点で `const isHere = captureHere()` と控え、成功の `.then` で
 * `if (!isHere()) return;`。比べるのは pathname だけ（絞り込みのクエリが変わっても同じ項目）。
 * データルーターの外（単体の描画）では常に「いまもここ」とみなす。
 */
export function useStillHere(): () => () => boolean {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  return () => {
    if (router === undefined) return () => true;
    const startedAt = router.state.location.pathname;
    return () => router.state.location.pathname === startedAt;
  };
}
