import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { tokenAddCommand, tokenRemoveCommand, tokenDisableCommand } = await import('./token.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { method: string; body: unknown }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    sent.push({ method, body });
    const reply = replies.get(`${method} ${new URL(url).pathname}`) ?? { status: 200, body: {} };
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

const SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };
const POOL = [
  { id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' },
  { id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' },
];

function putBody(): unknown {
  return sent.find((call) => call.method === 'PUT')?.body;
}

describe('alteroid token の全文置換は、読んだときの版を前提にする（#4591）', () => {
  it('remove は、読んだときの版を ifMatch にして送る', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: POOL, settings: SETTINGS, version: 'v1' },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [POOL[1]], settings: SETTINGS } });
    captureStdout();

    await tokenRemoveCommand('tok-a', { yes: true });

    expect(putBody()).toEqual({ tokens: [{ id: 'tok-b', label: 'b', order: 1 }], ifMatch: 'v1' });
  });

  it('disable も、読んだときの版を ifMatch にして送る', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: POOL, settings: SETTINGS, version: 'v1' },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: POOL, settings: SETTINGS } });
    captureStdout();

    await tokenDisableCommand('tok-a');

    expect((putBody() as { ifMatch?: unknown }).ifMatch).toBe('v1');
  });

  it('add も、読んだときの版を ifMatch にして送る', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: POOL, settings: SETTINGS, version: 'v1' },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: POOL, settings: SETTINGS } });
    captureStdout();
    const dir = await makeTempDir('alteroid-token-if-match-');
    const file = join(dir, 'value.txt');
    await writeFile(file, 'fake-token-value\n');

    await tokenAddCommand({ label: 'c', file });

    expect((putBody() as { ifMatch?: unknown }).ifMatch).toBe('v1');
  });

  it('読んだ後にほかで変わっていた（409）なら、変えていないと言い、読み直してやり直すよう案内する', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: POOL, settings: SETTINGS, version: 'v1' },
    });
    setReply('PUT', '/tokens', {
      status: 409,
      body: { error: '認証トークンのプールが読んだ後に変わっている（変えていない）' },
    });
    captureStdout();

    await expect(tokenRemoveCommand('tok-a', { yes: true })).rejects.toThrow(
      /ほかで変わっていたので、変えていません。\nalteroid token list/,
    );
  });

  it('対照: 版を返さない古いデーモンには、今までどおり ifMatch を付けずに送る', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: POOL, settings: SETTINGS } });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [POOL[1]], settings: SETTINGS } });
    captureStdout();

    await tokenRemoveCommand('tok-a', { yes: true });

    expect(putBody()).toEqual({ tokens: [{ id: 'tok-b', label: 'b', order: 1 }] });
  });
});
