// @vitest-environment jsdom
/**
 * 台帳（`GET /commitments`）の SSE による取り直し（#3784）。
 *
 * 「未了の仕事」の画面を開いたままにすると、クローンが台帳を動かしても一覧が
 * 古いまま残った。クローン自身の `tool_use` は `managers` を落とさない関門
 * （`isCloneActor`）の内側にあり、`commitments` を落とす経路が無かった。
 * 人間への返事（「未着手」の印）・委譲の開始と終わり（「進行中」の印）も同じ。
 *
 * **取り直したことの証拠は `GET /commitments` の回数である。** 「取り直さない」側は
 * 「取り直さない」側は、受信件数（`received`）が全件に達した時点で処理が済んだと
 * 読んで回数を確かめる（実時間の待ちは入れない）。
 */
import { CLONE_TOOL_NAMES } from '@alteroid/core';
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

/** `open` の後ろに `frames` を流す SSE と、空の `GET /commitments` を立てて描く。 */
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

/** 台帳を書く道具（`commitment_list` 以外）。core の名簿から数える。 */
const LEDGER_WRITERS = CLONE_TOOL_NAMES.filter(
  (name) => name.startsWith('commitment_') && name !== 'commitment_list',
);

describe('台帳の取り直し（SSE）', () => {
  it('core の名簿に台帳を書く道具が居る（数え上げが空にならない）', () => {
    expect([...LEDGER_WRITERS].sort()).toEqual([
      'commitment_close',
      'commitment_close_many',
      'commitment_edit',
      'commitment_open',
    ]);
  });

  it.each(LEDGER_WRITERS)('クローン自身の %s の tool_use で一覧を取り直す', async (tool) => {
    const stub = renderProbe([toolUse('t1', 'clone', tool)]);
    // 初回の取得 + 取り直しで2回以上
    await waitFor(() => {
      expect(commitmentFetches(stub)).toBeGreaterThanOrEqual(2);
    });
  });

  it('クローンが起こしたサブエージェントの台帳の道具でも取り直す', async () => {
    const stub = renderProbe([toolUse('t1', 'clone:sub:general-purpose', 'commitment_close')]);
    await waitFor(() => {
      expect(commitmentFetches(stub)).toBeGreaterThanOrEqual(2);
    });
  });

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

  /**
   * 取り直しすぎない歯。台帳を読むだけの道具・台帳と無関係な道具では取り直さない。
   */
  it('台帳を書かない道具の tool_use（commitment_list・Bash）では取り直さない', async () => {
    const stub = renderProbe([
      toolUse('t1', 'clone', 'commitment_list'),
      toolUse('t2', 'clone', 'Bash'),
      toolUse('t3', 'clone:sub:general-purpose', 'Read'),
    ]);
    await screen.findByText('loaded');
    await waitFor(() => {
      expect(screen.getByTestId('received').textContent).toBe('3');
    });
    // 3件とも処理済み。ここまでで取得は初回の1回だけ。
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
