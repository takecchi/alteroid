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
