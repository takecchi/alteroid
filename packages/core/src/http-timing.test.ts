import { describe, expect, it } from 'vitest';

import {
  describeHttpTimingBody,
  describeHttpTimingHead,
  renderHttpTimingSummary,
  type HttpTimingEntry,
} from './http-timing-format.js';
import {
  HttpTimingWindow,
  HTTP_TIMING_TOP_ROUTES,
  HTTP_TIMING_TOP_SLOWEST,
  describeHttpTimingSample,
  type HttpTimingSample,
} from './http-timing.js';
import { heuristicChars } from './quantity.js';
import { RequestTiming, currentRequestTiming, runWithRequestTiming } from './request-timing.js';
import type { CloneRuntimeFacts } from './self.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// HTTP API の要求ごとの時間（#5089）

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function sample(overrides: Partial<HttpTimingSample> = {}): HttpTimingSample {
  return {
    route: 'GET /journal',
    status: 200,
    at: '2026-10-20T00:00:00.000Z',
    totalMs: 100,
    db: { count: 2, totalMs: 60, wallMs: 60, waitMs: 0, slowestMs: 40, slowestSql: 'select 1' },
    serializeMs: 5,
    bytes: 1_000,
    ...overrides,
  };
}

describe('RequestTiming', () => {
  it('⭐ 本数・和・最長の1本を数え、並行した問い合わせは wall で1回に数える', () => {
    const clock = fakeClock();
    const timing = new RequestTiming(clock.now);
    const first = timing.queryStarted('select * from journal where type = $1');
    clock.advance(10);
    const second = timing.queryStarted('select * from jobs');
    clock.advance(30);
    first();
    clock.advance(20);
    second();
    clock.advance(100);
    const third = timing.queryStarted('select 1');
    clock.advance(5);
    third();

    expect(timing.db.count).toBe(3);
    // 40 + 50 + 5
    expect(timing.db.totalMs).toBe(95);
    // 0..60 の重なりを1回 + 5
    expect(timing.db.wallMs).toBe(65);
    expect(timing.db.slowestMs).toBe(50);
    expect(timing.db.slowestSql).toBe('select * from jobs');
  });

  it('同じ終わりを2回呼んでも二重に数えない', () => {
    const clock = fakeClock();
    const timing = new RequestTiming(clock.now);
    const end = timing.queryStarted('select 1');
    clock.advance(5);
    end();
    end();
    expect(timing.db.count).toBe(1);
  });

  it('走っている途中の写しは、そこまでを wall に入れる', () => {
    const clock = fakeClock();
    const timing = new RequestTiming(clock.now);
    timing.queryStarted('select pg_sleep(1)');
    clock.advance(70);
    expect(timing.snapshot().wallMs).toBe(70);
    expect(timing.db.wallMs).toBe(0);
  });

  it('空き待ちは足し、0 以下は足さない', () => {
    const timing = new RequestTiming();
    timing.waited(12);
    timing.waited(0);
    timing.waited(-1);
    expect(timing.db.waitMs).toBe(12);
  });

  it('runWithRequestTiming の中だけで器が見え、await を跨いでも同じ器', async () => {
    const timing = new RequestTiming();
    expect(currentRequestTiming()).toBeUndefined();
    await runWithRequestTiming(timing, async () => {
      await Promise.resolve();
      expect(currentRequestTiming()).toBe(timing);
    });
    expect(currentRequestTiming()).toBeUndefined();
  });
});

