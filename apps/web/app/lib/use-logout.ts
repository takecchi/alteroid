import { useRef, useState } from 'react';

import { useAuth } from '@alteroid/swr';

// 二度押しを state でなく ref で止める: state は次の描き直しまで古く、同じ tick の二度押しを止められないため
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

  const discard = () => {
    setError(null);
    auth.discardCredential();
  };

  return { busy, error, logout, discard };
}
