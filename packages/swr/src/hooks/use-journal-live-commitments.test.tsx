// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useCommitments } from './queries';
import { useJournalLive } from './use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '../test-support';

function Probe() {
  const live = useJournalLive();
  const commitments = useCommitments();
  return (
    <div>
      <div data-testid="received">{live.receivedCount ?? 0}</div>
      <div data-testid="loaded">{commitments.data ? 'loaded' : ''}</div>
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

function commitmentFetches(stub: FetchStub): number {
  return stub.calls.filter((url) => new URL(url).pathname === '/commitments').length;
}

type Frame = { event: string; data: unknown };

function toolUse(id: string, actor: string, tool: string): Frame {
  return {
    event: 'tool_use',
    data: { type: 'tool_use', id, at: '2026-10-07T00:00:00.000Z', actor, tool, input: {} },
  };
}

function exchange(id: string, withWho: 'human' | 'manager', role: 'inbound' | 'outbound'): Frame {
  return {
    event: 'exchange',
    data: { type: 'exchange', id, at: '2026-10-07T00:00:00.000Z', with: withWho, role, text: 'x' },
  };
}

function renderProbe(frames: Frame[]) {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }, ...frames], {
        keepOpen: true,
        signal: init?.signal,
      });
    }
    if (new URL(url).pathname === '/commitments') return json({ commitments: [] });
    return undefined;
  });
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  return stub;
}

describe('台帳の取り直し（SSE）', () => {
  it('exchange(with: human) で取り直す（「未着手」の印）', async () => {
    const stub = renderProbe([exchange('e1', 'human', 'outbound')]);
    await waitFor(() => {
      expect(commitmentFetches(stub)).toBeGreaterThanOrEqual(2);
    });
  });

  it('exchange(with: manager) で取り直す（「進行中」の印）', async () => {
    const stub = renderProbe([exchange('e1', 'manager', 'inbound')]);
    await waitFor(() => {
      expect(commitmentFetches(stub)).toBeGreaterThanOrEqual(2);
    });
  });

  // クローンの台帳の書き込みの道具は外した（#5923）: 旧い名前の tool_use が届いても取り直さない
  it('道具の tool_use（commitment_list・旧い commitment_close・Bash）では取り直さない', async () => {
    const stub = renderProbe([
      toolUse('t1', 'clone', 'commitment_list'),
      toolUse('t2', 'clone', 'Bash'),
      toolUse('t3', 'clone:sub:general-purpose', 'Read'),
      toolUse('t4', 'clone', 'commitment_close'),
    ]);
    await screen.findByText('loaded');
    await waitFor(() => {
      expect(screen.getByTestId('received').textContent).toBe('4');
    });
    expect(commitmentFetches(stub)).toBe(1);
  });

  it('台帳と無関係な exchange（with: self）では取り直さない', async () => {
    const stub = renderProbe([
      {
        event: 'exchange',
        data: {
          type: 'exchange',
          id: 'e1',
          at: '2026-10-07T00:00:00.000Z',
          with: 'self',
          role: 'outbound',
          text: 'x',
        },
      },
    ]);
    await screen.findByText('loaded');
    await waitFor(() => {
      expect(screen.getByTestId('received').textContent).toBe('1');
    });
    expect(commitmentFetches(stub)).toBe(1);
  });
});
