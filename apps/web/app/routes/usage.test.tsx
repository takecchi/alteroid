// @vitest-environment jsdom
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
  beforeTokens?: boolean;
  notice?: string;
  /** 既定は `unknown`。`null` を渡すと応答から `account` を落とす。 */
  account?: unknown;
  unrecordedManagers?: unknown[];
  unreadableRows?: unknown[];
  unmeteredRows?: unknown[];
  turnRows?: unknown[];
  managers?: { managerId: string; request: string; startedAt: string }[];
  tokens?: { id: string; label: string }[];
}) {
  // `account` を `...body` に混ぜると、「応答に無い」を作るための `null` が応答へ残ってしまう。
  const { account, managers, tokens, ...rest } = body;
  return stubFetch((url) => {
    if (url.includes('/managers')) return json({ managers: managers ?? [] });
    if (url.includes('/tokens')) return json({ tokens: tokens ?? [] });
    return url.includes('/usage')
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
      : undefined;
  });
}

// 画面全体から探さない。絞り込みの `<option>` にも `clone` / `session` があり、カードが消えても通ってしまう。
function axisCard(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const card = heading.closest('[data-slot="card"]');
  if (card === null) throw new Error(`${title} のカードが見つからない`);
  return card as HTMLElement;
}

describe('/usage 画面', () => {
  it('台帳がまだ空（since が null）なら、金額を1つも出さず「まだ記録が無い」と言う', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    expect(await screen.findByText(/まだ使用量の記録がありません/)).toBeTruthy();
    expect(renderedMoneyTexts()).toEqual(new Set());
  });

  it('beforeLedger が真なら、0 ではなく記録が無い範囲だと明示する', async () => {
    stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: true,
    });

    renderUsage();

    expect(await screen.findByText(/この期間の使用量の記録はありません/)).toBeTruthy();
    expect(await screen.findByText(/記録が始まる前の期間にかかっています/)).toBeTruthy();
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

    expect((await screen.findAllByText('$0.0123')).length).toBeGreaterThan(0);
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
      managers: [
        { managerId: 'm1', request: '一つ目の依頼', startedAt: '2026-08-13T01:00:00.000Z' },
        { managerId: 'm2', request: '二つ目の依頼', startedAt: '2026-08-14T01:00:00.000Z' },
      ],
    });

    renderUsage();

    // 軸のカードにも同じ $3.00 が出るので、合計のカードの中で探す。
    await screen.findByRole('heading', { name: '合計' });
    const total = axisCard('合計');
    expect(within(total).getByText('$3.00')).toBeTruthy();
    expect(screen.getByText('日別')).toBeTruthy();
    expect(screen.getByText('マネージャー別')).toBeTruthy();
    expect(screen.getByText('モデル別')).toBeTruthy();
    const managers = axisCard('マネージャー別');
    expect(within(managers).getByText(/^一つ目の依頼（/)).toBeTruthy();
    expect(within(managers).getByText(/^二つ目の依頼（/)).toBeTruthy();
    expect(within(managers).queryByText('m1')).toBeNull();
  });

  it('軸別カードは上位 20 件で切り、「すべて表示する」でそのカードだけ全件を出す', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(100 - i, { model: `m-${String(i + 1).padStart(2, '0')}` }),
    );
    stubUsage({ rows, since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage();

    await screen.findByRole('heading', { name: 'モデル別' });
    const card = axisCard('モデル別');
    expect(within(card).getByText('m-20')).toBeTruthy();
    expect(within(card).queryByText('m-21')).toBeNull();
    expect(within(card).getByText('…残り 5 件は出していない')).toBeTruthy();
    expect(within(axisCard('日別')).queryByRole('button')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'すべて表示する' }));
    expect(within(card).getByText('m-25')).toBeTruthy();
    expect(within(card).queryByText(/件は出していない/)).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: '上位 20 件に戻す' }));
    expect(within(card).queryByText('m-21')).toBeNull();
    expect(within(card).getByText('…残り 5 件は出していない')).toBeTruthy();
  });

  it('日別は 21 日以上あっても、金額ではなく最近の 20 日を新しい順に出す', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(100 - i, { date: `2026-08-${String(i + 1).padStart(2, '0')}` }),
    );
    stubUsage({ rows, since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage();

    await screen.findByRole('heading', { name: '日別' });
    const card = axisCard('日別');
    const shown = within(card)
      .getAllByText(/^2026-08-\d\d$/)
      .map((el) => el.textContent);
    expect(shown).toEqual(
      Array.from({ length: 20 }, (_, i) => `2026-08-${String(25 - i).padStart(2, '0')}`),
    );
    expect(within(card).getByText('…残り 5 件は出していない')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'すべて表示する' }));
    expect(within(card).getByText('2026-08-01')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '最近の 20 日に戻す' }));
    expect(within(card).queryByText('2026-08-01')).toBeNull();
  });

  it('層別（誰が）と場所別（どこで）の内訳も出す', async () => {
    stubUsage({
      rows: [
        row(1, { managerId: 'm1', model: 'opus', layer: 'manager', site: 'session' }),
        row(2, { managerId: 'clone', model: 'opus', layer: 'clone', site: 'distill' }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByRole('heading', { name: '誰が使ったか' });
    const layers = axisCard('誰が使ったか');
    expect(within(layers).getByText('クローン')).toBeTruthy();
    expect(within(layers).getByText('マネージャー（作業者の分を含む）')).toBeTruthy();
    expect(within(layers).getByText('$2.00')).toBeTruthy();
    expect(within(layers).getByText('$1.00')).toBeTruthy();
    const sites = axisCard('どこで使ったか');
    expect(within(sites).getByText('会話そのもの')).toBeTruthy();
    expect(within(sites).getByText('記憶への書き出し（要約の直前）')).toBeTruthy();
    const models = axisCard('モデル別');
    expect(within(models).getByText('opus')).toBeTruthy();
    expect(within(models).getByText('$3.00')).toBeTruthy();
  });

  it('peer の行は場所別で session と別に出る。知らない site（版ずれ）の行も捨てずに出す', async () => {
    stubUsage({
      rows: [
        row(1, { managerId: 'm1', model: 'opus', layer: 'manager', site: 'session' }),
        row(2, { managerId: 'm1', model: 'opus', layer: 'manager', site: 'peer' }),
        row(4, { managerId: 'm1', model: 'opus', layer: 'manager', site: 'future-site' }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage();

    await screen.findByRole('heading', { name: 'どこで使ったか' });
    const sites = axisCard('どこで使ったか');
    expect(within(sites).getByText('会話そのもの')).toBeTruthy();
    expect(within(sites).getByText('もう一方の AI への相談')).toBeTruthy();
    expect(within(sites).getByText('future-site')).toBeTruthy();
    expect(within(sites).getByText('$4.00')).toBeTruthy();
    expect(within(sites).getByText('$2.00')).toBeTruthy();
    expect(within(sites).getByText('$1.00')).toBeTruthy();
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

    expect(await screen.findByText(/実際に観測した値ではありません/)).toBeTruthy();
    expect(screen.getByText(/記録し始める前（.*08.*19.*）/)).toBeTruthy();
    expect(screen.queryByText(/2026-08-19T00:00:00\.000Z/)).toBeNull();
  });

  // jsdom はレイアウトを持たないので、実際に切れて hover で読めることは確かめられない。`title` の中身までを見る。
  it('entry.label が truncate で切られていても title で全文が引ける', async () => {
    const longManagerId = 'mgr-with-a-very-long-identifier-that-narrow-screens-will-cut-off';
    stubUsage({
      rows: [row(1, { managerId: longManagerId })],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      managers: [
        {
          managerId: longManagerId,
          request: '長い依頼文'.repeat(10),
          startedAt: '2026-08-14T01:00:00.000Z',
        },
      ],
    });

    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    const label = `${'長い依頼文'.repeat(10).slice(0, 28)}…（`;
    expect(within(managers).getByTitle(new RegExp(`^${label}`))).toBeTruthy();
    expect(within(managers).queryByText(longManagerId)).toBeNull();
  });

  it('マネージャー別は、mgr- で始まらない委譲の id もリンクにし、clone の行はしない', async () => {
    stubUsage({
      rows: [
        row(2, { managerId: 'job-7f3a' }),
        row(1, { managerId: 'clone', layer: 'clone', site: 'distill' }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      managers: [
        { managerId: 'job-7f3a', request: '記事の下書き', startedAt: '2026-08-14T01:00:00.000Z' },
      ],
    });

    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    const link = within(managers).getByRole('link', { name: /^記事の下書き（/ });
    expect(link.getAttribute('href')).toBe('/managers/job-7f3a');
    expect(within(managers).queryByRole('link', { name: 'クローン' })).toBeNull();
    expect(within(managers).getAllByRole('link')).toHaveLength(1);
  });

  it('マネージャー別の mgr- の行は /managers/<id> への Link になり、clone の行はならない', async () => {
    stubUsage({
      rows: [
        row(2, { managerId: 'mgr-42' }),
        row(1, { managerId: 'clone', layer: 'clone', site: 'distill' }),
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      managers: [
        { managerId: 'mgr-42', request: '週次の調査', startedAt: '2026-08-14T01:00:00.000Z' },
      ],
    });

    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    const link = within(managers).getByRole('link', { name: /^週次の調査（/ });
    expect(link.getAttribute('href')).toBe('/managers/mgr-42');
    expect(within(managers).getByTitle(/^週次の調査（/)).toBeTruthy();

    expect(within(managers).getByTitle('クローン').textContent).toBe('クローン');
    expect(within(managers).queryByRole('link', { name: 'クローン' })).toBeNull();
    expect(within(managers).getAllByRole('link')).toHaveLength(1);
  });

  it('認証トークン別の tokenId のある行は /tokens?tokenId=<id> への Link になり、帰属の無い行はならない', async () => {
    stubUsage({
      rows: [row(2, { tokenId: 'tok-42' }), row(1, {})],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      tokens: [{ id: 'tok-42', label: '個人の鍵' }],
    });

    renderUsage();

    await screen.findByRole('heading', { name: '認証トークン別' });
    const tokens = axisCard('認証トークン別');
    const link = within(tokens).getByRole('link', { name: '個人の鍵' });
    expect(link.getAttribute('href')).toBe('/tokens?tokenId=tok-42');
    expect(within(tokens).getByTitle('個人の鍵')).toBeTruthy();

    const noAttribution = '（認証トークンの分からない分）';
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

    await screen.findByText(/この期間の使用量の記録はありません/);
    const layerSelect = screen.getByLabelText('誰が');
    layerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(within(layerSelect).getByText('クローン')).toBeTruthy();
    expect(within(layerSelect).getByText('マネージャー（作業者の分を含む）')).toBeTruthy();
    const siteSelect = screen.getByLabelText('どこで');
    expect(within(siteSelect).getByText('会話そのもの')).toBeTruthy();
    expect(within(siteSelect).getByText('記憶への書き出し（要約の直前）')).toBeTruthy();
  });

  // クラスが当たっていることまでを見る。jsdom はレイアウトを持たないので、実機で枠に収まることは確かめられない（視覚回帰試験ではない）。
  it('絞り込みの容器は sm 未満でも grid-cols-1 を持つ（暗黙トラックを auto にしない）', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    const fromInput = await screen.findByLabelText('開始日');
    const grid = fromInput.parentElement?.parentElement;
    if (grid === null || grid === undefined) throw new Error('絞り込みの容器が見つからない');
    const tokens = grid.className.split(/\s+/);
    expect(tokens).toContain('grid-cols-1');
    expect(tokens).toContain('sm:grid-cols-3');
  });

  it('type="date" の from/to 入力は min-w-0 を持つ（内在幅の大きい要素だけの追加の押さえ）', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    // ラベルは前後を固定して当てる（部分一致だと、似た名前のラベルが増えたときに複数件へ当たる）。
    const fromInput = await screen.findByLabelText('開始日');
    const toInput = screen.getByLabelText('終了日');
    for (const input of [fromInput, toInput]) {
      const tokens = input.className.split(/\s+/);
      expect(tokens).toContain('min-w-0');
    }
  });
});

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

    await screen.findByText(/この期間の使用量の記録はありません/);

    expect((screen.getByLabelText('開始日') as HTMLInputElement).value).toBe('2026-08-01');
    expect((screen.getByLabelText('終了日') as HTMLInputElement).value).toBe('2026-08-20');
    expect((screen.getByLabelText('マネージャー') as HTMLInputElement).value).toBe('m1');
    expect((screen.getByLabelText('誰が') as HTMLSelectElement).value).toBe('clone');
    expect((screen.getByLabelText('どこで') as HTMLSelectElement).value).toBe('distill');
    expect((screen.getByLabelText('認証トークン') as HTMLInputElement).value).toBe('tok-1');
    expect(screen.queryByText(/読めないので、絞り込みに使っていません/)).toBeNull();
    expect(screen.queryByText(/に指定された値/)).toBeNull();

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
    stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      managers: [{ managerId: 'mgr-9', request: '調査', startedAt: '2026-08-14T01:00:00.000Z' }],
      tokens: [{ id: 'tok-2', label: '予備の鍵' }],
    });
    const { router } = renderUsage();
    await screen.findByText(/この期間の使用量の記録はありません/);

    fireEvent.change(screen.getByLabelText('開始日'), { target: { value: '2026-08-01' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('from')).toBe('2026-08-01');
    });

    fireEvent.change(screen.getByLabelText('終了日'), { target: { value: '2026-08-20' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('to')).toBe('2026-08-20');
    });

    await screen.findByRole('option', { name: /^調査（/ });
    await screen.findByRole('option', { name: '予備の鍵' });
    fireEvent.change(screen.getByLabelText('マネージャー'), { target: { value: 'mgr-9' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('managerId')).toBe('mgr-9');
    });

    fireEvent.change(screen.getByLabelText('誰が'), { target: { value: 'manager' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('layer')).toBe('manager');
    });

    fireEvent.change(screen.getByLabelText('どこで'), { target: { value: 'session' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('site')).toBe('session');
    });

    fireEvent.change(screen.getByLabelText('認証トークン'), { target: { value: 'tok-2' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('tokenId')).toBe('tok-2');
    });

    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('URL に知らない layer / site が書かれていても落ちず、「すべて」で出し、絞り込みに使っていないと注記する（#3872）', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?layer=no-such-layer&site=no-such-site']);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect((screen.getByLabelText('誰が') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('どこで') as HTMLSelectElement).value).toBe('');
    expect(
      screen.getByText(
        '「誰が」に指定された値（no-such-layer）は選べないので、絞り込みに使っていません',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        '「どこで」に指定された値（no-such-site）は選べないので、絞り込みに使っていません',
      ),
    ).toBeTruthy();

    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.has('layer')).toBe(false);
      expect(params.has('site')).toBe(false);
    });
  });

  it('知らない layer だけのとき、layer の注記だけが出る。長い値は切る（#3872）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage([`/?layer=${'x'.repeat(50)}&site=session`]);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(
      screen.getByText(
        `「誰が」に指定された値（${'x'.repeat(40)}…）は選べないので、絞り込みに使っていません`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/「どこで」に指定された値/)).toBeNull();
    expect((screen.getByLabelText('どこで') as HTMLSelectElement).value).toBe('session');
  });

  it('同じパラメタが重複しているとき、先頭の値を使いつつ、そのパラメタの注記を出す（#4000）', async () => {
    const stub = stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-08-01&from=2026-08-05&layer=clone&site=session&site=chat']);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(screen.getByText('開始日の指定が複数あるので、先頭の値を使っています')).toBeTruthy();
    expect(screen.getByText('「どこで」の指定が複数あるので、先頭の値を使っています')).toBeTruthy();
    expect(screen.queryByText(/「誰が」の指定が複数/)).toBeNull();
    expect(screen.queryByText(/終了日の指定が複数/)).toBeNull();
    expect((screen.getByLabelText('開始日') as HTMLInputElement).value).toBe('2026-08-01');
    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      expect(new URL(call as string).searchParams.get('from')).toBe('2026-08-01');
    });
  });

  it('対照: 重複していなければ、重複の注記は出ない（#4000）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-08-01&to=2026-08-05&layer=clone']);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(screen.queryByText(/の指定が複数あるので/)).toBeNull();
  });

  it('layer / site が空文字・無し・既知の値のときは、注記を出さない（#3872）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?layer=&site=']);
    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(screen.queryByText(/に指定された値/)).toBeNull();
  });

  it('知らない layer のあとに選び直すと、URL が置き換わり注記が消える（#3872）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    const { router } = renderUsage(['/?layer=no-such-layer']);
    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(screen.getByText(/「誰が」に指定された値/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('誰が'), { target: { value: 'manager' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('layer')).toBe('manager');
    });
    expect(screen.queryByText(/に指定された値/)).toBeNull();
  });

  it('URL の from が YYYY-MM-DD として読めないとき、GET /usage に渡さず、読めないと画面に出す', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?from=not-a-date']);

    await screen.findByText(/この期間の使用量の記録はありません/);

    expect(
      await screen.findByText(
        /開始日に指定された値（not-a-date）は日付として読めないので、絞り込みに使っていません/,
      ),
    ).toBeTruthy();

    expect((screen.getByLabelText('開始日') as HTMLInputElement).value).toBe('');

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

    await screen.findByText(/この期間の使用量の記録はありません/);

    expect(
      await screen.findByText(
        /終了日に指定された値（2026-02-30-ish）は日付として読めないので、絞り込みに使っていません/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/開始日に指定された値.*は日付として読めない/)).toBeNull();
    expect((screen.getByLabelText('開始日') as HTMLInputElement).value).toBe('2026-08-01');
    expect((screen.getByLabelText('終了日') as HTMLInputElement).value).toBe('');

    await waitFor(() => {
      const call = stub.calls.find((url) => url.includes('/usage'));
      expect(call).toBeDefined();
      const params = new URL(call as string).searchParams;
      expect(params.get('from')).toBe('2026-08-01');
      expect(params.has('to')).toBe(false);
    });
  });

  it('形は合うが実在しない日（2026-02-30）も読めない扱いにする（type="date" の空欄化との食い違いを避けるため。デーモンの GET /usage も同じ判定で揃っている — issue #2156）', async () => {
    const stub = stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    renderUsage(['/?from=2026-02-30']);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(
      await screen.findByText(
        /開始日に指定された値（2026-02-30）は日付として読めないので、絞り込みに使っていません/,
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText('開始日') as HTMLInputElement).value).toBe('');

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

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(await screen.findByText(/読めないので、絞り込みに使っていません/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('開始日'), { target: { value: '2026-08-05' } });

    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('from')).toBe('2026-08-05');
    });
    expect(screen.queryByText(/読めないので、絞り込みに使っていません/)).toBeNull();
    expect((screen.getByLabelText('開始日') as HTMLInputElement).value).toBe('2026-08-05');

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
    await screen.findByText(/この期間の使用量の記録はありません/);

    expect(new URLSearchParams(router.state.location.search).get('managerId')).toBe('m1');
    expect(new URLSearchParams(router.state.location.search).get('tokenId')).toBe('tok-1');

    fireEvent.change(screen.getByLabelText('マネージャー'), { target: { value: '' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).has('managerId')).toBe(false);
    });

    fireEvent.change(screen.getByLabelText('認証トークン'), { target: { value: '' } });
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).has('tokenId')).toBe(false);
    });
  });
});

