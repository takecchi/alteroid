// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Dropped from './dropped';

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

describe('/dropped 画面 — 跡の行は鍵を伏せる', () => {
  it('理由の文に鍵があっても出さず、地の文は残る', async () => {
    const traces = [
      `alteroid: 2026-09-01T00:00:01.000Z 記録できませんでした: Error: 理由の文 GH_TOKEN=${KEY} 以上`,
    ];
    stubFetch((url) =>
      url.includes('/dropped')
        ? json({
            origin: 'daemon',
            since: '2026-09-01T00:00:00.000Z',
            limit: 200,
            total: 1,
            traces,
          })
        : undefined,
    );

    render(
      <Providers>
        <MemoryRouter>
          <Dropped />
        </MemoryRouter>
      </Providers>,
    );
    await screen.findByText('失敗の一覧');

    const row = await screen.findByText(/記録できませんでした/);
    expect(row.textContent).toContain('理由の文');
    expect(row.textContent).toContain('以上');
    expect(row.textContent).not.toContain(KEY);
  });
});
