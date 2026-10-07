// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '../test-support';

import { useStatus } from './queries';

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

function Probe() {
  const status = useStatus();
  return (
    <div>
      <span data-testid="storage">{status.data?.storage ?? ''}</span>
      <span data-testid="error">{status.error === undefined ? '' : 'error'}</span>
    </div>
  );
}

describe('useStatus', () => {
  it('取れたら storage を返す', async () => {
    const stub = stubFetch((url) =>
      url === `${TEST_BASE_URL}/status` ? json({ storage: '/srv/alteroid' }) : undefined,
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('storage').textContent).toBe('/srv/alteroid'));
    expect(stub.calls).toContain(`${TEST_BASE_URL}/status`);
  });

  it('401 は例外にならず error になる', async () => {
    stubFetch((url) =>
      url.endsWith('/status') ? json({ error: 'unauthorized' }, 401) : undefined,
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('error'));
    expect(screen.getByTestId('storage').textContent).toBe('');
  });
});
