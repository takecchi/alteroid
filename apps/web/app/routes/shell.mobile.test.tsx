// @vitest-environment jsdom
/**
 * 狭い画面での `AuthedShell`（`shell.tsx`）。
 *
 * 幅 375px では nav 208px が常時居座ると本文の取り分がほとんど残らないので、
 * 768px 未満ではドロワーへ畳む変更（`git show 3169b99`）を入れた。ここではその
 * 効き目を4つ確かめる。
 *
 * 1. 狭い画面では、行き先の一覧が最初から出ていない（本文が脇の面に挟まれない）
 * 2. 狭い画面で「メニューを開く」を押すと出て、行き先を押すと閉じる
 *    （ドロワーが覆ったまま残らない）
 * 3. 広い画面では、ハンバーガーが無く、行き先の一覧が最初から出ている
 *    （広い画面の見た目を変えていない）
 * 4. 承認待ちがあるとき、狭い画面でも件数が見える（脇を畳んだ結果、人間を
 *    待っている仕事が見えなくなっていないこと）
 *
 * `AuthedShell` は `/health` と `/approvals` を叩き、`useJournalLive` が
 * `/journal/stream` へ SSE を張る。3つとも `stubFetch` に置く（置かないと
 * 「繋がらない」→再接続を繰り返すことになり、試験が不安定になる）。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  sse,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

/** 狭い画面。判定の境目（Tailwind の `md` の下限 768px）より下にある幅。 */
const NARROW_WIDTH = 375;

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ index: true, Component: () => <div>ダッシュボードの中身</div> }],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/**
 * `pendingApprovals` 件の承認待ちがある状態で `AuthedShell` まで通す。
 *
 * `approvalsFail: true` を渡すと `GET /approvals` が 500 を返す（issue
 * #2105 の「読めていない」の試験用）——`pendingApprovals` は無視される。
 */
function stubAuthedShell(pendingApprovals: unknown[] = [], approvalsFail = false) {
  return stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/approvals')) {
      return approvalsFail
        ? json({ error: 'internal' }, 500)
        : json({ approvals: pendingApprovals });
    }
    // `useJournalLive` の購読先。**置かないと「繋がらない」→再接続を繰り返す。**
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
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
  // 幅は試験をまたいで持ち越す状態。既定（広い画面）へ戻す。
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
});

describe('狭い画面（375px）', () => {
  it('行き先の一覧が最初から出ていない（本文の脇に挟まれない）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    // ドロワーは閉じているあいだ中身を描かない（`Drawer` の作り）ので、
    // 行き先のリンクはまだ現れていないはず。
    expect(screen.queryByText('ホーム')).toBeNull();
    expect(screen.queryByText('会話')).toBeNull();
    expect(screen.getByRole('button', { name: 'メニューを開く' })).toBeTruthy();
  });

  it('「メニューを開く」で出て、行き先を押すと閉じる（覆ったまま残らない）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');

    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));

    // ドロワーが開き、行き先の一覧が出る。
    const dashboardLink = await screen.findByRole('link', { name: /ホーム/ });
    expect(screen.getByRole('dialog', { name: 'メニュー' })).toBeTruthy();

    fireEvent.click(dashboardLink);

    // 覆いが残っていないこと（ドロワーは閉じているあいだ中身ごと描かない）。
    expect(screen.queryByRole('dialog', { name: 'メニュー' })).toBeNull();
    expect(screen.queryByRole('link', { name: /ホーム/ })).toBeNull();
  });
});

describe('狭い画面のドロワー', () => {
  it('広い画面と同じまとまり（見出し）と行き先が、ドロワーの中にも出る。現在地も同じ規則で示す', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));

    const dialog = await screen.findByRole('dialog', { name: 'メニュー' });
    expect(within(dialog).getAllByText('記録')).toHaveLength(1);
    expect(within(dialog).getAllByText('クローンの中身')).toHaveLength(1);
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'ホーム',
      '会話',
      '承認待ち',
      '仕事',
      'マネージャー',
      '日報',
      '日誌',
      '記憶とやり方',
      '予定と受信箱',
      '設定',
    ]);
    // 現在地（`/`）の印はドロワーの中でも付く。
    expect(within(dialog).getByRole('link', { name: 'ホーム' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});

describe('広い画面（1280px）', () => {
  it('ハンバーガーが無く、行き先の一覧が最初から出ている（見た目を変えていない）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell();

    renderShell();

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(screen.getByRole('link', { name: /ホーム/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: '会話' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'メニューを開く' })).toBeNull();
  });
});

