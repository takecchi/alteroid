// @vitest-environment jsdom
/**
 * 記憶一覧（`/memory` 画面）の行に「作成」時刻を出すこと（#233）。
 *
 * `memory_list`（クローンの道具、`packages/core/src/memory.ts` の
 * `formatMemoryCreatedAt`）と語彙を揃える——「作成」「更新」の順で、
 * 根拠が無ければ「不明」と明言する（AGENTS.md「踏みやすい地雷」の
 * 「取れない軸に 0 の行を作る」——空欄にすると取れないことが消える）。
 *
 * known と unknown を同じ `it()` に混ぜない——アサーションは最初の1つで
 * 止まるので、片方が通るともう片方も通ったように見える。
 *
 * `formatCreatedAtRelative` は `formatRelative` と同じく `Date.now()` に
 * 依存するので、`commitments.test.tsx` の `commitment()` と同じやり方で
 * 「テスト実行時点からの相対オフセット」で ISO を作る（時計を固定しない）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Memory from './memory';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `GET /memory` が返す1件ぶん（`content` を持たない一覧用の形）。 */
type MemoryListDoc = Omit<MemoryDocument, 'content'>;

/**
 * `title` を `slug` と別の文字列にしておく——同じ文字列だと、slug 行と
 * title 行の2箇所に同じテキストが出て `getByText` が「複数一致」で
 * 落ちる（実際に一度これで踏んだ）。
 */
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
    // 3日前に作成、1日前に更新——両方が別のラベルで出ていること。
    expect(screen.getByText(/作成 3日前/)).toBeTruthy();
    expect(screen.getByText(/更新 1日前/)).toBeTruthy();
  });

  it('createdAt が unknown なら「作成 不明」と出す（空欄にしない）', async () => {
    renderMemory([doc({ slug: 'old-note', title: '古い記憶', createdAt: { kind: 'unknown' } })]);

    await screen.findByText('古い記憶');
    expect(screen.getByText(/作成 不明/)).toBeTruthy();
    // 更新のほうは根拠があるので、そちらまで「不明」に引きずられない。
    expect(screen.getByText(/更新 1日前/)).toBeTruthy();
  });
});

/**
 * `type: indexed`（第3の区分。`packages/core/src/schema.ts` の
 * `memoryDocKindSchema`）を、人間が一覧で見分けられること。
 *
 * 人間が `~/.alteroid/memory/*.md` を直接開いたときの `type:` frontmatter と
 * 対応させる唯一の場所がこの一覧のタグである。タグの文字（`[indexed]`）
 * だけでは意味が分からないので、ホバー説明（`title` 属性）を確かめる。
 */
describe('記憶の区分タグ（[premise]/[fact]/[indexed]）に人間向けの説明が付く', () => {
  it('indexed のタグには「要旨だけが焼かれ、節の目次は焼かれない」旨の説明が付く', async () => {
    renderMemory([doc({ slug: 'proj-only', title: 'プロジェクト専用の記憶', kind: 'indexed' })]);

    const tag = await screen.findByText('[indexed]');
    expect(tag.getAttribute('title')).toContain('節の目次は焼かれない');
  });

  it('premise / fact のタグにも説明が付く（indexed だけの特別扱いにしない）', async () => {
    renderMemory([
      doc({ slug: 'premise-doc', title: '前提の記憶', kind: 'premise' }),
      doc({ slug: 'fact-doc', title: '事実の記憶', kind: 'fact' }),
    ]);

    const premiseTag = await screen.findByText('[premise]');
    const factTag = await screen.findByText('[fact]');
    expect(premiseTag.getAttribute('title')).not.toBe('');
    expect(factTag.getAttribute('title')).not.toBe('');
  });
});
