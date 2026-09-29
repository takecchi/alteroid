// @vitest-environment jsdom
/**
 * 「黙って嘘をつかない」を画面側で固定する。
 *
 * `beforeLedger` が真のときに 0 と出す・`since` が null なのに $0.00 と出す・
 * 但し書きを省く、のどれも数字を出す機能そのものの信用を失わせる
 * （`apps/cli/src/usage.ts` と同じ規約）。
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, renderedMoneyTexts, stubFetch, storeTestBaseUrl } from '~/test-support';

import Usage from './usage';

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
 * **Router で包む（issue #2050）。** `Usage` は絞り込みの正本を URL に置く
 * （`useSearchParams`）ので、Router 無しでは描けなくなった。「マネージャー別」軸の
 * id も `<Link>` を描く（issue #2046）ので、どちらの理由でも Router が要る。形は
 * `journal.tsx` の `renderJournal` / `managers.tsx` と同じ `createMemoryRouter`
 * + `RouterProvider`。
 *
 * **`router` を返すのは、絞り込みが URL に載ったことを読むためである**
 * （`router.state.location.search`）。画面の state を覗くのではなく URL を
 * 見ることで、「開き直しても・共有しても同じ絞り込みが再現できる」という
 * 主張そのものを測れる。
 */
function renderUsage(initialEntries: string[] = ['/']) {
  const router = createMemoryRouter([{ path: '/', Component: Usage }], {
    initialEntries,
  });
  const result = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, router };
}

function row(
  costUsd: number,
  over: Partial<{
    date: string;
    managerId: string;
    model: string;
    layer: string;
    site: string;
    tokenId: string;
    webSearchRequests: number;
    unreadable: Record<string, number>;
  }> = {},
) {
  const { webSearchRequests, unreadable, ...rest } = over;
  return {
    date: '2026-08-14',
    managerId: 'm1',
    model: 'claude-opus-4',
    layer: 'manager',
    site: 'session',
    updatedAt: '2026-08-14T10:00:00.000Z',
    ...rest,
    totals: {
      ...ZERO_USAGE,
      costUsd,
      webSearchRequests: webSearchRequests ?? 0,
      ...(unreadable === undefined ? {} : { unreadable }),
    },
  };
}

function stubUsage(body: {
  rows: unknown[];
  since: string | null;
  layersSince?: string | null;
  beforeLedger: boolean;
  beforeLayers?: boolean;
  notice?: string;
  /**
   * アカウント全体の残り。**既定は `unknown`（まだ取りに行っていない）。**
   *
   * 応答から落とすと「返さないデーモンに繋がっている」の分岐に入るので、
   * それを見たいテストだけが `null` を渡す（`account` を省く）。
   */
  account?: unknown;
  /**
   * 台帳に1行も無い委譲（Issue #98）。**既定は空配列**——この軸を測るテストだけが
   * 自分で渡す（他の軸と同じ形）。
   */
  unrecordedManagers?: unknown[];
  /**
   * 「起きた回数」の別会計。**既定は空配列**——`summarizeUsage` が無条件で
   * `turnRows.reduce` を呼ぶので、`rows` と同じく必須の欄として渡す
   * （`tokensSince` / `beforeTokens` と違い、省略すると画面側の分岐に入る前に
   * 例外で落ちる）。
   */
  turnRows?: unknown[];
}) {
  // **`account` は spread から外して組み立てる。** `...body` に混ぜると、
  // 「応答に無い」を作るために `null` を渡した場合、その `null` が応答へ残る
  // （「無い」と「null が入っている」は別物である）。
  const { account, ...rest } = body;
  return stubFetch((url) =>
    url.includes('/usage')
      ? json({
          ...rest,
          layersSince: body.layersSince === undefined ? body.since : body.layersSince,
          beforeLayers: body.beforeLayers ?? false,
          notice: body.notice ?? USAGE_ESTIMATE_NOTICE,
          breakdown: null,
          unrecordedManagers: body.unrecordedManagers ?? [],
          turnRows: body.turnRows ?? [],
          ...(account === null ? {} : { account: account ?? { state: 'unknown' } }),
        })
      : undefined,
  );
}

/**
 * 軸カードの中だけを見る。
 *
 * **画面全体から探さない。** 絞り込みの `<option>` にも `clone` / `session` という
 * 同じ文字列があるので、範囲を絞らないと「カードが消えても option が拾われて通る」
 * テストになる。
 */
function axisCard(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const card = heading.closest('div.rounded-lg');
  if (card === null) throw new Error(`${title} のカードが見つからない`);
  return card as HTMLElement;
}

