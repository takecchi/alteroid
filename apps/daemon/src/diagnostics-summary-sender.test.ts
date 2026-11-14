import type {
  CloneHost,
  DiagnosticsSummary,
  InboxEvent,
  JournalEntry,
  Stores,
} from '@alteroid/core';
import {
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  fakeCloneHost,
  jsonByteLength,
} from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import {
  DIAGNOSTICS_SEND_MAX_ATTEMPTS_PER_DAY,
  DIAGNOSTICS_SINK_KEY_ENV,
  DIAGNOSTICS_SINK_URL_ENV,
  createDiagnosticsSender,
  previousCompletedUtcDay,
  readDiagnosticsSinkConfig,
  startDiagnosticsSummarySending,
  type SinkConfig,
} from './diagnostics-summary-sender.js';

// 試験用のダミー。本物の鍵ではない
const KEY = 'altk_DUMMYSINKKEY0123456789abcdefABCDEF';
const URL_OK = 'https://sink.example';
const DAY13 = '2026-11-13';
const NOW = '2026-11-14T03:00:00.000Z';
const HOUR = 60 * 60 * 1000;

type Enabled = Extract<SinkConfig, { state: 'enabled' }>;
function enabled(url = URL_OK): Enabled {
  const config = readDiagnosticsSinkConfig({
    [DIAGNOSTICS_SINK_URL_ENV]: url,
    [DIAGNOSTICS_SINK_KEY_ENV]: KEY,
  });
  if (config.state !== 'enabled') throw new Error(`有効にならない: ${config.state}`);
  return config;
}

function turnUsage(managerId = 'mgr-a') {
  return {
    type: 'turn_usage',
    layer: 'clone',
    site: 'session',
    managerId,
    models: {
      opus: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        webSearchRequests: 0,
        costUsd: 0.1,
      },
    },
  } as never;
}

/** `at` は日誌の追記時の時計になる（メモリのストアは `new Date()`）ので、時計を動かしてから積む */
async function seed(stores: Stores, atIso: string, managerId = 'mgr-a'): Promise<void> {
  vi.setSystemTime(new Date(atIso));
  await stores.journal.append(turnUsage(managerId));
}

async function sendRows(
  stores: Stores,
): Promise<Extract<JournalEntry, { type: 'diagnostics_summary_send' }>[]> {
  const page = await stores.journal.list({ types: ['diagnostics_summary_send'], order: 'asc' });
  return page.filter(
    (entry): entry is Extract<JournalEntry, { type: 'diagnostics_summary_send' }> =>
      entry.type === 'diagnostics_summary_send',
  );
}

const rpcOk = (duplicate: boolean) =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true, id: 'j1', duplicate },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

let stores: Stores;
let lines: string[];
let outputs: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  stores = createMemoryStores();
  lines = [];
  outputs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    outputs.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    outputs.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSender(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<Parameters<typeof createDiagnosticsSender>[0]> = {},
) {
  const fetchSpy = vi.fn(fetchImpl);
  const sender = createDiagnosticsSender({
    config: enabled(),
    journal: stores.journal,
    usage: stores.usage,
    now: () => new Date(),
    fetch: fetchSpy as unknown as typeof fetch,
    env: { [DIAGNOSTICS_SINK_KEY_ENV]: KEY },
    resolveTimeZone: () => 'Asia/Tokyo',
    writeLine: (line) => lines.push(line),
    ...overrides,
  });
  return { sender, fetchSpy };
}

async function withData(): Promise<void> {
  await seed(stores, `${DAY13}T05:00:00.000Z`);
  await seed(stores, `${DAY13}T06:00:00.000Z`);
  vi.setSystemTime(new Date(NOW));
}

