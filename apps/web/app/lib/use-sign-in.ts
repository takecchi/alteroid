import { useCallback, useEffect, useRef, useState } from 'react';

import {
  claimUntilReady,
  openAuthorization,
  startLogin,
  useApiContext,
  useAuth,
  type ClaimOutcome,
} from '@alteroid/swr';
import { readPendingLogin, storePendingLogin, type PendingLogin } from '@alteroid/logic';

// 画面遷移は持たない: 遷移の有無は呼び出し側が `onSignedIn` で決める（ログイン画面と、書きかけを残したままログインし直す帯が共有するため）。
export function useSignIn(onSignedIn: () => void) {
  const auth = useAuth();
  const { client, baseUrl, setCredential } = useApiContext();

  // 初期値として読む: effect の中で state に写すと、同期的な setState で描き直しが1往復無駄に増える
  const [resumed, setResumed] = useState(() => readPendingLogin(baseUrl));
  const [busy, setBusy] = useState(() => resumed !== null);
  // 描画の中で捨てる: effect で捨てると、接続先が変わった描画の `settle` が先に合鍵を新しい接続先へ送るため
  if (resumed !== null && resumed.baseUrl !== baseUrl) {
    storePendingLogin(null);
    setResumed(null);
    setBusy(false);
  }
  const [failure, setFailure] = useState<unknown>(undefined);
  const [manualUrl, setManualUrl] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 接続先が変わったら、`begin` の待ちも自分で畳む: 任せると、前の世代の中断が通信の失敗（再試行のあと「引き取れなかった」）として出る
  const startedAt = useRef(baseUrl);
  useEffect(() => {
    if (startedAt.current === baseUrl) return;
    startedAt.current = baseUrl;
    if (abortRef.current === undefined) return;
    abortRef.current.abort();
    abortRef.current = undefined;
    storePendingLogin(null);
    setBusy(false);
    setManualUrl(undefined);
  }, [baseUrl]);

  const applyOutcome = useCallback(
    async (outcome: ClaimOutcome) => {
      if (outcome.status === 'ready') {
        storePendingLogin(null);
        setCredential(outcome.credential);
        await auth.revalidate();
        onSignedIn();
      } else if (outcome.status === 'failed') {
        storePendingLogin(null);
        setFailure(new Error(outcome.message));
      }
      setBusy(false);
      setManualUrl(undefined);
      abortRef.current = undefined;
    },
    [auth, onSignedIn, setCredential],
  );

  const fail = useCallback((error: unknown) => {
    setFailure(error);
    setBusy(false);
    abortRef.current = undefined;
  }, []);

  const settle = useCallback(
    (pending: Omit<PendingLogin, 'baseUrl'>, controller: AbortController) =>
      claimUntilReady(client, pending, { signal: controller.signal })
        .then((outcome) => (controller.signal.aborted ? undefined : applyOutcome(outcome)))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) fail(error);
        }),
    [client, applyOutcome, fail],
  );

  useEffect(() => {
    if (resumed === null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    void settle(resumed, controller);
    return () => controller.abort();
  }, [resumed, settle]);

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    storePendingLogin(null);
    setBusy(false);
    setManualUrl(undefined);
  }

  async function begin(provider: string) {
    setBusy(true);
    setFailure(undefined);
    setManualUrl(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const started = await startLogin(client, provider, baseUrl);
      if (controller.signal.aborted) {
        storePendingLogin(null);
        return;
      }
      const popup = openAuthorization(started.authorizationUrl);
      if (popup === null) setManualUrl(started.authorizationUrl);

      await settle({ ...started, provider }, controller);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    }
  }

  return { busy, failure, manualUrl, begin, cancel };
}
