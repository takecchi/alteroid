// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '../test-support';

import { useTopology } from './use-topology';

const snap = (observedAt: string) => ({
  observedAt,
  clone: { state: 'idle' },
  storage: { state: 'ok' },
  runners: [],
  managers: [],
  links: [],
});

function Probe() {
  const live = useTopology();
  return (
    <div>
      <div data-testid="status">{live.status}</div>
      <div data-testid="observed">{live.snapshot?.observedAt ?? '-'}</div>
      <div data-testid="unavailable">{live.unavailable ?? '-'}</div>
      <div data-testid="received">{live.receivedAt === undefined ? '-' : 'yes'}</div>
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

const text = (id: string) => screen.getByTestId(id).textContent;

describe('useTopology', () => {
  it('最初のメッセージが届くまで connecting。snapshot で live になり受け取り時刻が付く', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubFetch((url, init) =>
      url.endsWith('/topology/stream')
        ? sse([{ event: 'snapshot', data: snap('2026-10-04T00:00:00.000Z'), after: gate }], {
            keepOpen: true,
            signal: init?.signal,
          })
        : undefined,
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    expect(text('status')).toBe('connecting');
    expect(text('observed')).toBe('-');
    release();
    await waitFor(() => expect(text('status')).toBe('live'));
    expect(text('observed')).toBe('2026-10-04T00:00:00.000Z');
    expect(text('received')).toBe('yes');
    expect(stub.calls.filter((url) => url.endsWith('/topology/stream'))).toHaveLength(1);
  });

  it('unavailable は理由を残し、直前の snapshot は消さない。次の snapshot で理由が消える', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch((url, init) =>
      url.endsWith('/topology/stream')
        ? sse(
            [
              { event: 'snapshot', data: snap('2026-10-04T00:00:00.000Z') },
              { event: 'unavailable', data: { error: 'ECONNREFUSED' } },
              { event: 'snapshot', data: snap('2026-10-04T00:00:30.000Z'), after: gate },
            ],
            { keepOpen: true, signal: init?.signal },
          )
        : undefined,
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(text('unavailable')).toBe('ECONNREFUSED'));
    expect(text('observed')).toBe('2026-10-04T00:00:00.000Z');
    expect(text('status')).toBe('live');

    release();
    await waitFor(() => expect(text('observed')).toBe('2026-10-04T00:00:30.000Z'));
    expect(text('unavailable')).toBe('-');
  });

  it('流れが閉じると offline、最後の snapshot は残し、張り直す', async () => {
    const stub = stubFetch((url, init) =>
      url.endsWith('/topology/stream')
        ? sse([{ event: 'snapshot', data: snap('2026-10-04T00:00:00.000Z') }], {
            signal: init?.signal,
          })
        : undefined,
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(text('status')).toBe('offline'));
    expect(text('observed')).toBe('2026-10-04T00:00:00.000Z');
    await waitFor(
      () =>
        expect(stub.calls.filter((url) => url.endsWith('/topology/stream')).length).toBeGreaterThan(
          1,
        ),
      { timeout: 4000 },
    );
  });

  it('繋がらない（古いデーモンの 404 など）ときも offline で、snapshot は無いまま', async () => {
    stubFetch((url) =>
      url.endsWith('/topology/stream') ? json({ error: 'not found' }, 404) : undefined,
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(text('status')).toBe('offline'));
    expect(text('observed')).toBe('-');
  });

  it('アンマウントで中断する', async () => {
    let signal: AbortSignal | null | undefined;
    stubFetch((url, init) => {
      if (!url.endsWith('/topology/stream')) return undefined;
      signal = init?.signal;
      return sse([], { keepOpen: true, signal: init?.signal });
    });
    const { unmount } = render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