describe('設定: 両方そろったときだけ有効（既定は無効）', () => {
  it('両方無い・片方だけ・両方の組み合わせ', () => {
    expect(readDiagnosticsSinkConfig({}).state).toBe('disabled');
    expect(readDiagnosticsSinkConfig({ [DIAGNOSTICS_SINK_URL_ENV]: URL_OK })).toEqual({
      state: 'partial',
      missing: 'key',
    });
    expect(readDiagnosticsSinkConfig({ [DIAGNOSTICS_SINK_KEY_ENV]: KEY })).toEqual({
      state: 'partial',
      missing: 'url',
    });
    expect(enabled().endpoint).toBe('https://sink.example/mcp');
  });

  it('空白だけの値は無いのと同じ', () => {
    expect(
      readDiagnosticsSinkConfig({
        [DIAGNOSTICS_SINK_URL_ENV]: '  ',
        [DIAGNOSTICS_SINK_KEY_ENV]: KEY,
      }),
    ).toEqual({ state: 'partial', missing: 'url' });
  });

  it.each([
    ['http の外部ホスト', 'http://sink.example'],
    ['http の別 IP', 'http://10.0.0.5:4517'],
    ['パス付き', 'https://sink.example/mcp'],
    ['パス付き（深い）', 'https://sink.example/a/b'],
    ['クエリ付き', 'https://sink.example/?a=1'],
    ['空のクエリ', 'https://sink.example/?'],
    ['フラグメント付き', 'https://sink.example/#x'],
    ['認証情報付き', 'https://user:pass@sink.example'],
    ['ユーザー名だけ', 'https://user@sink.example'],
    ['URL でない', 'sink.example'],
    ['別のスキーム', 'ftp://sink.example'],
  ])('断る: %s', (_name, url) => {
    const config = readDiagnosticsSinkConfig({
      [DIAGNOSTICS_SINK_URL_ENV]: url,
      [DIAGNOSTICS_SINK_KEY_ENV]: KEY,
    });
    expect(config.state).toBe('not_configured');
  });

  it.each([
    'http://127.0.0.1:4517',
    'http://localhost:4517',
    'http://[::1]:4517',
    'https://sink.example:8443',
  ])('通す: %s', (url) => {
    expect(enabled(url).state).toBe('enabled');
  });

  it('sinkHost は host だけ（パス・鍵・認証情報を含まない）', () => {
    expect(enabled('https://sink.example:8443').host).toBe('sink.example:8443');
    expect(enabled('https://sink.example/').host).not.toContain('/');
  });

  it('無効のとき: 何も読まず何も書かず、何も送らず、ログも出さない（start は undefined）', () => {
    const touched: string[] = [];
    const trap = new Proxy(
      {},
      {
        get: (_t, prop) => {
          touched.push(String(prop));
          throw new Error('触ってはいけない');
        },
      },
    );
    const fetchSpy = vi.fn();
    const started = startDiagnosticsSummarySending({
      env: {},
      stores: { journal: trap, usage: trap } as unknown as Stores,
      fetch: fetchSpy as unknown as typeof fetch,
      writeLine: (line) => lines.push(line),
    });
    expect(started).toBeUndefined();
    expect(touched).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('片方しか無いとき: 動かず、起動時に1行だけ言う（値は出さない）', () => {
    const fetchSpy = vi.fn();
    const started = startDiagnosticsSummarySending({
      env: { [DIAGNOSTICS_SINK_KEY_ENV]: KEY },
      stores,
      fetch: fetchSpy as unknown as typeof fetch,
      writeLine: (line) => lines.push(line),
    });
    expect(started).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(DIAGNOSTICS_SINK_URL_ENV);
    expect(lines[0]).not.toContain(KEY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('URL が不正なとき: 動かず1行（URL の値は出さない）', () => {
    const started = startDiagnosticsSummarySending({
      env: {
        [DIAGNOSTICS_SINK_URL_ENV]: 'https://user:hunter2@sink.example/x',
        [DIAGNOSTICS_SINK_KEY_ENV]: KEY,
      },
      stores,
      writeLine: (line) => lines.push(line),
    });
    expect(started).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain(KEY);
  });

  it('有効なとき: 起動時に1行（送り先は host だけ。鍵は出さない）。起動時に1回走り、止められる', async () => {
    await withData();
    const fetchSpy = vi.fn(async () => rpcOk(false));
    const started = startDiagnosticsSummarySending({
      env: { [DIAGNOSTICS_SINK_URL_ENV]: URL_OK, [DIAGNOSTICS_SINK_KEY_ENV]: KEY },
      stores,
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => new Date(),
      intervalMs: 3_600_000,
      writeLine: (line) => lines.push(line),
    });
    expect(started).toBeDefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sink.example');
    expect(lines[0]).not.toContain(KEY);
    await started?.refresh();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    started?.stop();
  });
});

describe('いつ・何を送るか', () => {
  it('直前の完了した UTC の1日 [D 00:00Z, D+1 00:00Z)', () => {
    expect(previousCompletedUtcDay(new Date('2026-11-14T00:00:00.000Z'))).toEqual({
      start: '2026-11-13T00:00:00.000Z',
      end: '2026-11-14T00:00:00.000Z',
    });
    expect(previousCompletedUtcDay(new Date('2026-11-14T23:59:59.999Z')).start).toBe(
      '2026-11-13T00:00:00.000Z',
    );
  });

  it('1日1回だけ送る（同じ日の2回目の周期は送らない）', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false));
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'sent', attempt: 1 });
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'already_done' });
    vi.setSystemTime(new Date(Date.parse(NOW) + 5 * HOUR));
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'already_done' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await sendRows(stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'sent',
      attempt: 1,
      period: { start: `${DAY13}T00:00:00.000Z`, end: '2026-11-14T00:00:00.000Z' },
      sinkHost: 'sink.example',
      httpStatus: 200,
    });
  });

  it('再起動（別のインスタンス）してもその日は送らない: 済みの判定は日誌の送信結果から', async () => {
    await withData();
    const first = makeSender(async () => rpcOk(false));
    await first.sender.runOnce();
    const second = makeSender(async () => rpcOk(false));
    expect(await second.sender.runOnce()).toEqual({ kind: 'idle', why: 'already_done' });
    expect(second.fetchSpy).not.toHaveBeenCalled();
  });

  it('duplicate も「済み」: その日はもう送らない', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => rpcOk(true));
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'duplicate', attempt: 1 });
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'already_done' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('停止明け: 何日止まっていても、送るのは直前の完了日の1日だけ（遡らない）', async () => {
    // 11-10 と 11-13 に診断の行がある。11-14 の朝に起きたら、送るのは 11-13 の分だけ
    await seed(stores, '2026-11-10T05:00:00.000Z');
    await seed(stores, `${DAY13}T05:00:00.000Z`);
    vi.setSystemTime(new Date(NOW));
    const bodies: string[] = [];
    const { sender, fetchSpy } = makeSender(async (_url, init) => {
      bodies.push(String(init.body));
      return rpcOk(false);
    });
    await sender.runOnce();
    await sender.runOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await sendRows(stores);
    expect(rows.map((row) => row.period.start)).toEqual([`${DAY13}T00:00:00.000Z`]);
    const sent = JSON.parse(bodies[0] ?? '{}') as {
      params: { arguments: { summary: DiagnosticsSummary } };
    };
    const period = sent.params.arguments.summary.period;
    expect(period?.start.startsWith(DAY13)).toBe(true);
    expect(period?.end.startsWith(DAY13)).toBe(true);
  });

  it('翌日になれば、その日の分を送る（日が変われば試行も数え直す）', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false));
    await sender.runOnce();
    await seed(stores, '2026-11-14T05:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-15T03:00:00.000Z'));
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'sent', attempt: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('台帳の日付の切り方（サーバの TZ）が要約に残る: 窓が UTC の1日であることとのずれを読める', async () => {
    await withData();
    const bodies: string[] = [];
    const { sender } = makeSender(async (_url, init) => {
      bodies.push(String(init.body));
      return rpcOk(false);
    });
    await sender.runOnce();
    const summary = (
      JSON.parse(bodies[0] ?? '{}') as { params: { arguments: { summary: DiagnosticsSummary } } }
    ).params.arguments.summary;
    expect(summary.ledgerDateTimeZone).toMatchObject({ state: 'known', name: 'Asia/Tokyo' });
  });

  it('診断の行が1行も無い日は送らず、not_generated（no_diagnostics）を1回だけ残す', async () => {
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false));
    expect(await sender.runOnce()).toEqual({
      kind: 'recorded',
      outcome: 'not_generated',
      attempt: 1,
    });
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'already_done' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await sendRows(stores))[0]).toMatchObject({ reason: 'no_diagnostics' });
  });
});

