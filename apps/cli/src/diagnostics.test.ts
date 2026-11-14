import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  diagnosticsExportCommand,
  narrowDiagnosticsTypes,
  resolveDiagnosticsWindow,
} from './diagnostics.js';
import { captureStderr, captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
}));

const NOW = Date.parse('2026-11-14T00:00:00.000Z');

let sent: URL[] = [];
let replies: { status: number; body: unknown }[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  globalThis.fetch = ((input: unknown) => {
    const request = input as { url?: string };
    sent.push(new URL(typeof input === 'string' ? input : (request.url ?? String(input))));
    const reply = replies.shift() ?? { status: 500, body: { error: '返事が足りない' } };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function usageRow(id: string, at: string, withReset = false) {
  return {
    type: 'turn_usage',
    id,
    at,
    layer: 'clone',
    site: 'session',
    managerId: 'm1',
    models: {},
    ...(withReset ? { reset: { fromCostUsd: 2, toCostUsd: 0 } } : {}),
  };
}

function page(entries: unknown[], next: { id: string; at: string } | null) {
  return { status: 200, body: { entries, next } };
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('reject するはずが resolve した');
}

describe('narrowDiagnosticsTypes', () => {
  it('既定は turn_timing / turn_usage / context_usage（http_timing は入れない）', () => {
    expect(narrowDiagnosticsTypes(undefined)).toEqual([
      'turn_timing',
      'turn_usage',
      'context_usage',
    ]);
  });

  it('診断の型だけを通す', () => {
    expect(narrowDiagnosticsTypes('http_timing, turn_usage,turn_usage')).toEqual([
      'http_timing',
      'turn_usage',
    ]);
  });

  it.each(['exchange', 'external_event', 'daily_report', 'turn_usage,exchange', 'bogus'])(
    '診断以外の型 %s は、理由つきで断る',
    (value) => {
      expect(() => narrowDiagnosticsTypes(value)).toThrow(/診断の型ではない/);
    },
  );

  it('断る文に本文を含みうることを理由として書く', () => {
    expect(() => narrowDiagnosticsTypes('exchange')).toThrow(/本文を含みうる/);
  });
});

describe('resolveDiagnosticsWindow', () => {
  it('既定は終点が今、始点がその 1 日前', () => {
    expect(resolveDiagnosticsWindow({}, NOW)).toEqual({
      since: '2026-11-13T00:00:00.000Z',
      until: '2026-11-14T00:00:00.000Z',
    });
  });

  it('ちょうど 7 日は通り、7 日を 1 ms でも超えたら断る', () => {
    expect(() =>
      resolveDiagnosticsWindow(
        { since: '2026-11-01T00:00:00.000Z', until: '2026-11-08T00:00:00.000Z' },
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      resolveDiagnosticsWindow(
        { since: '2026-11-01T00:00:00.000Z', until: '2026-11-08T00:00:00.001Z' },
        NOW,
      ),
    ).toThrow(/窓が長すぎます/);
  });

  it('始点が終点以降なら断る・読めない日時も断る', () => {
    expect(() =>
      resolveDiagnosticsWindow(
        { since: '2026-11-02T00:00:00Z', until: '2026-11-01T00:00:00Z' },
        NOW,
      ),
    ).toThrow(/より前/);
    expect(() => resolveDiagnosticsWindow({ since: 'きのう' }, NOW)).toThrow();
  });
});

describe('diagnosticsExportCommand', () => {
  it('afterId / afterAt の組で全頁を読み、next が null で止まる。1行1JSON・要約は標準エラー', async () => {
    const a = usageRow('a', '2026-11-13T01:00:00.000Z');
    const b = usageRow('b', '2026-11-13T02:00:00.000Z', true);
    const c = usageRow('c', '2026-11-13T03:00:00.000Z', true);
    replies.push(
      page([a, b], { id: 'b', at: b.at }),
      page([], { id: 'b2', at: b.at }),
      page([c], null),
    );
    const out = captureStdout();
    const err = captureStderr();

    await diagnosticsExportCommand({ now: NOW, pageSize: '2' });

    expect(
      out()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([a, b, c]);
    expect(sent).toHaveLength(3);
    const q = (i: number) => Object.fromEntries(sent[i]!.searchParams);
    expect(q(0)).toEqual({
      type: 'turn_timing,turn_usage,context_usage',
      since: '2026-11-13T00:00:00.000Z',
      until: '2026-11-14T00:00:00.000Z',
      order: 'asc',
      limit: '2',
    });
    expect(q(1)).toMatchObject({ afterId: 'b', afterAt: b.at });
    expect(q(2)).toMatchObject({ afterId: 'b2', afterAt: b.at });
    const summary = err();
    expect(summary).toContain('3 行 / 3 頁');
    expect(summary).toContain('UTC');
    expect(summary).toContain('reset を持つ turn_usage 2 行');
  });

  it('診断以外の型は、デーモンへ問い合わせる前に断る', async () => {
    const error = await failureOf(diagnosticsExportCommand({ now: NOW, type: 'exchange' }));

    expect(error.message).toContain('診断の型ではない');
    expect(sent).toHaveLength(0);
  });

  it('窓が 7 日を超えたら、デーモンへ問い合わせる前に断る', async () => {
    const error = await failureOf(
      diagnosticsExportCommand({
        now: NOW,
        since: '2026-11-01T00:00:00Z',
        until: '2026-11-10T00:00:00Z',
      }),
    );

    expect(error.message).toContain('窓が長すぎます');
    expect(sent).toHaveLength(0);
  });

  it('途中の頁で失敗したら、出せた行は出したうえで失敗する（黙って短く終わらない）', async () => {
    const a = usageRow('a', '2026-11-13T01:00:00.000Z');
    replies.push(page([a], { id: 'a', at: a.at }), { status: 500, body: { error: 'boom' } });
    const out = captureStdout();
    captureStderr();

    const error = await failureOf(diagnosticsExportCommand({ now: NOW }));

    expect(
      out()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([a]);
    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain('ここまでに 1 行・1 頁');
    expect(error.message).toContain('途中で終わっている');
  });

  it('要求していない型の行（本文を持つ型）が返ったら、出さずに止める', async () => {
    replies.push(
      page(
        [{ type: 'exchange', id: 'x', at: '2026-11-13T01:00:00.000Z', text: '秘密の本文' }],
        null,
      ),
    );
    const out = captureStdout();
    captureStderr();

    const error = await failureOf(diagnosticsExportCommand({ now: NOW }));

    expect(out()).not.toContain('秘密の本文');
    expect(error.message).toContain('要求していない型');
  });

  it('続きの位置が進まなければ、同じ頁を読み続けず止める', async () => {
    const a = usageRow('a', '2026-11-13T01:00:00.000Z');
    const next = { id: 'a', at: a.at };
    replies.push(page([a], next), page([], next), page([], next));
    captureStdout();
    captureStderr();

    const error = await failureOf(diagnosticsExportCommand({ now: NOW }));

    expect(error.message).toContain('進みません');
    expect(sent).toHaveLength(2);
  });
});
