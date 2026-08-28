// @vitest-environment jsdom
/**
 * ダッシュボードについて2つ。
 *
 * 1. 「今日の利用」カードが、`/usage` 画面・CLI と同じ嘘をつかない規約を守っていること
 *    （`apps/cli/src/usage.ts` の docstring と同じ規約）
 * 2. 日誌を `AuthedShell` の購読から context 越しに受け取り、**自分では SSE を張らない**こと
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from '~/hooks/journal-feed';
import { summarizeJournalEntry } from '~/hooks/queries';
import type { JournalLive } from '~/hooks/use-journal-live';
import type { JournalEntry } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl, type FetchStub } from '~/test-support';

import Dashboard from './dashboard';

const RECENT: JournalEntry = {
  type: 'decision',
  id: 'recent-decision',
  at: '2026-08-14T09:00:00.000Z',
  decision: 'たった今届いた判断',
  grounds: '記憶',
};

const EMPTY_FEED: JournalLive = { status: 'live', recent: [], receivedCount: 0 };

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

function renderDashboard(
  usageBody: {
    rows: unknown[];
    since: string | null;
    beforeLedger: boolean;
    notice?: string;
  },
  live: JournalLive = EMPTY_FEED,
  // 既定は空のまま（既存のテストは全部これで、最新の日報カードを一度も
  // 描画経路に乗せていない）。「最新の日報」のテストだけがここへ渡す。
  // `unavailable` は「日報が書けなかった印」（`schema.ts`）。既定では付けないので、
  // 既存のテストは1つも振る舞いが変わらない。
  reports: Array<{
    type: 'daily_report';
    id: string;
    at: string;
    date: string;
    body: string;
    unavailable?: string;
  }> = [],
  // 概要カードが打ち切る側の分岐へ入れるための材料。既定は空なので、
  // 既存のテストは1つも振る舞いが変わらない。
  lists: { approvals?: unknown[]; managers?: unknown[] } = {},
  // 「次の自動実行」カードの材料。既定は空なので既存のテストは変わらない。
  scheduleEntries: Array<{ kind: string; description: string; nextAt: string }> = [],
): FetchStub {
  // **`/journal/stream` の経路を置いていない。** 置くと購読が増えたことに気づけない
  // （知らない URL は `stubFetch` が「繋がらない」にするので、張りに行けば必ず出る）。
  const stub = stubFetch((url) => {
    if (url.includes('/reports')) return json({ reports });
    if (url.includes('/approvals')) return json({ approvals: lists.approvals ?? [] });
    if (url.includes('/managers')) return json({ managers: lists.managers ?? [] });
    if (url.includes('/schedule')) return json({ entries: scheduleEntries });
    if (url.includes('/usage')) {
      return json({
        ...usageBody,
        notice: usageBody.notice ?? USAGE_ESTIMATE_NOTICE,
        breakdown: null,
      });
    }
    return undefined;
  });

  const router = createMemoryRouter([{ path: '/', Component: Dashboard }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <JournalFeedProvider value={live}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
  return stub;
}

describe('ダッシュボードの「今日の利用」', () => {
  it('台帳がまだ空（since が null）なら $0.00 と言わない', async () => {
    renderDashboard({ rows: [], since: null, beforeLedger: false });

    expect(await screen.findByText('まだ記録が無い。')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('beforeLedger が真なら 0 ではなく記録が無いと言う', async () => {
    renderDashboard({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: true });

    expect(await screen.findByText(/今日の分はまだ記録が無い/)).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('金額が出ているときは但し書きも一緒に出す', async () => {
    renderDashboard({
      rows: [
        {
          date: '2026-08-14',
          managerId: 'm1',
          model: 'claude-opus-4',
          updatedAt: '2026-08-14T10:00:00.000Z',
          totals: { ...ZERO_USAGE, costUsd: 0.02 },
        },
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    expect(await screen.findByText('$0.0200')).toBeTruthy();
    expect(screen.getByText(USAGE_ESTIMATE_NOTICE)).toBeTruthy();
  });
});

/**
 * 「最新の日報」カードが本文を実際に描く経路を1度は通す。
 *
 * これまでの `renderDashboard` は `/reports` を常に空で固定していたので、
 * このカードは `Empty` の分岐しか通ったことが無かった。**Markdown 化した
 * こと自体を保証するテストではない**（それは `markdown.test.tsx` の仕事）
 * — ここが保証するのは「日報の本文がこのカードの描画経路へ実際に渡る」
 * ことだけ。見出し記法（`## 見出し`）を混ぜているのは、素通しの
 * `whitespace-pre-wrap` の文字列表示のままでは無いこと（＝描画経路を
 * 通したのが `report.body` の生文字列比較ではないこと）を区別するため。
 */
