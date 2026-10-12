import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { profileClearCommand } = await import('./profile.js');

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  // 古いデーモンの形: runner の結果を伏せずに返す
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          updatedAt: '2026-10-12T00:00:00Z',
          clone: { ok: true },
          runners: [
            {
              runnerId: 'runner-b',
              ok: false,
              error: `bash: export GH_TOKEN=${TOKEN}: bad`,
              output: `+ export GH_TOKEN=${TOKEN}`,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid profile の台ごとの結果', () => {
  it('runner の error / output に鍵があっても、そのまま端末へ出さない（credential / mcp / plugin / runners と同じく伏せる）', async () => {
    const read = captureStdout();

    await expect(profileClearCommand({ yes: true })).rejects.toThrow('一部失敗');

    const text = read();
    expect(text).toContain('runner-b: 反映できませんでした — bash: export GH_TOKEN=');
    expect(text).toContain('    | + export GH_TOKEN=');
    expect(text).not.toContain(TOKEN);
  });
});
