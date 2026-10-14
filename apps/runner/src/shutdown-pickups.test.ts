import type { AddressInfo } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { Outbox } from './app.js';
import { shutdownHandingOver } from './index.js';
import { gateDuringShutdown, isPickupRequest, waitForPickups } from './shutdown-pickups.js';

describe('isPickupRequest（#4699）', () => {
  it.each([
    ['GET', '/managers/mgr-1/archive/a1', true],
    ['DELETE', '/managers/mgr-1/archive/a1', true],
    ['GET', '/managers/mgr-1/outbox/f1', true],
    ['DELETE', '/managers/mgr-1/outbox/f1', true],
    ['POST', '/managers', false],
    ['POST', '/managers/mgr-1/resume', false],
    ['POST', '/managers/mgr-1/messages', false],
    ['GET', '/events', false],
    ['GET', '/health', false],
    ['GET', '/managers/mgr-1/transcript', false],
    ['GET', '/managers/mgr-1/archive/a1/extra', false],
  ])('%s %s → %s', (method, path, expected) => {
    expect(isPickupRequest(method, path)).toBe(expected);
  });
});

describe('gateDuringShutdown: 畳みの間は取りに来る要求だけを通す（#4699）', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(stopping: () => boolean): Promise<string> {
    const app = new Hono()
      .get('/managers/:id/archive/:archiveId', (c) => c.text('生ログ'))
      .post('/managers', (c) => c.json({ ok: true }));
    const server = createAdaptorServer({ fetch: gateDuringShutdown(app.fetch, stopping) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it('畳む前は、どの要求も通す', async () => {
    const base = await serve(() => false);
    expect((await fetch(`${base}/managers`, { method: 'POST' })).status).toBe(200);
  });

  it('⭐ 畳みの間も、預けた生ログの取り出しは通す', async () => {
    const base = await serve(() => true);
    const response = await fetch(`${base}/managers/mgr-1/archive/a1`);
    expect(await response.text()).toBe('生ログ');
  });

  it('⭐ 畳みの間の start は、応答を返さずに繋ぎを壊す（口を閉じていた今までと同じく繋がらない）', async () => {
    const base = await serve(() => true);
    await expect(fetch(`${base}/managers`, { method: 'POST' })).rejects.toThrow();
  });
});

describe('waitForPickups（#4699）', () => {
  it('預けた物が取られ切ったら返る', async () => {
    let pending = 2;
    setTimeout(() => (pending = 0), 20);
    const left = await waitForPickups({
      pending: () => pending,
      subscribed: () => true,
      deadlineAt: Date.now() + 5_000,
      pollMs: 5,
    });
    expect(left).toBe(0);
  });

  it('デーモンが繋がっていなければ待たない', async () => {
    const started = Date.now();
    const left = await waitForPickups({
      pending: () => 3,
      subscribed: () => false,
      deadlineAt: Date.now() + 5_000,
      pollMs: 5,
    });
    expect(left).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('期限に達したら、残りの数を返して待つのをやめる', async () => {
    const left = await waitForPickups({
      pending: () => 1,
      subscribed: () => true,
      deadlineAt: Date.now() + 30,
      pollMs: 5,
    });
    expect(left).toBe(1);
  });
});

describe('shutdownHandingOver: 口は預けた物が取られてから閉じる（#4699）', () => {
  it('⭐ 畳み終えても、預けた物が取られるまでは口を閉じない', async () => {
    const order: string[] = [];
    let pending = 0;
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);
    const host = {
      shutdown: async () => {
        order.push('host.shutdown');
        pending = 2;
        // デーモンが参照を受けてから取りに来る（少し遅れて消す）
        setTimeout(() => {
          order.push('picked');
          pending = 0;
        }, 30);
      },
      pendingPickups: () => pending,
    };

    await shutdownHandingOver({
      host,
      outbox,
      closeListener: () => order.push('close'),
      drainWaitMs: 0,
      write: () => undefined,
    });
    detach();

    expect(order).toEqual(['host.shutdown', 'picked', 'close']);
  });

  it('期限までに取られなければ、残りを1行書いて口を閉じる', async () => {
    const lines: string[] = [];
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);
    let closed = false;

    await shutdownHandingOver({
      host: { shutdown: async () => undefined, pendingPickups: () => 1 },
      outbox,
      closeListener: () => (closed = true),
      drainWaitMs: 0,
      pickupWaitLimitMs: 30,
      write: (line) => lines.push(line),
    });
    detach();

    expect(closed).toBe(true);
    expect(lines.join('')).toContain('1 件を、デーモンが取りに来ないまま止まる');
  });
});