describe('HttpTimingWindow', () => {
  it('⭐ 経路ごとに回数・中央値・90% 点・最大・DB・本文を束ね、時間を食った順に並べる', () => {
    const window = new HttpTimingWindow(Date.parse('2026-10-20T00:00:00.000Z'));
    for (const totalMs of [10, 20, 30, 40, 50, 60, 70, 80, 90, 1_000]) {
      window.record(sample({ route: 'GET /journal', totalMs, bytes: 100 }));
    }
    window.record(sample({ route: 'GET /progress', totalMs: 5_000, status: 500, bytes: 9_000 }));

    const record = window.drain(Date.parse('2026-10-20T00:10:00.000Z'));
    expect(record?.windowStartedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(record?.windowMs).toBe(600_000);
    expect(record?.requests).toBe(11);
    expect(record?.routes.map((route) => route.route)).toEqual(['GET /progress', 'GET /journal']);
    const journal = record?.routes[1];
    expect(journal).toMatchObject({
      count: 10,
      errors: 0,
      p50Ms: 50,
      p90Ms: 90,
      maxMs: 1_000,
      totalMs: 1_450,
      db: { count: 20, totalMs: 600, wallMs: 600, waitMs: 0 },
      serializeMs: 50,
      bytes: 1_000,
      maxBytes: 100,
    });
    expect(record?.routes[0]?.errors).toBe(1);
    expect(record?.slowest[0]).toMatchObject({
      route: 'GET /progress',
      status: 500,
      totalMs: 5_000,
      db: { slowestMs: 40, slowestSql: 'select 1' },
    });
  });

  it('要求の無い窓は行を返さず、閉じたら次の窓は空から始まる', () => {
    const window = new HttpTimingWindow(0);
    expect(window.drain(1_000)).toBeNull();
    window.record(sample());
    expect(window.drain(2_000)?.requests).toBe(1);
    expect(window.requests).toBe(0);
    expect(window.drain(3_000)).toBeNull();
  });

  it('経路と遅い要求は上限で切り、省いた経路の数を残す', () => {
    const window = new HttpTimingWindow(0);
    for (let i = 0; i < HTTP_TIMING_TOP_ROUTES + 3; i += 1) {
      window.record(sample({ route: `GET /r${String(i)}`, totalMs: i + 1 }));
    }
    const record = window.drain(1_000);
    expect(record?.routes).toHaveLength(HTTP_TIMING_TOP_ROUTES);
    expect(record?.omittedRoutes).toBe(3);
    expect(record?.slowest).toHaveLength(HTTP_TIMING_TOP_SLOWEST);
    expect(record?.slowest[0]?.totalMs).toBe(HTTP_TIMING_TOP_ROUTES + 3);
  });

  it('本文の大きさが分からない要求は、大きさを足さない', () => {
    const window = new HttpTimingWindow(0);
    window.record(sample({ bytes: undefined }));
    const record = window.drain(1_000);
    expect(record?.routes[0]?.bytes).toBe(0);
    expect(record?.slowest[0]).not.toHaveProperty('bytes');
  });
});

describe('http_timing の描き方', () => {
  const entry: HttpTimingEntry = {
    type: 'http_timing',
    id: 'h-1',
    at: '2026-10-20T00:10:00.000Z',
    windowStartedAt: '2026-10-20T00:00:00.000Z',
    windowMs: 600_000,
    requests: 21,
    routes: [
      {
        route: 'GET /progress',
        count: 20,
        errors: 0,
        p50Ms: 400,
        p90Ms: 2_500,
        maxMs: 3_000,
        totalMs: 16_000,
        db: { count: 140, totalMs: 15_000, wallMs: 14_000, waitMs: 0 },
        serializeMs: 200,
        bytes: 2_048_000,
        maxBytes: 204_800,
      },
    ],
    slowest: [
      {
        route: 'GET /progress',
        status: 200,
        at: '2026-10-20T00:05:00.000Z',
        totalMs: 3_000,
        db: {
          count: 7,
          totalMs: 2_800,
          wallMs: 2_800,
          waitMs: 0,
          slowestMs: 2_500,
          slowestSql: 'select "entry" from "journal" where "type" = $1',
        },
        serializeMs: 20,
        bytes: 204_800,
      },
    ],
  };

  it('⭐ 1行目に窓・回数・時間を食った経路・最も遅い要求を出す', () => {
    expect(describeHttpTimingHead(entry)).toBe(
      '[http_timing 10分の窓] 要求 21 回・時間を最も食った経路 GET /progress 合計 16秒・最も遅い要求 GET /progress 3.0秒',
    );
  });

  it('⭐ 本文に経路ごとの内訳と、遅かった要求の DB・整形・本文・最も長い問い合わせを出す', () => {
    const body = describeHttpTimingBody(entry);
    expect(body).toContain(
      'GET /progress: 20 回・中央値 400ms・90% 点 2.5秒・最大 3.0秒・合計 16秒（DB 1回あたり 7.0 本・DB の合計 14秒・整形 200ms・本文 平均 100.0KB・最大 200.0KB）',
    );
    expect(body).toContain(
      'GET /progress 200 3.0秒（DB 7本 2.8秒・整形 20ms・それ以外 180ms・本文 200.0KB）。最も長い問い合わせ 2.5秒: select "entry" from "journal" where "type" = $1',
    );
  });

  it('⭐ 要約は窓を足し、経路ごとの DB の割合と最も遅かった要求を出す', () => {
    const summary = renderHttpTimingSummary([entry, { ...entry, id: 'h-2' }]);
    expect(summary).toContain('HTTP API の時間（2 窓・要求 42 回・2026-10-20T00:00:00.000Z から。');
    expect(summary).toContain(
      'GET /progress: 40 回・平均 800ms・窓の 90% 点の最大 2.5秒・最大 3.0秒・合計 32秒（うち DB 88%・1回あたり DB 7.0 本',
    );
    expect(summary).toContain('最も遅かった要求:');
  });

  it('記録が無ければ、まだ無いと言う', () => {
    expect(renderHttpTimingSummary([])).toContain('まだ記録が無い');
  });

  it('遅い要求の1行は、問い合わせが無ければ SQL を言わない', () => {
    expect(
      describeHttpTimingSample({
        route: 'GET /health',
        status: 200,
        totalMs: 1_200,
        db: { count: 0, totalMs: 0, wallMs: 0, waitMs: 0, slowestMs: 0 },
        serializeMs: 1,
      }),
    ).toBe('GET /health 200 1.2秒（DB 0本 0ms・整形 1ms・それ以外 1.2秒）');
  });
});

const RUNTIME: CloneRuntimeFacts = {
  revision: { commit: null, short: null, source: null },
  buildTime: { builtAt: null },
  declaredModel: 'fable',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: null,
  requestedEffort: null,
  claudeCodeVersion: null,
  apiKeySource: null,
  permissionMode: null,
  requestedPermissionMode: 'auto',
  mcpServers: [],
  sessionId: null,
  resumedFrom: null,
  injectedMemoryChars: heuristicChars(0),
  systemPromptChars: heuristicChars(0),
  lastContextUsage: null,
};

describe('self_status に「HTTP API の時間」の節が出る', () => {
  it('⭐ 日誌の http_timing を読んで要約を出す', async () => {
    const stores = createMemoryStores();
    const window = new HttpTimingWindow(Date.parse('2026-10-20T00:00:00.000Z'));
    window.record(sample({ route: 'GET /commitments', totalMs: 2_000 }));
    const record = window.drain(Date.parse('2026-10-20T00:10:00.000Z'));
    if (record === null) throw new Error('窓が空');
    await stores.journal.append({ type: 'http_timing', ...record });
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      runtime: () => RUNTIME,
    });
    const tool = tools.find((candidate) => candidate.name === 'self_status');
    const reply = await tool?.handler({} as never, {});
    const text = (reply?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(text).toContain('HTTP API の時間（1 窓・要求 1 回');
    expect(text).toContain('GET /commitments: 1 回');
  });
});
