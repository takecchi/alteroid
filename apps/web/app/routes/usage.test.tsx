// @vitest-environment jsdom
/**
 * 「黙って嘘をつかない」を画面側で固定する。
 *
 * `beforeLedger` が真のときに 0 と出す・`since` が null なのに $0.00 と出す・
 * 但し書きを省く、のどれも数字を出す機能そのものの信用を失わせる
 * （`apps/cli/src/usage.ts` と同じ規約）。
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

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

function row(
  costUsd: number,
  over: Partial<{
    date: string;
    managerId: string;
    model: string;
    layer: string;
    site: string;
  }> = {},
) {
  return {
    date: '2026-08-14',
    managerId: 'm1',
    model: 'claude-opus-4',
    layer: 'manager',
    site: 'session',
    updatedAt: '2026-08-14T10:00:00.000Z',
    ...over,
    totals: { ...ZERO_USAGE, costUsd },
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
  it('台帳がまだ空（since が null）なら、$0.00 ではなく「まだ記録が無い」と言う', async () => {
    stubUsage({ rows: [], since: null, beforeLedger: false });

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    expect(await screen.findByText(/台帳にはまだ1件も記録が無い/)).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('beforeLedger が真なら、0 ではなく記録が無い範囲だと明示する', async () => {
    stubUsage({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: true,
    });

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    expect(await screen.findByText(/その範囲には記録が無い/)).toBeTruthy();
    expect(await screen.findByText(/照会した範囲は台帳の始点より前にかかっている/)).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    // 「合計」の見出し自体は出るが、金額は出ない（記録が無いと言うだけ）。
    expect(screen.queryByText(/^\$/)).toBeNull();
  });

  it('但し書き（推定値であり請求明細ではない）を必ず出す', async () => {
    stubUsage({
      rows: [row(1.2)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    expect(await screen.findByText(USAGE_ESTIMATE_NOTICE)).toBeTruthy();
  });

  it('$1 未満の金額を $0.00 に丸めない（formatUsd をそのまま使う）', async () => {
    stubUsage({
      rows: [row(0.0123)],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    // 合計・日別・マネージャー別・モデル別のすべてに同じ金額がそのまま出る
    // （行が1件しかないので全軸で一致する）。
    expect((await screen.findAllByText('$0.0123')).length).toBeGreaterThan(0);
    expect(screen.queryByText('$0.00')).toBeNull();
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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    expect(await screen.findByText('$3.00')).toBeTruthy();
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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    expect(within(managers).getByTitle(longManagerId)).toBeTruthy();
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
      });
    });

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    const fromInput = await screen.findByLabelText(/from/);
    const toInput = screen.getByLabelText(/to/);
    for (const input of [fromInput, toInput]) {
      const tokens = input.className.split(/\s+/);
      expect(tokens).toContain('min-w-0');
    }
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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

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

    render(
      <Providers>
        <Usage />
      </Providers>,
    );

    const line = await screen.findByText(/返さないデーモンに繋がっている/);
    const tokens = line.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    // 折り返さない指定が残っていないこと。
    expect(tokens).not.toContain('whitespace-pre');
    // 空白を持たない値（reason・ISO 文字列）の受け。
    expect(tokens).toContain('break-words');
  });
});