describe('/usage 画面の絞り込み欄（issue #2795）', () => {
  it('欄の名前が日本語で、ラベルが入力欄に結びついている（for/id）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });
    renderUsage();
    await screen.findByText(/この期間の使用量の記録はありません/);

    for (const name of ['開始日', '終了日', 'マネージャー', '誰が', 'どこで', '認証トークン']) {
      const field = screen.getByLabelText(name);
      const label = document.querySelector(`label[for="${field.id}"]`);
      expect(field.id).not.toBe('');
      expect(label?.textContent).toBe(name);
    }
    expect(screen.queryByPlaceholderText('manager id')).toBeNull();
    expect(screen.queryByPlaceholderText('token id')).toBeNull();
  });

  it('URL の id が一覧に無くても、選択を「すべて」に見せず保つ', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });
    renderUsage(['/?managerId=gone-1&tokenId=gone-2']);
    await screen.findByText(/この期間の使用量の記録はありません/);

    const manager = screen.getByLabelText('マネージャー') as HTMLSelectElement;
    expect(manager.value).toBe('gone-1');
    expect(within(manager).getByText('（一覧に無い委譲）')).toBeTruthy();
    expect((screen.getByLabelText('認証トークン') as HTMLSelectElement).value).toBe('gone-2');
  });
});

