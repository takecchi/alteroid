// @vitest-environment jsdom
/**
 * ホームのタイルは、**一度読めたあとの取り直しが失敗しても、中身を残して取り直せなかったと注記する**
 * （issue #3346。進捗のタイルの #3069 と同じ形）。`data` が無いときだけエラーにする（それは各タイルの
 * 既存のテストが見ている）。
 *
 * **単発の失敗スタブでは `data` が一度も定まらない**ので、いったん成功させたあと経路だけを失敗に
 * 切り替え、`focus` イベント（SWR 既定の `revalidateOnFocus`）で取り直しを起こす。
 */
import { ZERO_USAGE } from '@alteroid/core/usage';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { homeRoute, renderHome, type HomeOptions } from './dashboard-test-helpers';

/** 稼働状況の図の経路（無いと図の「繋がらない」の alert が出て、タイルの alert と区別できない）。 */
const TOPOLOGY = { frames: [] };

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

function refocus() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

/** 読めた状態で描き、`failing` の経路だけを失敗に切り替えて取り直させる。 */
async function renderThenFail(
  healthy: HomeOptions,
  failing: HomeOptions,
  readable: RegExp | string,
  note: RegExp,
) {
  healthy = { ...healthy, topology: TOPOLOGY };
  failing = { ...failing, topology: TOPOLOGY };
  const stub = renderHome(healthy);
  expect(await screen.findByText(readable)).toBeTruthy();
  expect(screen.queryByText(note)).toBeNull();

  stub.setRoute(homeRoute(failing));
  refocus();
  expect(await screen.findByText(note)).toBeTruthy();
  // 画面を奪わない（エラーの枠に差し替わらない）。
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(readable)).toBeTruthy();

  stub.setRoute(homeRoute(healthy));
  refocus();
  await waitFor(() => expect(screen.queryByText(note)).toBeNull());
  expect(screen.getByText(readable)).toBeTruthy();
}

describe('ホームのタイル: 読めたあとの取り直しの失敗は、中身を残して注記する（issue #3346）', () => {
  it('「次の自動実行」', async () => {
    const schedule = {
      entries: [{ kind: 'cron', description: '朝の点検', nextAt: '2099-01-01T00:00:00.000Z' }],
    };
    await renderThenFail(
      { schedule },
      { schedule: 'fail' },
      '朝の点検',
      /最新の予定を取り直せなかった/,
    );
  });

  it('「今日の利用」', async () => {
    const usage = {
      rows: [
        {
          date: '2026-08-14',
          managerId: 'm1',
          model: 'claude-opus-4',
          updatedAt: '2026-08-14T10:00:00.000Z',
          totals: { ...ZERO_USAGE, costUsd: 1.23 },
        },
      ],
      since: '2026-08-01',
      beforeLedger: false,
    };
    await renderThenFail({ usage }, { usage: 'fail' }, /\$1\.23/, /最新の利用を取り直せなかった/);
  });

  it('「最新の日報」', async () => {
    const reports = [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-14T22:00:00.000Z',
        date: '2026-08-14',
        body: '昨日の日報の本文',
      },
    ];
    await renderThenFail(
      { reports },
      { reports: 'fail' },
      '昨日の日報の本文',
      /最新の日報を取り直せなかった/,
    );
  });

  it('「承認待ち一覧」（承認待ちが無かったときも、無いと言い切らない）', async () => {
    const stub = renderHome({ approvals: [], topology: TOPOLOGY });
    // 何も待っていないときは1行に畳む。
    expect(await screen.findByText('承認待ちはない')).toBeTruthy();
    stub.setRoute(homeRoute({ approvals: 'fail', topology: TOPOLOGY }));
    refocus();
    expect(await screen.findByText(/最新の承認待ちを取り直せなかった/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/前に読めたときは、承認待ちはなかった/)).toBeTruthy();
  });
});
