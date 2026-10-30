import type { AlteroidClient } from '@alteroid/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimUntilReady } from './login.js';

// 既定の待ち・回数・期限（login.ts の値）。公開の口を渡さずに、この値のまま動くことを縛る
const CLAIM_INTERVAL_MS = 1500;
const CLAIM_MAX_RETRIES = 4;
const CLAIM_REQUEST_TIMEOUT_MS = 10_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Step = 'network' | { status: number; body: unknown };

function scripted(steps: Step[]): {
  client: AlteroidClient;
  calls: { path: string; options: unknown }[];
  count: () => number;
} {
  const calls: { path: string; options: unknown }[] = [];
  let index = 0;
  const POST = (path: string, options: unknown) => {
    calls.push({ path, options });
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
  return { client: { api: { POST } } as unknown as AlteroidClient, calls, count: () => index };
}

const PENDING_STEP: Step = { status: 202, body: { status: 'pending' } };

const READY_BODY = {
  status: 'ready',
  token: 'alt_secret',
  account: { id: 'acc-1', displayName: '作者', email: 'me@example.com' },
  granted: true,
};

const PENDING = { requestId: 'req-1', claimSecret: 'shhh' };

const future = () => new Date(Date.now() + 60_000).toISOString();
const pending = () => ({ ...PENDING, expiresAt: future(), provider: 'google' });

/** 偽の時計を十分に進めて、待ちを抜けた結果を受け取る（待ちは既定の CLAIM_INTERVAL_MS ごとに1回ずつ） */
async function settled<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('claimUntilReady: 1回の claim の読み取り', () => {
  it('202 の pending は「まだ」として待ち、次の claim を撃つ', async () => {
    const { client, count } = scripted([PENDING_STEP, { status: 200, body: READY_BODY }]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('ready');
    expect(count()).toBe(2);
  });

  it('200 でも本文が pending なら待つ（番号ではなく status で決める）', async () => {
    const { client, count } = scripted([
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: READY_BODY },
    ]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('ready');
    expect(count()).toBe(2);
  });

  it('ready を資格情報に写す', async () => {
    const { client, calls } = scripted([{ status: 200, body: READY_BODY }]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') throw new Error('unreachable');
    expect(outcome.credential.token).toBe('alt_secret');
    expect(outcome.credential.account).toEqual({
      id: 'acc-1',
      displayName: '作者',
      email: 'me@example.com',
    });
    expect(outcome.credential.grantedAtClaim).toBe(true);

    expect(calls[0]).toMatchObject({
      path: '/auth/login/{requestId}/claim',
      options: { params: { path: { requestId: 'req-1' } }, body: { claimSecret: 'shhh' } },
    });
  });

  it('400 は「やり直しても解決しない」として返す（例外にしない）', async () => {
    const { client } = scripted([{ status: 400, body: { error: 'もう使えない' } }]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome).toEqual({ status: 'failed', message: 'もう使えない' });
  });
});

describe('claimUntilReady', () => {
  it('ready になるまで叩き続ける', async () => {
    const { client, calls } = scripted([
      PENDING_STEP,
      PENDING_STEP,
      { status: 200, body: READY_BODY },
    ]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('ready');
    expect(calls).toHaveLength(3);
  });

  it('期限を過ぎたら諦める（永久に回さない）', async () => {
    const { client, calls } = scripted([PENDING_STEP]);

    const outcome = await settled(
      claimUntilReady(client, {
        ...PENDING,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        provider: 'google',
      }),
    );

    expect(outcome).toEqual({
      status: 'failed',
      message: 'ログインの有効期限が切れた。やり直してほしい',
    });
    expect(calls).toHaveLength(0);
  });

  it('待っている途中でログインの期限が来たら、次の claim を撃たずに諦める', async () => {
    const { client, count } = scripted([PENDING_STEP]);

    const outcome = await settled(
      claimUntilReady(client, {
        ...PENDING,
        expiresAt: new Date(Date.now() + CLAIM_INTERVAL_MS - 1).toISOString(),
        provider: 'google',
      }),
    );

    expect(outcome).toEqual({
      status: 'failed',
      message: 'ログインの有効期限が切れた。やり直してほしい',
    });
    expect(count()).toBe(1);
  });

  it('中断できる', async () => {
    const { client } = scripted([PENDING_STEP]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await settled(
      claimUntilReady(client, pending(), { signal: controller.signal }),
    );

    expect(outcome).toEqual({ status: 'failed', message: '中断した' });
  });
});

describe('claimUntilReady の撃ち直し（通信の失敗と 5xx）', () => {
  it('一時的な 503 や通信の失敗の後に ready が返れば、引き取れる', async () => {
    const { client, count } = scripted([
      { status: 503, body: { error: '混んでいる' } },
      'network',
      { status: 200, body: READY_BODY },
    ]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('ready');
    expect(count()).toBe(3);
  });

  it('撃ち直しの間は CLAIM_INTERVAL_MS だけ待つ', async () => {
    const { client, count } = scripted(['network', { status: 200, body: READY_BODY }]);

    const promise = claimUntilReady(client, pending());
    await vi.advanceTimersByTimeAsync(CLAIM_INTERVAL_MS - 1);
    expect(count()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(2);
    expect((await promise).status).toBe('ready');
  });

  it('400 はすぐ失敗にする（撃ち直さない）', async () => {
    const { client, count } = scripted([{ status: 400, body: { error: 'もう使えない' } }]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome).toEqual({ status: 'failed', message: 'もう使えない' });
    expect(count()).toBe(1);
  });

  it('⭐ 通信の失敗の直後に 400 が返ったら、引き取り済みになった可能性とやり直しの案内を添える（#4751）', async () => {
    const { client } = scripted(['network', { status: 400, body: { error: 'もう使えない' } }]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.message).toContain('もう使えない');
    expect(outcome.message).toContain('ログインをやり直してほしい');
  });

  it('通信の失敗の後に pending を受けていれば、続く 400 に案内を添えない（#4751）', async () => {
    const { client } = scripted([
      'network',
      PENDING_STEP,
      { status: 400, body: { error: 'もう使えない' } },
    ]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome).toEqual({ status: 'failed', message: 'もう使えない' });
  });

  it('400 以外の 4xx は撃ち直さず投げる', async () => {
    const { client, count } = scripted([{ status: 403, body: { error: '禁止' } }]);

    const rejected = expect(claimUntilReady(client, pending())).rejects.toThrow('禁止');
    await vi.runAllTimersAsync();
    await rejected;
    expect(count()).toBe(1);
  });

  it('撃ち直しの上限を超えたら失敗として返す', async () => {
    const { client, count } = scripted([{ status: 503, body: { error: '落ちている' } }]);

    const outcome = await settled(claimUntilReady(client, pending()));

    expect(outcome.status).toBe('failed');
    expect(count()).toBe(CLAIM_MAX_RETRIES + 1);
  });

  it('成功（pending）を挟めば失敗の数え直しになる', async () => {
    const steps: Step[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < CLAIM_MAX_RETRIES; i += 1) steps.push('network');
      steps.push(PENDING_STEP);
    }
    steps.push({ status: 200, body: READY_BODY });
    const { client } = scripted(steps);

    // 待ちが 15 回を超えるので、ログインの期限を十分遠くに置く
    const outcome = await settled(
      claimUntilReady(client, {
        ...PENDING,
        provider: 'google',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );

    expect(outcome.status).toBe('ready');
  });

  it('撃ち直しの待ちの間に中断されたら、それ以上叩かない', async () => {
    const { client, count } = scripted(['network']);
    const controller = new AbortController();

    const promise = claimUntilReady(client, pending(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(CLAIM_INTERVAL_MS - 1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);

    expect(await promise).toEqual({ status: 'failed', message: '中断した' });
    expect(count()).toBe(1);
  });
});

describe('claimUntilReady: 返らない claim に期限で見切る（#4706）', () => {
  // 繋がるが何も返さないデーモンの代わり: signal が切れるまで決着しない
  function hangingThenReady(): { client: AlteroidClient; signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    let index = 0;
    const POST = (_path: string, options: { signal?: AbortSignal }) => {
      signals.push(options.signal);
      index += 1;
      if (index === 1) {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      }
      const response = { status: 200, statusText: '' } as Response;
      return Promise.resolve({ data: READY_BODY, response });
    };
    return { client: { api: { POST } } as unknown as AlteroidClient, signals };
  }

  it('⭐ claim の1回が返らなくても、期限で見切って待ちを続け、次の ready で引き取れる', async () => {
    // AbortSignal.timeout は偽の時計では進まない: 同じ長さで setTimeout が abort する signal に差し替える
    const asked: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      asked.push(ms);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    const { client, signals } = hangingThenReady();

    const promise = claimUntilReady(client, {
      ...PENDING,
      provider: 'google',
      expiresAt: '2999-01-01T00:00:00Z',
    });
    await vi.advanceTimersByTimeAsync(CLAIM_REQUEST_TIMEOUT_MS - 1);
    expect(signals).toHaveLength(1);

    // 期限で見切り、撃ち直しの待ちを挟んで2回目へ
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CLAIM_INTERVAL_MS);
    expect(signals).toHaveLength(2);

    const outcome = await promise;
    expect(outcome.status).toBe('ready');
    expect(signals[0]).toBeDefined();
    expect(asked).toEqual([CLAIM_REQUEST_TIMEOUT_MS, CLAIM_REQUEST_TIMEOUT_MS]);
  });
});
