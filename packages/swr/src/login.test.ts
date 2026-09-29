import type { AlteroidClient } from '@alteroid/api-client';
import { describe, expect, it } from 'vitest';

import { claimOnce, claimUntilReady } from './login.js';

/**
 * `client.api.POST` だけを持つ偽物。
 *
 * 引き取りの分岐（pending / ready / もう使えない）は HTTP の番号ではなく本文の
 * `status` で決まる、という約束をここで固定する。
 */
function fakeClient(responses: { status: number; body: unknown }[]): {
  client: AlteroidClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  let index = 0;

  const POST = (path: string, options: unknown) => {
    calls.push({ path, options });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('応答が足りない');
    const response = { status: next.status, statusText: '' } as Response;
    return Promise.resolve(
      next.status >= 400 ? { error: next.body, response } : { data: next.body, response },
    );
  };

  return { client: { api: { POST } } as unknown as AlteroidClient, calls };
}

const READY_BODY = {
  status: 'ready',
  token: 'alt_secret',
  account: { id: 'acc-1', displayName: '作者', email: 'me@example.com' },
  granted: true,
};

const PENDING = { requestId: 'req-1', claimSecret: 'shhh' };

describe('claimOnce', () => {
  it('202 の pending を「まだ」として返す', async () => {
    const { client } = fakeClient([{ status: 202, body: { status: 'pending' } }]);
    expect(await claimOnce(client, PENDING)).toEqual({ status: 'pending' });
  });

  it('200 でも本文が pending なら待つ（番号ではなく status で決める）', async () => {
    const { client } = fakeClient([{ status: 200, body: { status: 'pending' } }]);
    expect(await claimOnce(client, PENDING)).toEqual({ status: 'pending' });
  });

  it('ready を資格情報に写す', async () => {
    const { client, calls } = fakeClient([{ status: 200, body: READY_BODY }]);
    const outcome = await claimOnce(client, PENDING);

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') throw new Error('unreachable');
    expect(outcome.credential.token).toBe('alt_secret');
    expect(outcome.credential.account).toEqual({
      id: 'acc-1',
      displayName: '作者',
      email: 'me@example.com',
    });
    // **許可されていないアカウントは /auth/me に届かない。** ここで控えた id が
    // `alteroid access grant <id>` を案内する唯一の手がかりになる。
    expect(outcome.credential.grantedAtClaim).toBe(true);

    expect(calls[0]).toMatchObject({
      path: '/auth/login/{requestId}/claim',
      options: { params: { path: { requestId: 'req-1' } }, body: { claimSecret: 'shhh' } },
    });
  });

  it('400 は「やり直しても解決しない」として返す（例外にしない）', async () => {
    // 引き取りは一度きりなので、二度目・期限切れ・合鍵違いはここに来る。
    const { client } = fakeClient([{ status: 400, body: { error: 'もう使えない' } }]);
    const outcome = await claimOnce(client, PENDING);

    expect(outcome).toEqual({ status: 'failed', message: 'もう使えない' });
  });
});

describe('claimUntilReady', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();

  it('ready になるまで叩き続ける', async () => {
    const { client, calls } = fakeClient([
      { status: 202, body: { status: 'pending' } },
      { status: 202, body: { status: 'pending' } },
      { status: 200, body: READY_BODY },
    ]);

    const outcome = await claimUntilReady(
      client,
      { ...PENDING, expiresAt: future(), provider: 'google' },
      { sleep: () => Promise.resolve() },
    );

    expect(outcome.status).toBe('ready');
    expect(calls).toHaveLength(3);
  });

  it('期限を過ぎたら諦める（永久に回さない）', async () => {
    const { client, calls } = fakeClient([{ status: 202, body: { status: 'pending' } }]);

    const outcome = await claimUntilReady(
      client,
      { ...PENDING, expiresAt: new Date(Date.now() - 1000).toISOString(), provider: 'google' },
      { sleep: () => Promise.resolve() },
    );

    expect(outcome).toEqual({
      status: 'failed',
      message: 'ログインの有効期限が切れた。やり直してほしい',
    });
    // 期限の確認は叩く前にする。
    expect(calls).toHaveLength(0);
  });

  it('中断できる', async () => {
    const { client } = fakeClient([{ status: 202, body: { status: 'pending' } }]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await claimUntilReady(
      client,
      { ...PENDING, expiresAt: future(), provider: 'google' },
      { signal: controller.signal, sleep: () => Promise.resolve() },
    );

    expect(outcome).toEqual({ status: 'failed', message: '中断した' });
  });
});