describe('試行の上限・429', () => {
  it('失敗の再試行は1日6回で止まり、試行ごとに1行残る。日が変われば翌日の分へ', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => new Response('x', { status: 503 }));
    const results = [];
    for (let i = 0; i < 9; i += 1) results.push(await sender.runOnce());
    expect(fetchSpy).toHaveBeenCalledTimes(DIAGNOSTICS_SEND_MAX_ATTEMPTS_PER_DAY);
    expect(DIAGNOSTICS_SEND_MAX_ATTEMPTS_PER_DAY).toBe(6);
    expect(results[5]).toEqual({ kind: 'recorded', outcome: 'failed', attempt: 6 });
    expect(results[6]).toEqual({ kind: 'idle', why: 'attempts_exhausted' });
    const rows = await sendRows(stores);
    expect(rows.map((row) => row.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.every((row) => row.outcome === 'failed' && row.reason === 'http_5xx')).toBe(true);
    // 翌日の分は新しく数える
    await seed(stores, '2026-11-14T05:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-15T03:00:00.000Z'));
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'failed', attempt: 1 });
  });

  it('再起動しても試行の数は日誌から読み直す（再起動で6回が6回増えない）', async () => {
    await withData();
    for (let i = 0; i < 4; i += 1) {
      const { sender } = makeSender(async () => new Response('x', { status: 503 }));
      await sender.runOnce();
    }
    const { sender, fetchSpy } = makeSender(async () => new Response('x', { status: 503 }));
    await sender.runOnce();
    await sender.runOnce();
    await sender.runOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await sendRows(stores)).toHaveLength(6);
  });

  it('429 の Retry-After を尊重する: その時間のあいだの周期は送らない（日誌にも書かない）', async () => {
    await withData();
    let call = 0;
    const { sender, fetchSpy } = makeSender(async () => {
      call += 1;
      return call === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '7200' } })
        : rpcOk(false);
    });
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'rejected', attempt: 1 });
    vi.setSystemTime(new Date(Date.parse(NOW) + HOUR));
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'paused' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await sendRows(stores)).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * HOUR + 1000));
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'sent', attempt: 2 });
    expect((await sendRows(stores))[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'rate_limited',
      httpStatus: 429,
    });
  });

  it('Retry-After が HTTP の日付でも読める', async () => {
    await withData();
    const until = new Date(Date.parse(NOW) + 3 * HOUR).toUTCString();
    const { sender, fetchSpy } = makeSender(
      async () => new Response('x', { status: 429, headers: { 'retry-after': until } }),
    );
    await sender.runOnce();
    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * HOUR));
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'paused' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('送る前の検査', () => {
  it('秘密らしい値（altk_…）が入った managerId: 生成を断り、fetch は1回も呼ばれず、not_generated が残る', async () => {
    await seed(stores, `${DAY13}T05:00:00.000Z`, 'altk_LEAKEDKEYLEAKEDKEYLEAKEDKEY01');
    vi.setSystemTime(new Date(NOW));
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false));
    expect(await sender.runOnce()).toEqual({
      kind: 'recorded',
      outcome: 'not_generated',
      attempt: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await sendRows(stores);
    expect(rows[0]).toMatchObject({ outcome: 'not_generated', reason: 'secret_pattern' });
    // 見つけた文字列そのものは、送信結果の行にも出力にも残らない（元の診断の行は日誌に在る）
    expect(JSON.stringify(rows)).not.toContain('LEAKEDKEY');
    expect([...lines, ...outputs].join('')).not.toContain('LEAKEDKEY');
  });

  it('鍵そのものが要約へ紛れた場合も送らない（送る本文に鍵が含まれない二重の確認）', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false), {
      build: ((input: never, options: never) => {
        void input;
        void options;
        return {
          period: { start: `${DAY13}T05:00:00.000Z`, end: `${DAY13}T06:00:00.000Z` },
          note: KEY,
        };
      }) as never,
    });
    await sender.runOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await sendRows(stores))[0]).toMatchObject({
      outcome: 'not_generated',
      reason: 'secret_pattern',
    });
  });

  it('16 KiB を超える要約は、生成側（検査）をすり抜けても送る直前の二重の確認で止まる', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false), {
      build: (() => ({
        period: { start: `${DAY13}T05:00:00.000Z`, end: `${DAY13}T06:00:00.000Z` },
        padding: 'x'.repeat(17 * 1024),
      })) as never,
    });
    expect(await sender.runOnce()).toEqual({
      kind: 'recorded',
      outcome: 'not_generated',
      attempt: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await sendRows(stores))[0]).toMatchObject({ reason: 'oversize' });
  });

  it('実際に送る要約は 16 KiB 以内', async () => {
    await withData();
    const bodies: string[] = [];
    const { sender } = makeSender(async (_url, init) => {
      bodies.push(String(init.body));
      return rpcOk(false);
    });
    await sender.runOnce();
    const summary = (
      JSON.parse(bodies[0] ?? '{}') as { params: { arguments: { summary: unknown } } }
    ).params.arguments.summary;
    expect(jsonByteLength(summary)).toBeLessThanOrEqual(16 * 1024);
  });

  it('日誌の行が上限を超える日は、黙って切らず、送らずに failed（too_many_rows）で残す', async () => {
    await seed(stores, `${DAY13}T05:00:00.000Z`);
    await seed(stores, `${DAY13}T05:01:00.000Z`);
    await seed(stores, `${DAY13}T05:02:00.000Z`);
    vi.setSystemTime(new Date(NOW));
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false), { maxRows: 2 });
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'failed', attempt: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await sendRows(stores))[0]).toMatchObject({
      outcome: 'failed',
      reason: 'too_many_rows',
    });
  });

  it('窓の外の行（前の日・次の日）は読まない', async () => {
    await seed(stores, '2026-11-12T23:59:59.999Z', 'mgr-before');
    await seed(stores, `${DAY13}T05:00:00.000Z`, 'mgr-in');
    await seed(stores, '2026-11-14T00:00:00.000Z', 'mgr-after');
    vi.setSystemTime(new Date(NOW));
    const bodies: string[] = [];
    const { sender } = makeSender(async (_url, init) => {
      bodies.push(String(init.body));
      return rpcOk(false);
    });
    await sender.runOnce();
    expect(bodies[0]).toContain('mgr-in');
    expect(bodies[0]).not.toContain('mgr-before');
    expect(bodies[0]).not.toContain('mgr-after');
  });
});