describe('/usage 画面', () => {
  it('台帳がまだ空（since が null）なら、金額を1つも出さず「まだ記録が無い」と言う', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    expect(await screen.findByText(/台帳にはまだ1件も記録が無い/)).toBeTruthy();
    // ⛔ ここは `queryByText('$0.00')` だった（#935。理由は `renderedMoneyTexts` の doc）。
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('beforeLedger が真なら、0 ではなく記録が無い範囲だと明示する', async () => {
    stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: true,
    });

    renderUsage();

    expect(await screen.findByText(/その範囲には記録が無い/)).toBeTruthy();
    expect(await screen.findByText(/照会した範囲は台帳の始点より前にかかっている/)).toBeTruthy();
    // 「合計」の見出し自体は出るが、金額は出ない（記録が無いと言うだけ）。
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('但し書き（推定値であり請求明細ではない）を必ず出す', async () => {
    stubUsage({
      rows: [row(1.2)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    expect(await screen.findByText(USAGE_ESTIMATE_NOTICE)).toBeTruthy();
  });

  it('$1 未満の金額を $0.00 に丸めない（formatUsd をそのまま使う）', async () => {
    stubUsage({
      rows: [row(0.0123)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    // 合計・日別・マネージャー別・モデル別のすべてに同じ金額がそのまま出る
    // （行が1件しかないので全軸で一致する）。
    expect((await screen.findAllByText('$0.0123')).length).toBeGreaterThan(0);
    // ⭐ **直上の陰性対照の対照でもある**（`renderedMoneyTexts` の doc）。この行が
    // 赤くならない限り、「金額を1つも出さない」側の歯が空でないことは言えない ——
    // 網が壊れて常に空集合を返しても、陰性対照だけなら緑のままである。
    expect(renderedMoneyTexts()).toEqual(new Set(['$0.0123']));
  });

  it('日別・マネージャー別・モデル別の内訳を出す', async () => {
    stubUsage({
      rows: [
        row(1, { managerId: 'm1', model: 'opus', date: '2026-08-13' }),
        row(2, {
          managerId: 'm2',
          model: 'sonnet',
          date: '2026-08-14',
          layer: 'clone',
          site: 'distill',
        }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    // **合計の $3.00 を「画面に1つだけある」で特定しない。** 軸のカードにも同じ
    // 金額が出る（この土台は行が2件しかないので、1件に畳まれた軸のカードは
    // 合計と同額になる）。**緩めるのではなく、どこの $3.00 かを言う。**
    await screen.findByRole('heading', { name: '合計' });
    const total = axisCard('合計');
    expect(within(total).getByText('$3.00')).toBeTruthy();
    expect(screen.getByText('日別')).toBeTruthy();
    expect(screen.getByText('マネージャー別')).toBeTruthy();
    expect(screen.getByText('モデル別')).toBeTruthy();
    expect(screen.getByText('m1')).toBeTruthy();
    expect(screen.getByText('m2')).toBeTruthy();
  });

  it('層別（誰が）と場所別（どこで）の内訳も出す', async () => {
    // **モデル名では層を見分けられない。** 2行とも同じモデル帯にしてあるのは、
    // `ALTEROID_CLONE_MODEL` を置いたときに実際に起きる並びだからである。
    stubUsage({
      rows: [
        row(1, { managerId: 'm1', model: 'opus', layer: 'manager', site: 'session' }),
        row(2, { managerId: 'clone', model: 'opus', layer: 'clone', site: 'distill' }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByRole('heading', { name: '層別（誰が）' });
    const layers = axisCard('層別（誰が）');
    expect(within(layers).getByText('clone')).toBeTruthy();
    expect(within(layers).getByText('manager')).toBeTruthy();
    expect(within(layers).getByText('$2.00')).toBeTruthy();
    expect(within(layers).getByText('$1.00')).toBeTruthy();
    const sites = axisCard('場所別（どこで）');
    expect(within(sites).getByText('session')).toBeTruthy();
    expect(within(sites).getByText('distill')).toBeTruthy();
    // **モデル軸では分けられない。** 同じモデル帯なので1件に畳まれ、$3.00 がまとめて
    // 出る — 層の軸が無ければ「誰が使ったか」はこの画面から読めない。
    const models = axisCard('モデル別');
    expect(within(models).getByText('opus')).toBeTruthy();
    expect(within(models).getByText('$3.00')).toBeTruthy();
  });

  it('beforeLayers が真なら、その範囲の層と場所は観測ではないと書く', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      layersSince: '2026-08-19T00:00:00.000Z',
      beforeLedger: false,
      beforeLayers: true,
    });

    renderUsage();

    expect(await screen.findByText(/既定値であって観測ではない/)).toBeTruthy();
    // 層の始点を台帳の始点と混ぜない（2つの始点が別物であることを画面が言う）。
    expect(screen.getByText(/2026-08-19T00:00:00\.000Z/)).toBeTruthy();
  });

  /**
   * 軸カード（`AxisCard`）の `entry.label` は `truncate` で1行に切っているが、
   * `title` 属性が無く続きを取る手段が無かった（本5「省略の出口」）。
   *
   * **ここで言えること / 言えないこと**: `title` 属性は DOM に出るので
   * `getByTitle` で引ける — 「切られている値と同じ文字列が `title` に入って
   * いること」はここで踏める。jsdom はレイアウトを持たないので「実際に狭い
   * 画面で見た目が切れて hover で続きが読めること」はここでは確かめられない。
   */
  it('entry.label が truncate で切られていても title で全文が引ける', async () => {
    const longManagerId = 'mgr-with-a-very-long-identifier-that-narrow-screens-will-cut-off';
    stubUsage({
      rows: [row(1, { managerId: longManagerId })],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    expect(within(managers).getByTitle(longManagerId)).toBeTruthy();
  });

  /**
   * **マネージャー別の id を委譲の詳細へつなぐ（issue #2046）。** マネージャーの
   * 行（`mgr-…`）だけがリンクになり、クローンの分（`CLONE_ACTOR_ID` ＝ `clone`）は
   * 委譲ではないのでリンクにしない。`title`（全文の出口）は両方とも残る。
   */
  it('マネージャー別の mgr- の行は /managers/<id> への Link になり、clone の行はならない', async () => {
    stubUsage({
      rows: [
        row(2, { managerId: 'mgr-42' }),
        row(1, { managerId: 'clone', layer: 'clone', site: 'distill' }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    const link = within(managers).getByRole('link', { name: 'mgr-42' });
    expect(link.getAttribute('href')).toBe('/managers/mgr-42');
    expect(within(managers).getByTitle('mgr-42')).toBeTruthy();

    expect(within(managers).getByTitle('clone').textContent).toBe('clone');
    expect(within(managers).queryByRole('link', { name: 'clone' })).toBeNull();
    expect(within(managers).getAllByRole('link')).toHaveLength(1);
  });

  /**
   * **認証トークン別の帰属のある行だけ `/tokens` へつなぐ（issue #2100 段1）。**
   * `tokenId` を持つ行だけがリンクになり、帰属の無い分
   * （「（トークンの帰属が無い分）」＝ `tokenId: null`）はリンクにしない。
   *
   * **飛び先はその id の行そのもの（issue #2109。#2100 の段2）。** `/tokens`
   * 止まりだった飛び先を、`~/lib/tokens-links` の `tokensHref` で組み立てた
   * `/tokens?tokenId=<id>` へ向け直した——`tokens.tsx` 側がこのクエリを読んで
   * 行へスクロール・強調する（`tokens.test.tsx` が持つ）。
   */
  it('認証トークン別の tokenId のある行は /tokens?tokenId=<id> への Link になり、帰属の無い行はならない', async () => {
    stubUsage({
      rows: [row(2, { tokenId: 'tok-42' }), row(1, {})],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByRole('heading', { name: '認証トークン別' });
    const tokens = axisCard('認証トークン別');
    const link = within(tokens).getByRole('link', { name: 'tok-42' });
    expect(link.getAttribute('href')).toBe('/tokens?tokenId=tok-42');
    expect(within(tokens).getByTitle('tok-42')).toBeTruthy();

    const noAttribution = '（トークンの帰属が無い分）';
    expect(within(tokens).getByTitle(noAttribution).textContent).toBe(noAttribution);
    expect(within(tokens).queryByRole('link', { name: noAttribution })).toBeNull();
    expect(within(tokens).getAllByRole('link')).toHaveLength(1);
  });

  it('層と場所で絞り込める（4つの口に同じ絞り込みがある）', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      if (!url.includes('/usage')) return undefined;
      calls.push(url);
      return json({
        rows: [],
        since: '2026-08-01T00:00:00.000Z',
        layersSince: '2026-08-01T00:00:00.000Z',
        beforeLedger: false,
        beforeLayers: false,
        notice: USAGE_ESTIMATE_NOTICE,
        breakdown: null,
        unrecordedManagers: [],
        turnRows: [],
      });
    });

    renderUsage();

    await screen.findByText(/その範囲には記録が無い/);
    const layerSelect = screen.getByLabelText(/layer/);
    layerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    // 選択肢が core の一覧から作られていること（画面に書き写していない）。
    expect(within(layerSelect).getByText('clone')).toBeTruthy();
    expect(within(layerSelect).getByText('manager')).toBeTruthy();
    const siteSelect = screen.getByLabelText(/site/);
    expect(within(siteSelect).getByText('session')).toBeTruthy();
    expect(within(siteSelect).getByText('distill')).toBeTruthy();
  });

  /**
   * モバイルで from/to が枠から出た不具合（人間の実機報告）の再発防止。
   *
   * `sm` 未満の絞り込み容器に `grid-template-columns` が無いと暗黙の単一
   * トラックは `auto`＝max-content になり、内在幅の大きい要素（`type="date"`
   * の入力）がそのままトラック幅になって `Card` の枠を超える。
   *
   * **ここで押さえられること / 押さえられないこと**: クラスが当たっている
   * ことは押さえるが、実機で枠に収まることは押さえていない（jsdom は
   * レイアウトを持たず `offsetWidth` 等はすべて 0 を返すので、実際の
   * トラック幅も要素の内在幅も測れない）。次に読む人がこのテストを視覚
   * 回帰試験だと誤読しないように明示しておく。
   */
  it('絞り込みの容器は sm 未満でも grid-cols-1 を持つ（暗黙トラックを auto にしない）', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    const fromInput = await screen.findByLabelText(/from/);
    // grid の直接の子ではなく label なので、容器は label の親。
    const grid = fromInput.closest('label')?.parentElement;
    if (grid === null || grid === undefined) throw new Error('絞り込みの容器が見つからない');
    const tokens = grid.className.split(/\s+/);
    expect(tokens).toContain('grid-cols-1');
    expect(tokens).toContain('sm:grid-cols-3');
  });

  it('type="date" の from/to 入力は min-w-0 を持つ（内在幅の大きい要素だけの追加の押さえ）', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    // **ラベルは前後を固定して当てる。** `/to/` は部分一致なので、`token` という
    // ラベルが増えた瞬間に2件へ当たって落ちた。**緩めるのではなく、どのラベルか
    // を言う** — 前後を固定すれば、似た名前のラベルが増えても当たり続ける。
    const fromInput = await screen.findByLabelText(/^from$/);
    const toInput = screen.getByLabelText(/^to$/);
    for (const input of [fromInput, toInput]) {
      const tokens = input.className.split(/\s+/);
      expect(tokens).toContain('min-w-0');
    }
  });
});

/**
 * 絞り込みが URL に載る（issue #2050）。`journal.tsx`（#2029）の種別チップ・
 * `managers.tsx`（#2030）の状態チップと同じ判断——絞り込みの正本を画面の
 * state ではなく URL に置くことで、再読み込みやリンク共有で消えないように
 * する。
 *
 * **表示の意味そのものは変えていない。** ここで測るのは「URL とのやり取り」
 * だけで、絞り込みが `GET /usage` へどう効くかは上の「層と場所で絞り込める」
 * が既に押さえている。
 */
describe('/usage 画面の絞り込みが URL に載る（issue #2050）', () => {
  it('初期 URL の検索引数から絞り込みが復元され、/usage への問い合わせにその値が載る', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage([
      '/?from=2026-08-01&to=2026-08-20&managerId=m1&layer=clone&site=distill&tokenId=tok-1',
    ]);

    await screen.findByText(/その範囲には記録が無い/);

    // 入力欄そのものに復元されている。
    expect((screen.getByLabelText(/^from$/) as HTMLInputElement).value).toBe('2026-08-01');
    expect((screen.getByLabelText(/^to$/) as HTMLInputElement).value).toBe('2026-08-20');
    expect((screen.getByLabelText(/^manager$/) as HTMLInputElement).value).toBe('m1');
    expect((screen.getByLabelText(/layer/) as HTMLSelectElement).value).toBe('clone');
    expect((screen.getByLabelText(/site/) as HTMLSelectElement).value).toBe('distill');
    expect((screen.getByLabelText(/^token/) as HTMLInputElement).value).toBe('tok-1');
    // 読める日付なので、読めなかった旨の注記は出ない（issue #2133）。
    expect(screen.queryByText(/読めないので、絞り込みに使っていない/)).toBeNull();

    // `GET /usage` への問い合わせにも同じ値が載る。
    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.get('from')).toBe('2026-08-01');
      expect(params.get('to')).toBe('2026-08-20');
      expect(params.get('managerId')).toBe('m1');
      expect(params.get('layer')).toBe('clone');
      expect(params.get('site')).toBe('distill');
    });
  });

  it('入力欄を変えると URL に載る', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });
    const { router } = renderUsage();
    await screen.findByText(/その範囲には記録が無い/);

    fireEvent.change(screen.getByLabelText(/^from$/), { target: { value: '2026-08-01' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('from')).toBe('2026-08-01');
    });

    fireEvent.change(screen.getByLabelText(/^to$/), { target: { value: '2026-08-20' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('to')).toBe('2026-08-20');
    });

    fireEvent.change(screen.getByLabelText(/^manager$/), { target: { value: 'mgr-9' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('managerId')).toBe('mgr-9');
    });

    fireEvent.change(screen.getByLabelText(/layer/), { target: { value: 'manager' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('layer')).toBe('manager');
    });

    fireEvent.change(screen.getByLabelText(/site/), { target: { value: 'session' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('site')).toBe('session');
    });

    fireEvent.change(screen.getByLabelText(/^token/), { target: { value: 'tok-2' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('tokenId')).toBe('tok-2');
    });

    // 履歴を汚さない（`journal.tsx` / `managers.tsx` と同じ `replace: true`）。
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('URL に知らない layer / site が書かれていても落ちず、「すべて」として扱う', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?layer=no-such-layer&site=no-such-site']);

    // 画面ごと落ちない。
    await screen.findByText(/その範囲には記録が無い/);
    // 選択肢は既知のものしか無いので、不正な値は「すべて」（空文字）に落ちる。
    expect((screen.getByLabelText(/layer/) as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText(/site/) as HTMLSelectElement).value).toBe('');

    // 不正な値のまま `GET /usage` へ渡さない（API へ変な問い合わせを投げない）。
    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.has('layer')).toBe(false);
      expect(params.has('site')).toBe(false);
    });
  });

  /**
   * `from` / `to` は `layer` / `site` と違って**知らない値の集合が閉じて
   * いない**（人間が手で書き換えた URL・古いブックマーク・他の画面の組み
   * 立てミス、のどれでも壊れうる）ので、`layer` / `site` と同じ「知らない
   * 値は捨てて『すべて』にする」だけでは、読み手は絞り込みが効いていない
   * ことに気づけない（issue #2133）。**捨てたことを画面に1行出す。**
   */
  it('URL の from が YYYY-MM-DD として読めないとき、GET /usage に渡さず、読めないと画面に出す', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?from=not-a-date']);

    // 画面ごと落ちない。
    await screen.findByText(/その範囲には記録が無い/);

    // 捨てたことが分かる（値そのものも出る——人間が書いた URL の値であって
    // 秘密ではない）。
    expect(
      await screen.findByText(
        /URL の from=not-a-date は日付として読めないので、絞り込みに使っていない/,
      ),
    ).toBeTruthy();

    // 読めない値は入力欄にも出さない（絞り込みが効いているように見えるのに
    // 入力欄が空、という食い違いを作らない側——両方とも空にする）。
    expect((screen.getByLabelText(/^from$/) as HTMLInputElement).value).toBe('');

    // 読めない値のまま `GET /usage` へ渡さない。
    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.has('from')).toBe(false);
    });
  });

  it('URL の to が YYYY-MM-DD として読めないときも同じ（from とは別に判定する）', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?from=2026-08-01&to=2026-02-30-ish']);

    await screen.findByText(/その範囲には記録が無い/);

    expect(
      await screen.findByText(
        /URL の to=2026-02-30-ish は日付として読めないので、絞り込みに使っていない/,
      ),
    ).toBeTruthy();
    // from は読めているので、こちらは注記が出ない。
    expect(screen.queryByText(/URL の from=.*は日付として読めない/)).toBeNull();
    expect((screen.getByLabelText(/^from$/) as HTMLInputElement).value).toBe('2026-08-01');
    expect((screen.getByLabelText(/^to$/) as HTMLInputElement).value).toBe('');

    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.get('from')).toBe('2026-08-01');
      expect(params.has('to')).toBe(false);
    });
  });

  /**
   * `2026-02-30` は**形は `YYYY-MM-DD` に合うが、実在しない日**である。
   * デーモン側の `usageDateSchema`（`packages/core/src/usage.ts`）も正規表現
   * だけで検査していて実在の検査をしていない（`usage.tsx` の
   * `USAGE_DATE_PATTERN` の doc）ので、画面もここでは弾かず「読めた」側として
   * 渡す——弾くと、デーモンが通す値を画面だけが弾く逆向きの非対称ができる。
   */
  /**
   * `2026-02-30` は**形は `YYYY-MM-DD` に合うが、実在しない日**である。
   * デーモン側の `usageQuery`（`usageDateSchema`。`packages/core/src/usage.ts`）
   * は正規表現だけで検査していて実在の検査をしていないので、デーモン単体は
   * これを弾かない——だが画面はここを**あえて**デーモンと揃えず、読めない
   * 扱いにする。理由は `usage.tsx` の `isRealCalendarDate` の doc:
   * `type="date"` の `<input>` は実在しない日を渡すと値のサニタイズで
   * 空文字に落ちる（HTML の仕様。jsdom も同じ）ので、そのまま絞り込みへ
   * 通すと「入力欄は空なのに絞り込みが効いている」という、この issue が
   * 塞ごうとしている食い違いが実在しない日でも起きてしまう。
   */
  it('形は合うが実在しない日（2026-02-30）も読めない扱いにする（type="date" の空欄化との食い違いを避けるため、デーモンとは揃えていない）', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?from=2026-02-30']);

    await screen.findByText(/その範囲には記録が無い/);
    expect(
      await screen.findByText(
        /URL の from=2026-02-30 は日付として読めないので、絞り込みに使っていない/,
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText(/^from$/) as HTMLInputElement).value).toBe('');

    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.has('from')).toBe(false);
    });
  });

  it('入力欄で from を選び直すと、URL の読めない値は置き換わり、注記も消える', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    const { router } = renderUsage(['/?from=not-a-date']);

    await screen.findByText(/その範囲には記録が無い/);
    expect(await screen.findByText(/読めないので、絞り込みに使っていない/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^from$/), { target: { value: '2026-08-05' } });

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('from')).toBe('2026-08-05');
    });
    // 注記が消える。
    expect(screen.queryByText(/読めないので、絞り込みに使っていない/)).toBeNull();
    expect((screen.getByLabelText(/^from$/) as HTMLInputElement).value).toBe('2026-08-05');

    await waitFor(() => {
      const call = stub.calls.findLast((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.get('from')).toBe('2026-08-05');
    });
  });

  it('絞り込みを空にすると URL からそのパラメタが消える', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });
    const { router } = renderUsage(['/?managerId=m1&tokenId=tok-1']);
    await screen.findByText(/その範囲には記録が無い/);

    expect(new URLSearchParams(router.state.location.search).get('managerId')).toBe('m1');
    expect(new URLSearchParams(router.state.location.search).get('tokenId')).toBe('tok-1');

    fireEvent.change(screen.getByLabelText(/^manager$/), { target: { value: '' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).has('managerId')).toBe(false);
    });

    fireEvent.change(screen.getByLabelText(/^token/), { target: { value: '' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).has('tokenId')).toBe(false);
    });
  });
});

