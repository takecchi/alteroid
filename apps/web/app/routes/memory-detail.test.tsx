// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/memory-detail';
import MemoryDetail, { clientLoader } from './memory-detail';

// 時間帯を vi.hoisted で固定する: 器の TZ に依存すると CI（UTC）と手元（JST）で期待値が食い違い、import 評価より前に固定しないと効かないため
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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

// loaderData の形を手で書き写さない: 本物の clientLoader を通した戻り値をそのまま渡すため
function Harness({ slug }: { slug: string }) {
  const loaderData = clientLoader({ params: { slug } } as Route.ClientLoaderArgs);
  return (
    <>
      <Link to="/memory">記憶</Link>
      <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />
    </>
  );
}

function mountDetail(slug: string) {
  const router = createMemoryRouter(
    [
      { path: '/memory/:slug', Component: () => <Harness slug={slug} /> },
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

const DOC: MemoryDocument = {
  slug: 'notes',
  title: 'notes',
  updatedAt: '2026-08-22T00:00:00.000Z',
  createdAt: { kind: 'unknown' },
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
    expect(screen.queryByText('# 見出し')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('記憶は在るが本文が空のときも編集タブが既定（読むものが無い）', async () => {
    renderDetail('empty', docRoute({ ...DOC, slug: 'empty', content: '' }));

    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(screen.getByRole('tab', { name: 'プレビュー' })).toBeTruthy();
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

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    const heading = await screen.findByRole('heading', { name: '書きかけの見出し' });
    expect(heading.tagName).toBe('H1');
    expect(screen.getByText('まだ保存していない')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '編集' }));
    const textareaAgain = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(textareaAgain.value).toBe('# 書きかけの見出し\n\nまだ保存していない');
  });
});

describe('保存', () => {
  it('従来どおり効く — dirty で保存ボタンが押せ、PUT の本文が入力どおりで、保存後に日時が出る', async () => {
    // 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので、第2引数 init からは method が取れず GET と PUT を区別できないため
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
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    expect(putCalled).toBe(true);
  });
});

describe('作成時刻', () => {
  // known と unknown を同じ it() に混ぜない: アサーションは最初の1つで止まるので、片方が通るともう片方も通ったように見えるため

  // toFake: ['Date'] に絞る: 既定の vi.useFakeTimers() は setTimeout 等も止め、RTL のポーリング（waitFor 内部の real timer）を巻き込んでハングしうるため
  // NOW を壁時計に委ねず固定する: 暦が年を跨いだ瞬間にこの it が赤くなるのを避けるため
  const NOW_2026 = Date.parse('2026-08-25T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_2026);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('作成時刻が known なら、その時刻が画面に出る', async () => {
    renderDetail(
      'notes',
      docRoute({ ...DOC, createdAt: { kind: 'known', at: '2026-08-01T00:00:00.000Z' } }),
    );

    await screen.findByRole('heading', { name: '見出し' });
    expect(screen.getByText(/作成 08\/01 09:00/)).toBeTruthy();
  });

  it('作成時刻が unknown なら「不明」と出す（空欄にしない）', async () => {
    renderDetail('notes', docRoute({ ...DOC, createdAt: { kind: 'unknown' } }));

    await screen.findByRole('heading', { name: '見出し' });
    expect(screen.getByText(/作成 不明/)).toBeTruthy();
  });

  it('保存直後も作成時刻が画面から消えない', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/memory/notes')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'PUT') {
        return json({
          document: {
            ...DOC,
            createdAt: { kind: 'known', at: '2026-08-01T00:00:00.000Z' },
            content: '書き換えた本文',
            updatedAt: '2026-08-22T01:00:00.000Z',
          },
        });
      }
      return json({
        document: { ...DOC, createdAt: { kind: 'known', at: '2026-08-01T00:00:00.000Z' } },
      });
    }) as typeof fetch;
    mountDetail('notes');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '書き換えた本文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByText(/保存した/)).toBeTruthy();
    expect(screen.getByText(/作成 08\/01 09:00/)).toBeTruthy();
  });
});

