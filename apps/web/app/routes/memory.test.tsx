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

/**
 * #821 — 「⚠古い要旨」が12/12で鳴って信号を失っていた欠陥の直し（Web 一覧側）。
 *
 * `⚠` を消す決定は core だけでなく Web にも当てる——常に鳴る印が他の印への
 * 感度を下げる、というクローンの理由は表示面を問わない。
 */
describe('記憶一覧の要旨の前に付く印（#821 — ⚠ をやめて数で言う）', () => {
  it('stale は差の大きさを言い、1時間差と30日差で別の文字列になる（語ではなく数で測る）', async () => {
    renderMemory([
      doc({
        slug: 'stale-1h',
        title: '1時間だけ古い記憶',
        description: '古い要旨A',
        descriptionFreshness: { kind: 'stale', staleForMs: 60 * 60 * 1000 },
      }),
      doc({
        slug: 'stale-30d',
        title: '30日古い記憶',
        description: '古い要旨B',
        descriptionFreshness: { kind: 'stale', staleForMs: 30 * 24 * 60 * 60 * 1000 },
      }),
    ]);

    expect(await screen.findByText(/要旨は本文より1時間古い: 古い要旨A/)).toBeTruthy();
    expect(await screen.findByText(/要旨は本文より30日古い: 古い要旨B/)).toBeTruthy();
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
    // 「0日ぶん新しい」のような、欠測を鮮度に見せる文言が紛れ込んでいないこと。
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
