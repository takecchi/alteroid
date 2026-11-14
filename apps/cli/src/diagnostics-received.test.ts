import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDiagnosticsSummary, parseJournalJsonl } from '@alteroid/core';

import {
  diagnosticsReceivedCompareCommand,
  diagnosticsReceivedListCommand,
  diagnosticsReceivedShowCommand,
} from './diagnostics-received.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
}));

const usage = (at: string, read: number, creation: number) => ({
  type: 'turn_usage',
  id: `u-${at}`,
  at,
  layer: 'clone',
  site: 'session',
  managerId: 'mgr-a',
  models: {
    opus: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: creation,
      webSearchRequests: 0,
      costUsd: 0,
    },
  },
});
const summary = (rows: object[]) =>
  buildDiagnosticsSummary(
    { journal: parseJournalJsonl(rows.map((r) => JSON.stringify(r)).join('\n')) },
    { now: new Date('2026-11-14T00:00:00.000Z') },
  );
const timingOnly = {
  type: 'turn_timing',
  id: 't1',
  at: '2026-11-03T00:00:00.000Z',
  triggers: ['manager_message'],
  batchSize: 1,
  succeeded: true,
  totalMs: 10,
};

const row = (id: string, source: string, payload: unknown, at = '2026-11-10T00:00:00.000Z') => ({
  type: 'diagnostics_summary',
  id,
  at,
  source,
  principalKind: 'integration',
  keyId: 'k',
  payload,
});

const S1 = summary([usage('2026-11-01T00:00:00.000Z', 300, 100)]);
const S2 = summary([usage('2026-11-02T00:00:00.000Z', 100, 100)]);
const S_NULLS = summary([timingOnly]);

let urls: URL[] = [];
let replies: { status: number; body: unknown }[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  urls = [];
  replies = [];
  globalThis.fetch = ((input: unknown) => {
    const request = input as { url?: string };
    urls.push(new URL(typeof input === 'string' ? input : (request.url ?? String(input))));
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

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('reject するはずが resolve した');
}

describe('diagnostics received list', () => {
  it('1件1行（受信時刻・source・period・要点の数字・id）。型で絞って読み、source で絞れる', async () => {
    replies = [
      {
        status: 200,
        body: {
          entries: [row('r1', 'env.a', S1), row('r2', 'env.b', S2)],
          next: null,
        },
      },
    ];
    const out = captureStdout();
    await diagnosticsReceivedListCommand({ source: 'env.a' });
    expect(urls[0]?.searchParams.get('type')).toBe('diagnostics_summary');
    const text = out();
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('env.a');
    expect(text).toContain('2026-11-01T00:00:00.000Z');
    expect(text).toContain('id=r1');
    expect(text).not.toContain('env.b');
    expect(text).not.toContain('schemaVersion');
  });

  it('取れない値は 0 でなく「取れない」と出す。--json は null のまま', async () => {
    replies = [{ status: 200, body: { entries: [row('r1', 'env.a', S_NULLS)], next: null } }];
    const out = captureStdout();
    await diagnosticsReceivedListCommand({});
    expect(out()).toContain('読み出し率 取れない');
    expect(out()).not.toContain('読み出し率 0');
    replies = [{ status: 200, body: { entries: [row('r1', 'env.a', S_NULLS)], next: null } }];
    const out2 = captureStdout();
    await diagnosticsReceivedListCommand({ json: true });
    const parsed = JSON.parse(out2().trim().split('\n').at(-1) ?? '{}') as {
      entries: {
        summary: { cache: { fromTurnUsage: { overall: { readRate: { value: null } } } } };
      }[];
    };
    expect(parsed.entries[0]?.summary.cache.fromTurnUsage.overall.readRate.value).toBeNull();
  });

  it('不正な --limit・日時は断る', async () => {
    expect((await failureOf(diagnosticsReceivedListCommand({ limit: '0' }))).message).toContain(
      '--limit',
    );
    await failureOf(diagnosticsReceivedListCommand({ since: 'きのう' }));
  });
});

describe('diagnostics received show / compare', () => {
  it('show は要約の JSON 全文を出す。診断の要約でない行は断る', async () => {
    replies = [{ status: 200, body: row('r1', 'env.a', S1) }];
    const out = captureStdout();
    await diagnosticsReceivedShowCommand('r1');
    expect(JSON.parse(out())).toEqual(S1);
    replies = [{ status: 200, body: { type: 'decision', id: 'd', at: 'x' } }];
    expect((await failureOf(diagnosticsReceivedShowCommand('d'))).message).toContain(
      '診断の要約ではない',
    );
  });

  it('compare は同じ source の2件を並べ、取れない側は差を出さない', async () => {
    replies = [
      { status: 200, body: row('r1', 'env.a', S1) },
      { status: 200, body: row('r2', 'env.a', S_NULLS) },
    ];
    const out = captureStdout();
    await diagnosticsReceivedCompareCommand('r1', 'r2');
    const text = out();
    expect(text).toContain('キャッシュの読み出し率');
    expect(text).toContain('→ 取れない（差は取れない）');
    expect(text).not.toMatch(/→ 0\.0%/);
  });

  it('compare は source が違う2件を断る', async () => {
    replies = [
      { status: 200, body: row('r1', 'env.a', S1) },
      { status: 200, body: row('r2', 'env.b', S2) },
    ];
    expect((await failureOf(diagnosticsReceivedCompareCommand('r1', 'r2'))).message).toContain(
      'source が違う',
    );
  });

  it('無い id は、見つけ方つきで断る', async () => {
    replies = [{ status: 404, body: { error: 'not found' } }];
    expect((await failureOf(diagnosticsReceivedShowCommand('zzz'))).message).toContain(
      'received list',
    );
  });
});