describe('/usage 画面: to が from より前（issue #2155）', () => {
  it('to が from より前なら、絞り込みが逆だと注記する（「記録が無い」は残す）', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-09-10&to=2026-09-01']);

    expect(
      await screen.findByText(
        'to（2026-09-01）が from（2026-09-10）より前なので、この範囲には1日も入らない',
      ),
    ).toBeTruthy();
    expect(await screen.findByText(/この期間の使用量の記録はありません/)).toBeTruthy();
  });

  it('to と from が同じ日なら注記を出さない', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-09-10&to=2026-09-10']);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(screen.queryByText(/より前なので、この範囲には1日も入らない/)).toBeNull();
  });

  it('to が from より後なら注記を出さない', async () => {
    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });

    renderUsage(['/?from=2026-09-01&to=2026-09-10']);

    await screen.findByText(/この期間の使用量の記録はありません/);
    expect(screen.queryByText(/より前なので、この範囲には1日も入らない/)).toBeNull();
  });
});

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

describe('/usage 画面の読めずに外した行（unreadableRows）', () => {
  const UNREADABLE = [
    { table: 'usage_daily', date: '2026-08-13', fields: ['layer'] },
    { table: 'usage_turns', date: '2026-08-13', fields: ['layer'] },
  ];

  it('在れば、合計の上で「合計に入っていない」と言う（role=status）', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unreadableRows: UNREADABLE,
    });

    renderUsage();

    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('読めない使用量の行が 2 行あり、合計に入っていない');
    expect(note.textContent).toContain('日付: 2026-08-13');
  });

  it('台帳の始点が無い（since が null）画面でも言う', async () => {
    stubUsage({
      rows: [],
      since: null,
      beforeLedger: false,
      unreadableRows: UNREADABLE,
    });

    renderUsage();

    expect(await screen.findByText(/合計に入っていない/)).toBeTruthy();
  });

  it('#3614: since が null でも外した行が在れば、「記録がありません」と言い切らない', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false, unreadableRows: UNREADABLE });

    renderUsage();

    expect(await screen.findByText(/読めた使用量の記録はありません/)).toBeTruthy();
    expect(screen.queryByText(/まだ使用量の記録がありません/)).toBeNull();
  });

  it('#3614: 期間内が空でも外した行が在れば、「記録はありません」と言い切らない', async () => {
    stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unreadableRows: UNREADABLE,
    });

    renderUsage();

    expect(await screen.findByText(/この期間に読めた使用量の記録はありません/)).toBeTruthy();
    expect(screen.queryByText(/この期間の使用量の記録はありません/)).toBeNull();
  });

  it('#3614: 外した行が無ければ、空の文言は変わらない', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false, unreadableRows: [] });
    const { unmount } = renderUsage();
    expect(await screen.findByText(/まだ使用量の記録がありません/)).toBeTruthy();
    expect(screen.queryByText(/読めずに外した行があります/)).toBeNull();
    unmount();

    stubUsage({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });
    renderUsage();
    expect(await screen.findByText(/この期間の使用量の記録はありません/)).toBeTruthy();
    expect(screen.queryByText(/読めずに外した行があります/)).toBeNull();
  });

  it('対照: 欄が無い・空配列なら、何も出さない', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    const { unmount } = renderUsage();
    await screen.findByText(/合計/);
    expect(screen.queryByText(/読めない使用量/)).toBeNull();
    unmount();

    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unreadableRows: [],
    });
    renderUsage();
    await screen.findByText(/合計/);
    expect(screen.queryByText(/読めない使用量/)).toBeNull();
  });
});

