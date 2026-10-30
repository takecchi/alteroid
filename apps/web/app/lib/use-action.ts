import { useState } from 'react';

// 送信の「送信中・失敗・実行」の3つ。`run` は送信中を立て、前の失敗を消してから `action` を待ち、投げられた値を `failure` に入れ、最後に必ず送信中を下ろす（例外は呼び元へ投げ直さない）。
// 二重送信の門（`if (busy) return`）はここに持たない: 門の有無は画面ごとに違い（Enter や ⌘/Ctrl+S がボタンを通らない所だけが要る）、揃えると操作が変わるため。要る呼び元が `run` の前に自分で置く。
// 成功後の後始末は `action` の末尾に書く: 送信中を下ろすのと同じ描き直しにまとまり、間に「送信中でないのに確認の枠が残る」描画が挟まらないため。
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return { busy, failure, setFailure, run };
}