describe('送り方と分類', () => {
  it('POST {origin}/mcp、Bearer・Accept・content-type、redirect: error、タイムアウト付き。JSON-RPC の tools/call', async () => {
    await withData();
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false));
    await sender.runOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://sink.example/mcp');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['accept']).toBe('application/json, text/event-stream');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(init?.body)) as {
      jsonrpc: string;
      method: string;
      params: { name: string; arguments: { summary: unknown } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('report_diagnostics_summary');
    expect(Object.keys(body.params.arguments)).toEqual(['summary']);
  });

  const classification: Array<[string, () => Promise<Response>, string, string | undefined]> = [
    ['成功', async () => rpcOk(false), 'sent', undefined],
    ['重複', async () => rpcOk(true), 'duplicate', undefined],
    [
      'ツールエラー（isError）',
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { isError: true, content: [{ type: 'text', text: 'ひみつの文面 SECRET-MSG' }] },
          }),
          { status: 200 },
        ),
      'rejected',
      'receiver_rejected',
    ],
    [
      'JSON-RPC エラー',
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'SECRET-MSG' } }),
          { status: 200 },
        ),
      'rejected',
      'receiver_rejected',
    ],
    ['401', async () => new Response('SECRET-MSG', { status: 401 }), 'rejected', 'unauthorized'],
    ['403', async () => new Response('', { status: 403 }), 'rejected', 'forbidden'],
    ['413', async () => new Response('', { status: 413 }), 'rejected', 'payload_too_large'],
    ['429', async () => new Response('', { status: 429 }), 'rejected', 'rate_limited'],
    ['400', async () => new Response('', { status: 400 }), 'rejected', 'http_4xx'],
    ['406', async () => new Response('', { status: 406 }), 'rejected', 'http_4xx'],
    ['500', async () => new Response('SECRET-MSG', { status: 500 }), 'failed', 'http_5xx'],
    ['503', async () => new Response('', { status: 503 }), 'failed', 'http_5xx'],
    [
      '200 だが JSON でない',
      async () => new Response('<html>', { status: 200 }),
      'failed',
      'unexpected_response',
    ],
    [
      '200 だが ok が無い',
      async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 }),
      'failed',
      'unexpected_response',
    ],
    [
      'タイムアウト',
      async () => {
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
      },
      'failed',
      'timeout',
    ],
    [
      'ネットワーク失敗',
      async () => {
        throw new TypeError(`fetch failed ${KEY}`);
      },
      'failed',
      'network',
    ],
    [
      'リダイレクト（redirect: error の例外）',
      async () => {
        throw new TypeError('unexpected redirect');
      },
      'failed',
      'network',
    ],
  ];

  it.each(classification)('分類: %s', async (_name, respond, outcome, reason) => {
    await withData();
    const { sender } = makeSender(respond);
    expect(await sender.runOnce()).toMatchObject({ kind: 'recorded', outcome });
    const [row] = await sendRows(stores);
    expect(row?.outcome).toBe(outcome);
    expect(row?.reason).toBe(reason);
    // 受け手のメッセージ・例外の文面は日誌に載らない
    expect(JSON.stringify(row)).not.toContain('SECRET-MSG');
    expect(JSON.stringify(row)).not.toContain('fetch failed');
    expect(row?.sinkHost).toBe('sink.example');
  });

  it('日誌に残る reason は固定の語彙だけ（自由文を持てない）', async () => {
    const { journalEntrySchema } = await import('@alteroid/core');
    const parsed = journalEntrySchema.safeParse({
      type: 'diagnostics_summary_send',
      id: 'x',
      at: NOW,
      period: { start: '2026-11-13T00:00:00.000Z', end: '2026-11-14T00:00:00.000Z' },
      outcome: 'failed',
      attempt: 1,
      reason: 'connect ECONNREFUSED 10.0.0.1',
      sinkHost: 'sink.example',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('鍵の値はどこにも出ない', () => {
  it('日誌の全行・標準出力・標準エラー・ログの行・送った本文のどこにも、鍵がまるごと現れない', async () => {
    await withData();
    const bodies: string[] = [];
    const attempts: Array<() => Promise<Response>> = [
      async () => {
        throw new Error(`connect failed with ${KEY}`);
      },
      async () => new Response(`echo ${KEY}`, { status: 401 }),
      async () => new Response(`echo ${KEY}`, { status: 500 }),
      async () =>
        new Response(
          JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: KEY }] } }),
          { status: 200 },
        ),
      async () => rpcOk(false),
    ];
    let index = 0;
    const { sender } = makeSender(async (_url, init) => {
      bodies.push(String(init.body));
      const next = attempts[index] ?? attempts[attempts.length - 1];
      index += 1;
      return (next as () => Promise<Response>)();
    });
    for (let i = 0; i < 6; i += 1) await sender.runOnce();
    expect(index).toBeGreaterThanOrEqual(5);
    const everything =
      JSON.stringify(await stores.journal.list({})) +
      lines.join('') +
      outputs.join('') +
      bodies.join('');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('DUMMYSINKKEY');
  });

  it('日誌に書けないときのログの行にも鍵は出ない', async () => {
    await withData();
    const failing: Stores['journal'] = {
      ...stores.journal,
      append: async () => {
        throw new Error(`disk error ${KEY}`);
      },
    };
    const { sender } = makeSender(async () => rpcOk(false), { journal: failing });
    await sender.runOnce();
    expect(lines.join('')).toContain('診断の要約の送信結果を日誌へ残せませんでした');
    expect([...lines, ...outputs].join('')).not.toContain(KEY);
  });

  it('日誌が読めないときは送らない（済みかどうか分からないまま送らない）。鍵も出ない', async () => {
    await withData();
    const unreadable: Stores['journal'] = {
      ...stores.journal,
      listPage: async () => {
        throw new Error(`read error ${KEY}`);
      },
    };
    const { sender, fetchSpy } = makeSender(async () => rpcOk(false), { journal: unreadable });
    expect(await sender.runOnce()).toEqual({ kind: 'idle', why: 'unreadable' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...lines, ...outputs].join('')).not.toContain(KEY);
  });
});