describe('「最新の日報」', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('日報の本文が Markdown の描画経路を通って出る', async () => {
    renderDashboard(USAGE, EMPTY_FEED, [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-14T22:00:00.000Z',
        date: '2026-08-14',
        body: '## 今日やったこと\n\n進捗があった。',
      },
    ]);

    expect(await screen.findByRole('heading', { name: '今日やったこと' })).toBeTruthy();
    expect(screen.getByText('進捗があった。')).toBeTruthy();
  });

  /**
   * **「日報が書けなかった」印の行を「最新の日報」として描かないこと。**
   *
   * ここは人間が最初に開く面である。発端の壊れ方（日報の本文が丸ごと
   * `You've hit your org's monthly spend limit …`）が最も目に付く形で残るのは
   * このカードなので、`/reports` と別に歯を置く（判定と文言は `reports.tsx` の
   * 1本を共有しているが、**このカードがそれを呼んでいるか**は別の事実である）。
   */
  it('日報が作れなかった日は、印として出す（本文を日報として描かない）', async () => {
    const reason = "You've hit your org's monthly spend limit · ask your admin to raise it";
    renderDashboard(USAGE, EMPTY_FEED, [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-20T22:00:00.000Z',
        date: '2026-08-20',
        // 見出し記法を混ぜてある。Markdown の経路へ流れたら見出しになるので、
        // 日報として描いていないことを区別できる。
        body: `## ${reason}`,
        unavailable: reason,
      },
    ]);

    expect(await screen.findByText('この日の日報は作れなかった')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: reason })).toBeNull();
  });
});

/**
 * 概要カードは全件を出さない（それは要件である）。**要件でないのは、切ったことが
 * 出力から消えることである。**
 *
 * 保証しているのは2方向で、片方だけでは足りない。
 *
 * - 上限を越えたら残数が出る — 出ないと「全部でこれだけ」と読める
 * - **ちょうど上限のときは出ない** — 常に出る但し書きは、出ていることが情報に
 *   ならない（「残り 0 件」を作ると、取れない軸に 0 の行を作るのと同じになる）
 */
describe('概要カードが打ち切ったことを言う', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  const approval = (n: number) => ({
    id: `approval-${n}`,
    createdAt: '2026-08-14T09:00:00.000Z',
    question: `質問 ${n}`,
  });

  const manager = (n: number) => ({
    managerId: `mgr-${n}`,
    status: 'running',
    live: true,
    cwd: '/workspace',
    request: `依頼 ${n}`,
    startedAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
  });

  const decision = (n: number): JournalEntry => ({
    type: 'decision',
    id: `decision-${n}`,
    at: '2026-08-14T09:00:00.000Z',
    decision: `判断 ${n}`,
    grounds: '記憶',
  });

  it('承認待ちが上限を越えたら、出していない件数を言う', async () => {
    const approvals = Array.from({ length: 8 }, (_, i) => approval(i));
    renderDashboard(USAGE, EMPTY_FEED, [], { approvals });

    // 上限は5なので、出るのは残り3件。
    expect(await screen.findByText(/残り 3 件は出していない/)).toBeTruthy();
    expect(screen.getByText('質問 0')).toBeTruthy();
    expect(screen.queryByText('質問 5')).toBeNull();
  });

  it('承認待ちがちょうど上限なら、但し書きを出さない', async () => {
    const approvals = Array.from({ length: 5 }, (_, i) => approval(i));
    renderDashboard(USAGE, EMPTY_FEED, [], { approvals });

    expect(await screen.findByText('質問 4')).toBeTruthy();
    expect(screen.queryByText(/件は出していない/)).toBeNull();
  });

  it('稼働中のマネージャーが上限を越えたら、出していない件数を言う', async () => {
    const managers = Array.from({ length: 7 }, (_, i) => manager(i));
    renderDashboard(USAGE, EMPTY_FEED, [], { managers });

    expect(await screen.findByText(/残り 2 件は出していない/)).toBeTruthy();
    expect(screen.getByText('依頼 0')).toBeTruthy();
    expect(screen.queryByText('依頼 5')).toBeNull();
  });

  it('届いている出来事が上限を越えたら、出していない件数を言う', async () => {
    const recent = Array.from({ length: 32 }, (_, i) => decision(i));
    renderDashboard(USAGE, { status: 'live', recent }, [], {});

    // 上限は30なので、出るのは残り2件。
    expect(await screen.findByText(/残り 2 件は出していない/)).toBeTruthy();
    expect(screen.getByText(summarizeJournalEntry(decision(0)))).toBeTruthy();
    expect(screen.queryByText(summarizeJournalEntry(decision(31)))).toBeNull();
  });
});

