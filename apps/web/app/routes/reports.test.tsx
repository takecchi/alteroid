// @vitest-environment jsdom
/**
 * `apps/web` にこの画面のテストが1本も無かった。ここで測るのは
 * **「日報の本文が描画経路を通ること」だけ**（Markdown が正しく描かれるかは
 * `markdown.test.tsx` の仕事）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import Reports from './reports';

/*
  **時間帯を固定するのはテストの側だけである。表示は固定しない。**

  この画面の時刻は `packages/logic/src/format.ts` の `Intl.DateTimeFormat` で出る。あれは
  ロケールだけを固定し、**時間帯は閲覧者の端末に任せている** — 人間は JST で
  読むので、それが正しい振る舞いである。表示を UTC 固定にするような直し方は
  「テストを通すために人間の読みやすさを削る」側なので採らない。

  一方でテストは、時刻の文字列を期待値に持つ。**器の時間帯に任せると、期待値が
  「その器ではこうだから」に化ける。** 実際に落ちた — この器の `TZ` は
  Asia/Tokyo だが、**CI の runner は UTC である**（`.github/workflows/ci.yml` に
  `TZ` の指定は無い）。同じ `at` が手元で '09:30'、CI で '00:30' になり、
  **手元だけ緑**になっていた。

  **直し方は「期待値を器に合わせる」ではなく「注入する側を自分で用意する」である。**
  期待値を '00:30' に書き換えると、こんどは JST の器で落ちる — どちらの器でも
  落ちない形にはならない。だからここで時間帯そのものを固定し、**JST の器でも
  UTC の器でも同じ1つの期待値で通る**ようにしてある。

  **`vi.hoisted` でなければならない。** `packages/logic/src/format.ts` はモジュールの読み込み時に
  `Intl.DateTimeFormat` を作る。`process.env.TZ` の変更が効くのは**変更より後に
  作られた instance だけ**なので（実測で両方向を確認した）、固定は import の
  評価より前に走らなければならない。`vi.hoisted` はまさにそこへ持ち上げられる。
  素の代入を本文に書くと、ESM の import が先に評価されて**静かに効かなくなる**。

  戻すのは、同じ worker プロセスを次のテストファイルが再利用するからである
  （vitest は隔離しても process は使い回す）。ここの固定を他のファイルへ
  漏らさない。
*/
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

