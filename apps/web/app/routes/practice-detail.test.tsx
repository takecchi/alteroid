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
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice, PracticeVersionSummary } from '@alteroid/logic';
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
  return (
    <>
      {/* 離れる先のリンク（本番では左の一覧や上のタブが担う。一覧との組み合わせは practices-list-detail.test.tsx） */}
      <Link to="/practices">やり方</Link>
      <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />
    </>
  );
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
    expect(((await screen.findByLabelText('種類')) as HTMLInputElement).value).toBe('日報');
    expect((screen.getByLabelText('題') as HTMLInputElement).value).toBe('日報の書き方');
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
    const kindInput = (await screen.findByLabelText('種類')) as HTMLInputElement;
    expect(kindInput.value).toBe('日報');
    const titleInput = screen.getByLabelText('題') as HTMLInputElement;
    expect(titleInput.value).toBe('日報の書き方');
  });
});

describe('種類（kind）はプルダウンではなく自由入力である', () => {
  it('<select> を1つも置いていない', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    await screen.findByLabelText('種類');
    expect(document.querySelector('select')).toBeNull();
  });
});

describe('タブ切り替えと書きかけ', () => {
  it('編集タブで入力した書きかけは、タブを行き来しても消えない', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const titleInput = (await screen.findByLabelText('題')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '書きかけの題' } });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    await screen.findByText('書きかけの題');

    fireEvent.mouseDown(screen.getByRole('tab', { name: '編集' }));
    const titleAgain = (await screen.findByLabelText('題')) as HTMLInputElement;
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
    const contentBox = (await screen.findByLabelText('本文')) as HTMLTextAreaElement;
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
    const kindInput = (await screen.findByLabelText('種類')) as HTMLInputElement;
    fireEvent.change(kindInput, { target: { value: '' } });

    const saveButton = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });
});

describe('削除', () => {
  /** DELETE を打ったか。`openapi-fetch` は `Request` で呼ぶので、メソッドは `entries` の `request` で読む。 */
  function deleted(stub: ReturnType<typeof stubFetch>): number {
    return stub.entries.filter((entry) => entry.request?.method === 'DELETE').length;
  }

  it('「削除」を押しただけでは消さず、確認を出す（#2781）', async () => {
    const stub = renderDetail('daily-report', docRoute(PRACTICE));
    await screen.findByRole('heading', { name: '見出し' });

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('「daily-report」を削除しますか')).toBeTruthy();
    expect(screen.getByText(/このやり方は本文ごと消え、元に戻せません/)).toBeTruthy();
    expect(deleted(stub)).toBe(0);
  });

  it('確認で「やめる」を押すと消さずに閉じる', async () => {
    const stub = renderDetail('daily-report', docRoute(PRACTICE));
    await screen.findByRole('heading', { name: '見出し' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleted(stub)).toBe(0);
  });

  it('確認で「削除する」を押したときだけ DELETE を打つ', async () => {
    const stub = renderDetail('daily-report', docRoute(PRACTICE));
    await screen.findByRole('heading', { name: '見出し' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    await waitFor(() => expect(deleted(stub)).toBe(1));
  });

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
    expect(screen.queryByLabelText('本文')).toBeNull();
  });

  it('版が1件も無い slug では「まだ版が無い」と言う', async () => {
    renderDetail(PRACTICE.slug, historyRoute(PRACTICE, [], {}));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    expect(await screen.findByText(/まだ版が無い/)).toBeTruthy();
  });
});

/**
 * **「履歴」タブが、版を読めなかったときも `Spinner` のまま回り続けないこと
 * （issue #2139）。**
 *
 * 直す前は `usePracticeVersions` / `usePracticeVersion` のどちらも `error`
 * を受けておらず、失敗しても `history === undefined` / `historyDetail ===
 * undefined` のままなので `Spinner` が回り続け、「読めていない」のか
 * 「読んでいる途中」なのか見分けが付かなかった。
 */
