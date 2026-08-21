// @vitest-environment jsdom
/**
 * 日誌画面が SSE の `recent`（B-3）を履歴（`useJournal`）に重ねること。
 *
 * `AuthedShell` が1本だけ張った購読の結果を context 越しに受け取るだけで、
 * `Journal` 自身は `useJournalLive()` を呼ばない（呼んだら購読が増えてしまう）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from '~/hooks/journal-feed';
import type { JournalLive } from '~/hooks/use-journal-live';
import { summarizeJournalEntry } from '~/hooks/queries';
import type { JournalEntry } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Journal from './journal';

const HISTORY_ONLY: JournalEntry = {
  type: 'decision',
  id: 'h-decision',
  at: '2026-08-14T09:00:00.000Z',
  decision: '前からある判断',
  grounds: '記憶',
};

/** SSE で届いたあと、再取得で履歴側にも現れたもの（同じ id）。 */
const SHARED: JournalEntry = {
  type: 'exchange',
  id: 'shared-1',
  at: '2026-08-14T09:05:00.000Z',
  with: 'human',
  role: 'inbound',
  text: '両方に載る発言',
};

const RECENT_EXCHANGE: JournalEntry = {
  type: 'exchange',
  id: 'recent-exchange',
  at: '2026-08-14T09:10:00.000Z',
  with: 'human',
  role: 'outbound',
  text: 'たった今届いた発言',
};

const RECENT_ESCALATION: JournalEntry = {
  type: 'escalation',
  id: 'recent-escalation',
  at: '2026-08-14T09:11:00.000Z',
  question: 'たった今届いた確認',
  approvalId: 'approval-x',
};

const WORKER_WAIT: JournalEntry = {
  type: 'worker_wait',
  id: 'ww-1',
  at: '2026-08-20T22:10:00.000Z',
  openedAt: '2026-08-20T21:30:00.000Z',
  tasks: 5,
  turns: 41,
  byCause: { input: 1, notification: 3, continuation: 37 },
  toolless: 38,
  notifications: 3,
  submits: 0,
  settled: true,
};

const TURN_USAGE: JournalEntry = {
  type: 'turn_usage',
  id: 'tu-1',
  at: '2026-08-20T22:20:00.000Z',
  layer: 'clone',
  site: 'session',
  managerId: 'clone',
  models: {
    'claude-fable-5': {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 120,
      cacheCreationInputTokens: 40,
      webSearchRequests: 0,
      costUsd: 0.5,
    },
  },
};

