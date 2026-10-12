// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import ProgressPage from './progress';

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const OBSERVED_AT = '2026-09-30T03:00:00.000Z';

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

function body(latestOk: Record<string, unknown>) {
  return {
    observedAt: OBSERVED_AT,
    window: { hours: 168, from: '2026-09-23T03:00:00.000Z', to: OBSERVED_AT },
    backlog: {
      total: 1,
      byOrigin: { human: 1, manager: 0, external: 0, self: 0 },
      age: {
        oldestAt: '2026-09-27T03:00:00.000Z',
        medianHours: 30,
        buckets: { under1h: 0, under24h: 0, under7d: 1, over7d: 0 },
      },
      byState: { untouched: 1, responded: 0, delegated: 0, notApplicable: 0 },
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
    github: {
      state: 'observed',
      repos: [
        {
          repo: 'x/y',
          latestOk: {
            observedAt: '2026-09-30T01:00:00.000Z',
            observedBy: 'clone',
            query: 'gh issue list',
            openIssues: 1,
            openPulls: 0,
            truncated: false,
            ...latestOk,
          },
          latestFailed: null,
        },
      ],
      scan: { limit: 500, reachedLimit: false },
    },
  };
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

describe('/progress の GitHub 観測の自由文は、日誌の要約と同じく伏せ字を通る', () => {
  it('ciUnavailable に混じったトークンを出さない（地の文は残す）', async () => {
    stubFetch((url) =>
      url.includes('/progress')
        ? json(body({ ciUnavailable: `gh failed: Authorization: token ${TOKEN}` }))
        : undefined,
    );
    renderPage();
    await screen.findByText(/取れなかった — gh failed/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('ci.checks に混じったトークンを出さない', async () => {
    stubFetch((url) =>
      url.includes('/progress')
        ? json(
            body({
              ci: {
                pulls: 1,
                success: 1,
                failure: 0,
                pending: 0,
                checks: `必須チェック（token ${TOKEN} で読んだ）`,
              },
            }),
          )
        : undefined,
    );
    renderPage();
    await screen.findByText(/必須チェック/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('開発者向けの query に混じったトークンを出さない', async () => {
    stubFetch((url) =>
      url.includes('/progress') ? json(body({ query: `GH_TOKEN=${TOKEN} gh pr list` })) : undefined,
    );
    renderPage();
    await screen.findByText(/gh pr list/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
