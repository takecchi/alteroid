// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Schedule from './schedule';

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

// 依頼の本文は人間かクローンが書いた自由文。約束の一覧は同じ種類の本文を伏せて出す（commitments.tsx の redactBody）。
describe('定期の依頼の一覧は、依頼の本文の秘密を伏せる（#4525）', () => {
  it('request と、それを含む description に入った鍵を一覧へ出さない（地の文は残す）', async () => {
    const request = `朝いちで deploy する。GH_TOKEN=${TOKEN} を使って`;
    stubFetch((url) =>
      url.includes('/schedule')
        ? json({
            entries: [
              {
                kind: 'morning-deploy',
                description: `毎日 09:00（ローカル時刻）: ${request}`,
                nextAt: '2026-08-21T09:00:00.000Z',
                request,
                spec: { type: 'daily', at: '09:00' },
              },
            ],
          })
        : undefined,
    );
    const router = createMemoryRouter([{ path: '/', Component: Schedule }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await screen.findByText(/毎日 09:00（ローカル時刻）: 朝いちで deploy する/);
    expect(document.body.textContent).toContain('朝いちで deploy する。GH_TOKEN=');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
