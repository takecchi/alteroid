// @vitest-environment jsdom
/**
 * マネージャー詳細と生ログの無効化漏れ（B-2）。
 *
 * `invalidate()` は `tool_use` / `exchange(with:'manager')` / `escalation` で
 * 一覧（`KEY.managers`）しか落としていなかった。詳細（`KEY.manager(id)`）と
 * 生ログ（`KEY.transcript(id)`）は束で落ちること — id を指定しないので、
 * `exchange(with:'manager')` のように manager id を持たない種別が来ても
 * 取りこぼさないことを固定する。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useManager, useManagerTranscript } from '~/hooks/queries';
import { useJournalLive } from '~/hooks/use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '~/test-support';

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
      <div data-testid="transcript">{transcript.data ?? ''}</div>
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

  /**
   * クローンにも道具が全部ある（#32）ので、`tool_use` は**マネージャー発とは
   * 限らない**。クローンが自分で作業しているあいだ画面が再取得を続けると、
   * 何も動いていないマネージャーの一覧・詳細・生ログを取り直し続けることになる。
   */
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
          // クローンが起こしたサブエージェントの分も同じ扱いである
          actor: 'clone:sub:general-purpose',
          tool: 'Read',
          input: { file_path: '/tmp/a' },
        },
      },
    ]);

    await screen.findByText(MANAGER_ID);
    const before = countsOf(stub);

    // **「増えないこと」は待って確かめる。** 直後に見るだけでは、まだ届いて
    // いないだけの状態を「増えなかった」と読んでしまう。
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