/** 本番と同じ経路（`/reports/:date?/:reportId?`）に URL で入る。 */
function renderReportsAtUrl(url: string) {
  function Routed() {
    const { date, reportId } = useParams();
    return <ReportsRoute loaderData={{ date, reportId }} />;
  }
  const router = createMemoryRouter(
    [
      { path: '/reports/:date?/:reportId?', Component: Routed },
      { path: '/journal', Component: () => null },
      { path: '/schedule', Component: () => null },
    ],
    { initialEntries: [url] },
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

  /**
   * **並びはデーモンが持つ。この画面では並べ直さない。**
   *
   * 人間の申告は「日報の並び順が変。上が新しくて下が古くなるべき」だった。原因は
   * 日誌の並び（書いた順）が素通しされていたことで、直したのは
   * `apps/daemon/src/reports.ts`（日付の新しい順）である。**ここで並べ直すと
   * 「最新の日報」が CLI・クローンとこの画面で食い違う。**
   *
   * だからこのテストは**古い順の応答**（`date` も `at` も昇順）を与え、画面が
   * それをそのまま描くことを見る。**期待値が「古い順」なのは意図である** —
   * 日付でも書いた時刻でも並べ直した瞬間にここが落ちる（どちらか片方の昇順に
   * しておくと、もう片方で並べ直す実装を取り逃す）。落ちたときに直す先は
   * この画面ではなく、デーモンの並びである。
   */
  it('一覧はデーモンが返した順のまま描く（画面で並べ直さない）', async () => {
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r-old',
          at: '2026-08-19T22:00:00.000Z',
          date: '2026-08-19',
          body: '古い日付',
        },
        {
          type: 'daily_report',
          id: 'r-new',
          at: '2026-08-21T22:00:00.000Z',
          date: '2026-08-21',
          body: '新しい日付',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });

    renderReports();

    await screen.findAllByText('2026-08-19 の日報');
    const order = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null && href.startsWith('/reports/'));
    expect(order).toEqual(['/reports/2026-08-19/r-old', '/reports/2026-08-21/r-new']);
  });

  /*
    ここから3本、b69dca5（「日報の一覧を日時で1件ずつ並べ、選んだ1件だけを出す」）
    が直した「同じ日に複数あると見分けが付かず、選んでも2件同時に開く」を
    固定するテストである。

    同じ日に2件できる経路は「起動時の遡り生成」（`schedule.ts` の
    `missingDailyReportDates` → `clone.ts` の `#dailyReport`）で、前日ぶんの
    日報が翌日に書かれる。それを再現するため、`date` は同じ '2026-08-20' で、
    `at` は一方だけ翌日（`2026-08-21T…Z`）にしてある。
  */
  const closeEntry = {
    type: 'daily_report',
    id: 'r-close',
    at: '2026-08-20T22:00:00.000Z', // JST 07:00 ＝ その日の締め
    date: '2026-08-20',
    body: '## 締めの見出し\n\n締め本文だけの目印。',
  };
  const catchupEntry = {
    type: 'daily_report',
    id: 'r-catchup',
    at: '2026-08-21T00:30:00.000Z', // JST 09:30 ＝ 起動時の遡り生成（前日ぶんが翌日に書かれる）
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

  /**
   * 一覧の行を `id` で引く。
   *
   * **見出しの文字列で引かないこと。** 見出しは表示の結果であって、この関数が
   * 引きたいのは「どの日報の行か」である。`href` は `id` そのものを持つので、
   * 表示の整形が変わってもここは動かない。
   */
  function rowFor(id: string): HTMLElement {
    const row = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === `/reports/2026-08-20/${id}`);
    if (row === undefined) throw new Error(`一覧に ${id} の行が無い`);
    return row;
  }

  it('同じ日に2件あっても、一覧では時刻違いの別々の行として並ぶ', async () => {
    stubSameDayReports();

    renderReports();

    // 2件が別々の行として並ぶまで待つ。
    await screen.findAllByText('2026-08-20 の日報');

    // 日の軸は `report.date` である（題）。書かれた日時は日付つきで別に出す（#2779）。
    // 時:分だけだと、翌日に書かれた遡り生成が「その日の 09:30」に読めた。
    // 年は今年なら付かないので部分一致で見る。
    const catchup = rowFor('r-catchup').textContent ?? '';
    const close = rowFor('r-close').textContent ?? '';
    expect(catchup).toContain('2026-08-20 の日報');
    expect(catchup).toContain('08/21 09:30 に書かれた');
    expect(close).toContain('2026-08-20 の日報');
    expect(close).toContain('08/21 07:00 に書かれた');
    // 同じ日が複数あるとき、先頭（最新）にだけ目印が付く。
    expect(catchup).toContain('最新');
    expect(close).not.toContain('最新');
  });

  it('reportId で1件を指定すると、選択の見た目が付くリンクはちょうど1つになる', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    // 両方の行が描かれるまで待つ（先に getAllByRole を打つと、fetch が
    // 返る前の空の一覧で判定してしまいうる）。
    await screen.findAllByText('2026-08-20 の日報');

    // **クラス名は token で見ること。** 部分一致だと、全リンクが持つ `hover:bg-muted` などにも
    // 当たり、「選択の見た目」を数えているつもりで全リンクを数えることになる。選択の見た目は
    // 共通部品（`ListDetailItems`）が付ける `bg-accent` である。
    const selected = screen.getAllByRole('link').filter((link) => {
      const tokens = link.className.split(/\s+/);
      return tokens.includes('bg-accent');
    });

    // 前は `report.date === selected` で選んでいたので、同じ日の2件が両方
    // 選択中になっていた（人間の申告そのもの）。いまは `id` で選ぶので1つだけ。
    expect(selected).toHaveLength(1);
    // **選ばれたのがどれかは `href` で見る**（`id` が選択の単位そのものなので）。
    expect(selected[0]).toBe(rowFor('r-close'));
    // 支援技術へも伝える（#2780）。選択中だけ aria-current="page"。
    const current = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toEqual([rowFor('r-close')]);
  });

  it('本文の見出しは画面の h1 と並ばず、h3 以下に下がる（#2780）', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    const heading = await screen.findByRole('heading', { name: '締めの見出し' });
    // 本文の `##`（h2）は h4 になる。h1 は画面の「日報」だけ。
    expect(heading.tagName).toBe('H4');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('本文の `#` も h1 にならない', async () => {
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-14T22:00:00.000Z',
          date: '2026-08-14',
          body: '# 日報の題\n\n中身。',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });
    renderReports();
    const heading = await screen.findByRole('heading', { name: '日報の題' });
    expect(heading.tagName).toBe('H3');
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

  /**
   * 一覧と詳細は共通部品（`ListDetail`）が持つ。広い画面では左の一覧と右の詳細が同時に出て、
   * 一覧は自分の中でスクロールする（`nav` の `overflow-y-auto`）。**jsdom はレイアウトを
   * 持たないので、押さえられるのは構造とクラスまでである**（寸法は実ブラウザで見た）。
   */
  it('広い画面では一覧（nav）と詳細が両方出て、一覧だけが独立にスクロールできる形になる', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    const nav = await screen.findByRole('navigation', { name: '日報の一覧' });
    expect(nav.className.split(/\s+/)).toContain('overflow-y-auto');
    expect(screen.getByRole('region', { name: '日報の一覧の詳細' })).toBeTruthy();
    expect(await screen.findByText('締め本文だけの目印。')).toBeTruthy();
    // スマホ用の「開く」ボタンは広い画面では出ない。
    expect(screen.queryByRole('button', { name: '日報の一覧を開く' })).toBeNull();
    // 詳細の見出しは h2（画面の h1 は「日報」だけ）。
    expect(screen.getByRole('heading', { level: 2, name: '2026-08-20 の日報' })).toBeTruthy();
  });

  describe('スマホ幅', () => {
    afterEach(() => {
      setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    });

    it('詳細が全幅で出て、「日報の一覧を開く」ボタンからドロワーに一覧が出る。選ぶと詳細が変わる', async () => {
      setViewportWidth(390);
      stubSameDayReports();

      renderReports({ date: '2026-08-20', reportId: 'r-close' });

      expect(await screen.findByText('締め本文だけの目印。')).toBeTruthy();
      // 一覧は畳まれている。
      expect(screen.queryByRole('navigation', { name: '日報の一覧' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '日報の一覧を開く' }));
      const nav = await screen.findByRole('navigation', { name: '日報の一覧' });
      expect(within(nav).getAllByRole('link')).toHaveLength(2);
      const current = within(nav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]?.getAttribute('href')).toBe('/reports/2026-08-20/r-close');
    });

    it('一覧が読み込めていない間や0件のときは、一覧を全幅で出す', async () => {
      setViewportWidth(390);
      stubFetch((url) => {
        if (url.includes('/reports')) return json({ reports: [] });
        return undefined;
      });

      renderReports();

      expect(await screen.findByText('まだ無い。')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '日報の一覧を開く' })).toBeNull();
    });
  });

  it('URL で指定した日報を直接開ける（日付と id）', async () => {
    stubSameDayReports();

    renderReportsAtUrl('/reports/2026-08-20/r-catchup');

    expect(await screen.findByText('遡り生成本文だけの目印。')).toBeTruthy();
    expect(screen.queryByText('締め本文だけの目印。')).toBeNull();
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toEqual([rowFor('r-catchup')]);
  });

  it('指定が無ければ最新の日報が選ばれ、一覧でも選択中になる', async () => {
    stubSameDayReports();

    renderReports();

    expect(await screen.findByText('遡り生成本文だけの目印。')).toBeTruthy();
    expect(rowFor('r-catchup').getAttribute('aria-current')).toBe('page');
    expect(rowFor('r-close').getAttribute('aria-current')).toBeNull();
  });

  it('読み込み中は右側に「1件も無い」を出さない（#2803）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const reports = [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-14T22:00:00.000Z',
        date: '2026-08-14',
        body: '進捗があった。',
      },
    ];
    stubFetch((url) => {
      if (url.includes('/reports')) {
        requested = true;
        return gate.then(() => json({ reports }));
      }
      return undefined;
    });

    renderReports();

    // 一覧が未着の間（要求は出たが応答が返っていない）、右側は「1件も無い」と言わない。
    // 実時間で待たず、要求が出たことを待つ（#2146）。
    await waitFor(() => expect(requested).toBe(true));
    expect(screen.queryByText(/日報が1件も無い/)).toBeNull();
    expect(screen.queryByText('まだ無い。')).toBeNull();

    release();
    expect(await screen.findByText('進捗があった。')).toBeTruthy();
    expect(screen.queryByText(/日報が1件も無い/)).toBeNull();
  });

  /**
   * 日報が1件も無いときの案内は、詳細側（広い画面）に出る。一覧の側は「まだ無い。」。
   */
  it('日報が1件も無いときは、詳細側にその案内が出る', async () => {
    stubFetch((url) => {
      if (url.includes('/reports')) return json({ reports: [] });
      return undefined;
    });

    renderReports();

    const detail = await screen.findByRole('region', { name: '日報の一覧の詳細' });
    expect(within(detail).getByText(/日報が1件も無い/)).toBeTruthy();
  });

  /**
   * **切ったなら切ったと言う（Issue #426 の G3）。** `useReports(60)` は
   * 窓の大きさ（60）自体を変えない — 決め方が未決だと Issue 本文が書いて
   * いるので、決まっていない基準で窓を動かすより先に「切ったことと定量を
   * 言う」ほうを片付ける。
   *
   * `GET /reports` は総件数を返さないので、正確な省略件数は言えない。
   * 言えるのは「返ってきた件数が要求した上限（60）とちょうど一致した」
   * ことだけ——`tokens.tsx` の `RotationHistory`（`GET /journal` に対する
   * 同じ形）と揃えてある。
   */
  function makeReports(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      type: 'daily_report' as const,
      id: `r-${index}`,
      at: `2026-06-${String(index + 1).padStart(2, '0')}T22:00:00.000Z`,
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      body: `${index} 日目の進捗`,
    }));
  }

  it('返った件数が上限（60）ちょうどなら、これより古いかもしれないと言う', async () => {
    const reports = makeReports(60);
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports });
      return undefined;
    });

    renderReports();

    expect(
      await screen.findByText(/直近 60 件のみ表示している。これより古い日報があるかもしれない。/),
    ).toBeTruthy();
  });

  it('上限に達していなければ、その但し書きは出さない（雑音にしない）', async () => {
    const reports = makeReports(3);
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports });
      return undefined;
    });

    renderReports();

    await screen.findByText(/2026-06-03/);
    expect(screen.queryByText(/これより古い日報があるかもしれない/)).toBeNull();
  });
});
