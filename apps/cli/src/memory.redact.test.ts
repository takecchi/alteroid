import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null }),
}));

const { memoryListCommand, memoryShowCommand } = await import('./memory.js');

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

describe('alteroid memory — 一覧は伏せる・show は伏せない', () => {
  it('list の題と説明は鍵を出さず、地の文は残す', async () => {
    reply({
      documents: [
        {
          slug: 'notes',
          title: `題の頭 GH_TOKEN=${KEY} 題の終わり`,
          description: `説明の頭 GH_TOKEN=${KEY} 説明の終わり`,
          kind: 'fact',
          descriptionFreshness: { kind: 'absent' },
          createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
          updatedAt: '2026-08-15T00:00:00.000Z',
        },
      ],
    });
    const read = captureStdout();

    await memoryListCommand();

    const text = read();
    expect(text).toContain('題の頭');
    expect(text).toContain('題の終わり');
    expect(text).toContain('説明の頭');
    expect(text).toContain('説明の終わり');
    expect(text).not.toContain(KEY);
  });

  it('対照: show は本文をそのまま出す（データの口なので伏せない）', async () => {
    reply({
      document: { slug: 'notes', content: `本文 GH_TOKEN=${KEY} 以上\n` },
      version: 'v-shown',
    });
    const read = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await memoryShowCommand('notes');

    expect(read()).toBe(`本文 GH_TOKEN=${KEY} 以上\n`);
  });
});