describe('削除', () => {
  function deleted(stub: ReturnType<typeof stubFetch>): number {
    return stub.entries.filter((entry) => entry.request?.method === 'DELETE').length;
  }

  it('「削除」を押しただけでは消さず、確認を出す（#2781）', async () => {
    const stub = renderDetail('notes', docRoute(DOC));
    await screen.findByRole('heading', { name: '見出し' });

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('「notes」を削除しますか')).toBeTruthy();
    expect(screen.getByText(/この記憶は本文ごと消え、元に戻せません/)).toBeTruthy();
    expect(deleted(stub)).toBe(0);
  });

  it('確認で「やめる」を押すと消さずに閉じる', async () => {
    const stub = renderDetail('notes', docRoute(DOC));
    await screen.findByRole('heading', { name: '見出し' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleted(stub)).toBe(0);
  });

  it('確認で「削除する」を押したときだけ DELETE を打つ', async () => {
    const stub = renderDetail('notes', docRoute(DOC));
    await screen.findByRole('heading', { name: '見出し' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    await waitFor(() => expect(deleted(stub)).toBe(1));
  });

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

describe('折り返しの付け忘れ（本2）', () => {
  it('タイトル行の slug に break-all が付いている', async () => {
    const longSlug = 'a'.repeat(80);
    renderDetail(longSlug, docRoute({ ...DOC, slug: longSlug }));

    const span = await screen.findByText(longSlug);
    expect(span.className.split(/\s+/)).toContain('break-all');
  });
});

describe('横並びの積み替え（本4-D）: タイトル行の slug', () => {
  it('slug の見出し（h2）が break-all で幅に収まり、右のボタン群は縮まない', async () => {
    const longSlug = 'a'.repeat(80);
    renderDetail(longSlug, docRoute({ ...DOC, slug: longSlug }));

    const heading = await screen.findByRole('heading', { level: 2, name: longSlug });
    expect(heading.className.split(/\s+/)).toContain('break-all');
    expect(heading.parentElement?.className.split(/\s+/)).toContain('min-w-0');
    expect(
      screen.getByRole('button', { name: /保存|変更なし/ }).parentElement?.className,
    ).toContain('shrink-0');
  });
});

describe('編集欄の振る舞い（部品へ移しても変わらないもの）', () => {
  it('タブの並びは「プレビュー → 編集」の2つだけ（並べては出ない）', async () => {
    renderDetail('notes', docRoute(DOC));

    await screen.findByRole('heading', { name: '見出し' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'プレビュー',
      '編集',
    ]);
  });

  it('プレビューが既定のとき、選ばれているのはプレビュー、編集は選ばれていない', async () => {
    renderDetail('notes', docRoute(DOC));

    await screen.findByRole('heading', { name: '見出し' });
    expect(screen.getByRole('tab', { name: 'プレビュー' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: '編集' }).getAttribute('aria-selected')).toBe('false');
  });

  it('空の記憶に最初の1文字を打っても、編集タブのまま（プレビューへ勝手に移らない）', async () => {
    renderDetail('empty', docRoute({ ...DOC, slug: 'empty', content: '' }));

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'a' } });

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('a');
    expect(screen.getByRole('tab', { name: '編集' }).getAttribute('aria-selected')).toBe('true');
  });

  it('空のプレビューに「まだ何も書いていない」の一言は出ない', async () => {
    renderDetail('empty', docRoute({ ...DOC, slug: 'empty', content: '' }));

    await screen.findByRole('textbox');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    expect(screen.queryByText(/まだ何も書いていない/)).toBeNull();
  });

  it('編集タブの上の一文は文言のまま出て、「⌘/Ctrl + S で保存」は出ない。placeholder も無い', async () => {
    renderDetail('notes', docRoute(DOC));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');
    expect(
      screen.getByText('ここで書き換えたものは、人間が直した記録として日誌に残る。'),
    ).toBeTruthy();
    expect(screen.queryByText(/Ctrl \+ S/)).toBeNull();
    expect(textarea.getAttribute('placeholder') ?? '').toBe('');
    expect(textarea.getAttribute('spellcheck')).toBe('false');
  });

  it('⌘/Ctrl + S で保存する（PUT の本文は入力どおり）。s 以外・修飾なしでは保存しない', async () => {
    const puts: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/memory/notes')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'PUT') {
        puts.push(await request.json());
        return json({ document: { ...DOC, content: 'キーで保存' } });
      }
      return json({ document: DOC });
    }) as typeof fetch;
    mountDetail('notes');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'キーで保存' } });

    fireEvent.keyDown(textarea, { key: 's' });
    fireEvent.keyDown(textarea, { key: 'a', ctrlKey: true });
    expect(puts).toEqual([]);

    const notPrevented = fireEvent.keyDown(textarea, { key: 's', metaKey: true });
    expect(notPrevented).toBe(false);
    await waitFor(() => {
      expect(puts).toEqual([{ content: 'キーで保存' }]);
    });
  });

  it('書き換えていないとき（下書きが無い）の ⌘/Ctrl + S は PUT しない', async () => {
    const puts: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'PUT') puts.push(await request.json());
      return json({ document: DOC });
    }) as typeof fetch;
    mountDetail('notes');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');
    expect(fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })).toBe(false);
    expect(puts).toEqual([]);
  });
});

