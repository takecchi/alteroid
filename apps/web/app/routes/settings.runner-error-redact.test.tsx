// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DaemonRevision, RunnerSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Settings from './settings';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const BASE: RunnerSummary = {
  label: 'http://runner:4518',
  state: 'connected',
  since: '2026-08-22T00:00:00.000Z',
  runnerId: 'runner-primary',
  workspacePath: '/workspace',
  credentials: [],
  credentialsProbe: { status: 'asked' },
  profileProbe: { status: 'asked' },
  revision: { status: 'unheard' },
};

const DAEMON_UNKNOWN: DaemonRevision = { status: 'unknown' };

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderSettings(runners: RunnerSummary[]) {
  stubFetch((url) => {
    if (url.includes('/runners')) return json({ runners, daemonRevision: DAEMON_UNKNOWN });
    if (url.includes('/auth/providers')) return json({ providers: [] });
    if (url.includes('/me')) return json({ status: 'open' });
    if (url.includes('/health')) return json({ ok: true });
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

// CLI（runners.ts）は同じ欄を redactError に通して出す。画面は素のまま出していた。
describe('設定の実行環境の札は、失敗の理由の本文の秘密を伏せる', () => {
  it('runner.error に入った鍵を出さない', async () => {
    renderSettings([{ ...BASE, error: `connect failed: GH_TOKEN=${TOKEN}` }]);
    await screen.findByText(BASE.label);
    expect(document.body.textContent).toContain('connect failed');
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('鍵の確認の失敗（credentialsProbe.error）に入った鍵を出さない', async () => {
    renderSettings([
      { ...BASE, credentialsProbe: { status: 'failed', error: `probe: GH_TOKEN=${TOKEN}` } },
    ]);
    await screen.findByText(/渡している鍵を確かめられなかった/);
    expect(document.body.textContent).toContain('probe:');
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('プロファイルの確認の失敗（profileProbe.error）に入った鍵を出さない', async () => {
    renderSettings([
      { ...BASE, profileProbe: { status: 'failed', error: `probe: GH_TOKEN=${TOKEN}` } },
    ]);
    await screen.findByText(/プロファイルを確かめられなかった/);
    expect(document.body.textContent).toContain('probe:');
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('押し込みの失敗（pushHealth.*.error）に入った鍵を出さない', async () => {
    renderSettings([
      {
        ...BASE,
        pushHealth: {
          credentials: {
            status: 'failed',
            at: '2026-09-01T00:00:05.000Z',
            error: `push: GH_TOKEN=${TOKEN}`,
          },
        },
      },
    ]);
    await screen.findByText(/環境変数: 反映に失敗/);
    expect(document.body.textContent).toContain('push:');
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('plugin の読み込みの失敗（pluginLoad の errors の message）に入った鍵を出さない', async () => {
    renderSettings([
      {
        ...BASE,
        pluginLoad: {
          at: '2026-09-01T00:00:05.000Z',
          managerId: 'mgr-1',
          pluginLoad: {
            plugins: [],
            errors: [{ plugin: 'bad-plugin', type: 'load', message: `boom: GH_TOKEN=${TOKEN}` }],
          },
        },
      },
    ]);
    await screen.findByText('bad-plugin: load');
    expect(document.body.textContent).toContain('boom:');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
