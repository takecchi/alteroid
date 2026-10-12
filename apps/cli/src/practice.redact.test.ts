import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
}));

const { practiceHistoryCommand, practiceListCommand } = await import('./practice.js');

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function reply(body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof fetch;
}

describe('alteroid practice — list と versions の題は鍵を伏せる', () => {
  it('list の題は鍵を出さず、地の文は残す', async () => {
    reply({
      practices: [
        {
          slug: 'review',
          kind: 'レビュー',
          title: `題の頭 GH_TOKEN=${KEY} 題の終わり`,
          createdAt: '2026-09-20T00:00:00.000Z',
          updatedAt: '2026-09-21T00:00:00.000Z',
          chars: 30,
        },
      ],
    });
    const read = captureStdout();

    await practiceListCommand();

    const text = read();
    expect(text).toContain('題の頭');
    expect(text).toContain('題の終わり');
    expect(text).not.toContain(KEY);
  });

  it('versions（practiceHistoryCommand）の題は鍵を出さず、地の文は残す', async () => {
    reply({
      versions: [
        {
          slug: 'review',
          version: 1,
          kind: 'レビュー',
          title: `旧題 GH_TOKEN=${KEY} 旧題の終わり`,
          at: '2026-09-20T00:00:00.000Z',
          chars: 3,
        },
      ],
    });
    const read = captureStdout();

    await practiceHistoryCommand('review');

    const text = read();
    expect(text).toContain('版1 [レビュー] 旧題');
    expect(text).toContain('旧題の終わり');
    expect(text).not.toContain(KEY);
  });
});
