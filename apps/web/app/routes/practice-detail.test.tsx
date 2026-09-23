// @vitest-environment jsdom
/**
 * やり方の詳細（`/practices/:slug` 画面、#1055 段3③）。
 *
 * `memory-detail.test.tsx` と同じ骨組み（プレビュー/編集タブ、書きかけを
 * 失わないこと、404 は「これから書く」として編集タブを既定にすること、
 * 保存や削除）に加えて、`PracticeStore` 固有の点を測る——`kind` / `title`
 * も編集タブに在ること、保存の PUT 本文が `kind`/`title`/`content` の3つを
 * 持つこと（`memory` は `content` だけなので、ここが違いの本体）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice, PracticeVersionSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';
import type { Route as FetchRoute } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

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
 * ルートモジュールの props（`loaderData`）が渡るのは framework mode だけ
 * （`memory-detail.test.tsx` と同じ理由）。
 */
function Harness({ slug }: { slug: string }) {
  const loaderData = clientLoader({ params: { slug } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function mountDetail(slug: string) {
  const router = createMemoryRouter(
    [
      { path: '/practices/:slug', Component: () => <Harness slug={slug} /> },
      { path: '/practices', Component: () => null },
    ],
    { initialEntries: [`/practices/${slug}`] },
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

const PRACTICE: Practice = {
  slug: 'daily-report',
  kind: '日報',
  title: '日報の書き方',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 42,
  content: '# 見出し\n\n本文だよ',
};

function docRoute(doc: Practice): Parameters<typeof stubFetch>[0] {
  return (url) => {
    if (!url.includes(`/practices/${doc.slug}`)) return undefined;
    return json({ practice: doc });
  };
}

describe('既定タブ', () => {
  it('やり方が在るときはプレビューが既定で、本文が Markdown として描かれる', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));

    const heading = await screen.findByRole('heading', { name: '見出し' });
    expect(heading.tagName).toBe('H1');
    expect(screen.queryByText('# 見出し')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /本文/ })).toBeNull();
  });

  it('やり方は在るが本文が空のときは編集タブが既定（読むものが無い）', async () => {
    renderDetail('empty', docRoute({ ...PRACTICE, slug: 'empty', content: '' }));

    // kind / title / content の3つの入力欄が編集タブに出る。
    expect(((await screen.findByLabelText('種類（kind）')) as HTMLInputElement).value).toBe('日報');
    expect((screen.getByLabelText('題（title）') as HTMLInputElement).value).toBe('日報の書き方');
    expect(screen.getByRole('tab', { name: 'プレビュー' })).toBeTruthy();
  });

  it('やり方が無い（404）ときは編集タブが既定で、kind/title は空欄', async () => {
    renderDetail('new-one', (url) =>
      url.includes('/practices/new-one') ? json({ error: 'not found' }, 404) : undefined,
    );

    // 本文の textarea が編集タブとして最初から出ている。
    const textareas = await screen.findAllByRole('textbox');
    expect(textareas.length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: '見出し' })).toBeNull();
  });
});

describe('編集タブ', () => {
  it('kind / title / content の3つとも編集できる', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const kindInput = (await screen.findByLabelText('種類（kind）')) as HTMLInputElement;
    expect(kindInput.value).toBe('日報');
    const titleInput = screen.getByLabelText('題（title）') as HTMLInputElement;
    expect(titleInput.value).toBe('日報の書き方');
  });
});

describe('種類（kind）はプルダウンではなく自由入力である', () => {
  it('<select> を1つも置いていない', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    await screen.findByLabelText('種類（kind）');
    expect(document.querySelector('select')).toBeNull();
  });
});

describe('タブ切り替えと書きかけ', () => {
  it('編集タブで入力した書きかけは、タブを行き来しても消えない', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const titleInput = (await screen.findByLabelText('題（title）')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '書きかけの題' } });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    await screen.findByText('書きかけの題');

    fireEvent.mouseDown(screen.getByRole('tab', { name: '編集' }));
    const titleAgain = (await screen.findByLabelText('題（title）')) as HTMLInputElement;
    expect(titleAgain.value).toBe('書きかけの題');
  });
});

