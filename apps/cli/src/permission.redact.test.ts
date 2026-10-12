import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'http://127.0.0.1:4517',
      headers: {},
      note: null,
      remote: false,
    }),
}));

const { permissionListCommand } = await import('./permission.js');

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid permission list — rule と answer は鍵を伏せる', () => {
  it('鍵を出さず、地の文は残す', async () => {
    const grant = {
      id: 'grant-1',
      rule: `Bash(deploy GH_TOKEN=${KEY} --now:*)`,
      allows: ['deploy now'],
      denies: ['deploy; rm -rf /'],
      approvalId: 'approval-1',
      answer: `許可します GH_TOKEN=${KEY} 以上`,
      grantedAt: '2026-09-20T00:00:00.000Z',
      route: { principalKind: 'account', accountId: 'acc-1' },
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ grants: [grant] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;
    const read = captureStdout();

    await permissionListCommand();

    const text = read();
    expect(text).toContain('Bash(deploy');
    expect(text).toContain('--now:*)');
    expect(text).toContain('許可します');
    expect(text).toContain('以上');
    expect(text).not.toContain(KEY);
  });
});
