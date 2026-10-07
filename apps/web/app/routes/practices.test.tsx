// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PracticeSummary, UnreadablePractice } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Practices from './practices';

const DAY_MS = 24 * 60 * 60 * 1000;

// title を slug と別の文字列にする: 同じ文字列だと2箇所に同じテキストが出て getByText が複数一致で落ちるため
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

function renderPractices(
  practices: PracticeSummary[],
  unreadable?: UnreadablePractice[],
) {
  stubFetch((url) =>
    url.includes('/practices')
      ? json(unreadable === undefined ? { practices } : { practices, unreadable })
      : undefined,
  );
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
    expect(screen.getByText('日報')).toBeTruthy();
    expect(screen.getByText('daily-report')).toBeTruthy();
    expect(screen.getByText(/作成 3日前/)).toBeTruthy();
    expect(screen.getByText(/更新 1日前/)).toBeTruthy();
  });

  it('種類はタグとして出るだけで、プルダウンの選択肢としては出ない', async () => {
    renderPractices([practice({ kind: '調査' })]);

    await screen.findByText('調査');
    expect(document.querySelector('select')).toBeNull();
  });
});

describe('本文の大きさ（#1340）', () => {
  it('日本語の本文でも「N 文字」と名乗り、B / KB を名乗らない', async () => {
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
    expect(screen.queryByText(/未設定/)).toBeNull();
    expect(screen.queryByText(/読めないやり方/)).toBeNull();
  });

  it('読めない行が在るとき、「まだ1件も無い」「正常な状態」と言わず、件数を断る（#2346）', async () => {
    renderPractices([], [{ slug: 'bad-practice', reason: '不正な欄: kind' }]);

    expect(await screen.findByText(/読めないやり方が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/bad-practice/)).toBeTruthy();
    expect(screen.getByText(/不正な欄: kind/)).toBeTruthy();
    expect(screen.getByText(/読めたやり方は無い/)).toBeTruthy();
    expect(screen.queryByText(/まだ1件も無い/)).toBeNull();
    expect(screen.queryByText(/これは正常な状態/)).toBeNull();
  });

  it('読めない行が在っても、読めた行は今までどおり一覧に出る（#2346）', async () => {
    renderPractices([practice()], [{ reason: '不正な行' }]);

    expect(await screen.findByText('日報の書き方')).toBeTruthy();
    expect(screen.getByText(/読めないやり方が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/名前も取れない/)).toBeTruthy();
  });
});

describe('新しいやり方を書く', () => {
  it('妥当な slug を入れると開くボタンが押せる', async () => {
    renderPractices([]);
    await screen.findByText(/まだ1件も無い/);

    const input = screen.getByLabelText(/^名前/);
    const button = screen.getByRole('button', { name: '開く' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'new-practice' } });

    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('slug 欄の補足文', () => {
  it('書式は常時表示の補足文で、欄と aria-describedby で結ばれる（プレースホルダは短い例だけ）', async () => {
    renderPractices([]);
    const input = await screen.findByLabelText(/^名前/);
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/128 文字まで/);
    expect((input as HTMLInputElement).placeholder).not.toMatch(/英小文字/);
  });
});

describe('一覧の行は行全体がリンク', () => {
  it('題・slug・文字数・日時の文字はどれも同じ1本のリンクの内に在る', async () => {
    renderPractices([practice({ slug: 'daily-report', title: '日報の書き方' })]);

    const link = await screen.findByRole('link', { name: /日報の書き方/ });
    expect(link.getAttribute('href')).toBe('/practices/daily-report');
    expect(link.closest('li')?.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByText('daily-report').closest('a')).toBe(link);
    expect(screen.getByText(/作成 3日前/).closest('a')).toBe(link);
    expect(screen.getByText('日報の書き方').closest('a')).toBe(link);
  });
});

describe('利用者に内部の語を見せない（#2782 / #2787）', () => {
  it('名前の入力欄にラベルが在り、入力後も残る（プレースホルダだけに頼らない）', async () => {
    renderPractices([]);
    await screen.findByText(/まだ1件も無い/);

    const input = screen.getByLabelText(/^名前/);
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(screen.getByLabelText(/^名前/)).toBe(input);
    expect(screen.queryByLabelText(/slug/)).toBeNull();
  });

  it('procedure / routine は「手順」「定例」と出し、括弧つきの内部の語や Issue 番号を出さない', async () => {
    renderPractices([
      practice({ slug: 'a', kind: 'procedure', title: 'A のやり方' }),
      practice({ slug: 'b', kind: 'routine', title: 'B のやり方' }),
    ]);

    await screen.findByText('A のやり方');
    expect(screen.getByText('手順')).toBeTruthy();
    expect(screen.getByText('定例')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('[procedure]');
    expect(text).not.toContain('[routine]');
    expect(text).not.toMatch(/#\d{3,}/);
  });
});