describe('/usage 画面の無報告の provider（unmeteredRows）', () => {
  const UNMETERED = [
    {
      date: '2026-08-14',
      managerId: 'clone',
      layer: 'clone',
      site: 'session',
      provider: 'codex',
      turns: 3,
      updatedAt: '2026-08-14T10:00:00.000Z',
    },
  ];

  it('在れば、合計の上で「0 ではなく取れなかった」と言う（role=status）', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unmeteredRows: UNMETERED,
    });

    renderUsage();

    const note = await screen.findByRole('status');
    expect(note.textContent).toContain(
      '消費を報告しない provider のターンがある（0 ではなく取れなかった。合計に含まれない: codex・clone層 3ターン）',
    );
  });

  it('台帳の始点が無い（since が null）画面でも言う', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false, unmeteredRows: UNMETERED });

    renderUsage();

    expect(await screen.findByText(/合計に含まれない: codex・clone層 3ターン/)).toBeTruthy();
  });

  it('対照: 欄が無い・空配列なら、何も描かない（status も文言も無い）', async () => {
    stubUsage({ rows: [row(1)], since: '2026-08-01T00:00:00.000Z', beforeLedger: false });
    const { unmount } = renderUsage();
    await screen.findByText(/合計/);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/報告しない provider/)).toBeNull();
    unmount();

    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unmeteredRows: [],
    });
    renderUsage();
    await screen.findByText(/合計/);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/報告しない provider/)).toBeNull();
  });
});

