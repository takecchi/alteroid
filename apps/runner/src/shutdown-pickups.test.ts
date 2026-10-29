import type { AddressInfo } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Outbox } from './app.js';
import { shutdownHandingOver } from './index.js';
import { gateDuringShutdown, isPickupRequest, waitForPickups } from './shutdown-pickups.js';

describe('isPickupRequest（#4699）', () => {
  it.each([
    ['GET', '/managers/mgr-1/archive/a1', true],
    ['DELETE', '/managers/mgr-1/archive/a1', true],
    ['GET', '/managers/mgr-1/outbox/f1', true],
    ['DELETE', '/managers/mgr-1/outbox/f1', true],
    // 畳みが待つ物には rescue の預かりも入る（#5518）ので、取りに来る口も通す
    ['GET', '/managers/m/rescue-files/f', true],
    ['DELETE', '/managers/m/rescue-files/f', true],
    ['POST', '/managers/m/rescue-files/f', false],
    ['GET', '/managers/m/rescue-files/f/extra', false],
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
      .get('/managers/:id/rescue-files/:fileId', (c) => c.text('預かったファイル'))
      .delete('/managers/:id/rescue-files/:fileId', (c) => c.body(null, 204))
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

  it('⭐ 畳みの間も、rescue のファイルの取り出し（GET）と削除（DELETE）は通す（#5518）', async () => {
    const base = await serve(() => true);
    const got = await fetch(`${base}/managers/m/rescue-files/f`);
    expect(await got.text()).toBe('預かったファイル');
    const deleted = await fetch(`${base}/managers/m/rescue-files/f`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
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
      inlineUnpickedArchives: () => 0,
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
      host: {
        shutdown: async () => undefined,
        pendingPickups: () => 1,
        inlineUnpickedArchives: () => 0,
      },
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

  // 器の入れ替えの直前に預けた生ログが、取りに行った先の新しいプロセスに無く失われた（#4896）
  it('⭐ 取られないまま上限の手前に来たら、預けた生ログを本文つきで送り直してから口を閉じる', async () => {
    const order: string[] = [];
    let pending = 1;
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);
    const lines: string[] = [];

    await shutdownHandingOver({
      host: {
        shutdown: async () => undefined,
        pendingPickups: () => pending,
        inlineUnpickedArchives: () => {
          order.push('inline');
          pending = 0;
          return 1;
        },
      },
      outbox,
      closeListener: () => order.push('close'),
      // 畳み始めから 40 秒経った体にする（実時間を待たない）: 送り直す時刻（既定 30 秒）は過ぎ、上限（50 秒）は過ぎていない
      startedAt: Date.now() - 40_000,
      drainWaitMs: 0,
      write: (line) => lines.push(line),
    });
    detach();

    expect(order).toEqual(['inline', 'close']);
    expect(lines.join('')).toContain('本文を載せて送り直した');
    expect(lines.join('')).not.toContain('取りに来ないまま止まる');
  });

  it('送り直す時刻より前に取られたら、送り直さない', async () => {
    let pending = 1;
    let inlined = 0;
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);

    await shutdownHandingOver({
      host: {
        shutdown: async () => undefined,
        // 1回目の確認では残り、次の確認で取られている
        pendingPickups: () => {
          const now = pending;
          pending = 0;
          return now;
        },
        inlineUnpickedArchives: () => {
          inlined += 1;
          return 1;
        },
      },
      outbox,
      closeListener: () => undefined,
      drainWaitMs: 0,
      write: () => undefined,
    });
    detach();

    expect(inlined).toBe(0);
  });

  it('デーモンが繋がっていなければ、送り直さない（受ける相手が居ない）', async () => {
    let inlined = 0;
    await shutdownHandingOver({
      host: {
        shutdown: async () => undefined,
        pendingPickups: () => 1,
        inlineUnpickedArchives: () => {
          inlined += 1;
          return 1;
        },
      },
      outbox: new Outbox(),
      closeListener: () => undefined,
      startedAt: Date.now() - 40_000,
      drainWaitMs: 0,
      write: () => undefined,
    });

    expect(inlined).toBe(0);
  });
});

// shutdown() が長引いても、送り直しと待ちの段が止まらない（#4925）
describe('shutdownHandingOver: shutdown() と並行に送り直し、shutdown() が終わるまで（上限 50 秒）口を閉じない（#4925）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('⭐ shutdown() が終わらなくても、SIGTERM から 30 秒で退避を送り直す', async () => {
    vi.useFakeTimers();
    let pending = 1;
    let inlined = 0;
    let closed = false;
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);

    const done = shutdownHandingOver({
      host: {
        shutdown: () => new Promise<void>(() => undefined),
        pendingPickups: () => pending,
        inlineUnpickedArchives: () => {
          inlined += 1;
          pending = 0;
          return 1;
        },
      },
      outbox,
      closeListener: () => (closed = true),
      drainWaitMs: 0,
      write: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(inlined).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(inlined).toBe(1);
    // shutdown() が終わらないので、口を閉じるのは待ちの上限（50 秒）
    await vi.advanceTimersByTimeAsync(19_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    detach();
    expect(closed).toBe(true);
    expect(inlined).toBe(1);
  });

  it('⭐ shutdown() が 30 秒を超えて 35 秒で終わるなら、待ちものが無くても 35 秒まで口を閉じず、終わってから閉じる', async () => {
    vi.useFakeTimers();
    let closed = false;
    let finishShutdown: () => void = () => undefined;
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);

    const done = shutdownHandingOver({
      host: {
        shutdown: () =>
          new Promise<void>((resolve) => {
            finishShutdown = resolve;
          }),
        pendingPickups: () => 0,
        inlineUnpickedArchives: () => 0,
      },
      outbox,
      closeListener: () => (closed = true),
      drainWaitMs: 0,
      write: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(35_000);
    expect(closed).toBe(false);
    finishShutdown();
    await done;
    detach();
    expect(closed).toBe(true);
  });

  it('⭐ shutdown() が終わらないときは、待ちの上限（50 秒）で口を閉じる', async () => {
    vi.useFakeTimers();
    let closed = false;
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);

    const done = shutdownHandingOver({
      host: {
        shutdown: () => new Promise<void>(() => undefined),
        pendingPickups: () => 0,
        inlineUnpickedArchives: () => 0,
      },
      outbox,
      closeListener: () => (closed = true),
      drainWaitMs: 0,
      write: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(49_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    detach();
    expect(closed).toBe(true);
  });
});
