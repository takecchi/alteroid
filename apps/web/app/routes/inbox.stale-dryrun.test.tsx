// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import Inbox from './inbox';

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

function dryRunPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    dryRun: true,
    totalPending: 120,
    matched: 40,
    targeted: 40,
    removedIds: ['evt-old'],
    remaining: 0,
    ...overrides,
  };
}

// 応答を手で返す: 実時間を待たずに「応答待ちに欄を変える」順序を作るため
function stubDeferredRemove() {
  const pending: Array<(status: number, payload: unknown) => void> = [];
  const bodies: Array<{ dryRun: boolean; types: string[] }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    bodies.push(JSON.parse(await request.clone().text()));
    return new Promise<Response>((resolve) => {
      pending.push((status, payload) => resolve(json(payload, status)));
    });
  }) as typeof fetch;
  return { pending, bodies };
}

describe('/inbox 一括削除 — 試算の応答待ちに絞り込みを変えた（#4031）', () => {
  it('古い条件の試算は捨て、「実行する」を出さない', async () => {
    const { pending, bodies } = stubDeferredRemove();
    render(
      <Providers>
        <TestDataRouter>
          <Inbox />
        </TestDataRouter>
      </Providers>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /マネージャーの報告/ }));
    fireEvent.change(screen.getByLabelText('理由（日誌に残る・必須）'), {
      target: { value: '畳む' },
    });
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));
    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.click(screen.getByRole('checkbox', { name: /定期ジョブ/ }));
    await act(async () => {
      pending[0]?.(200, dryRunPayload());
    });

    expect(bodies).toHaveLength(1);
    expect(screen.queryByText(/未読 120 件中 40 件が絞り込みに一致/)).toBeNull();
    expect(screen.queryByRole('button', { name: /実行する/ })).toBeNull();
    // 応答が捨てられたあとは、新しい条件で試算し直せる
    expect(screen.getByRole('button', { name: '試算する' }).hasAttribute('disabled')).toBe(false);
  });
});
