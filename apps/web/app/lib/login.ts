/**
 * ブラウザからのログイン。
 *
 * **CLI とまったく同じ経路を通る。** `POST /auth/login` が返す `claimSecret` は
 * 呼んだ相手に渡されるもので、端末に固有の仕掛けは何も無い。だから画面も同じ形で
 * 引き取れる — デーモンに画面専用の経路を足す必要はない（PRD「入口の等価性」）。
 *
 * 段取り:
 *
 * 1. `POST /auth/login` → `{requestId, authorizationUrl, claimSecret, expiresAt}`
 * 2. `authorizationUrl` をブラウザで開く（Google へ）
 * 3. 戻り先は**デーモンの** `/auth/:provider/callback`。そこは「端末に戻れ」と
 *    書いた HTML を返すだけで、**鍵は URL にも Cookie にも載らない**
 * 4. この画面が `POST /auth/login/:requestId/claim` を叩き続け、200 で受け取る
 *
 * 3 のせいで、コールバックのタブからはこちらへ何も返ってこない（`postMessage` も
 * リダイレクトも無い）。**だから始めたタブが生きている必要がある** — ポップアップで
 * 開き、塞がれた場合に備えて引き換え券を `sessionStorage` にも置く。
 */
import type { AlteroidClient } from '@alteroid/api-client';

import { ApiError, unwrap } from './api.js';
import { deviceLabel, storePendingLogin, type Credential, type PendingLogin } from './auth.js';

/** 引き取りを試す間隔。CLI（`apps/cli/src/login.ts`）と揃えてある。 */
export const CLAIM_INTERVAL_MS = 1500;

export interface LoginStart {
  requestId: string;
  authorizationUrl: string;
  claimSecret: string;
  expiresAt: string;
}

/** ログインを始める。戻り値の `authorizationUrl` を開くのは呼ぶ側。 */
export async function startLogin(client: AlteroidClient, provider: string): Promise<LoginStart> {
  const started = await client.api
    .POST('/auth/login', { body: { provider, label: deviceLabel() } })
    .then(unwrap);

  const pending: PendingLogin = {
    requestId: started.requestId,
    claimSecret: started.claimSecret,
    expiresAt: started.expiresAt,
    provider,
  };
  // **開く前に控える。** 同じタブごと遷移させられても引き取りを続けられるように。
  storePendingLogin(pending);
  return started;
}

export type ClaimOutcome =
  | { status: 'pending' }
  | { status: 'ready'; credential: Credential }
  /** やり直しても解決しない（期限切れ・引き取り済み・合鍵違い）。 */
  | { status: 'failed'; message: string };

/**
 * 1回だけ引き取りを試す。
 *
 * 202 と 200 のどちらでも本文は同じ union なので、`status` だけを見る
 * （HTTP の番号で分岐すると、片方が変わったときに黙って壊れる）。
 */
export async function claimOnce(
  client: AlteroidClient,
  pending: Pick<PendingLogin, 'requestId' | 'claimSecret'>,
): Promise<ClaimOutcome> {
  let body;
  try {
    body = await client.api
      .POST('/auth/login/{requestId}/claim', {
        params: { path: { requestId: pending.requestId } },
        body: { claimSecret: pending.claimSecret },
      })
      .then(unwrap);
  } catch (error) {
    // 400 は「この引き換え券はもう使えない」。待っても変わらない。
    if (error instanceof ApiError && error.status === 400) {
      return { status: 'failed', message: error.message };
    }
    throw error;
  }

  if (body.status === 'pending') return { status: 'pending' };
  return {
    status: 'ready',
    credential: {
      token: body.token,
      account: {
        id: body.account.id,
        displayName: body.account.displayName ?? null,
        email: body.account.email ?? null,
      },
      grantedAtClaim: body.granted,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * 引き取れるまで叩き続ける。
 *
 * `signal` で中断でき、`expiresAt` を過ぎたら諦める（永久に回さない）。
 */
export async function claimUntilReady(
  client: AlteroidClient,
  pending: PendingLogin,
  options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ClaimOutcome> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.parse(pending.expiresAt);

  for (;;) {
    if (options.signal?.aborted === true) return { status: 'failed', message: '中断した' };
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      return { status: 'failed', message: 'ログインの有効期限が切れた。やり直してほしい' };
    }

    const outcome = await claimOnce(client, pending);
    if (outcome.status !== 'pending') return outcome;

    await sleep(CLAIM_INTERVAL_MS);
  }
}

/** 認証の画面を開く。塞がれたら `null`（呼ぶ側がリンクを出す）。 */
export function openAuthorization(url: string): Window | null {
  if (typeof window === 'undefined') return null;
  return window.open(url, 'alteroid-login', 'width=520,height=700,noopener=no');
}