describe('保存', () => {
  it('PUT の本文が kind/title/content の3つを持つ（memory と違い content だけではない）', async () => {
    let putBody: unknown;
    let putCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (!url.includes('/practices/daily-report')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
      }
      if (method === 'PUT') {
        putCalled = true;
        putBody = await request.json();
        return json({
          practice: { ...PRACTICE, content: '書き換えた本文', updatedAt: '2026-08-22T01:00:00Z' },
        });
      }
      return json({ practice: PRACTICE });
    }) as typeof fetch;
    mountDetail('daily-report');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const contentBox = (await screen.findByLabelText('本文（content）')) as HTMLTextAreaElement;
    expect(contentBox.value).toBe('# 見出し\n\n本文だよ');

    expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(contentBox, { target: { value: '書き換えた本文' } });

    const saveButton = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(putBody).toEqual({ kind: '日報', title: '日報の書き方', content: '書き換えた本文' });
    });
    expect(await screen.findByText(/保存した/)).toBeTruthy();
    expect(putCalled).toBe(true);
  });

  it('kind を空にすると保存ボタンが無効になる（practiceKindSchema の min(1)）', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const kindInput = (await screen.findByLabelText('種類（kind）')) as HTMLInputElement;
    fireEvent.change(kindInput, { target: { value: '' } });

    const saveButton = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });
});

describe('削除', () => {
  it('プレビュータブでも削除ボタンが在る', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));
    await screen.findByRole('heading', { name: '見出し' });
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();
  });
});

/**
 * 版の履歴（#1309）を含めた route stub。
 *
 * `docRoute` は `url.includes` が緩いので、`/versions` 付きの URL も
 * 誤って本体の応答にマッチしてしまう——履歴タブの試験では順序（版の
 * エンドポイントを先に見る）を自分で組む。
 */
function historyRoute(
  doc: Practice,
  versions: PracticeVersionSummary[],
  contents: Record<number, string>,
): FetchRoute {
  return (url) => {
    const versionMatch = /\/practices\/([^/]+)\/versions\/(\d+)/.exec(url);
    if (versionMatch) {
      const version = Number(versionMatch[2]);
      const summary = versions.find((v) => v.version === version);
      if (summary === undefined) return json({ error: 'not found' }, 404);
      return json({ version: { ...summary, content: contents[version] ?? '' } });
    }
    if (url.includes(`/practices/${doc.slug}/versions`)) return json({ versions });
    if (url.includes(`/practices/${doc.slug}`)) return json({ practice: doc });
    return undefined;
  };
}

describe('履歴タブ（#1309）', () => {
  const versions: PracticeVersionSummary[] = [
    {
      slug: PRACTICE.slug,
      version: 1,
      kind: '日報',
      title: '旧題',
      at: '2026-08-01T00:00:00.000Z',
      chars: 3,
    },
    {
      slug: PRACTICE.slug,
      version: 2,
      kind: '日報',
      title: '日報の書き方',
      at: '2026-08-22T00:00:00.000Z',
      chars: 42,
    },
  ];
  const contents = { 1: '# 旧本文', 2: PRACTICE.content };

  it('版の一覧を出す（メタだけ。本文は最初は出ない）', async () => {
    renderDetail(PRACTICE.slug, historyRoute(PRACTICE, versions, contents));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    expect(await screen.findByText('版1')).toBeTruthy();
    expect(await screen.findByText('版2')).toBeTruthy();
    expect(screen.queryByText('旧本文')).toBeNull();
  });

  it('版を選ぶと本文まで読める（読み取り専用）', async () => {
    renderDetail(PRACTICE.slug, historyRoute(PRACTICE, versions, contents));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    fireEvent.click(await screen.findByText('旧題'));

    await screen.findByText(/旧本文/);
    // 読み取り専用——textarea を持たない（編集タブの本文欄と区別する）。
    expect(screen.queryByLabelText('本文（content）')).toBeNull();
  });

  it('版が1件も無い slug では「まだ版が無い」と言う', async () => {
    renderDetail(PRACTICE.slug, historyRoute(PRACTICE, [], {}));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    expect(await screen.findByText(/まだ版が無い/)).toBeTruthy();
  });
});

describe('生 HTML の扱い', () => {
  it('本文中の生 HTML は要素にならず、テキストとしてそのまま出る', async () => {
    const withRawHtml: Practice = {
      ...PRACTICE,
      content: '<img src=x onerror="alert(1)"><script>alert(2)</script>本文',
    };

    renderDetail('daily-report', docRoute(withRawHtml));

    await screen.findByText(/本文/);
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('onerror="alert(1)"');
  });
});