/**
 * `to` が `from` より前（issue #2155）。
 *
 * デーモンの `usageQuery` は前後を検査せず単に0件になるので、画面が何も
 * 足さなければ「期間の指定が逆」と「その期間に本当に記録が無い」が同じ
 * 「その範囲には記録が無い。」に潰れる。`dateNotices` と同じ置き場・同じ
 * 見た目で1行足す——「記録が無い」自体は削らない（0件は事実として正しい）。
 */
describe('/usage 画面: to が from より前（issue #2155）', () => {
  it('to が from より前なら、絞り込みが逆だと注記する（「記録が無い」は残す）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-09-10&to=2026-09-01']);

    expect(
      await screen.findByText(
        'to（2026-09-01）が from（2026-09-10）より前なので、この範囲には1日も入らない',
      ),
    ).toBeTruthy();
    // 削らない側の判断: 0件であること自体は事実として正しいので残す。
    expect(await screen.findByText(/その範囲には記録が無い/)).toBeTruthy();
  });

  it('to と from が同じ日なら注記を出さない', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-09-10&to=2026-09-10']);

    await screen.findByText(/その範囲には記録が無い/);
    expect(screen.queryByText(/より前なので、この範囲には1日も入らない/)).toBeNull();
  });

  it('to が from より後なら注記を出さない', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-09-01&to=2026-09-10']);

    await screen.findByText(/その範囲には記録が無い/);
    expect(screen.queryByText(/より前なので、この範囲には1日も入らない/)).toBeNull();
  });
});

