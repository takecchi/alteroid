import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diagnosticsSentCommand } from './diagnostics-sent.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
}));

const row = (
  id: string,
  at: string,
  outcome: string,
  attempt: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'diagnostics_summary_send',
  id,
  at,
  period: { start: '2026-11-13T00:00:00.000Z', end: '2026-11-14T00:00:00.000Z' },
  outcome,
  attempt,
  sinkHost: 'sink.example',
  ...extra,
});

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

describe('diagnostics sent', () => {
  it('1件1行（日時・period・outcome・attempt・reason）。型で絞って読む', async () => {
    replies = [
      {
        status: 200,
        body: {
          entries: [
            row('s2', '2026-11-14T04:00:00.000Z', 'failed', 2, {
              reason: 'http_5xx',
              httpStatus: 503,
            }),
            row('s1', '2026-11-14T03:00:00.000Z', 'sent', 1, { httpStatus: 200 }),
          ],
          next: null,
        },
      },
    ];
    const out = captureStdout();
    await diagnosticsSentCommand({});
    expect(urls[0]?.pathname).toBe('/journal');
    expect(urls[0]?.searchParams.get('type')).toBe('diagnostics_summary_send');
    const lines = out().trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-11-14T04:00:00.000Z');
    expect(lines[0]).toContain('2026-11-13T00:00:00.000Z 〜 2026-11-14T00:00:00.000Z');
    expect(lines[0]).toContain('failed');
    expect(lines[0]).toContain('attempt=2');
    expect(lines[0]).toContain('reason=http_5xx');
    expect(lines[1]).toContain('sent');
    expect(lines[1]).not.toContain('reason=');
  });

  it('--json は reason・httpStatus が無ければ null（0 や空にしない）', async () => {
    replies = [
      {
        status: 200,
        body: { entries: [row('s1', '2026-11-14T03:00:00.000Z', 'sent', 1)], next: null },
      },
    ];
    const out = captureStdout();
    await diagnosticsSentCommand({ json: true });
    const parsed = JSON.parse(out().trim().split('\n').at(-1) ?? '{}') as {
      entries: { reason: unknown; httpStatus: unknown; attempt: number; sinkHost: string }[];
      complete: boolean;
    };
    expect(parsed.entries[0]).toMatchObject({
      reason: null,
      httpStatus: null,
      attempt: 1,
      sinkHost: 'sink.example',
    });
    expect(parsed.complete).toBe(true);
  });

  it('1件も無ければ、その旨を言う（設定の確認先も添える）', async () => {
    replies = [{ status: 200, body: { entries: [], next: null } }];
    const out = captureStdout();
    await diagnosticsSentCommand({});
    expect(out()).toContain('診断の要約の送信の記録は無い');
  });

  it('--since / --until / --limit を日誌の口へ渡す。不正な値は断る', async () => {
    replies = [{ status: 200, body: { entries: [], next: null } }];
    captureStdout();
    await diagnosticsSentCommand({
      since: '2026-11-01T00:00:00Z',
      until: '2026-11-14T00:00:00Z',
      limit: '5',
    });
    expect(urls[0]?.searchParams.get('since')).toBe('2026-11-01T00:00:00.000Z');
    expect(urls[0]?.searchParams.get('until')).toBe('2026-11-14T00:00:00.000Z');
    expect(urls[0]?.searchParams.get('limit')).toBe('5');
    await expect(diagnosticsSentCommand({ limit: '0' })).rejects.toThrow(/--limit/);
    await expect(diagnosticsSentCommand({ since: 'きのう' })).rejects.toThrow();
  });

  it('日誌が読めなければ断る', async () => {
    replies = [{ status: 500, body: { error: 'x' } }];
    await expect(diagnosticsSentCommand({})).rejects.toThrow(/日誌を読めませんでした/);
  });
});