describe('鍵の置き方と、子プロセスへ渡さない仕組み', () => {
  it('`alteroid credential set` で置ける（断る名前の一覧に入っていない）', async () => {
    const { createCredentialService, WITHHELD_ENV_KEYS } = await import('@alteroid/core');
    const { AUTH_WITHHELD_ENV_KEYS } = await import('./auth.js');
    expect([...WITHHELD_ENV_KEYS, ...AUTH_WITHHELD_ENV_KEYS]).not.toContain(
      DIAGNOSTICS_SINK_KEY_ENV,
    );
    const registry = {
      list: async () => [],
      get: async () => null,
      select: async () => {
        throw new Error('使わない');
      },
    } as never;
    const service = createCredentialService({
      stores,
      runners: registry,
      withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...AUTH_WITHHELD_ENV_KEYS],
    });
    await service.apply([{ name: DIAGNOSTICS_SINK_KEY_ENV, value: KEY, scope: 'app' }]);
    const rows = await stores.credentials.list();
    expect(rows.map((row) => row.name)).toContain(DIAGNOSTICS_SINK_KEY_ENV);
  });

  it('子プロセスの env から落とす名前に入っている（クローン・マネージャー・枠の観測の子）', async () => {
    const { SINK_KEY_ENV_KEYS } = await import('@alteroid/core');
    expect(SINK_KEY_ENV_KEYS).toEqual([DIAGNOSTICS_SINK_KEY_ENV]);
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    // 子プロセスを起こす口（枠の観測・鍵の試し・同一プロセスの runner）に `storage.withheldEnvKeys` を素で渡さない
    expect(source).not.toContain('withheldEnvKeys: storage.withheldEnvKeys');
    expect(source).toContain(
      'const childWithheldEnvKeys = [...storage.withheldEnvKeys, ...SINK_KEY_ENV_KEYS]',
    );
  });
});

