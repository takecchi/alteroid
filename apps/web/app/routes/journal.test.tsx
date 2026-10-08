// @vitest-environment jsdom
// 行の文言を画面で探さない: virtua は jsdom で実寸を測れず、行を1行も描かないため
import { JOURNAL_ENTRY_TYPES } from '@alteroid/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalFeedProvider, summarizeJournalEntry } from '@alteroid/swr';
import type { JournalLive } from '@alteroid/swr';
import { formatDateTime, JOURNAL_TYPE_LABEL } from '@alteroid/logic';
import type { JournalEntry } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Journal from './journal';

// Spinner の消滅を読み込み完了の代理にする: virtua は jsdom で行を描かず、findByText では待てないため
async function waitForLoaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByText('読み込み中')).toBeNull());
}

const HISTORY_ONLY: JournalEntry = {
  type: 'decision',
  id: 'h-decision',
  at: '2026-08-14T09:00:00.000Z',
  decision: '前からある判断',
  grounds: '記憶',
};

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

function renderJournal(live: JournalLive, initialEntries: string[] = ['/']) {
  const router = createMemoryRouter([{ path: '/', Component: Journal }], {
    initialEntries,
  });
  const result = render(
    <Providers>
      <JournalFeedProvider value={live}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
  return { ...result, router };
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
    await waitForLoaded();

    // 文言を直に書く: summarizeJournalEntry で引くと実装と同じ関数を通り、同語反復で何も保証しないため
    expect(screen.queryByText(`⚠ 2026-08-20 の日報は作れなかった: ${REASON}`)).toBeNull();
    expect(screen.queryByText('2026-08-19 の日報')).toBeNull();
  });
});

describe('絞り込みチップが日誌の全種別を尽くす', () => {
  it('JOURNAL_ENTRY_TYPES の全種別ぶんのチップが、他のボタンを増やさずに出る', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [], scanned: 0 });
      return undefined;
    });

    renderJournal({ status: 'live', recent: [] });
    await screen.findByRole('heading', { name: '日誌' });

    for (const type of JOURNAL_ENTRY_TYPES) {
      expect(screen.getByRole('button', { name: JOURNAL_TYPE_LABEL[type] })).toBeTruthy();
    }
    expect(screen.getAllByRole('button')).toHaveLength(JOURNAL_ENTRY_TYPES.length);
  });
});

describe('recent を履歴に重ねる', () => {
  it('再取得を待たずに recent の中身が出る（画面には出ない。歯は journal-window.test.ts 側）', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [HISTORY_ONLY], scanned: 1 });
      return undefined;
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE, RECENT_ESCALATION] });
    await waitForLoaded();

    expect(screen.queryByText(summarizeJournalEntry(RECENT_EXCHANGE))).toBeNull();
    expect(screen.queryByText(summarizeJournalEntry(RECENT_ESCALATION))).toBeNull();
    expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();
  });

  it('同じ id のエントリが履歴側にも現れても二重に出ない（画面には出ない。歯は journal-window.test.ts 側）', async () => {
    stubFetch((url) => {
      if (url.includes('/journal')) return json({ entries: [SHARED, HISTORY_ONLY], scanned: 2 });
      return undefined;
    });

    renderJournal({ status: 'live', recent: [SHARED, RECENT_EXCHANGE] });
    await waitForLoaded();

    expect(screen.queryAllByText(summarizeJournalEntry(SHARED))).toHaveLength(0);
  });

  it('種別フィルタに recent 側も従う（画面には出ないが、絞り込みは実際にサーバへ届く）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'exchange') return json({ entries: [SHARED], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, SHARED], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE, RECENT_ESCALATION] });
    await waitForLoaded();

    expect(screen.queryByText(summarizeJournalEntry(HISTORY_ONLY))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'やりとり' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (url) => url.includes('/journal') && new URL(url).searchParams.get('type') === 'exchange',
        ),
      ).toBe(true);
    });
    expect(screen.queryByText(summarizeJournalEntry(SHARED))).toBeNull();
  });
});

