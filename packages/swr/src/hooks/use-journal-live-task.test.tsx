// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTask, useTasks } from './queries';
import { useJournalLive } from './use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '../test-support';

function Probe() {
  const live = useJournalLive();
  const list = useTasks(false);
  const detail = useTask('t-1');
  const loaded = list.data && detail.data;
  return (
    <div>
      <div data-testid="received">{live.receivedCount ?? 0}</div>
      <div data-testid="loaded">{loaded ? 'loaded' : ''}</div>
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

function fetches(stub: FetchStub, path: string): number {
  return stub.calls.filter((url) => new URL(url).pathname === path).length;
}

type Frame = { event: string; data: unknown };

function decision(id: string, target?: { kind: 'task'; id?: string }): Frame {
  return {
    event: 'decision',
    data: {
      type: 'decision',
      id,
      at: '2026-11-01T00:00:00.000Z',
      decision: 'task を足した（t-2）: 題',
      grounds: '自分で task_add した',
      ...(target === undefined ? {} : { target }),
    },
  };
}

const TASK = {
  id: 't-1',
  title: '題',
  body: '本文',
  status: 'queued',
  origin: 'conv-1',
  createdAt: '2026-11-01T00:00:00.000Z',
};

function renderProbe(frames: Frame[]) {
  const stub = stubFetch((url, init) => {
    const path = new URL(url).pathname;
    if (path === '/journal/stream') {
      return sse([{ event: 'open', data: { ok: true } }, ...frames], {
        keepOpen: true,
        signal: init?.signal,
      });
    }
    if (path === '/tasks') return json({ entries: [], unreadable: [] });
    if (path === '/tasks/t-1') return json(TASK);
    return undefined;
  });
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  return stub;
}

describe('task の足し・閉じの取り直し（SSE）', () => {
  it('target(task) 付きの decision で、task の一覧を取り直す', async () => {
    const stub = renderProbe([decision('d1', { kind: 'task', id: 't-2' })]);
    await vi.waitFor(() => {
      expect(fetches(stub, '/tasks')).toBeGreaterThanOrEqual(2);
    });
  });

  it('その task の id を指す decision で、開いている詳細も取り直す。別の id では詳細を取り直さない', async () => {
    const stub = renderProbe([
      decision('d1', { kind: 'task', id: 't-2' }),
      decision('d2', { kind: 'task', id: 't-1' }),
    ]);
    await vi.waitFor(() => {
      expect(fetches(stub, '/tasks/t-1')).toBeGreaterThanOrEqual(2);
    });
  });

  it('別の id の decision だけでは、開いている詳細を取り直さない', async () => {
    const stub = renderProbe([decision('d1', { kind: 'task', id: 't-2' })]);
    await vi.waitFor(() => {
      expect(fetches(stub, '/tasks')).toBeGreaterThanOrEqual(2);
    });
    await screen.findByText('loaded');
    expect(fetches(stub, '/tasks/t-1')).toBe(1);
  });

  it('target の無い（古い）decision では取り直さず、壊れもしない', async () => {
    const stub = renderProbe([decision('d1')]);
    await screen.findByText('loaded');
    await vi.waitFor(() => {
      expect(screen.getByTestId('received').textContent).toBe('1');
    });
    expect(fetches(stub, '/tasks')).toBe(1);
    expect(fetches(stub, '/tasks/t-1')).toBe(1);
  });
});