describe('見出し（#2763）', () => {
  it('slug は h2 で、長くても折り返せる', async () => {
    renderDetail('notes', docRoute(DOC));

    const heading = await screen.findByRole('heading', { level: 2, name: 'notes' });
    expect(heading.className).toContain('break-all');
  });
});

describe('未保存の編集を離れる前に確認する', () => {
  async function startEditing(text = '書きかけ') {
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: text } });
    return textarea;
  }

  it('書きかけのまま他の画面へのリンクを押すと確認が出る。やめれば留まり下書きが残る', async () => {
    renderDetail('notes', docRoute(DOC));
    await startEditing();

    fireEvent.click(screen.getByRole('link', { name: '記憶' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('書きかけ');
  });

  it('確認で「破棄して離れる」を押すと移動する', async () => {
    renderDetail('notes', docRoute(DOC));
    await startEditing();

    fireEvent.click(screen.getByRole('link', { name: '記憶' }));
    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('変更が無ければ確認なしで移動する', async () => {
    renderDetail('notes', docRoute(DOC));
    await screen.findByRole('heading', { name: '見出し' });

    fireEvent.click(screen.getByRole('link', { name: '記憶' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: '見出し' })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('タブを閉じる・再読み込みは、書きかけのときだけブラウザの警告（beforeunload）を出す', async () => {
    renderDetail('notes', docRoute(DOC));
    await screen.findByRole('heading', { name: '見出し' });

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await startEditing();
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('保存は読んだ版を前提にし、衝突しても下書きを捨てない', () => {
  const V1 = 'a'.repeat(64);
  const V2 = 'b'.repeat(64);
  const CLONE_DOC = {
    ...DOC,
    content: 'クローンが書いた本文',
    updatedAt: '2026-08-22T02:00:00.000Z',
  };

  function stubPut(putResponses: Response[]) {
    const putBodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/memory/notes')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'PUT') {
        putBodies.push(await request.json());
        return putResponses.shift() ?? json({ error: 'x' }, 500);
      }
      return json({ document: DOC, version: V1 });
    }) as typeof fetch;
    mountDetail('notes');
    return putBodies;
  }

  const conflict = () =>
    json(
      {
        error: '記憶が読んだ後に変わっています（書き換えていません）',
        current: { document: CLONE_DOC, version: V2 },
      },
      409,
    );

  async function editAndSave() {
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '人間の書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  }

  it('読んだ版（version）を ifMatch として送る', async () => {
    const putBodies = stubPut([
      json({ document: { ...DOC, content: '人間の書きかけ' }, version: V2 }),
    ]);

    await editAndSave();

    await waitFor(() => expect(putBodies).toEqual([{ content: '人間の書きかけ', ifMatch: V1 }]));
  });

  it('409 では下書きを残し、ほかで書き換えられたことと最新の内容を見せる', async () => {
    const putBodies = stubPut([conflict()]);

    await editAndSave();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ほかで書き換えられた');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
    expect(screen.queryByText(/^保存した/)).toBeNull();
    expect(putBodies).toHaveLength(1);
  });

  it('「自分の内容で上書きする」は、いまの版を ifMatch にして書き直す', async () => {
    const putBodies = stubPut([
      conflict(),
      json({ document: { ...DOC, content: '人間の書きかけ' }, version: 'c'.repeat(64) }),
    ]);
    await editAndSave();

    fireEvent.click(await screen.findByRole('button', { name: '自分の内容で上書きする' }));

    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]).toEqual({ content: '人間の書きかけ', ifMatch: V2 });
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
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(DOC.content);
  });
});

describe('保存した直後に編集を再開しても、手元の版は保存の応答の版（偽の 409 にならない）', () => {
  it('保存の応答が新しい版を返し、再取得がまだ古い版を返していても、次の保存の ifMatch は新しい版', async () => {
    const V1 = 'a'.repeat(64);
    const V2 = 'b'.repeat(64);
    const putBodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/memory/notes')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'PUT') {
        putBodies.push(await request.json());
        return json({ document: { ...DOC, content: '1回目' }, version: V2 });
      }
      return json({ document: DOC, version: V1 });
    }) as typeof fetch;
    mountDetail('notes');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '1回目' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(await screen.findByText(/保存した/)).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '2回目' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[0]).toEqual({ content: '1回目', ifMatch: V1 });
    expect(putBodies[1]).toEqual({ content: '2回目', ifMatch: V2 });
  });
});

describe('削除は読んだ版を ifMatch（クエリ）として送り、衝突しても消さない', () => {
  const V1 = 'a'.repeat(64);
  const V2 = 'b'.repeat(64);
  const CLONE_DOC = {
    ...DOC,
    content: 'クローンが書いた本文',
    updatedAt: '2026-08-22T02:00:00.000Z',
  };

  function stubDelete(deleteResponses: Response[]) {
    const deleteUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/memory/notes')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'DELETE') {
        deleteUrls.push(request.url);
        return deleteResponses.shift() ?? json({ error: 'x' }, 500);
      }
      return json({ document: DOC, version: V1 });
    }) as typeof fetch;
    mountDetail('notes');
    return deleteUrls;
  }

  const conflict = () =>
    json(
      {
        error: '記憶が読んだ後に変わっています（消していません）',
        current: { document: CLONE_DOC, version: V2 },
      },
      409,
    );

  async function askDelete() {
    await screen.findByRole('heading', { name: '見出し' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
  }

  it('読んだ版を ifMatch として DELETE のクエリに付ける', async () => {
    const urls = stubDelete([json({ ok: true, slug: 'notes' })]);

    await askDelete();

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0] ?? '').searchParams.get('ifMatch')).toBe(V1);
  });

  it('409 では消さず、確認を閉じて、読んだ後に変わったことといまの内容を見せる。再送しない', async () => {
    const urls = stubDelete([conflict()]);

    await askDelete();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('消していない');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();
    expect(urls).toHaveLength(1);
  });

  it('いまの内容を見たうえで、もう一度確認して削除すると、いまの版（V2）で送る', async () => {
    const urls = stubDelete([conflict(), json({ ok: true, slug: 'notes' })]);
    await askDelete();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(new URL(urls[1] ?? '').searchParams.get('ifMatch')).toBe(V2);
  });
});

describe('保存の門（#3300）', () => {
  it('保存中に ⌘/Ctrl + S をもう一度押しても PUT は1回だけ', async () => {
    const puts: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'PUT') {
        puts.push(await request.json());
        await gate;
        return json({ document: { ...DOC, content: '二重に押す' }, version: 'v2' });
      }
      return json({ document: DOC });
    }) as typeof fetch;
    mountDetail('notes');

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '二重に押す' } });

    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    await waitFor(() => expect(puts).toHaveLength(1));
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    release();
    await screen.findByText(/保存した/);
    expect(puts).toHaveLength(1);
  });
});