describe('履歴タブが読めないとき（issue #2139）', () => {
  const versions: PracticeVersionSummary[] = [
    {
      slug: PRACTICE.slug,
      version: 1,
      kind: '日報',
      title: '旧題',
      at: '2026-08-01T00:00:00.000Z',
      chars: 3,
    },
  ];
  const contents = { 1: '# 旧本文' };

  /** 版の一覧（`/versions`）だけを失敗させる。本体・版1本は正常。 */
  function historyRouteVersionsFail(doc: Practice): FetchRoute {
    return (url) => {
      if (/\/practices\/[^/]+\/versions\/\d+/.exec(url)) return undefined;
      if (url.includes(`/practices/${doc.slug}/versions`)) return json({ error: 'internal' }, 500);
      if (url.includes(`/practices/${doc.slug}`)) return json({ practice: doc });
      return undefined;
    };
  }

  /** 版1本（`/versions/:version`）だけを失敗させる。一覧・本体は正常。 */
  function historyRouteVersionDetailFail(
    doc: Practice,
    versions: PracticeVersionSummary[],
  ): FetchRoute {
    return (url) => {
      if (/\/practices\/[^/]+\/versions\/\d+/.exec(url)) return json({ error: 'internal' }, 500);
      if (url.includes(`/practices/${doc.slug}/versions`)) return json({ versions });
      if (url.includes(`/practices/${doc.slug}`)) return json({ practice: doc });
      return undefined;
    };
  }

  it('版の一覧が読めないと ErrorNote を出す（Spinner のまま回らない）', async () => {
    renderDetail(PRACTICE.slug, historyRouteVersionsFail(PRACTICE));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('読み込み中')).toBeNull();
    expect(screen.queryByText('まだ版が無い（一度も書かれていない）。')).toBeNull();
  });

  it('選んだ版の本文が読めないと ErrorNote を出す（Spinner のまま回らない）', async () => {
    renderDetail(PRACTICE.slug, historyRouteVersionDetailFail(PRACTICE, versions));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    fireEvent.click(await screen.findByText('旧題'));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(contents[1])).toBeNull();
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

describe('見出し（#2763 と同じ作り）', () => {
  it('slug は h2 で、長くても折り返せる（縮む側は見出しを包む div、ボタン群は縮まない）', async () => {
    // jsdom はレイアウトを持たないので実寸は測れない。指定そのものを固定する。
    renderDetail('daily-report', docRoute(PRACTICE));

    const heading = await screen.findByRole('heading', { level: 2, name: 'daily-report' });
    expect(heading.className).toContain('break-all');
    expect(heading.parentElement?.className.split(/\s+/)).toContain('min-w-0');
    expect(
      screen.getByRole('button', { name: /保存|変更なし/ }).parentElement?.className,
    ).toContain('shrink-0');
  });
});

/** 未保存の編集があるまま離れない（#2764。`memory-detail.test.tsx` と同じ穴）。 */
describe('未保存の編集を離れる前に確認する', () => {
  it('書きかけのまま他の画面へのリンクを押すと確認が出る。やめれば留まる', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('題'), {
      target: { value: '書きかけ' },
    });

    fireEvent.click(screen.getByRole('link', { name: 'やり方' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((screen.getByLabelText('題') as HTMLInputElement).value).toBe('書きかけ');
  });

  it('変更が無ければ確認なしで移動し、書きかけのときだけ beforeunload の警告を出す', async () => {
    renderDetail('daily-report', docRoute(PRACTICE));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const input = await screen.findByLabelText('題');

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(input, { target: { value: '書きかけ' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

/**
 * 保存は読んだ版を前提にし、衝突しても下書きを捨てない（#2853。`memory-detail.test.tsx` と同じ形）。
 */
describe('保存は読んだ版を前提にし、衝突しても下書きを捨てない', () => {
  const V1 = 'a'.repeat(64);
  const V2 = 'b'.repeat(64);
  const CLONE = {
    ...PRACTICE,
    kind: 'クローンの種類',
    title: 'クローンが書いた題',
    content: 'クローンが書いた本文\n',
    updatedAt: '2026-08-22T02:00:00.000Z',
  };

  /** PUT の本文を控え、`putResponses` を順に返す。GET は `getVersions` を順に返す（最後の値を使い回す）。 */
  function stubPut(putResponses: Response[], getVersions: string[] = [V1]) {
    const putBodies: unknown[] = [];
    let gets = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes('/versions')) return json({ versions: [] });
      if (!request.url.includes('/practices/daily-report')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'PUT') {
        putBodies.push(await request.json());
        return putResponses.shift() ?? json({ error: 'x' }, 500);
      }
      const version = getVersions[Math.min(gets, getVersions.length - 1)];
      gets += 1;
      return json({ practice: PRACTICE, version });
    }) as typeof fetch;
    mountDetail('daily-report');
    return putBodies;
  }

  const conflict = () =>
    json(
      {
        error: 'やり方が読んだ後に変わっています（書き換えていません）',
        current: { practice: CLONE, version: V2 },
      },
      409,
    );

  async function editAndSave(text = '人間の書きかけ') {
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('本文'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  }

  it('読んだ版（version）を ifMatch として送る', async () => {
    const putBodies = stubPut([json({ practice: PRACTICE, version: V2 })]);

    await editAndSave();

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({
      kind: '日報',
      title: '日報の書き方',
      content: '人間の書きかけ',
      ifMatch: V1,
    });
  });

  it('409 では下書きを残し、ほかで書き換えられたことと最新の内容を見せる', async () => {
    stubPut([conflict()]);

    await editAndSave();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ほかで書き換えられた');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect(alert.textContent).toContain('クローンが書いた題');
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
    expect(screen.queryByText(/^保存した/)).toBeNull();
  });

  it('「自分の内容で上書きする」は、いまの版を ifMatch にして書き直す', async () => {
    const putBodies = stubPut([conflict(), json({ practice: PRACTICE, version: 'c'.repeat(64) })]);
    await editAndSave();

    fireEvent.click(await screen.findByRole('button', { name: '自分の内容で上書きする' }));

    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]).toMatchObject({ content: '人間の書きかけ', ifMatch: V2 });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('「いまの内容を読み直す」は下書きを捨てて、書き込まない', async () => {
    const putBodies = stubPut([conflict()]);
    await editAndSave();

    fireEvent.click(
      await screen.findByRole('button', { name: '自分の下書きを捨てて、いまの内容を読み直す' }),
    );

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(putBodies).toHaveLength(1);
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe(PRACTICE.content);
  });

  it('保存の応答が新しい版を返し、再取得がまだ古い版を返していても、次の保存の ifMatch は新しい版', async () => {
    const putBodies = stubPut([
      json({ practice: PRACTICE, version: V2 }),
      json({ practice: PRACTICE, version: 'c'.repeat(64) }),
    ]);

    await editAndSave('1回目');
    expect(await screen.findByText(/保存した/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '2回目' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[0]).toMatchObject({ content: '1回目', ifMatch: V1 });
    expect(putBodies[1]).toMatchObject({ content: '2回目', ifMatch: V2 });
  });
});
