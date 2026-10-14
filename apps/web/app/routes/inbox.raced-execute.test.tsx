// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

/** 試算では5件を選び、実行ではそのうち removedOnExecute だけを消せた（残りは他の経路が先に消した）と返す。 */
function stubRaced(removedOnExecute: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = JSON.parse(await (input as Request).clone().text()) as { dryRun: boolean };
    return json({
      ok: true,
      dryRun: body.dryRun,
      totalPending: 5,
      matched: 5,
      targeted: 5,
      removedIds: body.dryRun ? ['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5'] : removedOnExecute,
      remaining: 0,
    });
  }) as typeof fetch;
}

async function dryRunThenExecute(): Promise<void> {
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
  fireEvent.click(await screen.findByRole('button', { name: /実行する/ }));
  await screen.findByText('実行済み');
}

describe('/inbox 一括削除 — 対象を他の経路が先に消した分を言う（#4807）', () => {
  it('⭐ 対象の全部を他の経路が先に消していたら、「対象になる合図は無い」と言わず、消せなかった件数を言う', async () => {
    stubRaced([]);
    await dryRunThenExecute();

    expect(screen.getByText(/対象 5 件のうち 5 件は消せなかった/)).toBeTruthy();
    expect(screen.queryByText('対象になる合図は無い。')).toBeNull();
  });

  it('一部だけ消せたなら、消した id と、消せなかった件数の両方を出す', async () => {
    stubRaced(['evt-1', 'evt-2', 'evt-3']);
    await dryRunThenExecute();

    expect(screen.getByText('evt-3')).toBeTruthy();
    expect(screen.getByText(/対象 5 件のうち 2 件は消せなかった/)).toBeTruthy();
  });

  it('対照: 全部消せたなら、消せなかった旨は出さない', async () => {
    stubRaced(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5']);
    await dryRunThenExecute();

    expect(screen.queryByText(/消せなかった/)).toBeNull();
  });
});
