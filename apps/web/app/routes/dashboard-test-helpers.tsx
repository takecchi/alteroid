/**
 * ホーム（`dashboard.tsx`）のテストが共有する足場。**テストではない**（`*.test.tsx` ではない）。
 *
 * ホームは次の経路を読む: `/reports` `/approvals` `/progress` `/managers` `/schedule` `/usage` と、
 * 稼働の地図の SSE `/topology/stream`。**日誌の SSE（`/journal/stream`）の経路は置いていない。**
 * 置くと購読が増えたことに気づけない（知らない URL は `stubFetch` が「繋がらない」にするので、
 * 張りに行けば `stub.calls` に必ず出る）。
 *
 * 時刻を assert するテストは、自分で `TZ` を固定すること（AGENTS.md「時刻の扱い」。
 * `vi.hoisted` でなければ静かに効かない。各テストの冒頭を参照）。
 */
import { USAGE_ESTIMATE_NOTICE } from '@alteroid/core/usage';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { json, Providers, sse, stubFetch, type FetchStub, type Route } from '~/test-support';

import Dashboard from './dashboard';

export interface HomeOptions {
  usage?: {
    rows: unknown[];
    since: string | null;
    beforeLedger: boolean;
    notice?: string;
    turnRows?: unknown[];
    /** `null` は「応答に `today` が無い」（古いデーモン）。既定は 2026-08-14。 */
    today?: string | null;
    unreadableRows?: unknown[];
  };
  reports?: unknown[];
  /** 承認待ちの行。`'fail'` は 500、`{ raw }` は応答の本文をそのまま返す（版のずれ）。 */
  approvals?: unknown[] | 'fail' | { raw: unknown };
  managers?: { managers: unknown; unreadable?: unknown[] } | 'fail';
  schedule?: { entries: unknown[]; unreadable?: unknown[] } | 'fail';
  /** `GET /progress` の応答。`'fail'` は 500。既定の応答は未了 5 件、実行中 3 件。 */
  progress?: unknown | 'fail';
  /**
   * 稼働の地図の SSE。`frames` は流す枠。`undefined` は経路を置かない（繋がらない扱い）。
   * `keepOpen` は既定で真（閉じると再接続を繰り返すため）。
   */
  topology?: { frames: { event: string; data: unknown; after?: PromiseLike<unknown> }[] };
  /** この経路は解決しない Promise で保留する（読み込み中のまま止める）。 */
  hold?: ('approvals' | 'managers' | 'progress' | 'reports' | 'schedule' | 'usage')[];
}

export const PROGRESS_BODY = {
  observedAt: '2026-08-14T09:00:00.000Z',
  window: { hours: 168, from: '2026-08-07T09:00:00.000Z', to: '2026-08-14T09:00:00.000Z' },
  backlog: {
    total: 5,
    byOrigin: { human: 2, manager: 1, external: 1, self: 1 },
    age: {
      oldestAt: '2026-08-10T09:00:00.000Z',
      medianHours: 30,
      buckets: { under1h: 0, under24h: 1, under7d: 4, over7d: 0 },
    },
    byState: { untouched: 1, responded: 1, delegated: 2, notApplicable: 1 },
    completeness: { unreadable: 0, trimmedClosed: 0, unreadableJobs: 0 },
  },
  inProgress: {
    running: 3,
    awaitingHuman: 1,
    lost: 0,
    lastReport: { oldestAt: null, newestAt: null, withoutReport: 0 },
  },
  throughput: {
    commitmentsOpened: 14,
    commitmentsClosed: 12,
    delegationsEnded: { count: 4, basis: 'updatedAt' },
  },
  forecast: { state: 'not_converging', basis: {} },
  github: { state: 'not_observed', reason: 'なし' },
};

/** 経路の表。`hold` は呼び手（`renderHome`）が別に包む。 */
export function homeRoute(options: HomeOptions = {}): Route {
  const usage = options.usage ?? { rows: [], since: null, beforeLedger: false };
  return (url, init) => {
    if (url.includes('/topology/stream')) {
      return options.topology === undefined
        ? undefined
        : sse(options.topology.frames, { keepOpen: true, signal: init?.signal });
    }
    if (url.includes('/reports')) return json({ reports: options.reports ?? [] });
    if (url.includes('/approvals')) {
      const approvals = options.approvals ?? [];
      if (approvals === 'fail') return json({ error: 'internal' }, 500);
      return json(Array.isArray(approvals) ? { approvals } : approvals.raw);
    }
    if (url.includes('/progress')) {
      return options.progress === 'fail'
        ? json({ error: 'internal' }, 500)
        : json(options.progress ?? PROGRESS_BODY);
    }
    if (url.includes('/managers')) {
      const managers = options.managers ?? { managers: [] };
      return managers === 'fail' ? json({ error: 'internal' }, 500) : json(managers);
    }
    if (url.includes('/schedule')) {
      const schedule = options.schedule ?? { entries: [] };
      return schedule === 'fail' ? json({ error: 'internal' }, 500) : json(schedule);
    }
    if (url.includes('/usage')) {
      const { today, ...rest } = usage;
      return json({
        ...rest,
        ...(today === null ? {} : { today: today ?? '2026-08-14' }),
        notice: usage.notice ?? USAGE_ESTIMATE_NOTICE,
        turnRows: usage.turnRows ?? [],
        breakdown: null,
      });
    }
    return undefined;
  };
}

/** ホームを `/` に描く。呼び手が `afterEach` で `cleanup` と `fetch` の戻しをすること。 */
export function renderHome(options: HomeOptions = {}): FetchStub {
  const route = homeRoute(options);
  const hold = options.hold ?? [];
  const stub = stubFetch(route);
  if (hold.length > 0) {
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (hold.some((name) => url.includes(`/${name}`))) return new Promise<Response>(() => {});
      return stubbed(input, init);
    }) as typeof fetch;
  }
  const router = createMemoryRouter([{ path: '/', Component: Dashboard }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

/** 地図の1スナップショット（`GET /topology` と同じ形）。 */
export function topologySnapshot(patch: Record<string, unknown> = {}) {
  return {
    observedAt: '2026-08-14T09:00:00.000Z',
    clone: { state: 'idle' },
    storage: { state: 'ok', label: 'postgres' },
    runners: [{ label: 'runner-a', state: 'connected', since: '2026-08-14T08:00:00.000Z' }],
    managers: [],
    links: [],
    ...patch,
  };
}
