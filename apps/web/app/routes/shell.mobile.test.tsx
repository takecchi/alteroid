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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

/** `pendingApprovals` 件の承認待ちがある状態で `AuthedShell` まで通す。 */
function stubAuthedShell(pendingApprovals: unknown[] = []) {
  return stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/approvals')) return json({ approvals: pendingApprovals });
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
    expect(screen.queryByText('ダッシュボード')).toBeNull();
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
    const dashboardLink = await screen.findByRole('link', { name: /ダッシュボード/ });
    expect(screen.getByRole('dialog', { name: 'メニュー' })).toBeTruthy();

    fireEvent.click(dashboardLink);

    // 覆いが残っていないこと（ドロワーは閉じているあいだ中身ごと描かない）。
    expect(screen.queryByRole('dialog', { name: 'メニュー' })).toBeNull();
    expect(screen.queryByRole('link', { name: /ダッシュボード/ })).toBeNull();
  });
});

describe('広い画面（1280px）', () => {
  it('ハンバーガーが無く、行き先の一覧が最初から出ている（見た目を変えていない）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell();

    renderShell();

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(screen.getByRole('link', { name: /ダッシュボード/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: '会話' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'メニューを開く' })).toBeNull();
  });
});

/**
 * サイドバー（狭い画面ではドロワーの中に同じものが出る）フッターの
 * `記憶: {data.storage}` は `truncate` で1行に切っているが、`title` 属性が
 * 無く続きを取る手段が無かった（本5「省略の出口」）。
 *
 * **ここで言えること / 言えないこと**: `title` は DOM に出るので `getByTitle`
 * で引ける — 「切られている値と同じ文字列が `title` に入っていること」は
 * ここで踏める。jsdom はレイアウトを持たないので「実際に幅52（`w-52`）の
 * サイドバーで見た目が切れて hover で続きが読めること」はここでは確かめられない。
 */
describe('サイドバーの記憶ストレージ説明', () => {
  it('truncate で切られていても title で全文が引ける', async () => {
    const longStorage =
      'PostgreSQL（a-very-long-masked-connection-target-that-will-not-fit-in-w-52）';
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell();
    // `stubAuthedShell` の既定の `HEALTH` は短い値なので、この試験だけ差し替える。
    stubFetch((url, init) => {
      if (url.endsWith('/health')) return json({ ...HEALTH, storage: longStorage });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
      return undefined;
    });

    renderShell();

    expect(await screen.findByTitle(longStorage)).toBeTruthy();
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
