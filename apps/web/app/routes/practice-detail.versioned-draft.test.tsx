// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

// 版つき下書き（読んだ版を持って書き、保存に版を添え、衝突したら相手の版を見せる）の分岐を押さえる。
// memory-detail.versioned-draft.test.tsx と同じ分岐を、同じ順で押さえる。

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

const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);
const V3 = 'c'.repeat(64);

const PRACTICE: Practice = {
  slug: 'daily-report',
  kind: '日報',
  title: '日報の書き方',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 4,
  content: '元の本文',
};

function practiceWith(content: string): Practice {
  return { ...PRACTICE, content, updatedAt: '2026-08-22T02:00:00.000Z' };
}

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'daily-report' } } as Route.ClientLoaderArgs);
  return (
    <>
      <Link to="/practices">やり方</Link>
      <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />
    </>
  );
}

type Server = {
  practice: Practice;
  version: string;
  missing: boolean;
  gets: number;
  puts: Record<string, unknown>[];
  putQueue: (Response | (() => Promise<Response>))[];
};

function serve(init: Partial<Server> = {}): Server {
  const server: Server = {
    practice: PRACTICE,
    version: V1,
    missing: false,
    gets: 0,
    puts: [],
    putQueue: [],
    ...init,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.includes('/versions')) return json({ versions: [] });
    if (!request.url.includes('/practices/daily-report')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
    }
    if (request.method === 'PUT') {
      server.puts.push((await request.json()) as Record<string, unknown>);
      const next = server.putQueue.shift();
      if (next === undefined) return json({ error: 'x' }, 500);
      return typeof next === 'function' ? next() : next;
    }
    server.gets += 1;
    if (server.missing) return json({ error: 'not found' }, 404);
    return json({ practice: server.practice, version: server.version });
  }) as typeof fetch;
  const router = createMemoryRouter(
    [
      { path: '/practices/:slug', Component: Harness },
      { path: '/practices', Component: () => <p>一覧</p> },
    ],
    { initialEntries: ['/practices/daily-report'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return server;
}

const conflict = (content: string, version: string) =>
  json(
    {
      error: 'やり方が読んだ後に変わっています（書き換えていません）',
      current: { practice: practiceWith(content), version },
    },
    409,
  );

const saved = (content: string, version: string) =>
  json({ practice: practiceWith(content), version });

const body = (content: string, ifMatch: string | null) => ({
  kind: '日報',
  title: '日報の書き方',
  content,
  ifMatch,
});

function textbox() {
  return screen.getByLabelText('本文') as HTMLTextAreaElement;
}

async function edit(text: string) {
  const tab = await screen.findByRole('tab', { name: '編集' });
  if (tab.getAttribute('aria-selected') !== 'true') fireEvent.mouseDown(tab);
  fireEvent.change(await screen.findByLabelText('本文'), { target: { value: text } });
}

function pressSave() {
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
}

// 再取得（SSE の無効化と同じ効き）を起こし、その応答が画面へ届くまで待つ
async function refetch(server: Server) {
  const before = server.gets;
  fireEvent.focus(window);
  await waitFor(() => expect(server.gets).toBeGreaterThan(before));
  await act(async () => {
    await Promise.resolve();
  });
}

describe('版つき下書き: 保存の失敗', () => {
  it('衝突以外の失敗は注記に出し、下書きと保存ボタンを残す。衝突の選択肢は出ず、再保存で注記が消える', async () => {
    const server = serve({
      putQueue: [json({ error: '壊れた' }, 500), saved('人間の書きかけ', V2)],
    });
    await edit('人間の書きかけ');
    pressSave();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('壊れた');
    expect(screen.queryByRole('button', { name: '自分の内容で上書きする' })).toBeNull();
    expect(textbox().value).toBe('人間の書きかけ');
    expect(screen.queryByText(/^保存した/)).toBeNull();
    const retry = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    pressSave();
    expect(await screen.findByText(/^保存した/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(server.puts).toEqual([body('人間の書きかけ', V1), body('人間の書きかけ', V1)]);
  });
});

describe('版つき下書き: 衝突', () => {
  it('上書きがもう一度衝突したら、表示は新しい相手の版に替わり、次の上書きはその版を送る', async () => {
    const server = serve({
      putQueue: [
        conflict('クローンの本文1', V2),
        conflict('クローンの本文2', V3),
        saved('人間の書きかけ', 'd'.repeat(64)),
      ],
    });
    await edit('人間の書きかけ');
    pressSave();
    expect((await screen.findByRole('alert')).textContent).toContain('クローンの本文1');

    fireEvent.click(screen.getByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('クローンの本文2'));
    expect(textbox().value).toBe('人間の書きかけ');

    fireEvent.click(screen.getByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(server.puts).toHaveLength(3));
    expect(server.puts.map((put) => put.ifMatch)).toEqual([V1, V2, V3]);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText(/^保存した/)).toBeTruthy();
  });

  it('相手が無かった（current が null）ときの上書きは、版に null を添えて送る', async () => {
    const server = serve({
      putQueue: [
        json(
          { error: 'やり方が読んだ後に消されています（書き換えていません）', current: null },
          409,
        ),
        saved('人間の書きかけ', V2),
      ],
    });
    await edit('人間の書きかけ');
    pressSave();
    fireEvent.click(await screen.findByRole('button', { name: '自分の内容で上書きする' }));

    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[0]).toEqual(body('人間の書きかけ', V1));
    expect(server.puts[1]).toEqual(body('人間の書きかけ', null));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('衝突のあと、再取得で内容が下書きと同じになっても、人が選んだ上書きは通る（相手の版を前提にする）', async () => {
    const server = serve({
      putQueue: [conflict('人間の書きかけ', V2), saved('人間の書きかけ', V3)],
    });
    await edit('人間の書きかけ');
    pressSave();
    await screen.findByRole('button', { name: '自分の内容で上書きする' });

    server.practice = practiceWith('人間の書きかけ');
    server.version = V3;
    await refetch(server);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(textbox().value).toBe('人間の書きかけ');

    fireEvent.click(screen.getByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]).toEqual(body('人間の書きかけ', V2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('衝突のあと、種類を空にすると上書きは送られない（保存の門は衝突の後でも種類を見る）', async () => {
    const server = serve({ putQueue: [conflict('クローンの本文', V2)] });
    await edit('人間の書きかけ');
    pressSave();
    await screen.findByRole('button', { name: '自分の内容で上書きする' });

    fireEvent.change(screen.getByLabelText('種類'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '自分の内容で上書きする' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(server.puts).toHaveLength(1);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('衝突のあと、保存中に打ち足した分は残り、衝突の表示は片付く。次の保存は保存できた版を前提にする', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = serve({
      putQueue: [
        conflict('クローンの本文', V2),
        async () => {
          await gate;
          return saved('人間の書きかけ', V3);
        },
        saved('人間の書きかけ+', 'd'.repeat(64)),
      ],
    });
    await edit('人間の書きかけ');
    pressSave();
    fireEvent.click(await screen.findByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(server.puts).toHaveLength(2));

    fireEvent.change(textbox(), { target: { value: '人間の書きかけ+' } });
    release();
    expect(await screen.findByText(/^保存した/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(textbox().value).toBe('人間の書きかけ+');

    pressSave();
    await waitFor(() => expect(server.puts).toHaveLength(3));
    expect(server.puts[2]).toEqual(body('人間の書きかけ+', V3));
  });

  it('「読み直す」で下書きを捨てたあとの書き直しは、取り直した版を前提にする', async () => {
    const server = serve({
      putQueue: [conflict('クローンの本文', V2), saved('新しい書きかけ', V3)],
    });
    await edit('人間の書きかけ');
    pressSave();
    fireEvent.click(
      await screen.findByRole('button', { name: '自分の下書きを捨てて、いまの内容を読み直す' }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    server.practice = practiceWith('クローンの本文');
    server.version = V2;
    await refetch(server);
    expect(textbox().value).toBe('クローンの本文');

    await edit('新しい書きかけ');
    pressSave();
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]).toEqual(body('新しい書きかけ', V2));
  });
});

describe('版つき下書き: 離脱の確認と再取得', () => {
  it('衝突で保存できなかった下書きは未保存のまま。離れる前に確認が出て、読み直して捨てたあとは出ない', async () => {
    serve({ putQueue: [conflict('クローンの本文', V2)] });
    await edit('人間の書きかけ');
    pressSave();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('link', { name: 'やり方' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(textbox().value).toBe('人間の書きかけ');

    fireEvent.click(
      screen.getByRole('button', { name: '自分の下書きを捨てて、いまの内容を読み直す' }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    fireEvent.click(screen.getByRole('link', { name: 'やり方' }));
    expect(await screen.findByText('一覧')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('保存できたあとは未保存ではなくなり、離れても確認は出ない', async () => {
    serve({ putQueue: [saved('人間の書きかけ', V2)] });
    await edit('人間の書きかけ');
    pressSave();
    await screen.findByText(/^保存した/);
    await screen.findByRole('button', { name: '変更なし' });
    // 未保存の報告は effect で届くので、それが済んでから離れる
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('link', { name: 'やり方' }));
    expect(await screen.findByText('一覧')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('書きかけの最中に再取得が走っても、書きかけは消えない（取得した内容を写さない）', async () => {
    const server = serve();
    await edit('人間の書きかけ');

    server.practice = practiceWith('クローンの本文');
    server.version = V2;
    await refetch(server);

    expect(textbox().value).toBe('人間の書きかけ');
  });

  it('書きかけの最中に再取得が走っても、保存は書き始めた版を前提にする（取り直した版へ追従しない）', async () => {
    const server = serve({ putQueue: [conflict('クローンの本文', V2)] });
    await edit('人間の書きかけ');

    server.practice = practiceWith('クローンの本文');
    server.version = V2;
    await refetch(server);
    pressSave();

    await screen.findByRole('alert');
    expect(server.puts[0]).toEqual(body('人間の書きかけ', V1));
  });
});

describe('版つき下書き: 保存中', () => {
  it('保存中は削除ボタンが押せず、終われば押せる。保存ボタンの二重押しは PUT を1回しか打たない', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = serve({
      putQueue: [
        async () => {
          await gate;
          return saved('人間の書きかけ', V2);
        },
      ],
    });
    await edit('人間の書きかけ');
    pressSave();
    await waitFor(() => expect(server.puts).toHaveLength(1));

    expect((screen.getByRole('button', { name: '削除' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /保存する/ }));
    expect(server.puts).toHaveLength(1);

    release();
    await screen.findByText(/^保存した/);
    expect((screen.getByRole('button', { name: '削除' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(server.puts).toHaveLength(1);
  });
});

describe('版つき下書き: まだ無いやり方', () => {
  it('無いやり方への最初の保存は版に null を添え、その次の保存は応答の版を前提にする', async () => {
    const server = serve({
      missing: true,
      putQueue: [saved('1回目', V2), saved('2回目', V3)],
    });
    await edit('1回目');
    fireEvent.change(screen.getByLabelText('種類'), { target: { value: '日報' } });
    pressSave();
    await screen.findByText(/^保存した/);

    // 取得は 404 のままなので、保存で下書きが畳まれた後は種類も書き直す
    fireEvent.change(screen.getByLabelText('種類'), { target: { value: '日報' } });
    fireEvent.change(textbox(), { target: { value: '2回目' } });
    pressSave();

    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[0]).toMatchObject({ kind: '日報', content: '1回目', ifMatch: null });
    expect(server.puts[1]).toMatchObject({ content: '2回目', ifMatch: V2 });
  });
});
