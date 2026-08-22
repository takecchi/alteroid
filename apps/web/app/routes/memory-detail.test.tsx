// @vitest-environment jsdom
/**
 * 記憶詳細に「プレビュー | 編集」タブを入れること。
 *
 * 人間の依頼: 「メモリの画面見た際に編集できるようになってると思いますが、
 * プレビュー | 編集みたいな感じで表示をタブ切り替えられるようにしてほしい。
 * メモリもMarkdownで見たいので」（alteroid の Web UI について）。
 *
 * **守るべきは「新しく増えた表示」だけではない。** 既存の保存・削除・
 * Cmd/Ctrl+S・404 の扱いを1つも壊さないことも同じ重みで見る
 * （AGENTS.md「静かに失敗する道具」— テストの足場は動くのに嘘をつく）。
 *
 * **⭐ 最重要はタブ切り替えで書きかけを失わないこと。** `draft` state は
 * タブの外（`MemoryDetail` 自身）に置くので、Radix Tabs が非活性パネルを
 * unmount してもデータは消えない。これを直接固定する。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/memory-detail';
import MemoryDetail, { clientLoader } from './memory-detail';

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
 * ルートモジュールの props（`loaderData`）が渡るのは framework mode だけで、
 * `createMemoryRouter`（library mode）では渡らない。**形を手で書き写さない** —
 * 本物の `clientLoader` を通した戻り値をそのまま渡す（`manager-detail.test.tsx`
 * に倣う）。
 */
function Harness({ slug }: { slug: string }) {
  const loaderData = clientLoader({ params: { slug } } as Route.ClientLoaderArgs);
  return <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />;
}

/** ルーターを組んで描くだけ。`globalThis.fetch` の差し替えは呼ぶ側の責務。 */
function mountDetail(slug: string) {
  const router = createMemoryRouter(
    [
      { path: '/memory/:slug', Component: () => <Harness slug={slug} /> },
      // `Link to="/memory"` の行き先（描くだけで踏まない）。
      { path: '/memory', Component: () => null },
    ],
    { initialEntries: [`/memory/${slug}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function renderDetail(slug: string, route: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(route);
  mountDetail(slug);
  return stub;
}

/** GET /memory/{slug} が返す形。生成 spec の required 一式を省略しない。 */
const DOC: MemoryDocument = {
  slug: 'notes',
  title: 'notes',
  updatedAt: '2026-08-22T00:00:00.000Z',
  bytes: 42,
  frontmatter: { kind: 'none' },
  kind: 'fact',
  descriptionFreshness: { kind: 'absent' },
  content: '# 見出し\n\n本文だよ',
};

function docRoute(doc: MemoryDocument): Parameters<typeof stubFetch>[0] {
  return (url) => {
    if (!url.includes(`/memory/${doc.slug}`)) return undefined;
    return json({ document: doc });
  };
}

describe('既定タブ', () => {
  it('記憶が在るときはプレビューが既定で、本文が Markdown として描かれる', async () => {
    renderDetail('notes', docRoute(DOC));

    const heading = await screen.findByRole('heading', { name: '見出し' });
    expect(heading.tagName).toBe('H1');
    // リテラルの `# 見出し` が本文にそのまま出ていないこと。
    expect(screen.queryByText('# 見出し')).toBeNull();
    // 編集タブのテキストエリアは、まだ選ばれていないので出ていない。
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('記憶が無い（404）ときは編集タブが既定', async () => {
    renderDetail('new-memo', (url) =>
      url.includes('/memory/new-memo') ? json({ error: 'not found' }, 404) : undefined,
    );

    const textarea = await screen.findByRole('textbox');
    expect(textarea).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '見出し' })).toBeNull();
  });
});

describe('編集タブ', () => {
  it('textarea に本文が出る', async () => {
    renderDetail('notes', docRoute(DOC));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(textarea.value).toBe(DOC.content);
  });
});

describe('タブ切り替えと書きかけ', () => {
  it('⭐ 編集タブで入力した書きかけは、タブを行き来しても消えず、プレビューにも映る', async () => {
    renderDetail('notes', docRoute(DOC));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '# 書きかけの見出し\n\nまだ保存していない' } });

    // プレビューへ切り替える → 書きかけがそのまま Markdown として映る。
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    const heading = await screen.findByRole('heading', { name: '書きかけの見出し' });
    expect(heading.tagName).toBe('H1');
    expect(screen.getByText('まだ保存していない')).toBeTruthy();

    // 編集へ戻る → 入力した文字列がそのまま残っている（消えていない）。
    fireEvent.mouseDown(screen.getByRole('tab', { name: '編集' }));
    const textareaAgain = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(textareaAgain.value).toBe('# 書きかけの見出し\n\nまだ保存していない');
  });
});

describe('保存', () => {
  it('従来どおり効く — dirty で保存ボタンが押せ、PUT の本文が入力どおりで、保存後に日時が出る', async () => {
    /**
     * 共有の `stubFetch` は使わない。`openapi-fetch` は `fetch(new Request(...))`
     * の形で呼ぶので、共有スタブが見る第2引数 `init` からは method が取れず
     * GET と PUT を区別できない（`manager-detail.test.tsx` / `schedule.test.tsx`
     * に同じ注記が在る。最初それで書いて実際に踏んだ）。ここでは Request 本体から
     * method と body を読み直す。
     */
    let putBody: unknown;
    let putCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (!url.includes('/memory/notes')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
      }
      if (method === 'PUT') {
        putCalled = true;
        putBody = await request.json();
        return json({
          document: { ...DOC, content: '書き換えた本文', updatedAt: '2026-08-22T01:00:00.000Z' },
        });
      }
      return json({ document: DOC });
    }) as typeof fetch;
    mountDetail('notes');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');

    // まだ触っていない → 「変更なし」で無効。
    expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(textarea, { target: { value: '書き換えた本文' } });

    const saveButton = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(putBody).toEqual({ content: '書き換えた本文' });
    });
    expect(await screen.findByText(/保存した/)).toBeTruthy();
    // 保存できたら下書きが畳まれ、また「変更なし」に戻る。
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    // PUT が実際に飛んだこと（method で区別できているか自体の確認）。
    expect(putCalled).toBe(true);
  });
});

describe('削除', () => {
  it('プレビュータブでも削除ボタンが在る', async () => {
    renderDetail('notes', docRoute(DOC));
    await screen.findByRole('heading', { name: '見出し' });
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();
  });

  it('編集タブでも削除ボタンが在る', async () => {
    renderDetail('notes', docRoute(DOC));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    await screen.findByRole('textbox');
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();
  });
});

describe('生 HTML の扱い', () => {
  it('本文中の生 HTML は要素にならず、テキストとしてそのまま出る', async () => {
    const withRawHtml: MemoryDocument = {
      ...DOC,
      content: '<img src=x onerror="alert(1)"><script>alert(2)</script>本文',
    };

    renderDetail('notes', docRoute(withRawHtml));

    await screen.findByText(/本文/);
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('onerror="alert(1)"');
  });
});
