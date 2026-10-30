import { useState } from 'react';

import { useIsReportedDirty } from '~/lib/leave-guard';

// 編集欄の「開いている・やめる確認中」の2つと、やめる動作。書きかけでなければそのまま閉じ、書きかけなら確認を挟む。
// 書きかけかどうかは編集欄が `useReportDirty(dirtyId, …)` で離脱の見張りへ報告したものを読む（親へ別の経路では渡さない）。
// `onClosed` は閉じるたびに最後に走る呼び元固有の後始末（フォーカスを戻す・下書きの控えを捨てる等）。
export function useDiscardGuard(dirtyId: string, onClosed?: () => void) {
  const [editing, setEditing] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dirty = useIsReportedDirty(dirtyId);

  function closeEditor() {
    setEditing(false);
    setConfirmingDiscard(false);
    onClosed?.();
  }

  function requestCloseEditor() {
    if (dirty) setConfirmingDiscard(true);
    else closeEditor();
  }

  return {
    editing,
    setEditing,
    confirmingDiscard,
    setConfirmingDiscard,
    closeEditor,
    requestCloseEditor,
  };
}
