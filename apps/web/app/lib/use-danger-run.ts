import { useRef, useState } from 'react';

// 取り返しのつかない操作を1回叩く: 実行中・失敗・済んだ結果の3つ。済んだ結果が `undefined` でないことを「済んだ」の印にする（結果を持たない操作は `true` などを返す）。
// 実行中の再押下は呼び元のボタンの `disabled` が止める: ここでは弾かない（押せる条件は画面ごとに違う）。
export function useDangerRun<T>(action: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [done, setDone] = useState<T | undefined>(undefined);

  async function run() {
    setBusy(true);
    setFailure(undefined);
    try {
      setDone(await action());
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFailure(undefined);
    setDone(undefined);
  }

  return { busy, failure, done, run, reset };
}

// `<dialog>` で確認してから叩く操作。`confirmWord` があれば、その語を打つまで押せない（大文字小文字・前後の空白は見ない）。
// 開くたびに入力・失敗・済んだ結果を消す。
export function useDangerDialog<T>(action: () => Promise<T>, confirmWord?: string) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const danger = useDangerRun(action);
  const { reset } = danger;

  const canConfirm = confirmWord === undefined || confirmText.trim().toLowerCase() === confirmWord;

  function open() {
    setConfirmText('');
    reset();
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function run() {
    if (!canConfirm) return;
    await danger.run();
  }

  return {
    dialogRef,
    confirmWord,
    confirmText,
    setConfirmText,
    canConfirm,
    busy: danger.busy,
    failure: danger.failure,
    done: danger.done,
    open,
    close,
    run,
  };
}

export type DangerDialog<T> = ReturnType<typeof useDangerDialog<T>>;
