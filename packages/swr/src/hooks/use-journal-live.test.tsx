// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useManager, useManagerTranscript, useProfile, useTokens } from './queries';
import { useJournalLive } from './use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '../test-support';

const MANAGER_ID = 'm1';

const MANAGER_DETAIL = {
  manager: {
    managerId: MANAGER_ID,
    status: 'running',
    live: true,
    cwd: '/tmp',
    request: 'テスト用の依頼',
    startedAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    waiting: [],
  },
};

function Probe() {
  useJournalLive();
  const manager = useManager(MANAGER_ID);
  const transcript = useManagerTranscript(MANAGER_ID);
  return (
    <div>
      <div data-testid="manager">{manager.data?.manager.managerId ?? ''}</div>
      <div data-testid="transcript">
        {transcript.data?.kind === 'body' ? transcript.data.body : ''}
      </div>
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

function countsOf(stub: FetchStub) {
  return {
    manager: stub.calls.filter((url) => url.endsWith(`/managers/${MANAGER_ID}`)).length,
    transcript: stub.calls.filter((url) => url.endsWith(`/managers/${MANAGER_ID}/transcript`))
      .length,
  };
}

function renderProbe(frames: { event: string; data: unknown }[]) {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/journal/stream'))
      return sse(frames, { keepOpen: true, signal: init?.signal });
    if (url.endsWith(`/managers/${MANAGER_ID}`)) return json(MANAGER_DETAIL);
    if (url.endsWith(`/managers/${MANAGER_ID}/transcript`)) {
      return new Response('{"line":1}\n', { status: 200 });
    }
    return undefined;
  });
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  return stub;
}

describe('マネージャー詳細と生ログの無効化', () => {
  it('tool_use が届くと manager と transcript を束で落とす', async () => {
    const stub = renderProbe([
      { event: 'open', data: { ok: true } },
      {
        event: 'tool_use',
        data: {
          type: 'tool_use',
          id: 'e1',
          at: '2026-08-14T00:00:00.000Z',
          actor: `manager:${MANAGER_ID}`,
          tool: 'manager_send',
          input: {},
        },
      },
    ]);

    await screen.findByText(MANAGER_ID);
    const before = countsOf(stub);
    expect(before.manager).toBeGreaterThan(0);
    expect(before.transcript).toBeGreaterThan(0);

    await waitFor(() => {
      const after = countsOf(stub);
      expect(after.manager).toBeGreaterThan(before.manager);
      expect(after.transcript).toBeGreaterThan(before.transcript);
    });
  });

  it('クローン自身の手の tool_use では manager も transcript も落とさない', async () => {
    const stub = renderProbe([
      { event: 'open', data: { ok: true } },
      {
        event: 'tool_use',
        data: {
          type: 'tool_use',
          id: 'e1c',
          at: '2026-08-20T00:00:00.000Z',
          actor: 'clone',
          tool: 'Bash',
          input: { command: 'git log --oneline -3' },
        },
      },
      {
        event: 'tool_use',
        data: {
          type: 'tool_use',
          id: 'e2c',
          at: '2026-08-20T00:00:01.000Z',
          actor: 'clone:sub:general-purpose',
          tool: 'Read',
          input: { file_path: '/tmp/a' },
        },
      },
    ]);

    await screen.findByText(MANAGER_ID);
    const before = countsOf(stub);

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.endsWith('/journal/stream')).length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = countsOf(stub);
    expect(after.manager).toBe(before.manager);
    expect(after.transcript).toBe(before.transcript);
  });

  it('exchange(with: manager) が届くと manager と transcript を束で落とす（manager id を持たなくても）', async () => {
    const stub = renderProbe([
      { event: 'open', data: { ok: true } },
      {
        event: 'exchange',
        data: {
          type: 'exchange',
          id: 'e2',
          at: '2026-08-14T00:00:00.000Z',
          with: 'manager',
          role: 'inbound',
          text: 'マネージャーからの発言',
        },
      },
    ]);

    await screen.findByText(MANAGER_ID);
    const before = countsOf(stub);

    await waitFor(() => {
      const after = countsOf(stub);
      expect(after.manager).toBeGreaterThan(before.manager);
      expect(after.transcript).toBeGreaterThan(before.transcript);
    });
  });

  it('escalation が届くと manager と transcript を束で落とす', async () => {
    const stub = renderProbe([
      { event: 'open', data: { ok: true } },
      {
        event: 'escalation',
        data: {
          type: 'escalation',
          id: 'e3',
          at: '2026-08-14T00:00:00.000Z',
          question: '本番に出してよいか',
          approvalId: 'approval-1',
          managerId: MANAGER_ID,
        },
      },
    ]);

    await screen.findByText(MANAGER_ID);
    const before = countsOf(stub);

    await waitFor(() => {
      const after = countsOf(stub);
      expect(after.manager).toBeGreaterThan(before.manager);
      expect(after.transcript).toBeGreaterThan(before.transcript);
    });
  });
});

const TOKENS_RESPONSE = {
  tokens: [],
  settings: { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 },
};

function TokensProbe() {
  useJournalLive();
  const tokens = useTokens();
  return <div data-testid="tokens-count">{tokens.data?.tokens.length ?? -1}</div>;
}

function tokensCallCount(stub: FetchStub): number {
  return stub.calls.filter((url) => url.endsWith('/tokens')).length;
}

