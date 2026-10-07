// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommitmentOrigin } from '@alteroid/core';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';
import type { Commitment } from '@alteroid/logic';

import Commitments, { readableExternalBody } from './commitments';

const DAY_MS = 24 * 60 * 60 * 1000;

function commitment(over: Partial<Commitment> = {}): Commitment {
  const at = over.at ?? new Date(Date.now() - 3 * DAY_MS).toISOString();
  return {
    id: 'cmt-1',
    origin: 'human',
    body: 'ドキュメントの誤りを直す',
    ...over,
    at,
    updatedAt: over.updatedAt ?? over.closedAt ?? at,
  };
}

function recordRequests(): Request[] {
  const requests: Request[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) requests.push(input.clone());
    return inner(input, init);
  }) as typeof fetch;
  return requests;
}

function stubCommitments(open: Commitment[], closed: Commitment[] = []) {
  return stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
    if (url.includes('/close')) return json({ ok: true });
    return json({ entries: url.includes('includeClosed=true') ? [...open, ...closed] : open });
  });
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

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/', Component: Commitments },
      { path: '/elsewhere', Component: () => <p>別の画面</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

function renderPageWithRouter() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('/commitments 画面', () => {
  it('未了に起点と齢を出す（急ぎ方を決める材料はこの2つしかない）', async () => {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    renderPage();

    expect(await screen.findByText('ドキュメントの誤りを直す')).toBeTruthy();
    expect(screen.getByText(/人間/)).toBeTruthy();
    expect(screen.queryByText(/conv-1/)).toBeNull();
    expect(screen.getByText('(3日前)')).toBeTruthy();
  });

  it('origin: manager の行はバッジの id が /managers/<id> への Link になる', async () => {
    stubCommitments([commitment({ origin: 'manager', source: 'mgr-42' })]);
    renderPageWithRouter();

    expect(await screen.findByText('ドキュメントの誤りを直す')).toBeTruthy();
    expect(screen.queryByText(/mgr-42/)).toBeNull();
    const link = screen.getByRole('link', { name: 'マネージャーの詳細' });
    expect(link.getAttribute('href')).toBe('/managers/mgr-42');
  });

  it('origin: human の行はバッジの id をリンクにしない', async () => {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    renderPage();

    expect(await screen.findByText('ドキュメントの誤りを直す')).toBeTruthy();
    expect(screen.queryByText(/conv-1/)).toBeNull();
    expect(screen.queryByRole('link', { name: /conv-1/ })).toBeNull();
  });

  it('未知の origin でもバッジのラベルが空文字にならず、起点の生の値が出る（実行時の倒れ先）', async () => {
    stubCommitments([
      commitment({ origin: 'probe' as CommitmentOrigin, body: '未知の起点のコミットメント' }),
    ]);
    renderPage();

    await screen.findByText('未知の起点のコミットメント');
    expect(screen.getByText('probe')).toBeTruthy();
  });

  it('片付けたものは、押されたときだけ includeClosed=true で取りに行く', async () => {
    const stub = stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          body: 'もう終わった',
          closedAt: new Date().toISOString(),
          closedReason: 'PR #99 をマージした',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    expect(screen.queryByText('もう終わった')).toBeNull();
    expect(stub.calls.some((url) => url.includes('includeClosed=true'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    expect(await screen.findByText('もう終わった')).toBeTruthy();
    expect(screen.getByText(/PR #99 をマージした/)).toBeTruthy();
    expect(stub.calls.some((url) => url.includes('includeClosed=true'))).toBe(true);
    expect(screen.getByText('まだ終わっていない')).toBeTruthy();
  });

  it('保存の上限で消えた完了済みの仕事があれば、一覧の上に断りが出る', async () => {
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({ entries: [commitment()], unreadable: [], trimmedClosed: 3 });
    });
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByText(/古い完了済みの仕事が合わせて 3 件消えている/)).toBeTruthy();
  });

  it('読めない行が大量でも、id の列挙は上限で締まり省略の合図を出す', async () => {
    const count = 60;
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({
        entries: [commitment()],
        unreadable: Array.from({ length: count }, (_, index) => ({
          id: `c-broken-${index}`,
          at: new Date().toISOString(),
          reason: '型が合わない',
        })),
        trimmedClosed: 0,
      });
    });
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByText(new RegExp(`読めない行が ${count} 件ある`))).toBeTruthy();
    expect(screen.getByText(/c-broken-0/)).toBeTruthy();
    expect(screen.queryByText(/c-broken-59/)).toBeNull();
    expect(screen.getByText(/…ほか \d+ 件は省略/)).toBeTruthy();
  });

  it('読めない委譲があれば、どの行かは言えないという断りが一覧の上に出る', async () => {
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({
        entries: [commitment({ origin: 'human', source: 'conv-1' })],
        unreadable: [],
        trimmedClosed: 0,
        unreadableJobs: [{ id: 'mgr-bad', reason: '不正な欄: status' }],
      });
    });
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const note = screen.getByRole('status');
    expect(note.textContent).toContain('読めない委譲が 1 件ある（id: mgr-bad）');
    expect(note.textContent).toContain('どの行に紐づくかは分からない');
    expect(note.textContent).toContain('進行中（委譲あり）」の印が無い行の中に');
    expect(screen.queryByText(/委譲なし/)).toBeNull();
  });

  it('対照: 読めない委譲が無ければ（デーモンが古く欄が無いときも）断りを出さない', async () => {
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({
        entries: [commitment({ origin: 'human', source: 'conv-1' })],
        unreadable: [],
        trimmedClosed: 0,
      });
    });
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.queryByText(/読めない委譲/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('物理削除が0件なら断りを出さない', async () => {
    stubCommitments([commitment()]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.queryByText(/完了済みの仕事が合わせて/)).toBeNull();
  });

  it('理由を書かないと片付けられない', async () => {
    stubCommitments([commitment()]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const close = screen.getByRole('button', { name: '「ドキュメントの誤りを直す」が片付いた' });
    expect((close as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), {
      target: { value: '   ' },
    });
    expect(
      (screen.getByRole('button', { name: /が片付いた$/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('理由を書いて片付けると、その id と理由が閉じる経路へ乗る', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), {
      target: { value: 'PR #99 をマージした' },
    });
    fireEvent.click(screen.getByRole('button', { name: /が片付いた$/ }));

    const closed = await waitFor(() => {
      const found = requests.find((request) => request.url.includes('/commitments/cmt-42/close'));
      expect(found).toBeDefined();
      return found!;
    });
    expect(closed.method).toBe('POST');
    expect(JSON.parse(await closed.text())).toEqual({ reason: 'PR #99 をマージした' });
  });

  it('送信中に Enter をもう一度押しても、閉じる要求は1回だけ', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const inner = globalThis.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request && input.url.includes('/commitments/cmt-42/close')) {
        closeCalls += 1;
        await gate;
      }
      return inner(input, init);
    }) as typeof fetch;
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const field = screen.getByLabelText(/を片付けた理由$/);
    fireEvent.change(field, { target: { value: 'PR #99 をマージした' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(closeCalls).toBe(1));
    fireEvent.keyDown(field, { key: 'Enter' });
    release();
    await waitFor(() => expect(screen.queryByText('ドキュメントの誤りを直す')).not.toBeNull());
    expect(closeCalls).toBe(1);
  });

  it('積む口が、本文をそのまま POST /commitments へ送る', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('未了の仕事はない。');
    fireEvent.change(screen.getByLabelText('何を引き受けたか'), {
      target: { value: '週明けに設計を見直す' },
    });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));

    const posted = await waitFor(() => {
      const found = requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/commitments'),
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(JSON.parse(await posted.text())).toEqual({ body: '週明けに設計を見直す' });
  });

  it('本文が空のあいだは積めない', async () => {
    stubCommitments([]);
    renderPage();

    await screen.findByText('未了の仕事はない。');
    expect((screen.getByRole('button', { name: '積む' }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe('本文欄は複数行（Textarea）', () => {
    const isPost = (request: Request) =>
      request.method === 'POST' && request.url.endsWith('/commitments');

    it('textarea で、自動で伸びる（上限の高さを持つ）', async () => {
      stubCommitments([]);
      renderPage();
      const body = await screen.findByLabelText('何を引き受けたか');
      expect(body.tagName).toBe('TEXTAREA');
      expect((body as HTMLTextAreaElement).style.maxHeight).toBe('60vh');
    });

    it('Enter は改行のままで、送られない', async () => {
      stubCommitments([]);
      const requests = recordRequests();
      renderPage();
      const body = await screen.findByLabelText('何を引き受けたか');
      fireEvent.change(body, { target: { value: '手順1' } });

      const notPrevented = fireEvent.keyDown(body, { key: 'Enter' });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(notPrevented).toBe(true);
      expect(requests.some(isPost)).toBe(false);
    });

    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Cmd', { metaKey: true }],
    ])('%s+Enter で、複数行の本文がそのまま送られる', async (_name, modifier) => {
      stubCommitments([]);
      const requests = recordRequests();
      renderPage();
      const body = await screen.findByLabelText('何を引き受けたか');
      fireEvent.change(body, { target: { value: '次を出す\n- 手順1\n- 手順2' } });

      fireEvent.keyDown(body, { key: 'Enter', ...modifier });

      const posted = await waitFor(() => {
        const found = requests.find(isPost);
        expect(found).toBeDefined();
        return found!;
      });
      expect(JSON.parse(await posted.text())).toEqual({ body: '次を出す\n- 手順1\n- 手順2' });
    });

    it('空のあいだは Cmd/Ctrl+Enter でも送られない', async () => {
      stubCommitments([]);
      const requests = recordRequests();
      renderPage();
      const body = await screen.findByLabelText('何を引き受けたか');
      fireEvent.change(body, { target: { value: '  \n ' } });

      fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(requests.some(isPost)).toBe(false);
    });

    it('送るキーの案内が出る', async () => {
      stubCommitments([]);
      renderPage();
      await screen.findByLabelText('何を引き受けたか');
      expect(await screen.findByText(/Enter で登録$/)).toBeTruthy();
    });
  });
});

describe('返答済み・未クローズ / 未着手（issue #1003）', () => {
  it('origin: human の未了行に respondedAt が付けば「返答済み・未クローズ」が出る', async () => {
    stubCommitments([
      commitment({
        origin: 'human',
        source: 'conv-1',
        respondedAt: '2026-09-14T00:00:00.000Z',
      }),
    ]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByText(/返事済み・まだ片付いていない/)).toBeTruthy();
    expect(screen.queryByText('未着手')).toBeNull();
  });

  it('origin: human で respondedAt が無ければ「未着手」が残余として出る', async () => {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByText('未着手')).toBeTruthy();
    expect(screen.queryByText(/返事済み・まだ片付いていない/)).toBeNull();
  });

  it('origin が human でなければ、respondedAt があっても両方のバッジを出さない', async () => {
    stubCommitments([
      commitment({ origin: 'self', source: undefined, respondedAt: '2026-09-14T00:00:00.000Z' }),
    ]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.queryByText(/返事済み・まだ片付いていない/)).toBeNull();
    expect(screen.queryByText('未着手')).toBeNull();
  });
});

describe('進行中（委譲あり）の id が /managers/<id> への Link になる（issue #2097）', () => {
  it('activeManagerIds が2件のとき、2つとも /managers/<id> への Link になり、文言は変わらない', async () => {
    stubCommitments([
      commitment({
        origin: 'human',
        source: 'conv-1',
        activeManagerIds: ['mgr-1', 'mgr-2'],
      }),
    ]);
    renderPageWithRouter();

    await screen.findByText('ドキュメントの誤りを直す');
    // textContent で確かめる: id がリンクに分かれて別ノードになり、getByText の既定は直下のテキストノードしか見ないため
    const badge = screen.getByText(
      (_, node) =>
        node?.tagName === 'SPAN' && node.textContent === '進行中（委譲あり: 詳細1, 詳細2）',
    );
    expect(badge).toBeTruthy();

    const link1 = screen.getByRole('link', { name: '詳細1' });
    const link2 = screen.getByRole('link', { name: '詳細2' });
    expect(link1.getAttribute('href')).toBe('/managers/mgr-1');
    expect(link2.getAttribute('href')).toBe('/managers/mgr-2');
  });
});

describe('折り返しの付け忘れ（本2）', () => {
  it('未了の本文（body）に break-words が付いている', async () => {
    stubCommitments([commitment({ body: '未了の本文' })]);
    renderPage();

    const body = await screen.findByText('未了の本文');
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('break-words');
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  it('片付いた行の本文（body）にも break-words が付いている', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '理由の本文',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    const body = await screen.findByText('片付いた本文');
    expect(body.className.split(/\s+/)).toContain('break-words');
  });

  it('closedReason に break-words が付いている', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '理由の本文',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    const label = await screen.findByText('どう片付いたか');
    const wrapper = label.closest('p');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className.split(/\s+/)).toContain('break-words');
  });
});

describe('本文を origin で Markdown / 素のテキストへ切り分ける', () => {
  it('起点が自分（self）の本文は Markdown の描画経路を通る', async () => {
    stubCommitments([commitment({ origin: 'self', body: '## 引き受けた見出し\n\nこれは本文' })]);
    renderPage();

    expect(await screen.findByRole('heading', { name: '引き受けた見出し' })).toBeTruthy();
    expect(screen.getByText('これは本文')).toBeTruthy();
  });

  it('起点がマネージャー（manager）の本文は Markdown の描画経路を通る', async () => {
    stubCommitments([
      commitment({ origin: 'manager', body: '[report] ## 報告の見出し\n\n報告の本文' }),
    ]);
    renderPage();

    expect(await screen.findByRole('heading', { name: '報告の見出し' })).toBeTruthy();
    expect(screen.getByText('報告の本文')).toBeTruthy();
  });

  it.each(['report', 'question', 'permission'] as const)(
    'manager の [%s] 接頭辞は素のテキストとして出る（Markdown の描画経路を通らない）',
    async (kind) => {
      stubCommitments([commitment({ origin: 'manager', body: `[${kind}] 完了した` })]);
      renderPage();

      const prefix = await screen.findByText(new RegExp(`\\[${kind}\\]`));
      expect(prefix.tagName).toBe('SPAN');
      expect(prefix.closest('p.mt-2')).toBeNull();
      // 名前で絞る: この画面には常設の見出し（Card の h2）があり、名前指定なしの queryByRole('heading') は誤検出するため
      expect(screen.queryByRole('heading', { name: new RegExp(kind) })).toBeNull();
      // document 全体ではなくこの行（li）の中だけを見る: 無関係な場所に strong / em が増えても、この行が落ちないようにするため
      const row = prefix.closest('li');
      expect(row).not.toBeNull();
      expect(row!.querySelector('strong, em')).toBeNull();
    },
  );

  it("manager の本文は bodyMarkup === 'none' のとき、* を含んでいても強調に化けない（人間の停止理由が化ける回帰）", async () => {
    stubCommitments([
      commitment({
        origin: 'manager',
        body: '[report] *思いつきで* 止めた',
        bodyMarkup: 'none',
      }),
    ]);
    renderPage();

    const body = await screen.findByText('*思いつきで* 止めた');
    expect(body.textContent).toBe('*思いつきで* 止めた');
    const row = body.closest('li');
    expect(row).not.toBeNull();
    expect(row!.querySelector('strong, em')).toBeNull();
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  it('manager の本文は bodyMarkup が無いとき、今日どおり Markdown の描画経路を通る', async () => {
    stubCommitments([commitment({ origin: 'manager', body: '[report] *強調される* はず' })]);
    renderPage();

    const em = await screen.findByText('強調される');
    expect(em.tagName).toBe('EM');
  });

  it('manager の本文は schema に無い bodyMarkup が来ても、消さず素のテキストとして出す', async () => {
    stubCommitments([
      commitment({
        origin: 'manager',
        body: '[report] ## 未知の記法の本文',
        bodyMarkup: 'html',
      }),
    ]);
    renderPage();

    const body = await screen.findByText('## 未知の記法の本文');
    expect(screen.queryByRole('heading', { name: '未知の記法の本文' })).toBeNull();
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  it('起点が人間（human）の本文は Markdown の描画経路を通らない', async () => {
    stubCommitments([commitment({ origin: 'human', body: '## これは見出しではない' })]);
    renderPage();

    const body = await screen.findByText('## これは見出しではない');
    expect(screen.queryByRole('heading', { name: 'これは見出しではない' })).toBeNull();
    expect(body.textContent).toContain('## これは見出しではない');
  });

  it('起点が外部（external）の本文も Markdown の描画経路を通らない', async () => {
    stubCommitments([commitment({ origin: 'external', body: '## これも見出しではない' })]);
    renderPage();

    const body = await screen.findByText('## これも見出しではない');
    expect(screen.queryByRole('heading', { name: 'これも見出しではない' })).toBeNull();
    expect(body.textContent).toContain('## これも見出しではない');
  });

  it('起点が人間（human）の本文は whitespace-pre-wrap と break-words を持つ', async () => {
    stubCommitments([commitment({ origin: 'human', body: '素のままの本文' })]);
    renderPage();

    const body = await screen.findByText('素のままの本文');
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    expect(tokens).toContain('break-words');
  });

  it('起点が自分（self）の本文も break-words を持つ要素の内側にある', async () => {
    stubCommitments([commitment({ origin: 'self', body: 'クローンが書いた本文' })]);
    renderPage();

    const body = await screen.findByText('クローンが書いた本文');
    expect(body.closest('.break-words')).not.toBeNull();
  });

  it('片付いた行（ClosedRow）でも origin による分岐が同じように効く', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-self',
          origin: 'self',
          body: '## 片付けた見出し',
          closedAt: new Date().toISOString(),
        }),
        commitment({
          id: 'closed-human',
          origin: 'human',
          body: '## 見出しではない',
          closedAt: new Date().toISOString(),
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    expect(await screen.findByRole('heading', { name: '片付けた見出し' })).toBeTruthy();
    expect(screen.getByText('## 見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '見出しではない' })).toBeNull();
  });

  it('closedReason は closedBy が clone のとき Markdown の描画経路を通る', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出し',
          closedBy: 'clone',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(await screen.findByRole('heading', { name: '理由の見出し' })).toBeTruthy();
    expect(screen.queryByText('## 理由の見出し')).toBeNull();
  });

  it('closedReason は closedBy が無いとき（導入前の行）素のテキストのまま', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-legacy',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出しではない',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(screen.getByText('## 理由の見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '理由の見出しではない' })).toBeNull();
  });

  it('closedReason は closedBy が human のとき素のテキストのまま（whitespace-pre-wrap を保つ）', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-human',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出しではない',
          closedBy: 'human',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    const reason = screen.getByText('## 理由の見出しではない');
    expect(screen.queryByRole('heading', { name: '理由の見出しではない' })).toBeNull();
    const p = reason.closest('p');
    expect(p).not.toBeNull();
    const tokens = (p?.className ?? '').split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  // console.warn 自体は検証しない: vitest の既定 reporter が通ったテストの出力を横取りするため
  it('closedReason は schema に無い closedBy が来ても、消さず素のテキストとして出す', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-unknown',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出しではない',
          closedBy: 'manager',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(screen.getByText('## 理由の見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '理由の見出しではない' })).toBeNull();
  });

  it('schema に無い origin が来ても、本文を消さず素のテキストとして出す（実行時の倒れ先）', async () => {
    stubCommitments([
      commitment({ origin: 'probe' as CommitmentOrigin, body: '未知の起点からの本文' }),
    ]);
    renderPage();

    const body = await screen.findByText('未知の起点からの本文');
    expect(body.tagName).toBe('P');
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    expect(tokens).toContain('break-words');
  });
});

describe('本文の編集（未了の行すべて。origin では隠さない）', () => {
  it('origin が human の未了行には「本文を編集」の入口が出る', async () => {
    stubCommitments([commitment({ origin: 'human' })]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByRole('button', { name: /の本文を編集$/ })).toBeTruthy();
  });

  it.each(['self', 'manager', 'external'] as const)(
    'origin が %s の未了行にも編集の入口が出る（隠すと「なぜ押せないか」が消える）',
    async (origin) => {
      stubCommitments([commitment({ origin, body: `${origin} の本文` })]);
      renderPage();

      await screen.findByText(`${origin} の本文`);
      expect(screen.getByRole('button', { name: /の本文を編集$/ })).toBeTruthy();
    },
  );

  it('片付いた行には origin が human でも編集の入口が出ない', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          origin: 'human',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '直した',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(screen.getAllByRole('button', { name: /の本文を編集$/ })).toHaveLength(1);
  });

  it('編集を開くと既定タブはプレビューで、中身が素テキストのまま出る（Markdown へ倒さない）', async () => {
    stubCommitments([commitment({ origin: 'human', body: '## 見出しではない' })]);
    renderPage();

    await screen.findByText('## 見出しではない');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));

    const previewTab = await screen.findByRole('tab', { name: 'プレビュー' });
    expect(previewTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('## 見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '見出しではない' })).toBeNull();
    // Tabs.Root の中だけを見る: queryByRole('textbox') を素で呼ぶと、片付ける理由の Input や積む本文の Textarea まで拾って複数一致で例外になるため
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    expect(within(tabsRoot).queryByRole('textbox')).toBeNull();
  });

  it('self の行のプレビューは、一覧と同じく Markdown の描画経路を通る（下書きも同じ）', async () => {
    stubCommitments([commitment({ origin: 'self', body: '## 引き受けた見出し' })]);
    renderPage();

    await screen.findByRole('heading', { name: '引き受けた見出し' });
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));

    expect(await screen.findByRole('heading', { name: '引き受けた見出し' })).toBeTruthy();

    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '## 直した見出し' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));

    expect(await screen.findByRole('heading', { name: '直した見出し' })).toBeTruthy();
  });

  // 画面の全文を完全一致で固定しない: 文面の持ち主はサーバで、断りの文面が良くなった日に無関係な PR が赤くなるため
  it('保存が 403 で断られると、サーバが返した理由が画面に出る（origin を名指しした本文）', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-7')) {
        return json(
          {
            error:
              "cmt-7 は origin:'self' で、クローンやマネージャーが立てた行は人間からは直せない",
          },
          403,
        );
      }
      if (url.includes('/commitments')) {
        return json({
          entries: [commitment({ id: 'cmt-7', origin: 'self', body: 'クローンが積んだ行' })],
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    renderPage();

    await screen.findByText('クローンが積んだ行');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    // Tabs.Root の中だけを見る: 無関係な Input と role が衝突するため
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '直したい本文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("origin:'self'");
  });

  it('⭐ タブを往復しても下書きが消えない', async () => {
    stubCommitments([commitment({ origin: 'human', body: 'もとの本文' })]);
    renderPage();

    await screen.findByText('もとの本文');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    const tabsRoot = screen.getByRole('tablist').parentElement!;

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '書きかけの本文' } });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    expect(await screen.findByText('書きかけの本文')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '編集' }));
    const textareaAgain = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
    expect(textareaAgain.value).toBe('書きかけの本文');
  });

  it('保存すると、正しい id と本文で PATCH /commitments/{id} が呼ばれる', async () => {
    // 共有の stubFetch に頼らず Request 本体から method と本文を読む: stubFetch は URL しか見ず、GET と PATCH を区別できないため
    let patchCalled = false;
    let patchBody: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-42')) {
        patchCalled = true;
        patchBody = await request.json();
        return json({ ok: true });
      }
      if (url.includes('/commitments')) {
        return json({
          entries: [commitment({ id: 'cmt-42', origin: 'human', body: 'もとの依頼' })],
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    renderPage();

    await screen.findByText('もとの依頼');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    // Tabs.Root の中だけを見る: 無関係な Input と role が衝突するため
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patchCalled).toBe(true));
    expect(patchBody).toEqual({ body: '直した依頼' });
  });

  it('保存が 409（その間に片付けられた）で返ると、人間に見える形でエラーが出る', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-42')) {
        return json(
          { error: 'cmt-42 は既に 2026-08-26T00:00:00.000Z に片付いている（直した）' },
          409,
        );
      }
      if (url.includes('/commitments')) {
        return json({
          entries: [commitment({ id: 'cmt-42', origin: 'human', body: 'もとの依頼' })],
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    renderPage();

    await screen.findByText('もとの依頼');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    // Tabs.Root の中だけを見る: 無関係な Input と role が衝突するため
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText(/既に.*に片付いている/)).toBeTruthy();
  });

  it('editedAt が在る行に「編集済み」の印が出る', async () => {
    stubCommitments([
      commitment({
        origin: 'human',
        body: '直した後の本文',
        editedAt: '2026-08-26T00:00:00.000Z',
      }),
    ]);
    renderPage();

    await screen.findByText('直した後の本文');
    expect(screen.getByText(/編集済み/)).toBeTruthy();
  });

  it('editedAt が無い行には「編集済み」の印が出ない（一度も編集していない）', async () => {
    stubCommitments([commitment({ origin: 'human', body: '編集していない本文' })]);
    renderPage();

    await screen.findByText('編集していない本文');
    expect(screen.queryByText(/編集済み/)).toBeNull();
  });
});

