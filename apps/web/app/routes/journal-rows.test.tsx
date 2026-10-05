// @vitest-environment jsdom
/**
 * 日誌の**1行**の DOM（時刻の出し方・開閉・開いたときに出るもの・Tab の停止点）。
 *
 * `journal.test.tsx` のファイル冒頭のとおり、`virtua` は jsdom では行を1つも描かない
 * ので、行の DOM はその画面のテストからは見えない。ここでは `virtua` の `Virtualizer`
 * だけを「子をそのまま並べる箱」に差し替えて、行を描かせる（行の高さの測り方は
 * jsdom では測れないので、ここでは見ない）。
 *
 * **この歯は行の実装を問わない**（移す前の `JournalRow` にも、`@alteroid/ui` の
 * `JournalEntryRow` にも同じ形で当たる）。行を部品へ移したとき、画面の振る舞いが
 * 変わっていないことをここで押さえる。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalFeedProvider } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { JournalEntry } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Journal from './journal';

vi.mock('virtua', () => ({
  Virtualizer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const NOW = new Date('2026-08-20T12:00:00.000Z');

// `managerId` は型に無いが、実データの一部の行が持つ（`~/lib/journal-links` が型を通さずに読む）。
const DECISION = {
  type: 'decision',
  id: 'row-decision',
  at: '2026-08-20T11:57:00.000Z',
  decision: '行の見た目を確かめる判断',
  grounds: '記憶',
  managerId: 'mgr-abc12345',
} as JournalEntry;

const OTHER: JournalEntry = {
  type: 'decision',
  id: 'row-other',
  at: '2026-08-20T09:00:00.000Z',
  decision: 'もう1件の判断',
  grounds: '記憶',
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  // 相対の表示（「3分前」）を固定する。`Date` だけを偽にして、タイマーは実物のまま
  // （SWR と `waitFor` の待ちを止めない）。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function renderRows(entries: JournalEntry[]) {
  stubFetch((url) => {
    if (url.includes('/journal')) return json({ entries, scanned: entries.length });
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/', Component: Journal }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <JournalFeedProvider value={{ status: 'live', recent: [] }}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
  await waitFor(() => expect(screen.queryByText('読み込み中')).toBeNull());
}

/** 要旨の文字から、その行の開閉ボタンと行の根を引く（要旨は開閉ボタンの外にある。#2756）。 */
async function rowOf(summary: string) {
  const summaryNode = await screen.findByText(summary);
  const root = summaryNode.parentElement?.parentElement as HTMLElement;
  const button = root.querySelector('button');
  if (button === null) throw new Error('行に開閉のボタンが無い');
  return { button, root };
}

describe('日誌の1行: 閉じているとき', () => {
  it('時刻は @alteroid/logic の整形のまま、相対の表示は素の文字で出し、<time> も Tab の停止点も足さない', async () => {
    await renderRows([DECISION]);
    const { button, root } = await rowOf('行の見た目を確かめる判断（根拠: 記憶）');

    // 行頭の絶対時刻: 閲覧者の端末の時間帯のまま（JST 固定にしない）。
    expect(within(button).getByText(formatDateTime(DECISION.at, NOW.getTime()))).toBeTruthy();
    // 右端の相対の表示。
    expect(within(root).getByText('3分前')).toBeTruthy();
    // JST/UTC の tooltip を持つ `<time>` を出さない。開閉のボタンの中に焦点を受ける物を足さない。
    expect(root.querySelector('time')).toBeNull();
    expect(root.querySelectorAll('[tabindex]')).toHaveLength(0);
    // Tab の順路: 閉じた行の停止点は開閉のボタン1つだけ。
    expect(
      root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'),
    ).toHaveLength(1);
    // 種別の札の文字は行に1回だけ。
    expect(within(root).getAllByText('判断')).toHaveLength(1);
    // 識別子は札の本文には出さず、補足（title）に回す。
    expect(within(root).getByText('判断').getAttribute('title')).toBe('decision');
    // 閉じている間は生の中身を出さない。
    expect(root.querySelector('pre')).toBeNull();
  });
});

describe('日誌の1行: 開いたとき', () => {
  it('押すと開き、もう一度押すと閉じる。開くと実体へのリンクと生の JSON だけを出す', async () => {
    await renderRows([DECISION]);
    const { button, root } = await rowOf('行の見た目を確かめる判断（根拠: 記憶）');

    fireEvent.click(button);

    // 実体の詳細へのリンク。
    expect(within(root).getByRole('link', { name: /委譲 mgr-abc12345 の詳細/ })).toBeTruthy();
    // 生の中身（要約で止めない）。
    const pre = root.querySelector('pre');
    expect(pre?.textContent).toBe(JSON.stringify(DECISION, null, 2));
    // 開いても、種別の文字は行に1回だけ（`getByText` が多重に一致しない）。
    expect(within(root).getAllByText('判断')).toHaveLength(1);
    // 識別子は札の本文には出さず、補足（title）に回す。
    expect(within(root).getByText('判断').getAttribute('title')).toBe('decision');
    // この画面に無かった操作（生の中身を写すボタン）を足さない。
    expect(screen.queryByText('写す')).toBeNull();
    // 開いた行の停止点は、開閉のボタンとリンクだけ。
    expect(
      root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'),
    ).toHaveLength(2);

    fireEvent.click(button);
    expect(root.querySelector('pre')).toBeNull();
    expect(within(root).queryByRole('link')).toBeNull();
  });

  it('行ごとに独立して開閉する', async () => {
    await renderRows([DECISION, OTHER]);
    const first = await rowOf('行の見た目を確かめる判断（根拠: 記憶）');
    const second = await rowOf('もう1件の判断（根拠: 記憶）');

    fireEvent.click(first.button);
    expect(first.root.querySelector('pre')).not.toBeNull();
    expect(second.root.querySelector('pre')).toBeNull();
  });
});

describe('日誌の1行: github_observation は英語の識別子を要旨に出さない（#2806）', () => {
  it('記録元と CI の軸は日本語で出る。clone / success / failure / pending は閉じた行に出ない', async () => {
    const entry = {
      type: 'github_observation',
      id: 'row-gh',
      at: '2026-08-20T11:00:00.000Z',
      repo: 'a/b',
      query: 'is:open',
      observedBy: 'clone',
      result: {
        status: 'ok',
        openIssues: 3,
        openPulls: 2,
        truncated: false,
        ci: { pulls: 3, success: 1, failure: 1, pending: 1, checks: '必須チェックだけ' },
      },
    } as JournalEntry;
    await renderRows([entry]);
    const { root, button } = await rowOf(
      'a/b: 開いている Issue 3 件 / 開いている PR 2 件（記録したのは: クローン） / CI: 3 件の PR を確認 — 成功 1 / 失敗 1 / 実行中・待ち 1（数えたもの: 必須チェックだけ）',
    );
    const closed = button.textContent ?? '';
    const text = root.textContent ?? '';
    for (const word of ['clone', 'success', 'failure', 'pending', '観測者', 'open']) {
      expect(text).not.toContain(word);
      expect(closed).not.toContain(word);
    }
  });
});
