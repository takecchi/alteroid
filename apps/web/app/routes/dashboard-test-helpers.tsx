// 日誌の SSE（/journal/stream）の経路を置かない: 置くと購読が増えたことに気づけないため
import { USAGE_ESTIMATE_NOTICE } from '@alteroid/core/usage';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, vi } from 'vitest';

import { json, Providers, sse, stubFetch, type FetchStub, type Route } from '~/test-support';

import Dashboard from './dashboard';

export interface HomeOptions {
  usage?:
    | 'fail'
    | {
        rows: unknown[];
        since: string | null;
        beforeLedger: boolean;
        notice?: string;
        turnRows?: unknown[];
        today?: string | null;
        unreadableRows?: unknown[];
      };
  reports?: unknown[] | 'fail' | { raw: unknown };
  approvals?: unknown[] | 'fail' | { raw: unknown };
  managers?: { managers: unknown; unreadable?: unknown[] } | 'fail';
  schedule?: { entries: unknown[]; unreadable?: unknown[] } | 'fail';
  progress?: unknown | 'fail';
  topology?: { frames: { event: string; data: unknown; after?: PromiseLike<unknown> }[] };
  hold?: ('approvals' | 'managers' | 'progress' | 'reports' | 'schedule' | 'usage')[];
  /** `/status` の応答。省略は「繋がらない」（帯は何も出さない）。 */
  status?: unknown;
}

export const HOME_TODAY = '2026-08-14';

/**
 * ホームの時計を `HOME_TODAY` に固定する（ファイルの先頭で呼ぶ）。今日の利用の窓は端末の時計で決まるので、
 * 実時計のままだと、応答の today が窓に入るかが走らせた日で変わる。
 * `Date` だけを偽物にして実時間で進める: 止めると SWR の取り直しの間隔が動かず、取り直しの試験が進まないため。
 * 刻みを 1ms にする: 既定の 20ms 刻みだと、続けて起こした focus が同じ時刻になり、SWR が2回目を間引くため。
 */
export function fixHomeClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, advanceTimeDelta: 1 });
    vi.setSystemTime(new Date(`${HOME_TODAY}T09:00:00.000Z`));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
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

export function homeRoute(options: HomeOptions = {}): Route {
  const usageOption = options.usage ?? { rows: [], since: null, beforeLedger: false };
  return (url, init) => {
    if (url.includes('/topology/stream')) {
      return options.topology === undefined
        ? undefined
        : sse(options.topology.frames, { keepOpen: true, signal: init?.signal });
    }
    if (url.endsWith('/status')) {
      return options.status === undefined ? undefined : json(options.status);
    }
    if (url.includes('/reports')) {
      const reports = options.reports ?? [];
      if (reports === 'fail') return json({ error: 'internal' }, 500);
      return json(Array.isArray(reports) ? { reports } : reports.raw);
    }
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
      if (usageOption === 'fail') return json({ error: 'internal' }, 500);
      const usage = usageOption;
      const { today, ...rest } = usage;
      return json({
        ...rest,
        ...(today === null ? {} : { today: today ?? HOME_TODAY }),
        notice: usage.notice ?? USAGE_ESTIMATE_NOTICE,
        turnRows: usage.turnRows ?? [],
        breakdown: null,
      });
    }
    return undefined;
  };
}

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
