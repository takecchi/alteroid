// @vitest-environment jsdom
/**
 * 「黙って嘘をつかない」を画面側で固定する。
 *
 * `beforeLedger` が真のときに 0 と出す・`since` が null なのに $0.00 と出す・
 * 但し書きを省く、のどれも数字を出す機能そのものの信用を失わせる
 * （`apps/cli/src/usage.ts` と同じ規約）。
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen } from '@testing-library/react';
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
  over: Partial<{ date: string; managerId: string; model: string }> = {},
) {
  return {
    date: '2026-08-14',
    managerId: 'm1',
    model: 'claude-opus-4',
    updatedAt: '2026-08-14T10:00:00.000Z',
    ...over,
    totals: { ...ZERO_USAGE, costUsd },
  };
}

function stubUsage(body: {
  rows: unknown[];
  since: string | null;
  beforeLedger: boolean;
  notice?: string;
}) {
  return stubFetch((url) =>
    url.includes('/usage')
      ? json({ ...body, notice: body.notice ?? USAGE_ESTIMATE_NOTICE, breakdown: null })
      : undefined,
  );
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
        row(2, { managerId: 'm2', model: 'sonnet', date: '2026-08-14' }),
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
});