describe('/usage 画面の記録の無い委譲', () => {
  it('1件以上あれば、この画面にも出す', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unrecordedManagers: [
        { managerId: 'mgr-unrecorded', status: 'running', startedAt: '2026-08-25T12:00:00.000Z' },
      ],
      managers: [
        {
          managerId: 'mgr-unrecorded',
          request: '未記録の依頼',
          startedAt: '2026-08-25T12:00:00.000Z',
        },
      ],
    });

    renderUsage();

    expect(await screen.findByText(/記録の無い委譲/)).toBeTruthy();
    const link = await screen.findByRole('link', { name: /^未記録の依頼（/ });
    expect(link.getAttribute('href')).toBe('/managers/mgr-unrecorded');
    expect(screen.queryByText(/mgr-unrecorded/)).toBeNull();
    expect(screen.queryByText(/running/)).toBeNull();
  });

  it('0件のときも「0件」と明示する（カードごと消さない）', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      unrecordedManagers: [],
    });

    renderUsage();

    const heading = await screen.findByText(/記録の無い委譲/);
    expect(heading).toBeTruthy();
    expect(await screen.findByText(/記録が1件も無い委譲は、ありません/)).toBeTruthy();
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

    expect(await screen.findByText(/まだ使用量の記録がありません/)).toBeTruthy();
    expect(await screen.findByText(/（一覧に無い委譲）/)).toBeTruthy();
  });

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
    const totalCard = totalHeading.closest('[data-slot="card"]');
    if (totalCard === null) throw new Error('合計カードが見つからない');
    const nextCard = totalCard.nextElementSibling;
    expect(nextCard?.textContent).toContain('記録の無い委譲');
  });
});

