import type { AlteroidClient } from '@alteroid/api-client';
import { describe, expect, it } from 'vitest';

import { CLAIM_INTERVAL_MS, claimOnce, claimUntilReady } from './login.js';

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

describe('claimUntilReady の撃ち直し（通信の失敗と 5xx）', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();
  const pending = () => ({ ...PENDING, expiresAt: future(), provider: 'google' });
  const noSleep = () => Promise.resolve();

  /** 呼ばれるたびに、並びの次の動作（応答か通信の失敗）を実行する偽物。 */
  function scripted(steps: ('network' | { status: number; body: unknown })[]) {
    let index = 0;
    const POST = () => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step === 'network' || step === undefined) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const response = { status: step.status, statusText: '' } as Response;
      return Promise.resolve(
        step.status >= 400 ? { error: step.body, response } : { data: step.body, response },
      );
    };
    return {
      client: { api: { POST } } as unknown as AlteroidClient,
      count: () => index,
    };
  }

  it('一時的な 503 や通信の失敗の後に ready が返れば、引き取れる', async () => {
    const { client, count } = scripted([
      { status: 503, body: { error: '混んでいる' } },
      'network',
      { status: 200, body: READY_BODY },
    ]);

    const outcome = await claimUntilReady(client, pending(), { sleep: noSleep });

    expect(outcome.status).toBe('ready');
    expect(count()).toBe(3);
  });

  it('撃ち直しの間は CLAIM_INTERVAL_MS だけ待つ', async () => {
    const { client } = scripted(['network', { status: 200, body: READY_BODY }]);
    const waits: number[] = [];

    await claimUntilReady(client, pending(), {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(waits).toEqual([CLAIM_INTERVAL_MS]);
  });

  it('400 はすぐ失敗にする（撃ち直さない）', async () => {
    const { client, count } = scripted([{ status: 400, body: { error: 'もう使えない' } }]);

    const outcome = await claimUntilReady(client, pending(), { sleep: noSleep });

    expect(outcome).toEqual({ status: 'failed', message: 'もう使えない' });
    expect(count()).toBe(1);
  });

  it('400 以外の 4xx は撃ち直さず投げる', async () => {
    const { client, count } = scripted([{ status: 403, body: { error: '禁止' } }]);

    await expect(claimUntilReady(client, pending(), { sleep: noSleep })).rejects.toThrow('禁止');
    expect(count()).toBe(1);
  });

  it('撃ち直しの上限を超えたら失敗として返す', async () => {
    const { client, count } = scripted([{ status: 503, body: { error: '落ちている' } }]);

    const outcome = await claimUntilReady(client, pending(), { sleep: noSleep });

    expect(outcome.status).toBe('failed');
    // 最初の1回 + 撃ち直し CLAIM_MAX_RETRIES 回で打ち切る。
    expect(count()).toBe(5);
  });

  it('成功（pending）を挟めば失敗の数え直しになる', async () => {
    const steps: ('network' | { status: number; body: unknown })[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < CLAIM_MAX_RETRIES; i += 1) steps.push('network');
      steps.push({ status: 202, body: { status: 'pending' } });
    }
    steps.push({ status: 200, body: READY_BODY });
    const { client } = scripted(steps);

    const outcome = await claimUntilReady(client, pending(), { sleep: noSleep });

    expect(outcome.status).toBe('ready');
  });

  it('撃ち直しの待ちの間に中断されたら、それ以上叩かない', async () => {
    const { client, count } = scripted(['network']);
    const controller = new AbortController();

    const outcome = await claimUntilReady(client, pending(), {
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    expect(outcome).toEqual({ status: 'failed', message: '中断した' });
    expect(count()).toBe(1);
  });
});
