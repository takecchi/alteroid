import { useRef, useState } from 'react';

import { useAuth } from '@alteroid/swr';

/**
 * ログアウト（サーバ側の失効 → 鍵を捨てる）の送信中の状態と失敗の1行（#3738）。
 *
 * 設定・サイドバー・許可の無い画面の3か所が同じ形を持っていたのでここへ寄せた。
 * **送信中は二度目を受けない**（`state` は次の描き直しまで古いので、同じ tick の二度押しは
 * `ref` で止める）。成功すると鍵が消えて画面ごと変わるので、成功側では何も戻さない。
 */
export function useLogout() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const logout = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void auth
      .logout()
      .then((result) => {
        if (!result.ok) setError(result.message);
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  /** 失効に失敗したときの逃げ道。サーバへは呼ばず、この画面から鍵だけを捨てる。 */
  const discard = () => {
    setError(null);
    auth.discardCredential();
  };

  return { busy, error, logout, discard };
}