/**
 * 「次の自動実行」カードは、この画面の他5枚（最新の日報／承認待ち／稼働中の
 * マネージャー／今日の利用／いま届いている出来事）と違って `action` を持たず、
 * かつ `entry.description` を `truncate` で切っている唯一のカードだった
 * （本5「省略の出口」）。
 *
 * **ここで言えること / 言えないこと**: `action` の `<Link>` と `title` 属性は
 * DOM に出るので `getByRole('link', { name })` の `href` と `getByTitle` で
 * 引ける — 「リンクが在り行き先が `/schedule` であること」「`title` に
 * `entry.description` と同じ値が入っていること」はここで踏める。
 * jsdom はレイアウトを持たないので、「実際に狭い画面で文字が切れて hover で
 * 続きが読めること」はここでは確かめられない（クラス名が書かれたことまで）。
 */
describe('「次の自動実行」カードの出口', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };
  const LONG_DESCRIPTION =
    '毎朝5時に日報を締めて要約する定期ジョブ（設定を長くすると狭い画面では確実に切れる長さの説明文）';

  it('他5枚と同じ形で action にスケジュール画面へのリンクを持つ', async () => {
    renderDashboard(USAGE, EMPTY_FEED, [], {}, [
      { kind: 'daily_report', description: LONG_DESCRIPTION, nextAt: '2026-08-15T05:00:00.000Z' },
    ]);

    // 「今日の利用」カードの action も同じ文言（「詳しく見る」）を使っているので
    // `getByRole` 単体では一意にならない。href で `/schedule` へのものを選ぶ。
    await screen.findByText(LONG_DESCRIPTION, { exact: false });
    const links = screen.getAllByRole('link', { name: '詳しく見る' });
    const hrefs = links.map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/schedule');
  });

  it('entry.description が truncate で切られていても title で全文が引ける', async () => {
    renderDashboard(USAGE, EMPTY_FEED, [], {}, [
      { kind: 'daily_report', description: LONG_DESCRIPTION, nextAt: '2026-08-15T05:00:00.000Z' },
    ]);

    expect(await screen.findByTitle(LONG_DESCRIPTION)).toBeTruthy();
  });
});

describe('日誌は AuthedShell の購読から受け取る', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('context の recent をそのまま出す', async () => {
    renderDashboard(USAGE, { status: 'live', recent: [RECENT], receivedCount: 1 });

    expect(await screen.findByText(summarizeJournalEntry(RECENT))).toBeTruthy();
  });

  it('自分では SSE を張らない（購読は AuthedShell の1本だけ）', async () => {
    const stub = renderDashboard(USAGE, {
      status: 'live',
      recent: [RECENT],
      receivedCount: 1,
    });

    // 画面が出揃うまで待ってから見る（描画前に数えると、張っていても空になる）。
    await screen.findByText(summarizeJournalEntry(RECENT));
    expect(stub.calls.filter((url) => url.includes('/journal/stream'))).toEqual([]);
  });

  /**
   * **切ったことを言う（Issue #426 の G3）。** `recent` は購読側
   * （`use-journal-live.ts`）の `RECENT_LIMIT`（200件）で頭打ちにしてある
   * ので、`recent.length` を但し書きの `total` に使うと 200件を超えて届いた
   * 分が消える。`receivedCount`（上限を掛けずに1件ごと積んだ値）を使う
   * ことで、`recent.length` が小さいままでも本当の総数が出せることを
   * 固定する — この歯は `total={live.recent.length}` へ戻す変異で赤くなる
   * （`recent` は1件だけなので、その変異では但し書きが出なくなる）。
   */
  it('但し書きの total は recent.length ではなく receivedCount を使う', async () => {
    renderDashboard(USAGE, { status: 'live', recent: [RECENT], receivedCount: 999 });

    await screen.findByText(summarizeJournalEntry(RECENT));
    expect(await screen.findByText(/残り 969 件は出していない/)).toBeTruthy();
  });
});