describe('worker_wait — 種別フィルタと1行の文言', () => {
  it('絞り込みボタンで type=worker_wait が実際にサーバへ届く（1行の文言は queries.test.ts 側）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'worker_wait') return json({ entries: [WORKER_WAIT], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, WORKER_WAIT], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByText(summarizeJournalEntry(WORKER_WAIT))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '作業者の待機' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (url) =>
            url.includes('/journal') && new URL(url).searchParams.get('type') === 'worker_wait',
        ),
      ).toBe(true);
    });
  });
});

describe('turn_usage — 種別フィルタと1行の文言', () => {
  it('絞り込みボタンで type=turn_usage が実際にサーバへ届く（1行の文言は queries.test.ts 側）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const type = new URL(url).searchParams.get('type');
      if (type === 'turn_usage') return json({ entries: [TURN_USAGE], scanned: 1 });
      return json({ entries: [HISTORY_ONLY, TURN_USAGE], scanned: 2 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByText(summarizeJournalEntry(TURN_USAGE))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ターンの消費' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (url) =>
            url.includes('/journal') && new URL(url).searchParams.get('type') === 'turn_usage',
        ),
      ).toBe(true);
    });
  });
});

describe('もっと遡る（過去方向のカーソル送り）', () => {
  const CURSOR_BASE = new Date('2026-08-20T00:00:00.000Z').getTime();

  function pastDecision(id: string, minutesAgo: number): JournalEntry {
    return {
      type: 'decision',
      id,
      at: new Date(CURSOR_BASE - minutesAgo * 60_000).toISOString(),
      decision: `d-${id}`,
      grounds: 'g',
    };
  }

  const PAGE = Array.from({ length: 100 }, (_, i) => pastDecision(`p${i}`, i));

  it('until には一覧の末尾（最古）の at を渡す（先頭の at と取り違えたら落ちる）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) {
        return json({ entries: [], scanned: 0 });
      }
      return json({ entries: PAGE, scanned: PAGE.length });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(2);
    });

    const secondCall = stub.calls.filter((url) => url.includes('/journal'))[1]!;
    expect(new URL(secondCall).searchParams.get('until')).toBe(PAGE.at(-1)!.at);
  });

  it('読み足しが失敗しても一覧は残り、「もう一度試す」で撃ち直せる。成功すると帯が消える', async () => {
    let olderCalls = 0;
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) {
        olderCalls += 1;
        if (olderCalls === 1) return json({ error: 'boom' }, 500);
        return json({ entries: [], scanned: 0 });
      }
      return json({ entries: PAGE, scanned: PAGE.length });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    expect(await screen.findByText(/日誌の続きを読み込めませんでした/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /もっと遡る（いま 100 件）/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /もう一度試す/ }));

    await waitFor(() => {
      expect(screen.queryByText(/日誌の続きを読み込めませんでした/)).toBeNull();
    });
    expect(olderCalls).toBe(2);
    expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(3);
  });

  it('初回が失敗し SSE で1件入っても「もう一度試す」が在り、押して成功すると帯が消える', async () => {
    let calls = 0;
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      calls += 1;
      if (calls === 1) return json({ error: 'boom' }, 500);
      return json({ entries: [RECENT_EXCHANGE], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [RECENT_EXCHANGE] });

    expect(await screen.findByText(/日誌を読み込めませんでした/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /もう一度試す/ }));

    await waitFor(() => {
      expect(screen.queryByText(/日誌を読み込めませんでした/)).toBeNull();
    });
    expect(calls).toBe(2);
  });

  it('next が先を指すなら、100件未満で返っても終端にせず、継続点（afterId/afterAt）で読み継ぐ（Issue #2604 / #2605）', async () => {
    const short = PAGE.slice(0, 99);
    const cursor = { id: 'dropped-row', at: PAGE[99]!.at };
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      const params = new URL(url).searchParams;
      if (params.has('afterId')) return json({ entries: [pastDecision('older', 200)], next: null });
      return json({ entries: short, next: cursor });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByText(/これより古い記録は無い/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(screen.getByText(/これより古い記録は無い/)).toBeTruthy();
    });
    const second = new URL(stub.calls.filter((url) => url.includes('/journal'))[1]!);
    expect(second.searchParams.get('afterId')).toBe('dropped-row');
    expect(second.searchParams.get('afterAt')).toBe(cursor.at);
    expect(second.searchParams.has('until')).toBe(false);
    expect(second.searchParams.get('horizon')).toBe('true');
  });

  it('retryLarger（同じ境界が limit ちょうど埋まった）のとき limit を JOURNAL_MAX_LIMIT へ上げて撃ち直す', async () => {
    // 呼び出し回数で応答を決め limit の値では決めない: limit の値で分岐すると、limit を上げない変異で同じ分岐へ入り続けて撃ち直しが止まらなくなるため
    let journalCalls = 0;
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      journalCalls += 1;
      if (journalCalls <= 2) {
        return json({ entries: PAGE, scanned: PAGE.length });
      }
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal')).length).toBeGreaterThanOrEqual(3);
    });

    const thirdCall = stub.calls.filter((url) => url.includes('/journal'))[2]!;
    expect(new URL(thirdCall).searchParams.get('limit')).toBe('1000');
  });
});

