// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Memory from './memory';

const DAY_MS = 24 * 60 * 60 * 1000;

type MemoryListDoc = Omit<MemoryDocument, 'content'>;

// title を slug と別の文字列にする: 同じ文字列だと2箇所に同じテキストが出て getByText が複数一致で落ちるため
function doc(over: Partial<MemoryListDoc> = {}): MemoryListDoc {
  return {
    slug: 'notes',
    title: 'notes という記憶',
    updatedAt: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    createdAt: { kind: 'known', at: new Date(Date.now() - 3 * DAY_MS).toISOString() },
    bytes: 42,
    frontmatter: { kind: 'none' },
    kind: 'fact',
    descriptionFreshness: { kind: 'absent' },
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

function renderMemory(documents: MemoryListDoc[]) {
  stubFetch((url) => (url.includes('/memory') ? json({ documents }) : undefined));
  const router = createMemoryRouter(
    [
      { path: '/', Component: Memory },
      { path: '/memory/:slug', Component: () => null },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('一覧の行に作成時刻を出す', () => {
  it('createdAt が known なら「作成」の相対時刻が出る', async () => {
    renderMemory([doc({ slug: 'notes', title: 'notes という記憶' })]);

    await screen.findByText('notes という記憶');
    expect(screen.getByText(/作成 3日前/)).toBeTruthy();
    expect(screen.getByText(/更新 1日前/)).toBeTruthy();
  });

  it('createdAt が unknown なら「作成 不明」と出す（空欄にしない）', async () => {
    renderMemory([doc({ slug: 'old-note', title: '古い記憶', createdAt: { kind: 'unknown' } })]);

    await screen.findByText('古い記憶');
    expect(screen.getByText(/作成 不明/)).toBeTruthy();
    expect(screen.getByText(/更新 1日前/)).toBeTruthy();
  });
});

describe('記憶の区分タグ（[premise]/[fact]/[indexed]）に人間向けの説明が付く', () => {
  it('indexed のタグには「要旨だけが焼かれ、節の目次は焼かれない」旨の説明が付く', async () => {
    renderMemory([doc({ slug: 'proj-only', title: 'プロジェクト専用の記憶', kind: 'indexed' })]);

    const tag = await screen.findByText('特定の作業用');
    expect(tag.getAttribute('title')).toContain('要旨だけを見ている');
  });

  it('premise / fact のタグにも説明が付く（indexed だけの特別扱いにしない）', async () => {
    renderMemory([
      doc({ slug: 'premise-doc', title: '前提の記憶', kind: 'premise' }),
      doc({ slug: 'fact-doc', title: '事実の記憶', kind: 'fact' }),
    ]);

    const premiseTag = await screen.findByText('前提');
    const factTag = await screen.findByText('事実');
    expect(premiseTag.getAttribute('title')).not.toBe('');
    expect(factTag.getAttribute('title')).not.toBe('');
  });
});

describe('記憶一覧の要旨の前に付く印（#821 — ⚠ をやめて数で言う）', () => {
  it('stale は差の大きさを言い、1時間差と30日差で別の文字列になる（語ではなく数で測る）', async () => {
    renderMemory([
      doc({
        slug: 'stale-1h',
        title: '1時間だけ古い記憶',
        description: '古い要旨A',
        descriptionFreshness: {
          kind: 'stale',
          staleForMs: 60 * 60 * 1000,
          drift: { kind: 'unrecorded' },
        },
      }),
      doc({
        slug: 'stale-30d',
        title: '30日古い記憶',
        description: '古い要旨B',
        descriptionFreshness: {
          kind: 'stale',
          staleForMs: 30 * 24 * 60 * 60 * 1000,
          drift: { kind: 'unrecorded' },
        },
      }),
    ]);

    expect(
      await screen.findByText(
        /要旨は本文より1時間古い（本文の変化量は記録されていない）: 古い要旨A/,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        /要旨は本文より30日古い（本文の変化量は記録されていない）: 古い要旨B/,
      ),
    ).toBeTruthy();
  });

  it('unknown（記録なし）と fresh（正直なゼロ）は別の言葉で出る（条件1: 取れなかったと0を混ぜない）', async () => {
    renderMemory([
      doc({
        slug: 'unknown-doc',
        title: '鮮度不明の記憶',
        description: '要旨U',
        descriptionFreshness: { kind: 'unknown' },
      }),
      doc({
        slug: 'fresh-doc',
        title: '鮮度が新しい記憶',
        description: '要旨F',
        descriptionFreshness: { kind: 'fresh' },
      }),
    ]);

    expect(await screen.findByText(/要旨を書いた時刻が記録されていない: 要旨U/)).toBeTruthy();
    expect(await screen.findByText(/要旨の後に本文は動いていない: 要旨F/)).toBeTruthy();
    expect(screen.queryByText(/0日/)).toBeNull();
  });

  it('absent（要旨なし）は印を出さない', async () => {
    renderMemory([
      doc({
        slug: 'absent-doc',
        title: '要旨のない記憶',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
      }),
    ]);

    await screen.findByText('要旨のない記憶');
    expect(screen.queryByText(/要旨は本文より/)).toBeNull();
    expect(screen.queryByText(/記録されていない/)).toBeNull();
    expect(screen.queryByText(/動いていない/)).toBeNull();
  });
});

describe('slug 欄の補足文', () => {
  it('書式は常時表示の補足文で、欄と aria-describedby で結ばれる（プレースホルダは短い例だけ）', async () => {
    renderMemory([]);
    const input = await screen.findByLabelText(/^名前/);
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/128 文字まで/);
    expect((input as HTMLInputElement).placeholder).not.toMatch(/英小文字/);
  });
});

describe('一覧の行は行全体がリンク', () => {
  it('題名・slug・サイズ・日時の文字はどれも同じ1本のリンクの内に在る', async () => {
    renderMemory([doc({ slug: 'about-me', title: '私について' })]);

    const link = await screen.findByRole('link', { name: /私について/ });
    expect(link.getAttribute('href')).toBe('/memory/about-me');
    expect(link.closest('li')?.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByText('about-me').closest('a')).toBe(link);
    expect(screen.getByText(/作成 3日前/).closest('a')).toBe(link);
    expect(screen.getByText('私について').closest('a')).toBe(link);
  });
});

describe('利用者に内部の語を見せない（#2782 / #2787）', () => {
  it('種別は「前提」「事実」「特定の作業用」と出し、[premise] のような内部の語や「提供価値」を出さない', async () => {
    renderMemory([
      doc({ slug: 'p', title: '前提の記憶', kind: 'premise' }),
      doc({ slug: 'f', title: '事実の記憶', kind: 'fact' }),
      doc({ slug: 'i', title: '専用の記憶', kind: 'indexed' }),
    ]);

    await screen.findByText(/前提の記憶/);
    const text = document.body.textContent ?? '';
    for (const word of ['[premise]', '[fact]', '[indexed]', '提供価値']) {
      expect(text).not.toContain(word);
    }
  });

  it('名前の入力欄にラベルが在り、入力後も残る', async () => {
    renderMemory([]);

    const input = await screen.findByLabelText(/^名前/);
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(screen.getByLabelText(/^名前/)).toBe(input);
    expect(screen.queryByLabelText(/slug/)).toBeNull();
  });
});
