import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
}));

const { renderDropped, droppedCommand } = await import('./dropped.js');

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const VIEW = {
  origin: 'daemon' as const,
  since: '2026-09-01T00:00:00.000Z',
  limit: 200,
  total: 1,
  traces: [
    `alteroid: 2026-09-01T00:00:01.000Z 記録できませんでした: Error: 理由の文 GH_TOKEN=${KEY} 以上`,
  ],
};

let originalFetch: typeof fetch | undefined;

afterEach(() => {
  if (originalFetch !== undefined) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  vi.restoreAllMocks();
});

describe('alteroid dropped — 跡の行は鍵を伏せる', () => {
  it('renderDropped は鍵を出さず、地の文は残す', () => {
    const text = renderDropped(VIEW);

    expect(text).toContain('記録できませんでした: Error: 理由の文');
    expect(text).toContain('以上');
    expect(text).not.toContain(KEY);
  });

  it('droppedCommand の出力にも鍵が出ない', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(VIEW), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;
    const read = captureStdout();

    await droppedCommand();

    const text = read();
    expect(text).toContain('理由の文');
    expect(text).not.toContain(KEY);
  });
});