function renderJournal(live: JournalLive) {
  return render(
    <Providers>
      <JournalFeedProvider value={live}>
        <Journal />
      </JournalFeedProvider>
    </Providers>,
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

/**
 * **日誌の1行が、日報が書けなかった日を「日報」と呼ばないこと。**
 *
 * 日報の行には「書けなかった」の印が付くことがある（`packages/core/src/schema.ts`
 * の `unavailable`）。日誌は人間が拾い読みする面でもあるので、ここが
 * 「2026-08-20 の日報」としか言わないと、**書けなかった日が書けた日と同じ顔で
 * 並ぶ** — 発端の壊れ方（エラー文が日報として出ていた）の、一覧側の残りである。
 */
describe('日誌の1行は、日報が書けなかった日を日報と呼ばない', () => {
  const REASON = "You've hit your org's monthly spend limit";
  const UNAVAILABLE: JournalEntry = {
    type: 'daily_report',
    id: 'dr-unavailable',
    at: '2026-08-20T22:00:00.000Z',
    date: '2026-08-20',
    body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${REASON}）`,
    unavailable: REASON,
  };
  const WRITTEN: JournalEntry = {
    type: 'daily_report',
    id: 'dr-written',
    at: '2026-08-19T22:00:00.000Z',
    date: '2026-08-19',
    body: '進捗があった。',
  };

  it('印の付いた日は「作れなかった」と理由まで言い、書けた日はこれまでどおり', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) {
        return json({ entries: [UNAVAILABLE, WRITTEN], scanned: 2 });
      }
      return undefined;
    });

    renderJournal({ status: 'live', recent: [] });

    // **文言を直に書く。** `summarizeJournalEntry(...)` で引くと、実装と同じ関数を
    // 通ることになって何も保証しない（同語反復になる）。
    expect(await screen.findByText(`⚠ 2026-08-20 の日報は作れなかった: ${REASON}`)).toBeTruthy();
    expect(screen.getByText('2026-08-19 の日報')).toBeTruthy();
  });
});

describe('recent を履歴に重ねる', () => {
  it('再取得を待たずに recent の中身が出る', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [HISTORY_ONLY], scanned: 1 });
      return undefined;
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE, RECENT_ESCALATION] });

    expect(await screen.findByText(summarizeJournalEntry(RECENT_EXCHANGE))).toBeTruthy();
    expect(screen.getByText(summarizeJournalEntry(RECENT_ESCALATION))).toBeTruthy();
    // 履歴側にもともとあったものも消えていない
    expect(screen.getByText(summarizeJournalEntry(HISTORY_ONLY))).toBeTruthy();
  });

  it('同じ id のエントリが履歴側にも現れても二重に出ない', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [SHARED, HISTORY_ONLY], scanned: 2 });
      return undefined;
    });

    // SHARED は「recent で届いた直後、再取得が終わって履歴側にも現れた」状態を再現する。
    renderJournal({ status: 'live', recent: [SHARED, RECENT_EXCHANGE] });

    await screen.findByText(summarizeJournalEntry(RECENT_EXCHANGE));
    expect(screen.getAllByText(summarizeJournalEntry(SHARED))).toHaveLength(1);
  });

  it('種別フィルタに recent 側も従う', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'exchange') return json({ entries: [SHARED], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, SHARED], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE, RECENT_ESCALATION] });

    // 絞り込み前は4種類とも出ている
    await screen.findByText(summarizeJournalEntry(HISTORY_ONLY));
    expect(screen.getByText(summarizeJournalEntry(SHARED))).toBeTruthy();
    expect(screen.getByText(summarizeJournalEntry(RECENT_EXCHANGE))).toBeTruthy();
    expect(screen.getByText(summarizeJournalEntry(RECENT_ESCALATION))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'exchange' }));

    // exchange だけに絞られる（history 側は再取得されたぶん、recent 側も同じ条件で絞る）
    await waitFor(() => {
      expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();
      expect(screen.queryByText(summarizeJournalEntry(RECENT_ESCALATION))).toBeNull();
    });
    expect(screen.getByText(summarizeJournalEntry(SHARED))).toBeTruthy();
    expect(screen.getByText(summarizeJournalEntry(RECENT_EXCHANGE))).toBeTruthy();
  });
});

/**
 * **空回りが目で分かる文言であること**（`summarizeJournalEntry` の doc）と、
 * 他の種別と同じ絞り込み経路（`GET /journal?type=`）に乗っていること。
 */
describe('worker_wait — 種別フィルタと1行の文言', () => {
  it('1行は空回りが目で分かる文言で、絞り込みボタンでも選べる', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'worker_wait') return json({ entries: [WORKER_WAIT], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, WORKER_WAIT], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [] });

    await screen.findByText(summarizeJournalEntry(HISTORY_ONLY));
    const row = screen.getByText(summarizeJournalEntry(WORKER_WAIT));
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('作業者 5 体を待つあいだに 41 ターン');
    expect(row.textContent).toContain('自己継続 37');
    expect(row.textContent).toContain('道具を1つも動かしていない');

    fireEvent.click(screen.getByRole('button', { name: 'worker_wait' }));

    await waitFor(() => {
      expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();
    });
    expect(screen.getByText(summarizeJournalEntry(WORKER_WAIT))).toBeTruthy();
  });
});

/**
 * **キャッシュの書き直しが目で分かる文言であること**（`summarizeJournalEntry`
 * の doc — read/write を潰すと測る意味が消える）と、他の種別と同じ絞り込み
 * 経路（`GET /journal?type=`）に乗っていること。
 */
describe('turn_usage — 種別フィルタと1行の文言', () => {
  it('1行は cache read/write を潰さない文言で、絞り込みボタンでも選べる', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'turn_usage') return json({ entries: [TURN_USAGE], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, TURN_USAGE], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [] });

    await screen.findByText(summarizeJournalEntry(HISTORY_ONLY));
    const row = screen.getByText(summarizeJournalEntry(TURN_USAGE));
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('read=120');
    expect(row.textContent).toContain('write=40');

    fireEvent.click(screen.getByRole('button', { name: 'turn_usage' }));

    await waitFor(() => {
      expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();
    });
    expect(screen.getByText(summarizeJournalEntry(TURN_USAGE))).toBeTruthy();
  });
});
