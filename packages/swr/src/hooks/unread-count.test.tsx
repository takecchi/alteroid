// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

import { useUnreadConversationCount } from './conversation-read';

function Probe() {
  const { data, error } = useUnreadConversationCount();
  return (
    <div>
      <div data-testid="count">{data === undefined ? '-' : String(data.count)}</div>
      <div data-testid="capped">{data === undefined ? '-' : String(data.capped)}</div>
      <div data-testid="unreadable">{data?.readStateUnreadable ?? '-'}</div>
      <div data-testid="error">{error === undefined ? '-' : 'error'}</div>
    </div>
  );
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

function renderProbe() {
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
}

describe('useUnreadConversationCount', () => {
  it('取得後の件数を返し、件数専用の口だけを叩く', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/conversations/unread-count') ? json({ count: 4, capped: false }) : undefined,
    );
    renderProbe();

    expect((await screen.findByText('4')).getAttribute('data-testid')).toBe('count');
    expect(screen.getByTestId('capped').textContent).toBe('false');
    expect(stub.calls).toHaveLength(1);
  });

  it('数え切れていない（capped）を伝える', async () => {
    stubFetch(() => json({ count: 99, capped: true }));
    renderProbe();

    expect(await screen.findByText('99')).toBeTruthy();
    expect(screen.getByTestId('capped').textContent).toBe('true');
  });

  it('既読の記録が読めない旨と、取得の失敗は、件数と区別できる形で渡す', async () => {
    stubFetch(() => json({ count: 3, capped: false, readStateUnreadable: '壊れている' }));
    renderProbe();
    expect(await screen.findByText('壊れている')).toBeTruthy();
    cleanup();

    stubFetch(() => json({ error: 'internal' }, 500));
    renderProbe();
    expect(await screen.findByText('error')).toBeTruthy();
    expect(screen.getByTestId('count').textContent).toBe('-');
  });
});
