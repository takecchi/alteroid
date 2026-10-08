// @vitest-environment jsdom
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import {
  fixHomeClock,
  HOME_TODAY,
  homeRoute,
  renderHome,
  type HomeOptions,
} from './dashboard-test-helpers';

fixHomeClock();

// vi.hoisted にする: import の評価より後だと TZ の固定が静かに効かないため
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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

function cardOf(element: HTMLElement): HTMLElement {
  const card = element.closest<HTMLElement>('[data-slot="card"]');
  if (card === null) throw new Error('カードが見つからない');
  return card;
}

interface Tile {
  name: string;
  title?: string;
  ok: HomeOptions;
  fail: HomeOptions;
  content: string;
  note: RegExp;
}

const TILES: Tile[] = [
  {
    name: '次の自動実行',
    title: '次の自動実行',
    ok: {
      schedule: {
        entries: [
          { kind: 'k1', description: '毎日 22:00 に日報', nextAt: '2026-08-15T05:00:00.000Z' },
        ],
      },
    },
    fail: { schedule: 'fail' },
    content: '毎日 22:00 に日報',
    note: /最新の予定を取り直せなかった/,
  },
  {
    name: '今日の利用',
    title: '今日の利用',
    ok: {
      usage: {
        rows: [
          {
            date: HOME_TODAY,
            managerId: 'm1',
            model: 'claude-opus-4',
            updatedAt: '2026-08-14T10:00:00.000Z',
            totals: { ...ZERO_USAGE, costUsd: 0.02 },
          },
        ],
        since: '2026-08-01T00:00:00.000Z',
        beforeLedger: false,
      },
    },
    fail: { usage: 'fail' },
    content: '$0.0200',
    note: /最新の利用を取り直せなかった/,
  },
  {
    name: '最新の日報',
    title: '最新の日報',
    ok: {
      reports: [
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-14T22:00:00.000Z',
          date: '2026-08-14',
          body: '今日は日報の本文だけがある。',
        },
      ],
    },
    fail: { reports: 'fail' },
    content: '今日は日報の本文だけがある。',
    note: /最新の日報を取り直せなかった/,
  },
  {
    name: 'あなたの番',
    ok: {
      approvals: [{ id: 'approval-0', createdAt: '2026-08-14T09:00:00.000Z', question: '質問 0' }],
    },
    fail: { approvals: 'fail' },
    content: '質問 0',
    note: /最新の承認待ちを取り直せなかった/,
  },
];

describe.each(TILES)('「$name」のタイル', (tile) => {
  it('一度読めた後に取り直しが失敗しても、中身は残り、控えめな注記が出る', async () => {
    const stub = renderHome({ ...tile.ok, topology: { frames: [] } });
    await screen.findByText(tile.content);

    stub.setRoute(homeRoute({ ...tile.ok, ...tile.fail, topology: { frames: [] } }));
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText(tile.note)).toBeTruthy();
    const card = cardOf(screen.getByText(tile.content));
    expect(within(card).getByText(tile.note)).toBeTruthy();
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('最初から読めないときは、エラーを出す', async () => {
    renderHome({ ...tile.fail, topology: { frames: [] } });

    const card = cardOf(await screen.findByRole('alert'));
    if (tile.title !== undefined) expect(within(card).getByText(tile.title)).toBeTruthy();
    expect(within(card).queryByText(tile.note)).toBeNull();
    expect(within(card).queryByText(tile.content)).toBeNull();
  });
});

describe('「あなたの番」が、読めていた承認待ちが0件のまま取り直しに失敗したとき', () => {
  it('「承認待ちはない」と言い切らず、前に読めたときの言い分だと注記する', async () => {
    const stub = renderHome({ approvals: [], topology: { frames: [] } });
    await screen.findByText('承認待ちはない');

    stub.setRoute(homeRoute({ approvals: 'fail', topology: { frames: [] } }));
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText(/最新の承認待ちを取り直せなかった/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('「今日の利用」', () => {
  it('取り直しの失敗の後も、金額に但し書きを添える', async () => {
    const tile = TILES[1]!;
    const stub = renderHome({ ...tile.ok, topology: { frames: [] } });
    await screen.findByText(tile.content);

    stub.setRoute(homeRoute({ usage: 'fail', topology: { frames: [] } }));
    window.dispatchEvent(new Event('focus'));

    await screen.findByText(tile.note);
    expect(screen.getByText(USAGE_ESTIMATE_NOTICE)).toBeTruthy();
  });
});
