// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Usage from './usage';

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

const cases: [string, () => Response][] = [
  ['200 で本文が空', () => new Response('', { status: 200 })],
  [
    '200 で HTML',
    () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  ],
  [
    '200 で壊れた JSON',
    () =>
      new Response('{"rows":', { status: 200, headers: { 'content-type': 'application/json' } }),
  ],
];

describe('使用量: 読めない形で届いた応答', () => {
  for (const [name, respond] of cases) {
    it(`${name}は「受け付けませんでした」ではなく「読めない形で届いた」と案内する`, async () => {
      stubFetch((url) => {
        if (url.includes('/managers')) return json({ managers: [] });
        if (url.includes('/tokens')) return json({ tokens: [] });
        if (!url.includes('/usage')) return undefined;
        return respond();
      });
      const router = createMemoryRouter([{ path: '/', Component: Usage }], {
        initialEntries: ['/'],
      });
      render(
        <Providers>
          <RouterProvider router={router} />
        </Providers>,
      );
      const alerts = await screen.findAllByRole('alert');
      const text = alerts.map((alert) => alert.textContent).join('\n');
      expect(text).toContain('応答が読めない形で届きました');
      expect(text).toContain('版がずれている');
      expect(text).not.toContain('受け付けませんでした');
      expect(text).not.toContain('原因を特定できませんでした');
    });
  }
});
