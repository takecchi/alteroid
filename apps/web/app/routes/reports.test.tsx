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
//
// `reportId` は b69dca5 で `clientLoader` の戻りに増えた（ルートが
// `reports/:date?` → `reports/:date?/:reportId?` になったのに追随）。
const ReportsRoute = Reports as unknown as (props: {
  loaderData: { date: string | undefined; reportId: string | undefined };
}) => React.ReactElement;

function renderReports(loaderData: { date?: string; reportId?: string } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: '/reports',
        Component: () => (
          <ReportsRoute loaderData={{ date: loaderData.date, reportId: loaderData.reportId }} />
        ),
      },
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

    // b69dca5 で見出しが `report.date` 単体から `` `${report.date} ${formatTime(report.at)}` ``
    // （`reportLabel()`）に変わった。この正規表現は部分一致なので当たり続ける
    // （期待値は緩めていない — 実際に `2026-08-20 07:00` に対して一致することを
    // このテストの実行そのもので確かめている）。
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

  /*
    ここから3本、b69dca5（「日報の一覧を日時で1件ずつ並べ、選んだ1件だけを出す」）
    が直した「同じ日に複数あると見分けが付かず、選んでも2件同時に開く」を
    固定するテストである。

    同じ日に2件できる経路は「起動時の遡り生成」（`schedule.ts` の
    `missingDailyReportDates` → `clone.ts` の `#dailyReport`）で、前日ぶんの
    日報が翌日に書かれる。それを再現するため、`date` は同じ '2026-08-20' で、
    `at` は一方だけ翌日（`2026-08-21T…Z`）にしてある。`reportLabel()` が
    `at` ではなく `date` を見出しの日の軸に取っていることは、この2件が両方
    '2026-08-20' の見出しで出ることそのもので確かめられる（`formatDateTime(at)`
    を使っていれば、遡り生成の側が `08/21` に化けて隣の日と区別できなくなる）。
  */
  const closeEntry = {
    type: 'daily_report',
    id: 'r-close',
    at: '2026-08-20T22:00:00.000Z', // JST 07:00（翌日）＝ その日の締め
    date: '2026-08-20',
    body: '## 締めの見出し\n\n締め本文だけの目印。',
  };
  const catchupEntry = {
    type: 'daily_report',
    id: 'r-catchup',
    at: '2026-08-21T00:30:00.000Z', // JST 09:30（翌日）＝ 起動時の遡り生成
    date: '2026-08-20',
    body: '## 遡り生成の見出し\n\n遡り生成本文だけの目印。',
  };

  function stubSameDayReports() {
    // 一覧（limit 付きの `/reports`）も、その日の詳細（`/reports/2026-08-20`）も、
    // 実物と同じくその日の全件を返す（本文側で1件だけに絞るのが今回の直しの要）。
    const reports = [catchupEntry, closeEntry];
    return stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports });
      if (url.includes('/reports/2026-08-20')) return json({ reports });
      return undefined;
    });
  }

  it('同じ日に2件あっても、一覧では時刻違いの別々の行として並ぶ', async () => {
    stubSameDayReports();

    renderReports();

    // 見出しは「日付＋時刻」。日付だけなら2件とも `2026-08-20` で区別できない。
    expect(await screen.findByRole('link', { name: '2026-08-20 09:30' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: '2026-08-20 07:00' })).toBeTruthy();
  });

  it('reportId で1件を指定すると、選択の見た目が付くリンクはちょうど1つになる', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    // 両方の行が描かれるまで待つ（先に findAllByRole を打つと、fetch が
    // 返る前の空の一覧で判定してしまいうる）。
    await screen.findByRole('link', { name: '2026-08-20 09:30' });
    const links = screen.getAllByRole('link');
    const selected = links.filter(
      (link) => link.className.includes('bg-surface-2') && link.className.includes('text-accent'),
    );

    // 前は `report.date === selected` で選んでいたので、同じ日の2件が両方
    // 選択中になっていた（人間の申告そのもの）。いまは `id` で選ぶので1つだけ。
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('2026-08-20 07:00');
  });

  /**
   * ⭐ この3本の中で最重要。「本文が1件だけ出る」ことは、選ばれた側が出る
   * ことだけでは確かめられない — もう片方が画面から消えていることまで
   * assert しないと、以前の「その日の全件を縦に並べる」実装でも通ってしまう。
   */
  it('本文にも選んだ1件だけが描かれ、同じ日のもう片方の本文は出ない', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    expect(await screen.findByText('締め本文だけの目印。')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '締めの見出し' })).toBeTruthy();
    // **同じ日のもう片方は、データとしては取得しているが本文には描かれない。**
    expect(screen.queryByText('遡り生成本文だけの目印。')).toBeNull();
    expect(screen.queryByRole('heading', { name: '遡り生成の見出し' })).toBeNull();
  });
});