describe('利用者に内部表現を見せない・入力欄に名前が在る（#2801 / #2787）', () => {
  const CONV_ID = '2fa61863-1e7e-4bc2-acd6-48a465a650de';

  it('人間の行の出どころは、会話の冒頭を名前にした会話へのリンクで、UUID は文字として出ない', async () => {
    stubFetch((url) => {
      if (url.includes('/conversations')) {
        return json({
          conversations: [
            {
              conversationId: CONV_ID,
              preview: 'こんにちは。一言で自己紹介して',
              updatedAt: new Date().toISOString(),
              messages: 2,
            },
          ],
          hiddenByLimit: 0,
        });
      }
      if (!url.includes('/commitments')) return undefined;
      return json({ entries: [commitment({ origin: 'human', source: CONV_ID })] });
    });
    renderPageWithRouter();

    const link = await screen.findByRole('link', {
      name: /会話「こんにちは。一言で自己紹介して」/,
    });
    expect(link.getAttribute('href')).toBe(`/chat/${CONV_ID}`);
    expect(document.body.textContent).not.toContain(CONV_ID);
  });

  function stubConversations(opts: {
    recent: { conversationId: string; preview: string }[];
    detail: (id: string) => Response;
  }) {
    return stubFetch((url) => {
      const detail = /\/conversations\/([^/?]+)/.exec(url);
      if (detail !== null) return opts.detail(detail[1]!);
      if (url.includes('/conversations')) {
        return json({
          conversations: opts.recent.map((c) => ({
            ...c,
            updatedAt: new Date().toISOString(),
            messages: 1,
          })),
          hiddenByLimit: 0,
        });
      }
      if (!url.includes('/commitments')) return undefined;
      return json({ entries: [commitment({ origin: 'human', source: CONV_ID })] });
    });
  }

  it('直近の一覧に載っている会話は、1件を引かずに一覧から名前を取る', async () => {
    const calls = stubConversations({
      recent: [{ conversationId: CONV_ID, preview: '直近の会話' }],
      detail: () => json({ error: 'not found' }, 404),
    });
    renderPageWithRouter();

    await screen.findByRole('link', { name: /会話「直近の会話」/ });
    expect(calls.calls.some((url) => url.includes(`/conversations/${CONV_ID}`))).toBe(false);
  });

  it('直近に無くても1件引ける会話は、会話へのリンクになる', async () => {
    stubConversations({
      recent: [],
      detail: (id) =>
        json({
          conversationId: id,
          messages: [
            { id: 'm1', at: '2026-01-01T00:00:00.000Z', role: 'inbound', text: '古い会話の最初' },
            { id: 'm2', at: '2026-01-01T00:01:00.000Z', role: 'outbound', text: '古い会話の返事' },
          ],
          readThrough: null,
          unreadCount: 0,
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        }),
    });
    renderPageWithRouter();

    const link = await screen.findByRole('link', { name: /会話「古い会話の返事」/ });
    expect(link.getAttribute('href')).toBe(`/chat/${CONV_ID}`);
    expect(document.body.textContent).not.toContain(CONV_ID);
  });

  it('直近に無く、引いても 404 なら会話ではない（承認の id など）。「人間」とだけ出す', async () => {
    stubConversations({
      recent: [],
      detail: () => json({ error: 'not found' }, 404),
    });
    renderPageWithRouter();

    await screen.findByText('ドキュメントの誤りを直す');
    await waitFor(() => expect(document.body.textContent).toContain('人間'));
    expect(document.body.textContent).not.toContain(CONV_ID);
    expect(screen.queryByRole('link', { name: /会話/ })).toBeNull();
    expect(screen.queryByText(/確かめられなかった/)).toBeNull();
  });

  it('引くのに失敗したとき（404 以外）は「人間」に潰さず、確かめられなかったと出す', async () => {
    stubConversations({
      recent: [],
      detail: () => json({ error: 'boom' }, 500),
    });
    renderPageWithRouter();

    expect(await screen.findByText(/会話？（確かめられなかった）/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /会話/ })).toBeNull();
    expect(document.body.textContent).not.toContain(CONV_ID);
    expect(screen.getByText('ドキュメントの誤りを直す')).toBeTruthy();
  });

  it('外部イベントの JSON は、note だけなら文面、平たい欄なら「欄: 値」の行で出る', async () => {
    stubCommitments([
      commitment({
        id: 'a',
        origin: 'external',
        source: 'manual',
        body: '{ "note": "請求書を確認する" }',
      }),
      commitment({
        id: 'b',
        origin: 'external',
        source: 'ci',
        body: '{"repo":"alteroid","failed":3}',
      }),
    ]);
    renderPage();

    expect(await screen.findByText('請求書を確認する')).toBeTruthy();
    expect(document.body.textContent).not.toContain('{ "note"');
    expect(screen.getByText(/repo: alteroid/)).toBeTruthy();
    expect(screen.getByText(/failed: 3/)).toBeTruthy();
    expect(readableExternalBody('{壊れた')).toBe('{壊れた');
    expect(readableExternalBody('{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
  });

  it('仕事を登録する欄と、行ごとの「片付けた理由」欄にラベルが在る（入力後も名前が残る）', async () => {
    stubCommitments([
      commitment({ id: 'a', body: '請求書を確認する' }),
      commitment({ id: 'b', body: '議事録を共有する' }),
    ]);
    renderPage();

    const push = await screen.findByLabelText('何を引き受けたか');
    fireEvent.change(push, { target: { value: 'あ' } });
    expect(screen.getByLabelText('何を引き受けたか')).toBe(push);

    const first = screen.getByLabelText('「請求書を確認する」を片付けた理由');
    const second = screen.getByLabelText('「議事録を共有する」を片付けた理由');
    expect(first).not.toBe(second);
  });
});

describe('入力欄の補足文', () => {
  it('登録欄・片付ける欄の条件は常時表示の補足文で、欄と aria-describedby で結ばれる', async () => {
    stubCommitments([commitment()]);
    renderPage();

    const body = await screen.findByLabelText('何を引き受けたか');
    const bodyHint = document.getElementById(body.getAttribute('aria-describedby') ?? '');
    expect(bodyHint?.textContent).toMatch(/commitment_list/);
    expect(bodyHint?.textContent).not.toMatch(/一覧側の仕事/);
    expect((body as HTMLTextAreaElement).placeholder).not.toMatch(/一覧側/);

    const reason = screen.getByLabelText(/を片付けた理由$/);
    const reasonHint = document.getElementById(reason.getAttribute('aria-describedby') ?? '');
    expect(reasonHint?.textContent).toMatch(/後から否定できる/);
    expect((reason as HTMLInputElement).placeholder).not.toMatch(/否定/);
  });
});

const BODY_LABEL = '「ドキュメントの誤りを直す」の本文';

describe('本文の編集: 未保存のまま離れる前に確認する（#2764）', () => {
  async function startEditing() {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    const router = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /の本文を編集$/ }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await screen.findByLabelText(BODY_LABEL)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '書きかけ' } });
    return router;
  }

  it('書きかけのままアプリ内で移動しようとすると確認が出る。やめれば留まり下書きが残る', async () => {
    const router = await startEditing();

    await act(async () => {
      void router.navigate('/elsewhere');
    });

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
    expect((screen.getByLabelText(BODY_LABEL) as HTMLTextAreaElement).value).toBe('書きかけ');
  });

  it('「破棄して離れる」を押すと移動する', async () => {
    const router = await startEditing();
    await act(async () => {
      void router.navigate('/elsewhere');
    });

    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
  });

  it('変更が無ければ確認なしで移動し、beforeunload も警告しない。書きかけのときだけ警告する', async () => {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    const router = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /の本文を編集$/ }));
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText(BODY_LABEL), { target: { value: '書きかけ' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    fireEvent.change(screen.getByLabelText(BODY_LABEL), {
      target: { value: 'ドキュメントの誤りを直す' },
    });
    const back = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(false);
    await act(async () => {
      void router.navigate('/elsewhere');
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('2行同時に編集を開き、先の行だけ書きかけでも移動は止まる（ブロッカーはページに1つ）', async () => {
    stubCommitments([
      commitment({ id: 'a', body: '先の仕事' }),
      commitment({ id: 'b', body: '後の仕事' }),
    ]);
    const router = renderPage();
    const openers = await screen.findAllByRole('button', { name: /の本文を編集$/ });
    fireEvent.click(openers[0]!);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('「先の仕事」の本文'), {
      target: { value: '書きかけ' },
    });
    fireEvent.click(openers[1]!);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /の編集をやめる$/ })).toHaveLength(2),
    );

    await act(async () => {
      void router.navigate('/elsewhere');
    });

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('本文の編集: 書きかけがあるときだけ、やめる前に確認する（#3375）', () => {
  async function startEditing(draft: string | null) {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    const router = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /の本文を編集$/ }));
    if (draft !== null) {
      fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
      fireEvent.change(await screen.findByLabelText(BODY_LABEL), { target: { value: draft } });
    }
    return router;
  }

  it('「本文を編集」「編集をやめる」には、どの行かが分かる名前が付く（見える文言は変わらない）', async () => {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    renderPage();
    const open = await screen.findByRole('button', {
      name: '「ドキュメントの誤りを直す」の本文を編集',
    });
    expect(open.textContent).toBe('本文を編集');
    fireEvent.click(open);
    const close = await screen.findByRole('button', {
      name: '「ドキュメントの誤りを直す」の編集をやめる',
    });
    expect(close.textContent).toBe('編集をやめる');
  });

  it.each([
    ['行の右上の「編集をやめる」', /の編集をやめる$/],
    ['編集欄の「やめる」', 'やめる'],
  ])('書きかけのとき、%s は確認を挟み、閉じない', async (_name, button) => {
    await startEditing('書きかけ');

    fireEvent.click(screen.getByRole('button', { name: button }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('保存していない変更があります')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((screen.getByLabelText(BODY_LABEL) as HTMLTextAreaElement).value).toBe('書きかけ');
  });

  it.each([
    ['行の右上の「編集をやめる」', /の編集をやめる$/],
    ['編集欄の「やめる」', 'やめる'],
  ])('書きかけのとき、%s は「破棄して閉じる」で閉じて下書きを捨てる', async (_name, button) => {
    await startEditing('書きかけ');
    fireEvent.click(screen.getByRole('button', { name: button }));

    fireEvent.click(await screen.findByRole('button', { name: '破棄して閉じる' }));

    await waitFor(() => expect(screen.queryByLabelText(BODY_LABEL)).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    expect((screen.getByLabelText(BODY_LABEL) as HTMLTextAreaElement).value).toBe(
      'ドキュメントの誤りを直す',
    );
  });

  it.each([
    ['行の右上の「編集をやめる」', /の編集をやめる$/],
    ['編集欄の「やめる」', 'やめる'],
  ])('何も書いていなければ、%s は確認なしで閉じる', async (_name, button) => {
    await startEditing(null);

    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /の編集をやめる$/ })).toBeNull(),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('元の本文に書き戻していれば、書きかけではないので確認なしで閉じる', async () => {
    await startEditing('書きかけ');
    fireEvent.change(screen.getByLabelText(BODY_LABEL), {
      target: { value: 'ドキュメントの誤りを直す' },
    });

    fireEvent.click(screen.getByRole('button', { name: /の編集をやめる$/ }));

    await waitFor(() => expect(screen.queryByLabelText(BODY_LABEL)).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('「仕事を登録する」の書きかけも、離れる前に確認する（#3375）', () => {
  it('書きかけのままアプリ内で移動しようとすると確認が出て、beforeunload も警告する', async () => {
    stubCommitments([]);
    const router = renderPage();
    const input = await screen.findByLabelText('何を引き受けたか');
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(input, { target: { value: '書きかけの仕事' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    await act(async () => {
      void router.navigate('/elsewhere');
    });
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });

  it('空のままなら確認なしで移動できる', async () => {
    stubCommitments([]);
    const router = renderPage();
    await screen.findByLabelText('何を引き受けたか');
    await act(async () => {
      void router.navigate('/elsewhere');
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('「片付けたものも見る」の初回読み込み中も、未了の行の書きかけを保つ（#3074）', () => {
  function stubSlowClosed(open: Commitment[], closed: Commitment[]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubCommitments(open, closed);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('includeClosed=true')) await gate;
      return inner(input, init);
    }) as typeof fetch;
    return release;
  }

  it('本文の書きかけが、閉じた分の読み込み中も消えない', async () => {
    const release = stubSlowClosed(
      [commitment({ origin: 'human', body: 'もとの本文' })],
      [commitment({ id: 'cmt-9', body: '片付いた依頼', closedAt: new Date().toISOString() })],
    );
    renderPage();

    await screen.findByText('もとの本文');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '書きかけの本文' } });

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    expect(screen.getByRole('tablist')).toBeTruthy();
    expect((within(tabsRoot).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      '書きかけの本文',
    );
    expect(screen.queryByText('完了した仕事の記録はまだない。')).toBeNull();

    release();
    await screen.findByText('片付いた依頼');
    expect((within(tabsRoot).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      '書きかけの本文',
    );
  });

  it('片付ける理由の書きかけが、閉じた分の読み込み中も消えない', async () => {
    const release = stubSlowClosed(
      [commitment({ body: 'もとの本文' })],
      [commitment({ id: 'cmt-9', body: '片付いた依頼', closedAt: new Date().toISOString() })],
    );
    renderPage();

    await screen.findByText('もとの本文');
    const reason = screen.getByLabelText(/を片付けた理由$/) as HTMLInputElement;
    fireEvent.change(reason, { target: { value: '書きかけの理由' } });

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    expect((screen.getByLabelText(/を片付けた理由$/) as HTMLInputElement).value).toBe(
      '書きかけの理由',
    );
    release();
    await screen.findByText('片付いた依頼');
    expect((screen.getByLabelText(/を片付けた理由$/) as HTMLInputElement).value).toBe(
      '書きかけの理由',
    );
  });
});

describe('閉じた分が0件のときの再検証で「記録はまだない」がちらつかない（#3074）', () => {
  it('閉じた分を読み終えた後の再検証中も、空の表示のまま（スピナーに戻らない）', async () => {
    stubCommitments([commitment({ body: 'もとの本文' })], []);
    renderPage();

    await screen.findByText('もとの本文');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));
    await screen.findByText('完了した仕事の記録はまだない。');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      held += 1;
      await gate;
      return inner(input, init);
    }) as typeof fetch;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(held).toBeGreaterThan(0));

    expect(screen.getByText('完了した仕事の記録はまだない。')).toBeTruthy();
    await act(async () => {
      release();
    });
    expect(screen.getByText('完了した仕事の記録はまだない。')).toBeTruthy();
  });
});

describe('本文の編集の保存の門と送るキーの案内（#3300）', () => {
  async function openEditor() {
    await screen.findByText('もとの依頼');
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    return screen.getByRole('tablist').parentElement!;
  }

  it('保存中に Ctrl+S をもう一度押しても PATCH は1回だけ', async () => {
    let patches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-1')) {
        patches += 1;
        await gate;
        return json({ ok: true });
      }
      if (url.includes('/commitments')) {
        return json({ entries: [commitment({ body: 'もとの依頼' })] });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    renderPage();

    const tabsRoot = await openEditor();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '直した依頼' } });

    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    await waitFor(() => expect(patches).toBe(1));
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    release();
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(patches).toBe(1);
  });

  it('送るキーの案内は編集のタブでだけ出る（プレビューでは出ない）', async () => {
    stubCommitments([commitment({ body: 'もとの依頼' })]);
    renderPage();

    await openEditor();
    expect(screen.queryByText(/Enter で保存$/)).toBeNull();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    expect(await screen.findByText(/Enter で保存$/)).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    await waitFor(() => expect(screen.queryByText(/Enter で保存$/)).toBeNull());
  });

  it('Cmd/Ctrl+S でも保存できることを、編集のタブでだけ案内する（#3788）', async () => {
    stubCommitments([commitment({ body: 'もとの依頼' })]);
    renderPage();

    await openEditor();
    expect(screen.queryByText('⌘/Ctrl + S で保存')).toBeNull();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    expect(await screen.findByText('⌘/Ctrl + S で保存')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    await waitFor(() => expect(screen.queryByText('⌘/Ctrl + S で保存')).toBeNull());
  });
});

describe('本文の編集: 保存は trim して送る（#3788）', () => {
  function stubPatch(original: string) {
    const sent: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-1')) {
        sent.push(await request.json());
        await gate;
        return json({ ok: true });
      }
      if (url.includes('/commitments')) {
        return json({ entries: [commitment({ body: original })] });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    return { sent, release };
  }

  async function openEditor(original: string) {
    await screen.findByText(original);
    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    return screen.findByLabelText(`「${original}」の本文`);
  }

  it('前後の空白と改行を落として送る（積むのと揃える）', async () => {
    const { sent, release } = stubPatch('もとの依頼');
    renderPage();
    const textarea = await openEditor('もとの依頼');

    fireEvent.change(textarea, { target: { value: '  直した依頼\n\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(sent).toEqual([{ body: '直した依頼' }]));
    release();
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
  });

  it('末尾の空白だけを足した下書きは変更なし: 保存は押せず、どのキーでも送らず、離れる確認も出ない', async () => {
    const { sent } = stubPatch('もとの依頼');
    renderPage();
    const textarea = await openEditor('もとの依頼');

    fireEvent.change(textarea, { target: { value: 'もとの依頼\n  ' } });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('応答を待つ間に末尾の空白だけを打ち足しても、本文は変わらないので編集欄は畳む', async () => {
    const { sent, release } = stubPatch('もとの依頼');
    renderPage();
    const textarea = await openEditor('もとの依頼');

    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent).toEqual([{ body: '直した依頼' }]));
    fireEvent.change(textarea, { target: { value: '直した依頼\n' } });
    release();

    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
  });

  it('応答を待つ間に本文を打ち足したときは、畳まず下書きを残す（#3515 のまま）', async () => {
    const { sent, release } = stubPatch('もとの依頼');
    renderPage();
    const textarea = await openEditor('もとの依頼');

    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent).toEqual([{ body: '直した依頼' }]));
    fireEvent.change(textarea, { target: { value: '直した依頼 さらに' } });
    release();

    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeTruthy());
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('直した依頼 さらに'));
    expect(screen.getByRole('tablist')).toBeTruthy();
  });
});

describe('本文の編集欄の名前は行ごとに区別される（#3788）', () => {
  it('複数の行で編集を開いても、欄は本文で引き分けられる', async () => {
    stubCommitments([
      commitment({ id: 'cmt-1', body: '請求書を確認する' }),
      commitment({ id: 'cmt-2', body: '議事録を共有する' }),
    ]);
    renderPage();

    await screen.findByText('請求書を確認する');
    for (const button of screen.getAllByRole('button', { name: /の本文を編集$/ })) {
      fireEvent.click(button);
    }
    for (const tab of await screen.findAllByRole('tab', { name: '編集' })) {
      fireEvent.mouseDown(tab);
    }

    const first = await screen.findByLabelText('「請求書を確認する」の本文');
    const second = await screen.findByLabelText('「議事録を共有する」の本文');
    expect(first).not.toBe(second);
    expect((first as HTMLTextAreaElement).value).toBe('請求書を確認する');
    expect((second as HTMLTextAreaElement).value).toBe('議事録を共有する');
  });
});
