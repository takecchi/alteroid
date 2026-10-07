import { createContext, useContext, useRef, useState } from 'react';

import { useAuth } from '@alteroid/swr';

export interface LogoutGuard {
  confirm: (run: () => void) => void;
  end: () => void;
}

// 確認は門（Shell）が持つ: ログイン画面のように書きかけの無い場所では undefined のまま、確認なしで進むため
export const LogoutGuardContext = createContext<LogoutGuard | undefined>(undefined);

// 二度押しを state でなく ref で止める: state は次の描き直しまで古く、同じ tick の二度押しを止められないため
export function useLogout() {
  const auth = useAuth();
  const guard = useContext(LogoutGuardContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void auth
      .logout()
      .then((result) => {
        if (!result.ok) {
          setError(result.message);
          guard?.end();
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  // 鍵だけを捨てる経路も確認を通す: こちらも配下の書きかけごと画面を外すため
  const drop = () => {
    setError(null);
    auth.discardCredential();
  };

  const through = (action: () => void) => (guard === undefined ? action() : guard.confirm(action));

  return { busy, error, logout: () => through(run), discard: () => through(drop) };
}