describe('結合: 送る側 → 受け口（実際の /mcp と連携の鍵の認証）', () => {
  const OPERATOR = { authorization: 'Bearer test-token' };
  let receiver: Stores;
  let posted: InboxEvent[];

  function buildReceiver() {
    posted = [];
    const clone = fakeCloneHost({
      post: (event: InboxEvent) => {
        posted.push(event);
        return 'conversation-1';
      },
      postPersisted: async (event: InboxEvent) => {
        posted.push(event);
        return 'persisted' as const;
      },
      subscribe: () => () => undefined,
      stop: () => Promise.resolve(),
      usageBlocked: false,
      managers: {
        list: () => Promise.resolve([]),
        listWithUnreadable: () => Promise.resolve({ managers: [], unreadable: [] }),
      },
    } as unknown as Partial<CloneHost>);
    return createApp({
      clone,
      stores: receiver,
      token: 'test-token',
      shutdown: () => undefined,
      now: () => new Date(NOW),
      journalEvents: { subscribe: () => () => undefined },
      auth: {
        plan: {
          enabled: true,
          providers: [],
          publicBaseUrl: 'http://127.0.0.1:4517',
          tokenTtlDays: 30,
          description: 'テスト',
        },
        service: createAuthService({
          store: receiver.auth,
          providers: createAuthProviderRegistry([]),
        }),
      },
    });
  }

  async function issueKey(app: ReturnType<typeof buildReceiver>): Promise<string> {
    const response = await app.request('/integration-keys', {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '診断の鍵', source: 'remote.alteroid' }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { value: string }).value;
  }

  it('送った要約が受け口の strict の検査を通って1行積まれ、同じ日の再送は duplicate、受信箱には何も積まれない', async () => {
    receiver = createMemoryStores();
    const app = buildReceiver();
    const realKey = await issueKey(app);
    const config = readDiagnosticsSinkConfig({
      [DIAGNOSTICS_SINK_URL_ENV]: 'https://sink.example',
      [DIAGNOSTICS_SINK_KEY_ENV]: realKey,
    }) as Enabled;
    const toReceiver = (async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/mcp');
      return app.request('/mcp', init);
    }) as unknown as typeof fetch;

    await withData();
    const first = createDiagnosticsSender({
      config,
      journal: stores.journal,
      usage: stores.usage,
      now: () => new Date(),
      fetch: toReceiver,
      env: { [DIAGNOSTICS_SINK_KEY_ENV]: realKey },
      writeLine: (line) => lines.push(line),
    });
    expect(await first.runOnce()).toEqual({ kind: 'recorded', outcome: 'sent', attempt: 1 });
    const received = await receiver.journal.list({ types: ['diagnostics_summary'] });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ principalKind: 'integration', source: 'remote.alteroid' });

    // 送り手の日誌を失った（別のデーモンから同じ日を送り直す）想定: 受け口は duplicate を返す
    stores = createMemoryStores();
    await withData();
    const second = createDiagnosticsSender({
      config,
      journal: stores.journal,
      usage: stores.usage,
      now: () => new Date(),
      fetch: toReceiver,
      env: { [DIAGNOSTICS_SINK_KEY_ENV]: realKey },
      writeLine: (line) => lines.push(line),
    });
    expect(await second.runOnce()).toEqual({ kind: 'recorded', outcome: 'duplicate', attempt: 1 });
    expect(await receiver.journal.list({ types: ['diagnostics_summary'] })).toHaveLength(1);

    // クローンの受信箱・ターンを起こさない
    expect(posted).toEqual([]);
    expect((await receiver.inbox.pending()).count).toBe(0);
    expect(lines).toEqual([]);
  });

  it('鍵が違えば受け口は 401: rejected（unauthorized）。日誌には積まれない', async () => {
    receiver = createMemoryStores();
    const app = buildReceiver();
    await issueKey(app);
    await withData();
    const { sender } = makeSender(async (_url, init) => app.request('/mcp', init));
    expect(await sender.runOnce()).toEqual({ kind: 'recorded', outcome: 'rejected', attempt: 1 });
    expect((await sendRows(stores))[0]).toMatchObject({ reason: 'unauthorized', httpStatus: 401 });
    expect(await receiver.journal.list({ types: ['diagnostics_summary'] })).toHaveLength(0);
    expect(posted).toEqual([]);
  });
});