/**
 * Web 検索の回数（`webSearchRequests`。Issue #1950）。
 *
 * **0 のときは1文字も増やさない**（AGENTS.md 地雷表）。文言は core の
 * `describeWebSearchRequests` が1箇所で持つので、ここで測るのは「合計カードの
 * 内訳に実際に繋がっているか」だけである。
 */
describe('/usage 画面の Web 検索の回数（webSearchRequests）', () => {
  it('合計が 0 のときは Web検索 の文字列を出さない', async () => {
    stubUsage({
      rows: [row(1, { webSearchRequests: 0 })],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByText(/合計/);
    expect(screen.queryByText(/Web検索/)).toBeNull();
  });

  it('合計が 0 より大きいときは回数を出す', async () => {
    stubUsage({
      rows: [row(1, { webSearchRequests: 3 })],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    expect(await screen.findByText(/Web検索/)).toBeTruthy();
  });
});

/**
 * 取れなかった区切りの1行（`describeUnreadableUsage`。Issue #2086）。
 *
 * 文言そのものの試験は core（`describeUnreadableUsage`）が持つ。ここで見るのは
 * 「画面に実際に繋がっているか」と「無ければ1文字も増やさないこと」だけである
 * （`describeWebSearchRequests` と同じ形の歯）。
 */
describe('/usage 画面の取れなかった区切り（unreadable）', () => {
  it('unreadable が無ければ、それらしい行を出さない', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByText(/合計/);
    expect(screen.queryByText(/取れなかった/)).toBeNull();
  });

  it('unreadable が在れば、値を作らず理由の行を出す', async () => {
    stubUsage({
      rows: [row(1, { unreadable: { webSearchRequests: 2 } })],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    expect(await screen.findByText(/取れなかった/)).toBeTruthy();
  });
});

/**
 * 台帳に1行も無い委譲（Issue #98「台帳が取りこぼした委譲」）。
 *
 * 文言そのものの試験は core（`describeUnrecordedManagers`）が持つ。ここで見るのは
 * 「この画面に出ていること」と「合計値の隣であること」と「0件でも省略しないこと」。
 */
describe('/usage 画面の台帳に1行も無い委譲', () => {
  it('1件以上あれば、この画面にも出す', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unrecordedManagers: [
        { managerId: 'mgr-unrecorded', status: 'running', startedAt: '2026-08-25T12:00:00.000Z' },
      ],
    });

    renderUsage();

    expect(await screen.findByText(/台帳に1行も無い委譲/)).toBeTruthy();
    expect(await screen.findByText(/mgr-unrecorded/)).toBeTruthy();
    expect(screen.getByText(/mgr-unrecorded/).textContent).toContain('running');
  });

  /**
   * **0件のときも黙らない。** 空配列は「取りこぼしが無い」であって「調べていない」
   * ではない——カード自体は常に出て、0件と明示する。
   */
  it('0件のときも「0件」と明示する（カードごと消さない）', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unrecordedManagers: [],
    });

    renderUsage();

    const heading = await screen.findByText(/台帳に1行も無い委譲/);
    expect(heading).toBeTruthy();
    expect(await screen.findByText(/0件/)).toBeTruthy();
  });

  it('台帳がまだ空（since が null）でも、取りこぼしがあれば出す', async () => {
    stubUsage({
      rows: [],
      since: null,
      beforeLedger: false,
      unrecordedManagers: [
        { managerId: 'mgr-unrecorded', status: 'lost', startedAt: '2026-08-25T12:00:00.000Z' },
      ],
    });

    renderUsage();

    expect(await screen.findByText(/台帳にはまだ1件も記録が無い/)).toBeTruthy();
    expect(await screen.findByText(/mgr-unrecorded/)).toBeTruthy();
  });

  /**
   * **合計値の隣。** 「合計」カードのすぐ後に「台帳に1行も無い委譲」カードが
   * 続くことを、DOM 上の並びで確かめる。
   */
  it('「合計」カードの直後に置く', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unrecordedManagers: [
        { managerId: 'mgr-unrecorded', status: 'running', startedAt: '2026-08-25T12:00:00.000Z' },
      ],
    });

    renderUsage();

    const totalHeading = await screen.findByRole('heading', { name: '合計' });
    const totalCard = totalHeading.closest('div.rounded-lg');
    if (totalCard === null) throw new Error('合計カードが見つからない');
    const nextCard = totalCard.nextElementSibling;
    expect(nextCard?.textContent).toContain('台帳に1行も無い委譲');
  });
});

