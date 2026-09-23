// @vitest-environment jsdom
/**
 * やり方一覧（`/practices` 画面、#1055 段3③）。
 *
 * `memory.test.tsx` と同じ骨組み——一覧の1行に種類（kind）・題・slug・
 * 文字数・作成/更新の相対時刻が出ること、0件のときは正常な状態として
 * 案内すること（「まだ設定されていない」という異常には読ませない——
 * `practice_list` のクローンの道具と同じ語彙）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PracticeSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Practices from './practices';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `title` を `slug` と別の文字列にしておく——同じ文字列だと slug 行と
 * title 行の2箇所に同じテキストが出て `getByText` が「複数一致」で落ちる
 * （`memory.test.tsx` の同じ注記のとおり）。
 */
function practice(over: Partial<PracticeSummary> = {}): PracticeSummary {
  return {
    slug: 'daily-report',
    kind: '日報',
    title: '日報の書き方',
    updatedAt: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    createdAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    chars: 42,
    ...over,
  };
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
});

function renderPractices(practices: PracticeSummary[]) {
  stubFetch((url) => (url.includes('/practices') ? json({ practices }) : undefined));
  const router = createMemoryRouter(
    [
      { path: '/', Component: Practices },
      { path: '/practices/:slug', Component: () => null },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('一覧の行', () => {
  it('種類・題・slug・作成/更新の相対時刻が出る', async () => {
    renderPractices([practice()]);

    await screen.findByText('日報の書き方');
    expect(screen.getByText('[日報]')).toBeTruthy();
    expect(screen.getByText('daily-report')).toBeTruthy();
    expect(screen.getByText(/作成 3日前/)).toBeTruthy();
    expect(screen.getByText(/更新 1日前/)).toBeTruthy();
  });

  it('種類はタグとして出るだけで、プルダウンの選択肢としては出ない', async () => {
    // ⛔ north_star「仕事の型を実装専用に狭めていないか」——`practiceKindSchema`
    // を enum にしない決定の画面側の裏返し。`<select>` を1つも置いていないこと
    // を確かめる（固定リストへ倒れていないことの最小限の歯）。
    renderPractices([practice({ kind: '調査' })]);

    await screen.findByText('[調査]');
    expect(document.querySelector('select')).toBeNull();
  });
});

describe('本文の大きさ（#1340）', () => {
  /**
   * `chars` は本文の**文字数**（コードポイント数。`practiceMetaSchema` の
   * doc。fs は `[...content].length`、pg は `char_length(content)`）。CLI と
   * クローンの道具は「N 文字」と刷っているのに、この画面だけが `formatBytes`
   * で「B / KB」と名乗っていた ⟹ 日本語の本文では実サイズの半分以下を
   * 「B」と言っていた。画面の名乗りは #1354 で直り（`formatBytes` を外した）、
   * 欄そのものの改名（`bytes` → `chars`）と保存をやめる変更は #1340 本体で
   * 直した——この歯は画面の名乗りだけを見る。
   */
  it('日本語の本文でも「N 文字」と名乗り、B / KB を名乗らない', async () => {
    // `# レビュー\n\n差分より先に Issue を読む。\n` は 26 文字（UTF-8 では 54 バイト）。
    renderPractices([practice({ title: 'レビューの手順', chars: 26 })]);

    const row = await screen.findByText(/26 文字/);
    expect(row.textContent).not.toMatch(/\d\s*(B|KB|MB)\b/);
  });

  it('1024 を超えても KB へ繰り上げない（文字数は 1024 で割る単位ではない）', async () => {
    renderPractices([practice({ chars: 2048 })]);

    const row = await screen.findByText(/2048 文字/);
    expect(row.textContent).not.toMatch(/KB/);
  });

  it('陽性対照: ASCII の本文でも同じく「N 文字」と名乗る', async () => {
    renderPractices([practice({ chars: 42 })]);

    expect(await screen.findByText(/42 文字/)).toBeTruthy();
  });
});

describe('0件のとき', () => {
  it('「まだ無い」を正常な状態として案内する（異常とは言わない）', async () => {
    renderPractices([]);

    expect(await screen.findByText(/まだ1件も無い/)).toBeTruthy();
    expect(screen.getByText(/正常な状態/)).toBeTruthy();
    // 「未設定」「異常」という、まだ設定されていないかのような語を避ける
    // （`practice_list` の道具の文言と同じ語彙。`tools.ts` を参照）。
    expect(screen.queryByText(/未設定/)).toBeNull();
  });
});

describe('新しいやり方を書く', () => {
  it('妥当な slug を入れると開くボタンが押せる', async () => {
    renderPractices([]);
    await screen.findByText(/まだ1件も無い/);

    const input = screen.getByPlaceholderText(/slug/);
    const button = screen.getByRole('button', { name: '開く' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'new-practice' } });

    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
