import { useCallback, useEffect, useRef } from 'react';

// 厳密一致（scrollTop + clientHeight === scrollHeight）は小数の丸めで成立しないことがあるので余裕を持たせる
const BOTTOM_THRESHOLD_PX = 32;

// 呼ぶ位置が効果の実行順を決める: 同じ commit 内の他の効果との前後を変えないよう、呼び出し側は元の効果が在った位置に置く
export function useFollowScroll({
  length,
  lines,
  shownId,
}: {
  length: number;
  lines: unknown;
  shownId: string | undefined;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // 測定は onScroll 側で行ってここへ持ち越す: 効果が走る時点では新しい行が既に描かれ scrollHeight が伸びていて、行が来る前の位置は測れない
  const isAtBottomRef = useRef(true);
  const justSentOwnLineRef = useRef(false);
  // 会話の切り替わりを追従の効果自身の中で見分ける: 他の効果の宣言順に依存させないため（ChatPane は切り替えで作り直されず、ref は会話 A の false を持ち越す）
  const lastSeenShownIdRef = useRef(shownId);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el === null) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (lastSeenShownIdRef.current !== shownId) {
      lastSeenShownIdRef.current = shownId;
      isAtBottomRef.current = true;
    }
    if (isAtBottomRef.current || justSentOwnLineRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      // scroll イベントを待たずに確定させる: チャンクが立て続けに届くと、イベントが次の効果の実行に間に合わない
      isAtBottomRef.current = true;
    }
    justSentOwnLineRef.current = false;
  }, [length, lines, shownId]);

  return { bottomRef, scrollContainerRef, handleScroll, justSentOwnLineRef };
}