describe('日誌の地平（issue #1510 の積み残し）', () => {
  const CURSOR_BASE = new Date('2026-08-20T00:00:00.000Z').getTime();

  function pastDecision(id: string, minutesAgo: number): JournalEntry {
    return {
      type: 'decision',
      id,
      at: new Date(CURSOR_BASE - minutesAgo * 60_000).toISOString(),
      decision: `d-${id}`,
      grounds: 'g',
    };
  }

  const PAGE = Array.from({ length: 100 }, (_, i) => pastDecision(`p${i}`, i));

  it('窓が地平より前にかかっていたら、「これより古い記録は無い」に続けて注記を出す', async () => {
    const OLDEST_AT = '2026-08-14T00:00:00.000Z';
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) {
        return json({ entries: [], oldestAt: OLDEST_AT, crossesHorizon: true });
      }
      return json({ entries: PAGE });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));
    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(2);
    });

    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(await screen.findByText(new RegExp(formatDateTime(OLDEST_AT)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(OLDEST_AT))).toBeNull();
    expect(screen.queryByText(/記憶ストア/)).toBeNull();
    expect(screen.getByText(/区別できない/)).toBeTruthy();
  });

  it('窓が地平より後ろなら（本当に終端だと言い切れる）、注記は出ない', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) {
        return json({
          entries: [],
          oldestAt: '2026-08-14T00:00:00.000Z',
          crossesHorizon: false,
        });
      }
      return json({ entries: PAGE });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));
    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(2);
    });

    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByText(/区別できない/)).toBeNull();
  });

  it('初期読み込みだけで日誌が尽きるとき（1ページに収まる）でも、地平の注記が出る（issue #1530）', async () => {
    const OLDEST_AT = '2026-08-14T00:00:00.000Z';
    const SHORT_PAGE = PAGE.slice(0, 3);
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.get('horizon') !== 'true') {
        return json({ entries: SHORT_PAGE });
      }
      return json({ entries: SHORT_PAGE, oldestAt: OLDEST_AT, crossesHorizon: true });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByRole('button', { name: /もっと遡る/ })).toBeNull();

    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(await screen.findByText(new RegExp(formatDateTime(OLDEST_AT)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(OLDEST_AT))).toBeNull();
    expect(screen.queryByText(/記憶ストア/)).toBeNull();
    expect(screen.getByText(/区別できない/)).toBeTruthy();

    const firstCall = stub.calls.filter((url) => url.includes('/journal'))[0]!;
    expect(new URL(firstCall).searchParams.get('horizon')).toBe('true');
    expect(new URL(firstCall).searchParams.has('until')).toBe(false);
    expect(new URL(firstCall).searchParams.has('since')).toBe(false);
  });
});

