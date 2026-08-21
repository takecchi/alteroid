// @vitest-environment jsdom
/**
 * `apps/web` にこの画面のテストが1本も無かった。ここで測るのは
 * **「日報の本文が描画経路を通ること」だけ**（Markdown が正しく描かれるかは
 * `markdown.test.tsx` の仕事）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Reports from './reports';

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

// framework mode の `loaderData` を手で与える（`chat.test.tsx` と同じやり方）。
const ReportsRoute = Reports as unknown as (props: {
  loaderData: { date: string | undefined };
}) => React.ReactElement;

function renderReports() {
  const router = createMemoryRouter(
    [
      { path: '/reports', Component: () => <ReportsRoute loaderData={{ date: undefined }} /> },
      // 印の行が出す `Link`（日誌・スケジュール）の行き先。描くだけで踏まない。
      { path: '/journal', Component: () => null },
      { path: '/schedule', Component: () => null },
    ],
    { initialEntries: ['/reports'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('日報', () => {
  it('最新の日報の本文が Markdown の描画経路を通って出る', async () => {
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) {
        return json({
          reports: [
            {
              type: 'daily_report',
              id: 'r1',
              at: '2026-08-14T22:00:00.000Z',
              date: '2026-08-14',
              body: '',
            },
          ],
        });
      }
      if (url.includes('/reports/2026-08-14')) {
        return json({
          reports: [
            {
              type: 'daily_report',
              id: 'r1',
              at: '2026-08-14T22:00:00.000Z',
              date: '2026-08-14',
              body: '## 今日やったこと\n\n進捗があった。',
            },
          ],
        });
      }
      return undefined;
    });

    renderReports();

    expect(await screen.findByRole('heading', { name: '今日やったこと' })).toBeTruthy();
    expect(screen.getByText('進捗があった。')).toBeTruthy();
  });

  /**
   * **「日報が書けなかった」印の行を、日報として描かないこと。**
   *
   * 発端は、日報の本文が丸ごと
   * `You've hit your org's monthly spend limit …` になっていたことである
   * （`packages/core/src/sdk-failure.ts` の doc）。器の側は印を付けて「まだ書けて
   * いない」と数えられるようにしたが、**この画面が印を読まなければ、人間には
   * 直す前と同じものが見える**。
   *
   * 保証するのは3つ。印だと分かること / 理由が言い換えられずに出ること /
   * 印の行を Markdown の日報として描かないこと。
   */
  it('日報が作れなかった日は、印として出す（本文を日報として描かない）', async () => {
    const reason = "You've hit your org's monthly spend limit · ask your admin to raise it";
    const entry = {
      type: 'daily_report',
      id: 'r2',
      at: '2026-08-20T22:00:00.000Z',
      date: '2026-08-20',
      // 器が実際に書く本文（`clone.ts` の `#dailyReport`）。**見出し記法を混ぜて
      // ある** — Markdown の経路へ流れたらここが見出しになるので、日報として
      // 描いていないことを区別できる。
      body: `## ${reason}`,
      unavailable: reason,
    };
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports: [entry] });
      if (url.includes('/reports/2026-08-20')) return json({ reports: [entry] });
      return undefined;
    });

    renderReports();

    // 日報ではないと分かる形で出ている。
    expect(await screen.findByText('この日の日報は作れなかった')).toBeTruthy();
    // 理由は SDK の文言そのまま（人間がこれで検索する）。
    expect(screen.getByText(reason)).toBeTruthy();
    // **Markdown の日報として描いていない。** 描いていれば見出しになる。
    expect(screen.queryByRole('heading', { name: reason })).toBeNull();
    // 「記録ごと消えた」と読まれないよう、降りる先と作り直す道を出す。
    expect(screen.getByRole('link', { name: '日誌' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'スケジュール' })).toBeTruthy();
  });

  /**
   * **開く前に分かること。** 左の一覧には日付しか並ばないので、印を出さないと
   * 「日報がある日」と同じ顔になり、人間は開くまで気づけない。
   */
  it('日付の一覧でも、作れなかった日には印が付く', async () => {
    const reason = "You've hit your org's monthly spend limit";
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r2',
          at: '2026-08-20T22:00:00.000Z',
          date: '2026-08-20',
          body: '（この日の日報は作れなかった）',
          unavailable: reason,
        },
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-19T22:00:00.000Z',
          date: '2026-08-19',
          body: '進捗があった。',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });

    renderReports();

    const marked = await screen.findByRole('link', { name: /2026-08-20/ });
    expect(marked.textContent).toContain('⚠');
    // 書けた日には付けない（付けたら印が意味を失う）。
    expect(screen.getByRole('link', { name: /2026-08-19/ }).textContent).not.toContain('⚠');
  });

  it('印が無い日には「作れなかった」と言わない（雑音にしない）', async () => {
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-14T22:00:00.000Z',
          date: '2026-08-14',
          body: '進捗があった。',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });

    renderReports();

    expect(await screen.findByText('進捗があった。')).toBeTruthy();
    expect(screen.queryByText(/作れなかった/)).toBeNull();
  });
});
