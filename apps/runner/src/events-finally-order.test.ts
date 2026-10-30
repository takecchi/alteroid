import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import * as core from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-finally-order-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /events: finally の片付け順序と取りこぼし無し（#279 心拍・#358/#630 書けなかった分が消えない）', () => {
  it('stopHeartbeat が detach より先に呼ばれる（#279）', async () => {
    const order: string[] = [];

    const realStart = core.startSseHeartbeat;
    const startSpy = vi
      .spyOn(core, 'startSseHeartbeat')
      .mockImplementation((stream, intervalMs, wake) => {
        const stop = realStart(stream, intervalMs, wake);
        return () => {
          order.push('stopHeartbeat');
          stop();
        };
      });

    // /events の接続は `subscribe` で繋ぐ（#5692 で `attach` から変わった）。外し方（`detach`）の呼ばれる順を見る。
    const realSubscribe = Outbox.prototype.subscribe;
    const attachSpy = vi.spyOn(Outbox.prototype, 'subscribe').mockImplementation(function (
      this: Outbox,
      options: Parameters<Outbox['subscribe']>[0],
    ) {
      const subscription = realSubscribe.call(this, options);
      return {
        get superseded() {
          return subscription.superseded;
        },
        peek: () => subscription.peek(),
        wrote: (item, chars) => subscription.wrote(item, chars),
        pending: () => subscription.pending(),
        detach: () => {
          order.push('detach');
          subscription.detach();
        },
      };
    });

    try {
      const host = newHost();
      const outbox = new Outbox();
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 5,
      });

      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();

      await reader.cancel();
      await expect.poll(() => order.length >= 2, { timeout: 1000 }).toBe(true);

      expect(order).toEqual(['stopHeartbeat', 'detach']);
      await host.shutdown();
    } finally {
      startSpy.mockRestore();
      attachSpy.mockRestore();
    }
  });

  it('流し切れなかった出来事は outbox へ戻る（消えない）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };
    outbox.push(event1);
    outbox.push(event2);
    expect(outbox.pending).toBe(2);

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 5,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    expect(outbox.pending).toBe(2);
    await reader.cancel();

    await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(2);

    await host.shutdown();
  });
});
