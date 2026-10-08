import type { AlteroidClient } from '@alteroid/api-client';

import { ApiError, unwrap } from './api.js';
import {
  deviceLabel,
  storePendingLogin,
  type Credential,
  type PendingLogin,
} from '@alteroid/logic';

export const CLAIM_INTERVAL_MS = 1500;

export const CLAIM_MAX_RETRIES = 4;

function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

export interface LoginStart {
  requestId: string;
  authorizationUrl: string;
  claimSecret: string;
  expiresAt: string;
}

export async function startLogin(
  client: AlteroidClient,
  provider: string,
  baseUrl: string,
): Promise<LoginStart> {
  const started = await client.api
    .POST('/auth/login', { body: { provider, label: deviceLabel() } })
    .then(unwrap);

  const pending: PendingLogin = {
    requestId: started.requestId,
    claimSecret: started.claimSecret,
    expiresAt: started.expiresAt,
    provider,
    baseUrl,
  };
  // 開く前に控える: 同じタブごと遷移させられても引き取りを続けられるように
  storePendingLogin(pending);
  return started;
}

export type ClaimOutcome =
  | { status: 'pending' }
  | { status: 'ready'; credential: Credential }
  | { status: 'failed'; message: string };

// HTTP の番号ではなく本文の `status` で分岐する: 202 と 200 は同じ union で、番号で分けると片方が変わったとき黙って壊れる
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

export async function claimUntilReady(
  client: AlteroidClient,
  pending: Omit<PendingLogin, 'baseUrl'>,
  options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ClaimOutcome> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.parse(pending.expiresAt);

  let failures = 0;

  for (;;) {
    if (options.signal?.aborted === true) return { status: 'failed', message: '中断した' };
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      return { status: 'failed', message: 'ログインの有効期限が切れた。やり直してほしい' };
    }

    try {
      const outcome = await claimOnce(client, pending);
      if (outcome.status !== 'pending') return outcome;
      failures = 0;
    } catch (error) {
      // 一度の失敗で、認可を済ませた待ちを捨てない
      if (!isTransient(error)) throw error;
      failures += 1;
      if (failures > CLAIM_MAX_RETRIES) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: 'failed', message: `サーバと通信できず、引き取れなかった（${reason}）` };
      }
    }

    await sleep(CLAIM_INTERVAL_MS);
  }
}

export function openAuthorization(url: string): Window | null {
  if (typeof window === 'undefined') return null;
  return window.open(url, 'alteroid-login', 'width=520,height=700,noopener=no');
}