describe('/usage 画面のアカウント全体の残り', () => {
  it('台帳がまだ空でも出る（台帳が空なことと、枠が分からないことは別）', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false, account: { state: 'unknown' } });

    renderUsage();

    expect(await screen.findByRole('heading', { name: /アカウント全体の残り/ })).toBeTruthy();
    expect(screen.getByText(/まだ取りに行っていない/)).toBeTruthy();
    expect(screen.getByText(/0 ではなく、分からない/)).toBeTruthy();
    // この確認はここに置く。`**` を含むのはこの状態の文言だけで、他の fixture に置くと落ちない見張りになる。
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

    expect(await screen.findByText(/取得できませんでした/)).toBeTruthy();
    expect(screen.queryByText(/0% 使用/)).toBeNull();
  });

  it('ログインしていないときは、次にすることを利用者の言葉で言い、診断の行は折りたたみへ寄せる', async () => {
    stubUsage({
      rows: [],
      since: null,
      beforeLedger: false,
      account: {
        state: 'unavailable',
        at: '2026-08-14T10:00:00.000Z',
        reason: 'claude.ai にログインしていない（鍵が届けば取れる）',
        cause: 'not_logged_in',
        accountKeys: ['apiProvider', 'tokenSource'],
      },
    });

    renderUsage();

    expect(await screen.findByText(/Claude にログインすると、残りが見えます/)).toBeTruthy();
    const details = screen.getByText('詳しい情報（開発者向け）').closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    const raw = screen.getByText(/apiKeySource/);
    expect(details?.contains(raw)).toBe(true);
    expect(screen.queryByText(/2026-08-14T10:00:00\.000Z/)).toBeNull();
  });

  it('記録が1件も無いとき、橙の注意を並べず、読み方は折りたたみへ寄せる', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    renderUsage();

    expect(
      await screen.findByText(/まだ使用量の記録がありません。会話を始めると、ここに出ます/),
    ).toBeTruthy();
    const guide = screen.getByText('記録の読み方').closest('details');
    expect(guide?.open).toBe(false);
    expect(document.querySelectorAll('.text-warn').length).toBe(0);
  });

  it('範囲に記録が無いとき、始点の注記3本は橙で並べず「記録の読み方」の中へ入る', async () => {
    stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      layersSince: null,
      beforeLedger: true,
      beforeLayers: true,
      beforeTokens: true,
    });

    renderUsage();

    await screen.findByText(/この期間の使用量の記録はありません/);
    const guide = screen.getByText('記録の読み方').closest('details');
    expect(guide?.open).toBe(false);
    expect(guide?.querySelectorAll('li').length).toBe(3);
    expect(document.querySelectorAll('.text-warn').length).toBe(0);
  });

  it('応答に入っていなければ、白い画面にせず「返さないデーモン」と言う', async () => {
    stubUsage({
      rows: [row(1)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      account: null,
    });

    renderUsage();

    expect(await screen.findByText(/返さないデーモンに繋がっている/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '合計' })).toBeTruthy();
  });

  // はみ出しが直ったことの試験ではない（jsdom にレイアウトも CSS も無い）。`whitespace-pre` へ戻す変更を通さないための指定の確認。
  // `toContain('whitespace-pre')` は `whitespace-pre-wrap` にも当たるので、トークンに割ってから見る。
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
    expect(tokens).not.toContain('whitespace-pre');
    expect(tokens).toContain('break-words');
  });
});
