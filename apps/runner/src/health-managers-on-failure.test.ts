import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function heldSdk(): {
  fn: typeof sdkQuery;
  fail: (error: unknown) => void;
  failNth: (index: number, error: unknown) => void;
} {
  const rejects: ((error: unknown) => void)[] = [];
  const fn = ((): Query => {
    let reject!: (error: unknown) => void;
    const held = new Promise<IteratorResult<never>>((_resolve, rejectHeld) => {
      reject = rejectHeld;
    });
    rejects.push(reject);
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<never>> => held,
      return: (): Promise<IteratorResult<never>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
    return Object.assign(stream, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return {
    fn,
    fail: (error) => {
      for (const reject of rejects) reject(error);
    },
    failNth: (index, error) => {
      const reject = rejects[index];
      if (reject === undefined) throw new Error('その番号のセッションは開いていない');
      reject(error);
    },
  };
}

async function readHealth(
  app: ReturnType<typeof createRunnerApp>,
): Promise<Record<string, unknown>> {
  const response = await app.request('/health', {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function hostOf(runnerId: string, events: RunnerEvent[], queryFn: typeof sdkQuery): RunnerHost {
  return createRunnerHost({
    runnerId,
    workspacePath: '/workspace',
    emit: (event) => events.push(event),
    queryFn,
    env: { PATH: '/usr/bin' },
  });
}

async function waitForClosed(
  events: RunnerEvent[],
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
  await vi.waitFor(() => {
    closed = events.find(
      (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
    );
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');
  });
  if (closed === undefined) throw new Error('closed がまだ降りてきていない');
  return closed;
}

describe('起動失敗が /health の managers を減らす（#712 の輪の後半）', () => {
  it('セッションが failed で落ちると、/health の managers が 1 から 0 へ減る', async () => {
    const events: RunnerEvent[] = [];
    const sdk = heldSdk();
    const host = hostOf('runner-712', events, sdk.fn);
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    expect((await readHealth(app)).managers).toBe(0);

    await host.start({ managerId: 'mgr-712', request: '最初の依頼', cwd: '/workspace' });
    expect((await readHealth(app)).managers).toBe(1);

    sdk.fail(new Error('合成した起動失敗（本物の資源枯渇は再現しない）'));

    const closed = await waitForClosed(events);
    expect(closed.status).toBe('failed');

    expect((await readHealth(app)).managers).toBe(0);

    await host.shutdown();
  });

  it('2本のうち1本だけ落ちても、減るのは落ちた1本ぶんである（全部消えたのではない）', async () => {
    const events: RunnerEvent[] = [];
    const sdk = heldSdk();
    const host = hostOf('runner-712-pair', events, sdk.fn);
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    await host.start({ managerId: 'mgr-712-a', request: '依頼A', cwd: '/workspace' });
    await host.start({ managerId: 'mgr-712-b', request: '依頼B', cwd: '/workspace' });
    expect((await readHealth(app)).managers).toBe(2);

    // `host.stop()` を使わない: `#finish` を通らない別の終わり口で、この経路ではないため。
    sdk.failNth(0, new Error('合成した起動失敗（1本目だけ）'));

    const closed = await waitForClosed(events);
    expect(closed.status).toBe('failed');
    expect(closed.managerId).toBe('mgr-712-a');

    expect((await readHealth(app)).managers).toBe(1);

    // 残りも落としてから畳む: 待ち続ける偽 SDK を抱えたまま `shutdown()` を呼ぶと返らないため。
    sdk.fail(new Error('後片付け'));
    await host.shutdown();
  });
});
