import { useRef, useState } from 'react';

import { useAction } from '~/lib/use-action';

// `<dialog>` で確認してから叩く操作。送信中・失敗は `useAction` が持ち、ここは済んだ結果（`done`）・確認語・開閉だけを足す。
// 済んだ結果が `undefined` でないことを「済んだ」の印にする（結果を持たない操作は `true` などを返す）。
// `confirmWord` があれば、その語を打つまで押せない（大文字小文字・前後の空白は見ない）。開くたびに入力・失敗・済んだ結果を消す。
export function useDangerDialog<T>(action: () => Promise<T>, confirmWord?: string) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const { busy, failure, setFailure, run: runAction } = useAction();
  const [done, setDone] = useState<T | undefined>(undefined);

  const canConfirm = confirmWord === undefined || confirmText.trim().toLowerCase() === confirmWord;

  function open() {
    setConfirmText('');
    setFailure(undefined);
    setDone(undefined);
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function run() {
    if (!canConfirm) return;
    await runAction(async () => {
      setDone(await action());
    });
  }

  return {
    dialogRef,
    confirmWord,
    confirmText,
    setConfirmText,
    canConfirm,
    busy,
    failure,
    done,
    open,
    close,
    run,
  };
}

export type DangerDialog<T> = ReturnType<typeof useDangerDialog<T>>;
