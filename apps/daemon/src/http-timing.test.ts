import type { CloneHost, HttpTimingSample, JournalEntry } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { httpTimingMiddleware, startHttpTimingCollector } from './http-timing.js';

// HTTP API の要求ごとの時間（#5089）

const authed = { authorization: 'Bearer test-token' };

function recorder(): { samples: HttpTimingSample[]; record: (sample: HttpTimingSample) => void } {
  const samples: HttpTimingSample[] = [];
  return { samples, record: (sample) => samples.push(sample) };
}

describe('httpTimingMiddleware', () => {
  it('⭐ 本物のアプリで、経路の型・状態・本文の大きさを渡し、Server-Timing を付ける（JSON の本文は変えない）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '決めた', grounds: '理由' });
    const sink = recorder();
    const app = createApp({
      clone: {} as unknown as CloneHost,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      journalEvents: { subscribe: () => () => undefined },
      httpTiming: sink,
    });
    const listed = await app.request('/journal', { headers: authed });
    const id = ((await listed.json()) as { entries: JournalEntry[] }).entries[0]?.id ?? '';

    const response = await app.request(`/journal/${id}`, { headers: authed });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ type: 'decision', decision: '決めた' });
    expect(response.headers.get('server-timing')).toMatch(
      /^db;dur=[\d.]+;desc="DB 0 queries", serialize;dur=[\d.]+, app;dur=[\d.]+, total;dur=[\d.]+$/,
    );
    const last = sink.samples.at(-1);
    expect(last?.route).toBe('GET /journal/:id');
    expect(last?.status).toBe(200);
    expect(last?.bytes).toBe(Buffer.byteLength(text));
    // 値の入った実際のパスは載せない
    expect(JSON.stringify(sink.samples)).not.toContain(id);
  });

  it('見つからなかった要求も、経路の型と 404 で数える', async () => {
    const sink = recorder();
    const app = createApp({
      clone: {} as unknown as CloneHost,
      stores: createMemoryStores(),
      token: 'test-token',
      shutdown: () => undefined,
      journalEvents: { subscribe: () => () => undefined },
      httpTiming: sink,
    });
    const response = await app.request('/journal/no-such-id', { headers: authed });
    expect(response.status).toBe(404);
    expect(sink.samples.at(-1)).toMatchObject({ route: 'GET /journal/:id', status: 404 });
  });

  it('どの経路にも当たらない要求は、パスを載せずにまとめる', async () => {
    const sink = recorder();
    const app = new Hono();
    app.use('*', httpTimingMiddleware(sink));
    app.get('/known', (c) => c.json({ ok: true }));
    const response = await app.request('/secret-looking-path-123');
    expect(response.status).toBe(404);
    expect(sink.samples[0]?.route).toBe('GET （経路なし）');
  });

  it('c.json の状態・追加の頭を保つ', async () => {
    const app = new Hono();
    app.use('*', httpTimingMiddleware(undefined));
    app.get('/x', (c) => c.json({ error: 'nope' }, 409, { 'X-Extra': '1' }));
    const response = await app.request('/x');
    expect(response.status).toBe(409);
    expect(response.headers.get('x-extra')).toBe('1');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'nope' });
  });

  it('ハンドラが投げて onError が答えた要求も、500 として数える', async () => {
    const sink = recorder();
    const app = new Hono();
    app.onError((_err, c) => c.json({ error: 'Internal Server Error' }, 500));
    app.use('*', httpTimingMiddleware(sink));
    app.get('/boom', () => {
      throw new Error('boom');
    });
    const response = await app.request('/boom');
    expect(response.status).toBe(500);
    expect(sink.samples[0]).toMatchObject({ route: 'GET /boom', status: 500 });
  });

  it('SSE は数えない（流れている時間は要求の遅さではない）', async () => {
    const sink = recorder();
    const app = new Hono();
    app.use('*', httpTimingMiddleware(sink));
    app.get('/events', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: 'x' });
      }),
    );
    const response = await app.request('/events');
    await response.text();
    expect(sink.samples).toEqual([]);
  });
});

describe('startHttpTimingCollector', () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  function sample(overrides: Partial<HttpTimingSample> = {}): HttpTimingSample {
    return {
      route: 'GET /progress',
      status: 200,
      at: '2026-10-20T00:00:00.000Z',
      totalMs: 50,
      db: { count: 3, totalMs: 30, wallMs: 30, waitMs: 0, slowestMs: 20 },
      serializeMs: 1,
      bytes: 10,
      ...overrides,
    };
  }

  it('⭐ 窓を閉じると日誌へ1行だけ書き、要求の無い窓は書かない', async () => {
    const stores = createMemoryStores();
    const lines: string[] = [];
    let now = Date.parse('2026-10-20T00:00:00.000Z');
    const collector = startHttpTimingCollector({
      journal: stores.journal,
      intervalMs: 60 * 60_000,
      writeLine: (line) => lines.push(line),
      onDropped: () => undefined,
      clock: () => now,
    });
    stops.push(() => collector.stop());

    collector.record(sample());
    collector.record(sample({ totalMs: 70 }));
    now += 600_000;
    await collector.flush();
    await collector.flush();

    const rows = await stores.journal.list({ types: ['http_timing'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'http_timing',
      windowStartedAt: '2026-10-20T00:00:00.000Z',
      windowMs: 600_000,
      requests: 2,
    });
    expect(lines).toEqual([]);
  });

  it('遅い要求はその場で stderr へ1行出す', () => {
    const lines: string[] = [];
    const collector = startHttpTimingCollector({
      journal: createMemoryStores().journal,
      writeLine: (line) => lines.push(line),
      onDropped: () => undefined,
    });
    stops.push(() => collector.stop());
    collector.record(
      sample({
        totalMs: 2_400,
        db: {
          count: 7,
          totalMs: 2_000,
          wallMs: 2_000,
          waitMs: 0,
          slowestMs: 1_500,
          slowestSql: 'select x',
        },
      }),
    );
    expect(lines).toEqual([
      'alteroidd: 遅い要求 GET /progress 200 2.4秒（DB 7本 2.0秒・整形 1ms・それ以外 399ms・本文 10B）。最も長い問い合わせ 1.5秒: select x\n',
    ]);
  });

  it('書けなかった窓は落とした記録として知らせ、投げない', async () => {
    const dropped: unknown[] = [];
    const collector = startHttpTimingCollector({
      journal: { append: () => Promise.reject(new Error('disk full')) },
      writeLine: () => undefined,
      onDropped: (error) => dropped.push(error),
    });
    collector.record(sample());
    await collector.stop();
    expect(dropped).toHaveLength(1);
  });
});
