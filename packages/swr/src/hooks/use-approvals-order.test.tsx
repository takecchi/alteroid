// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useApprovals } from './queries';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

function Probe() {
  const { data } = useApprovals();
  return <div data-testid="count">{data === undefined ? 'loading' : data.approvals.length}</div>;
}

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

describe('useApprovals は order を明示して呼ぶ（並びを実装によらず揃える）', () => {
  it('未回答のみの呼びに order=asc が載る', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [], total: 0 });
      return undefined;
    });

    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await screen.findByText('0');

    const call = stub.calls.find((url) => url.includes('/approvals'));
    expect(call).toBeDefined();
    expect(call).toContain('order=asc');
    expect(call).toContain('pending=true');
    expect(call).not.toContain('limit=');
    expect(call).not.toContain('cursor=');
  });
});