/**
 * アカウント全体の残り（claude.ai 側の値）を、**この画面にも出す。**
 *
 * `GET /usage` は最初からこれを返していたのに、人間が読む2面（CLI・この画面）は
 * どちらも捨てていた。読んでいたのはクローンの `usage_read` だけで、クローンに
 * 見えているものが人間に見えない状態だった（north_star 禁止1）。
 *
 * 文言そのものの試験は core（`describeAccountUsage`）が持つ。ここで見るのは
 * 「この画面に出ていること」と「取れなかったものを 0 と描かないこと」。
 */
describe('/usage 画面のアカウント全体の残り', () => {
  it('台帳がまだ空でも出る（台帳が空なことと、枠が分からないことは別）', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false, account: { state: 'unknown' } });

    renderUsage();

    expect(await screen.findByRole('heading', { name: /アカウント全体の残り/ })).toBeTruthy();
    expect(screen.getByText(/まだ取りに行っていない/)).toBeTruthy();
    expect(screen.getByText(/0 ではなく、分からない/)).toBeTruthy();
    /*
     * **画面も Markdown を解釈しない。強調記号を素で出さない。**
     *
     * この確認をここへ置いてあるのは、**この状態の文言だけが `**` を含む**ため
     * である。枠が取れている fixture（下のテスト）には `**` が1つも無いので、
     * そちらへ置くと「落ちない見張り」になる（変異試験で実際に空振りした）。
     */
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('枠と支出上限が出る', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      account: {
        state: 'ok',
        usage: {
          at: '2026-08-14T10:00:00.000Z',
          plan: 'Claude Max',
          limitsAvailable: true,
          windows: [{ kind: 'five_hour', utilization: 42 }],
          extraUsage: {
            enabled: true,
            monthlyLimit: 100,
            usedCredits: 40,
            utilization: 40,
            currency: 'USD',
          },
        },
      },
    });

    renderUsage();

    expect(await screen.findByText(/Claude Max/)).toBeTruthy();
    expect(screen.getByText(/42% 使用/)).toBeTruthy();
    expect(screen.getByText('支出上限: 40 USD / 100 USD（40% 使用）')).toBeTruthy();
  });

  it('取れなかったときに 0% と描かない', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      account: {
        state: 'failed',
        at: '2026-08-14T10:00:00.000Z',
        reason: '2つの口のどちらも答えなかった',
      },
    });

    renderUsage();

    expect(await screen.findByText(/取れなかった/)).toBeTruthy();
    expect(screen.queryByText(/0% 使用/)).toBeNull();
  });

  it('応答に入っていなければ、白い画面にせず「返さないデーモン」と言う', async () => {
    // 画面（Vercel）とデーモンは別々に配れるので、繋ぎ先が古いことは起こりうる。
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      account: null,
    });

    renderUsage();

    expect(await screen.findByText(/返さないデーモンに繋がっている/)).toBeTruthy();
    // 台帳側は変わらず描けている（表示1枚のために画面全体を落とさない）。
    expect(screen.getByRole('heading', { name: '合計' })).toBeTruthy();
  });

  /**
   * **これは「はみ出しが直った」の試験ではない。**
   *
   * jsdom はレイアウトを持たないので（`offsetWidth` / `scrollWidth` /
   * `getBoundingClientRect()` はどれも 0 を返す）、実際に折り返しているかは
   * ここでは測れない。そもそも画面の試験は `root.tsx` を経由しないため、
   * **実行中に Tailwind の CSS ルールは1つも存在しない。**
   *
   * だからここで固定できるのは「その指定が書かれていること」までである。
   * 実機で崩れていないことは、見た人間しか言えない。
   *
   * それでも置くのは、`whitespace-pre` へ戻す変更を黙って通さないためである。
   * 見た目の差は誰も測れないので、戻っても気づく契機が他に無い。
   *
   * **`toContain('whitespace-pre')` では見分けられない**（`whitespace-pre-wrap`
   * にも当たる）。クラス名をトークンに割ってから見る。
   */
  it('行は折り返す指定で描かれる（whitespace-pre のままにしない）', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      account: null,
    });

    renderUsage();

    const line = await screen.findByText(/返さないデーモンに繋がっている/);
    const tokens = line.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    // 折り返さない指定が残っていないこと。
    expect(tokens).not.toContain('whitespace-pre');
    // 空白を持たない値（reason・ISO 文字列）の受け。
    expect(tokens).toContain('break-words');
  });
});