/**
 * サイドバー（狭い画面ではドロワーの中に同じものが出る）のフッターには、
 * サーバの記憶ディレクトリのパスとプロセス番号を出さない（#2762）。利用者が見て
 * 何かする情報ではなく、画面共有・スクリーンショットでサーバのファイル配置が漏れる。
 * 移し先は設定画面の「詳細」（settings.test.tsx）。
 */
describe('サイドバーのフッター', () => {
  it('記憶ディレクトリのパスとプロセス番号を出さず、接続状態だけを出す', async () => {
    const storage = '/tmp/mgr-secret/home';
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubFetch((url, init) => {
      if (url.endsWith('/health')) return json({ ...HEALTH, pid: 927, storage });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
      return undefined;
    });

    const { container } = renderShell();

    expect(await screen.findByText('接続中')).toBeTruthy();
    expect(container.textContent).not.toContain(storage);
    expect(container.textContent).not.toContain('pid');
    expect(container.textContent).not.toContain('927');
    expect(screen.queryByTitle(storage)).toBeNull();
  });
});

describe('承認待ちの見え方', () => {
  it('狭い画面でも、脇を畳んだまま件数が見える（人間を待っている仕事が消えない）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell([{ id: 'a1', question: '本番に出してよいか' }]);

    renderShell();

    // ドロワーを開かなくても、上端の帯（`MobileTopBar`）に件数が出ている。
    expect(await screen.findByRole('link', { name: '承認待ち 1 件' })).toBeTruthy();
  });

  it('0件のときは、狭い画面の上端に何も出ない（バッジ無し）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell([]);

    renderShell();

    await screen.findByText('ダッシュボードの中身');
    expect(screen.queryByRole('link', { name: /承認待ち/ })).toBeNull();
  });
});

/**
 * `GET /approvals` が読めなかったとき（issue #2105）。
 *
 * **0件（バッジ無し）と見分けが付くこと**が測りたい保証——読めなかったのに
 * 「いま承認待ちは無い」と読めてしまうのが症状だったので、単に何かが出る
 * だけでは足りず、0件のときには出ないものと違う見た目（`aria-label` /
 * `title` に「読めていない」の文言）で出ることまで確かめる。
 */
describe('/approvals が読めないとき（issue #2105）', () => {
  it('狭い画面の上端（MobileTopBar）に「読めていない」印が出る。リンク先は /approvals のまま', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell([], true);

    renderShell();

    const link = await screen.findByRole('link', { name: '承認待ちを読めていない' });
    expect(link.getAttribute('href')).toBe('/approvals');
    // 0件のバッジ（`Badge tone="warn"`）ではなく、専用の印が出ている。
    expect(screen.queryByRole('link', { name: /承認待ち \d+ 件/ })).toBeNull();
  });

  it('広い画面のナビにも「読めていない」印が出る（0件のバッジは出ない）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell([], true);

    renderShell();

    expect(await screen.findByTitle('承認待ちを読めていない')).toBeTruthy();
    expect(screen.getByLabelText('承認待ちを読めていない')).toBeTruthy();
  });

  it('広い画面で0件のときは、ナビに何も出ない（「読めていない」印と混ざらないことの対照）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell([]);

    renderShell();

    await screen.findByText('ダッシュボードの中身');
    expect(screen.queryByTitle('承認待ちを読めていない')).toBeNull();
    expect(screen.queryByLabelText('承認待ちを読めていない')).toBeNull();
  });

  it('広い画面で承認待ちが2件のときは、ナビに2のバッジが出て、「読めていない」印は出ない', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell([
      { id: 'a1', question: '本番に出してよいか' },
      { id: 'a2', question: 'ロールバックしてよいか' },
    ]);

    renderShell();

    // `Nav` は `MobileTopBar` と違い `aria-label` を件数バッジに乗せていない
    // ので、リンクの見える中身（`承認待ち` ラベル＋バッジの数字）で確かめる。
    const link = await screen.findByRole('link', { name: /承認待ち/ });
    expect(link.textContent).toContain('2');
    // 0件のバッジ（対照、直前のテスト）や「読めていない」印と混ざらないこと。
    expect(screen.queryByTitle('承認待ちを読めていない')).toBeNull();
    expect(screen.queryByLabelText('承認待ちを読めていない')).toBeNull();
  });
});

