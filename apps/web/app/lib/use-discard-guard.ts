import { useState } from 'react';

// 編集欄の「開いている・書きかけ・やめる確認中」の3つと、やめる動作。書きかけでなければそのまま閉じ、書きかけなら確認を挟む。
// `onClosed` は閉じるたびに最後に走る呼び元固有の後始末（フォーカスを戻す・下書きの控えを捨てる等）。
export function useDiscardGuard(onClosed?: () => void) {
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  function closeEditor() {
    setEditing(false);
    setDirty(false);
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
    setDirty,
    confirmingDiscard,
    setConfirmingDiscard,
    closeEditor,
    requestCloseEditor,
  };
}