function renderTokensProbe(frames: { event: string; data: unknown }[]) {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/journal/stream'))
      return sse(frames, { keepOpen: true, signal: init?.signal });
    if (url.endsWith('/tokens')) return json(TOKENS_RESPONSE);
    return undefined;
  });
  render(
    <Providers>
      <TokensProbe />
    </Providers>,
  );
  return stub;
}

describe('プールの状態（GET /tokens）の取り直し', () => {
  it('token_rotation が届くと KEY.tokens を取り直す', async () => {
    const stub = renderTokensProbe([
      { event: 'open', data: { ok: true } },
      {
        event: 'token_rotation',
        data: {
          type: 'token_rotation',
          id: 'jr-1',
          at: '2026-08-25T00:00:00.000Z',
          event: 'rotated',
          tokenId: 't2',
          fromTokenId: 't1',
          generation: 2,
          text: 't1 から t2 へ回した',
        },
      },
    ]);

    await screen.findByText('0');
    const before = tokensCallCount(stub);
    expect(before).toBeGreaterThan(0);

    await waitFor(() => {
      expect(tokensCallCount(stub)).toBeGreaterThan(before);
    });
  });

  it('turn_usage が届いても KEY.tokens は取り直さない', async () => {
    const stub = renderTokensProbe([
      { event: 'open', data: { ok: true } },
      {
        event: 'turn_usage',
        data: {
          type: 'turn_usage',
          id: 'tu-1',
          at: '2026-08-25T00:00:00.000Z',
          layer: 'manager',
          site: 'session',
          managerId: MANAGER_ID,
          models: {
            'claude-opus-4': {
              costUsd: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        },
      },
    ]);

    await screen.findByText('0');
    const before = tokensCallCount(stub);
    expect(before).toBeGreaterThan(0);

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.endsWith('/journal/stream')).length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tokensCallCount(stub)).toBe(before);
  });
});

describe('再接続時の取り直し', () => {
  const RECONNECT_TIMEOUT = 4000;

  function ReconnectProbe() {
    const live = useJournalLive();
    const manager = useManager(MANAGER_ID);
    const transcript = useManagerTranscript(MANAGER_ID);
    useProfile();
    return (
      <div>
        <div data-testid="status">{live.status}</div>
        <div data-testid="manager">{manager.data?.manager.managerId ?? ''}</div>
        <div data-testid="transcript">
          {transcript.data?.kind === 'body' ? transcript.data.body : ''}
        </div>
      </div>
    );
  }

  function renderReconnect(first: 'close' | 'fail' | 'stay') {
    const state = { streams: 0 };
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/journal/stream')) {
        state.streams += 1;
        if (state.streams === 1 && first === 'fail') return undefined;
        return sse([{ event: 'open', data: { ok: true } }], {
          keepOpen: state.streams > 1 || first !== 'close',
          signal: init?.signal,
        });
      }
      if (url.endsWith(`/managers/${MANAGER_ID}`)) return json(MANAGER_DETAIL);
      if (url.endsWith(`/managers/${MANAGER_ID}/transcript`)) {
        return new Response('{"line":1}\n', { status: 200 });
      }
      if (url.endsWith('/profile')) return json({ entries: [] });
      return undefined;
    });
    render(
      <Providers>
        <ReconnectProbe />
      </Providers>,
    );
    return { stub, state };
  }

  const profileCalls = (stub: FetchStub) => stub.calls.filter((u) => u.endsWith('/profile')).length;

  it('初回の open では表示中のキーを取り直さない', async () => {
    const { stub } = renderReconnect('stay');

    await screen.findByText(MANAGER_ID);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('live'));
    await act(async () => {});
    expect(countsOf(stub)).toEqual({ manager: 1, transcript: 1 });
    expect(profileCalls(stub)).toBe(1);
  });

  it('接続が正常終了して繋ぎ直したとき、表示中のキーを取り直す', async () => {
    const { stub, state } = renderReconnect('close');

    await screen.findByText(MANAGER_ID);
    await waitFor(() => expect(state.streams).toBe(2), { timeout: RECONNECT_TIMEOUT });
    await waitFor(() => {
      const after = countsOf(stub);
      expect(after.manager).toBeGreaterThan(1);
      expect(after.transcript).toBeGreaterThan(1);
    });
  }, 10_000);

  it('接続の失敗（offline）から繋ぎ直したときも取り直す', async () => {
    const { stub, state } = renderReconnect('fail');

    await screen.findByText(MANAGER_ID);
    await waitFor(() => expect(state.streams).toBe(2), { timeout: RECONNECT_TIMEOUT });
    await waitFor(() => {
      const after = countsOf(stub);
      expect(after.manager).toBeGreaterThan(1);
      expect(after.transcript).toBeGreaterThan(1);
    });
  }, 10_000);

  it('繋ぎ直しでは自動の再取得をしない設定のキー（useProfile）を取り直さない', async () => {
    const { stub, state } = renderReconnect('close');

    await screen.findByText(MANAGER_ID);
    await waitFor(() => expect(profileCalls(stub)).toBe(1));
    await waitFor(() => expect(state.streams).toBe(2), { timeout: RECONNECT_TIMEOUT });
    await waitFor(() => expect(countsOf(stub).manager).toBeGreaterThan(1));
    await act(async () => {});
    expect(profileCalls(stub)).toBe(1);
  }, 10_000);
});