/**
 * 狭い画面の上端の帯（`MobileTopBar`）の横向き safe-area inset（Issue #247 の4）。
 *
 * **これは「切り欠きの側で欠けなくなった」ことの試験ではない。** jsdom は
 * `env(safe-area-inset-*)` を評価できないので、実際に何 px になるかはここでは
 * 測れない。固定できるのは、帯にそのクラス名が書かれていることまでである。
 *
 * この帯は `--safe-top` は既に持っていた（縦向き）。ここで見るのは横向きぶん
 * （`--safe-left` / `--safe-right`）で、`page.test.tsx` の本文側と対になる。
 */
describe('上端の帯の横向き safe-area inset（本4）', () => {
  it('狭い画面の上端の帯（header）が pl / pr の safe-area クラスを持つ（クラス名の存在のみ）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');

    const header = screen.getByRole('banner');
    const classes = header.className.split(/\s+/);
    expect(classes).toContain('pl-[var(--safe-left)]');
    expect(classes).toContain('pr-[var(--safe-right)]');
    // 既存の縦の safe-area（本4の対象外だが、消していないことも一緒に見ておく）。
    expect(classes).toContain('pt-[var(--safe-top)]');
  });
});

/**
 * 広い画面（`useIsMobile` の境目 768px 以上）で `nav` が単独で画面の左端に
 * 立つときの横向き safe-area inset（Issue #247 の4、差し戻し分）。
 *
 * **横向きにすると 768px を超える現行機種が多い**（`MOBILE_BREAKPOINT` は
 * `use-is-mobile.ts` の doc を参照）。その場合 `MobileTopBar` ではなくこの
 * `nav` が画面の左端に出るので、横向きの左端の safe-area はむしろこちらが
 * 主な当たり先になる。
 *
 * **狭い画面（`Drawer` の中）では同じ `nav` に `pl-[var(--safe-left)]` を
 * 足していないことも合わせて見る。** `Drawer` の `SheetContent` が既に
 * `pl-[var(--safe-left)]` を持っているので（`drawer.tsx`）、`nav` 側にも
 * 足すと二重に効く（余白が倍になる）。二重にならないことをここで固定する。
 *
 * どちらも**クラス名の存在／不在のみを見る弱い歯**である。jsdom は
 * `env(safe-area-inset-*)` を評価できないので、実際に何 px になるか・
 * 二重に描画されて余白が本当に倍になるかはここでは測れない。
 */
describe('nav の横向き safe-area inset（本4、差し戻し分）', () => {
  it('広い画面では nav（画面の左端）が pl-[var(--safe-left)] を持つ（クラス名の存在のみ）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');

    const nav = screen.getByRole('navigation');
    const classes = nav.className.split(/\s+/);
    expect(classes).toContain('pl-[var(--safe-left)]');
  });

  it('狭い画面（Drawer の中）では nav に pl-[var(--safe-left)] が付いていない（Drawer 側と二重にならないこと）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    await screen.findByRole('dialog', { name: 'メニュー' });

    const nav = screen.getByRole('navigation');
    const classes = nav.className.split(/\s+/);
    expect(classes).not.toContain('pl-[var(--safe-left)]');
  });
});
