// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import EnvVars from './env-vars';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

// CLI（env-vars）は runner の失敗文を redactError に通して出す。画面は素のまま出していた。
describe('/env-vars 画面は、runner への反映の失敗の理由の本文の秘密を伏せる', () => {
  it('runner.error に入った鍵を出さない', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (!url.includes('/credentials')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
      }
      if (method === 'PUT') {
        return json({
          credentials: [],
          runners: [{ runnerId: 'runner-2', ok: false, error: `push failed: GH_TOKEN=${TOKEN}` }],
        });
      }
      return json({ credentials: [] });
    }) as typeof fetch;

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await screen.findByRole('heading', { name: '一覧' });

    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tz' } });
    fireEvent.change(screen.getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('runner-2');
    expect(alert.textContent).toContain('push failed');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