describe('日誌画面の検索欄（issue #250）', () => {
  function searchTerms(calls: readonly string[]): (string | null)[] {
    return calls
      .filter((url) => url.includes('/journal'))
      .map((url) => new URL(url).searchParams.get('q'));
  }

  it('入力した語が GET /journal?q= としてサーバへ届く', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(searchTerms(stub.calls)).toEqual([null]);

    fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
      target: { value: 'トマト' },
    });

    await waitFor(() => {
      expect(searchTerms(stub.calls)).toContain('トマト');
    });
  });

  it('途中の打鍵ではサーバを撃たず、止まった後の語だけを撃つ', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    const input = screen.getByLabelText('日誌を語で探す');
    fireEvent.change(input, { target: { value: 'ト' } });
    fireEvent.change(input, { target: { value: 'トマ' } });
    fireEvent.change(input, { target: { value: 'トマト' } });

    await waitFor(() => {
      expect(searchTerms(stub.calls)).toContain('トマト');
    });

    expect(searchTerms(stub.calls)).not.toContain('ト');
    expect(searchTerms(stub.calls)).not.toContain('トマ');
  });

  // 時計を止めて待ちの長さそのものを測る: fireEvent.change の3連打は同じ同期のかたまりの中で起き、待ちが0でもタイマは発火せず、連打だけでは待つことを測れないため
  it('待ちの手前では撃たず、待ちを越えて初めて撃つ（時計を止めて測る）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    // 初期取得が終わってから時計を止める: 止めたまま fetch の解決を待つと進まなくなるため
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
        target: { value: 'トマト' },
      });

      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(searchTerms(stub.calls)).not.toContain('トマト');

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(searchTerms(stub.calls)).toContain('トマト');
    } finally {
      vi.useRealTimers();
    }
  });

  it('検索語が URL のクエリに載る', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    const { router } = renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
      target: { value: 'トマト' },
    });

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('トマト');
    });
  });

  it('URL に q が載った状態で開くと、その語で最初から探しに行く', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('トマト')}`]);
    await waitForLoaded();

    expect(searchTerms(stub.calls)).toEqual(['トマト']);
    expect((screen.getByLabelText('日誌を語で探す') as HTMLInputElement).value).toBe('トマト');
  });

  it('当たらなかったら、その語では無いと言う（記録が無いとは言わない）', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('当たらない語')}`]);
    await waitForLoaded();

    expect(
      screen.getByText('「当たらない語」に当たる記録はありません（この条件の中では）。'),
    ).toBeTruthy();
    expect(screen.queryByText('この条件では何も記録されていない。')).toBeNull();
  });

  it('種別チップで絞ったら、その種別では無いと言う（記録が無いとは言わない）', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] }, ['/?types=exchange']);
    await waitForLoaded();

    expect(
      screen.getByText('「やりとり」の記録はありません（絞り込みを外せば見えるかもしれません）。'),
    ).toBeTruthy();
    expect(screen.queryByText('この条件では何も記録されていない。')).toBeNull();
  });

  it('種別チップと検索語の両方で絞ったら、両方を名指しする', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] }, [
      `/?types=exchange&q=${encodeURIComponent('当たらない語')}`,
    ]);
    await waitForLoaded();

    expect(
      screen.getByText(
        '「やりとり」に絞った上で、「当たらない語」に当たる記録はありません（絞り込みを外せば見えるかもしれません）。',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('この条件では何も記録されていない。')).toBeNull();
  });

  it('検索語が、新着が届いた後も URL に保たれる（絞りの当否は filterRecent 側で測る）', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    const { router } = renderJournal({ status: 'live', recent: [RECENT_EXCHANGE] }, [
      `/?q=${encodeURIComponent('当たらない語')}`,
    ]);
    await waitForLoaded();

    expect(new URLSearchParams(router.state.location.search).get('q')).toBe('当たらない語');
  });

  it('探す対象に入っていない欄の断りは、語で探しているときだけ出る', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    const NOTE =
      '道具の入力・作業者の待機・ターンの消費・文脈の占有・受信箱の流量・GitHub の観測・会話の削除は探す対象に入っていない（そこにだけ書かれている語は当たらない）。';
    const { unmount } = renderJournal({ status: 'live', recent: [] }, [
      `/?q=${encodeURIComponent('当たらない語')}`,
    ]);
    await waitForLoaded();
    expect(screen.getByText(NOTE)).toBeTruthy();
    unmount();

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('検索したまま遡ると、2頁目の要求に q と until の両方が載る', async () => {
    const base = new Date('2026-08-20T00:00:00.000Z').getTime();
    const page: JournalEntry[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'decision',
      id: `q-p${i}`,
      at: new Date(base - i * 60_000).toISOString(),
      decision: 'トマトの水やり',
      grounds: 'g',
    }));

    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) return json({ entries: [], scanned: 0 });
      return json({ entries: page, scanned: page.length });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('トマト')}`]);
    await waitForLoaded();

    fireEvent.click(await screen.findByRole('button', { name: /もっと遡る/ }));

    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/journal'))).toHaveLength(2);
    });

    const second = new URL(stub.calls.filter((url) => url.includes('/journal'))[1]!);
    expect(second.searchParams.get('until')).toBe(page.at(-1)!.at);
    expect(second.searchParams.get('q')).toBe('トマト');
  });

  it('検索していないときは、対象外の欄の断り書きを出さない', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] });
    await waitForLoaded();

    expect(screen.queryByText(/tool_use の input/)).toBeNull();
  });

  it('検索しているときは、対象外の欄の断り書きを出す', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [HISTORY_ONLY], scanned: 1 });
    });

    renderJournal({ status: 'live', recent: [] }, [`/?q=${encodeURIComponent('トマト')}`]);
    await waitForLoaded();

    expect(screen.getByText(/道具の入力/)).toBeTruthy();
    expect(
      screen.getByText(
        /道具の入力・作業者の待機・ターンの消費・文脈の占有・受信箱の流量・GitHub の観測・会話の削除/,
      ),
    ).toBeTruthy();
  });
});

describe('種別チップの選択が URL に載る（issue #2029）', () => {
  it('チップを押すと URL の types に種別が載る', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    const { router } = renderJournal({ status: 'live', recent: [] });
    await screen.findByRole('heading', { name: '日誌' });

    fireEvent.click(screen.getByRole('button', { name: 'やりとり' }));

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('types')).toBe('exchange');
    });

    fireEvent.click(screen.getByRole('button', { name: '判断' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('types')).toBe(
        'exchange,decision',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'やりとり' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('types')).toBe('decision');
    });
  });

  it('URL の types から初期状態が復元される（チップが押された状態で開く）', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] }, ['/?types=exchange,decision']);
    await screen.findByRole('heading', { name: '日誌' });

    expect(screen.getByRole('button', { name: 'やりとり' }).className).toContain('border-primary');
    expect(screen.getByRole('button', { name: '判断' }).className).toContain('border-primary');
    expect(screen.getByRole('button', { name: 'エスカレーション' }).className).not.toContain(
      'border-primary',
    );

    await waitFor(() => {
      const types = stub.calls
        .filter((url) => url.includes('/journal'))
        .map((url) => new URL(url).searchParams.get('type'));
      expect(types).toContain('exchange,decision');
    });
  });

  it('URL に知らない種別が書かれていても落ちず、無視する', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    renderJournal({ status: 'live', recent: [] }, ['/?types=exchange,no-such-type']);

    expect(await screen.findByRole('heading', { name: '日誌' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'やりとり' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'no-such-type' })).toBeNull();
  });

  it('チップの切り替えは履歴を汚さない（replace: true。検索語と同じ判断）', async () => {
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [], scanned: 0 });
    });

    const { router } = renderJournal({ status: 'live', recent: [] });
    await screen.findByRole('heading', { name: '日誌' });
    const initialIndex = router.state.location.key;

    fireEvent.click(screen.getByRole('button', { name: 'やりとり' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('types')).toBe('exchange');
    });

    // historyAction が REPLACE であることで確かめる: createMemoryRouter からは history stack を覗けないため
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.key).not.toBe(initialIndex);
  });
});
