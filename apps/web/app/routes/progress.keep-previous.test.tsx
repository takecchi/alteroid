// @vitest-environment jsdom
/**
 * `/progress` 画面で期間を替えても、読めていた中身を消さない（issue #3419）。
 *
 * 期間を替えると SWR のキーが変わり、新しいキーの `data` が無い間、中身が全部
 * スピナーに入れ替わっていた。`useCommitments`（#3074）と同じく前の中身を残し、
 * 前の期間の数字を見せている間は、数字のそばで「読み込み中」と言う。
 * 初回（まだ何も読めていない）はこれまでどおりスピナーである。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import ProgressPage from './progress';

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

const OBSERVED_AT = '2026-09-30T03:00:00.000Z';

function body(total: number, hours: number) {
  return {
    observedAt: OBSERVED_AT,
    window: { hours, from: '2026-09-23T03:00:00.000Z', to: OBSERVED_AT },
    backlog: {
      total,
      byOrigin: { human: total, manager: 0, external: 0, self: 0 },
      age: {
        oldestAt: '2026-09-27T03:00:00.000Z',
        medianHours: 30.25,
        buckets: { under1h: 0, under24h: 0, under7d: total, over7d: 0 },
      },
      byState: { untouched: total, responded: 0, delegated: 0, notApplicable: 0 },
      completeness: { unreadable: 0, trimmedClosed: 0, unreadableJobs: 0 },
    },
    inProgress: {
      running: 0,
      awaitingHuman: 0,
      lost: 0,
      lastReport: { oldestAt: null, newestAt: null, withoutReport: 0 },
    },
    throughput: {
      commitmentsOpened: 0,
      commitmentsClosed: 0,
      delegationsEnded: { count: 0, basis: 'updatedAt' },
    },
    forecast: { state: 'unavailable', reason: 'closed_too_few' },
    github: { state: 'not_observed', reason: 'x' },
  };
}

/** 24時間の要求だけ、`release()` まで応答を止める。 */
function stubHeld24h() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetch((url) => {
    if (!url.includes('/progress')) return undefined;
    if (url.includes('windowHours=24')) return gate.then(() => json(body(31, 24)));
    return json(body(12, 168));
  });
  return release;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/progress',
        element: (
          <Providers>
            <ProgressPage />
          </Providers>
        ),
      },
    ],
    { initialEntries: ['/progress'] },
  );
  render(<RouterProvider router={router} />);
}

const MARK = /前の期間の数字/;

describe('/progress 画面 — 期間を替えても前の中身を残す（#3419）', () => {
  it('替えたあと新しい応答が来るまで、前の数字が見え、そばに読み込み中の印がある', async () => {
    stubHeld24h();
    renderPage();
    await screen.findByText('12');
    expect(screen.queryByText(MARK)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: '24時間' }));

    expect(await screen.findByText(MARK)).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('新しい応答が来たら印が消え、新しい数字になる', async () => {
    const release = stubHeld24h();
    renderPage();
    await screen.findByText('12');
    fireEvent.click(screen.getByRole('radio', { name: '24時間' }));
    await screen.findByText(MARK);

    await act(async () => {
      release();
    });

    await waitFor(() => {
      expect(screen.queryByText(MARK)).toBeNull();
    });
    expect(screen.getByText('31')).toBeTruthy();
    expect(screen.queryByText('12')).toBeNull();
  });

  it('初回（まだ何も読めていない）は印ではなくスピナーである', async () => {
    stubFetch((url) => (url.includes('/progress') ? new Promise<Response>(() => {}) : undefined));
    renderPage();

    expect(await screen.findByText('読み込み中')).toBeTruthy();
    expect(screen.queryByText(MARK)).toBeNull();
  });
});

describe('/progress 画面 — 新しい期間の取得が失敗したとき（#3419）', () => {
  it('前の期間の数字だと言い、再試行の口を残す', async () => {
    stubFetch((url) => {
      if (!url.includes('/progress')) return undefined;
      return url.includes('windowHours=24') ? json({ error: 'boom' }, 500) : json(body(12, 168));
    });
    renderPage();
    await screen.findByText('12');

    fireEvent.click(screen.getByRole('radio', { name: '24時間' }));

    expect(
      await screen.findByText(/新しい期間では読み込めなかった。下は前の期間の数字/),
    ).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    // 同じ期間の取り直しの失敗の文言ではない。
    expect(screen.queryByText(/下の数は前に読めたときのもの/)).toBeNull();
    expect(screen.getByRole('button', { name: /再試行|もう一度/ })).toBeTruthy();
  });
});
