// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommitmentOrigin } from '@alteroid/core';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';
import { formatDateTime, type Commitment } from '@alteroid/logic';

import Commitments from './commitments';
import { readableExternalBody } from './commitments-body';

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

function stubCommitments(open: Commitment[], closed: Commitment[] = []) {
  return stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
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

  /**
   * **空の枠は、読めなかったものがあるとき言い切らない。** 読めない行・読めない委譲は
   * 「無い」でも「片付いた」でもないので、空は「読めた範囲では」の言い方になる（承認の画面と同じ）。
   */
  describe('空の枠の言い方', () => {
    it('読めない行があって未了が空なら、「読めた範囲では、未了の仕事はない。」と言う', async () => {
      stubFetch((url) => {
        if (!url.includes('/commitments')) return undefined;
        return json({ entries: [], unreadable: [{ id: 'c-bad', reason: '型が合わない' }] });
      });
      renderPage();

      await screen.findByText('読めた範囲では、未了の仕事はない。');
      expect(screen.queryByText('未了の仕事はない。')).toBeNull();
    });

    it('読めない委譲があって未了が空でも、同じ言い方をする', async () => {
      stubFetch((url) => {
        if (!url.includes('/commitments')) return undefined;
        return json({
          entries: [],
          unreadable: [],
          unreadableJobs: [{ id: 'mgr-bad', reason: '不正な欄: status' }],
        });
      });
      renderPage();

      await screen.findByText('読めた範囲では、未了の仕事はない。');
      expect(screen.queryByText('未了の仕事はない。')).toBeNull();
    });

    it('対照: 読めないものが無ければ、言い切る', async () => {
      stubFetch((url) => {
        if (!url.includes('/commitments')) return undefined;
        return json({ entries: [], unreadable: [], trimmedClosed: 0, unreadableJobs: [] });
      });
      renderPage();

      await screen.findByText('未了の仕事はない。');
      expect(screen.queryByText(/読めた範囲では/)).toBeNull();
    });

    it('刈られた記録があって完了が空なら、消えた分があると分かる文にする', async () => {
      stubFetch((url) => {
        if (!url.includes('/commitments')) return undefined;
        return json({ entries: [], unreadable: [], trimmedClosed: 3 });
      });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));
      await screen.findByText('残っている範囲に、完了した仕事の記録はない。');
      expect(screen.queryByText('完了した仕事の記録はまだない。')).toBeNull();
    });

    it('読めない行があって完了が空でも、「読めた範囲では」と言う', async () => {
      stubFetch((url) => {
        if (!url.includes('/commitments')) return undefined;
        return json({ entries: [], unreadable: [{ id: 'c-bad', reason: '型が合わない' }] });
      });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));
      await screen.findByText('読めた範囲では、完了した仕事の記録はない。');
      expect(screen.queryByText('完了した仕事の記録はまだない。')).toBeNull();
    });

    it('対照: 刈られた記録が無ければ、完了の空は「まだない」のまま', async () => {
      stubFetch((url) => {
        if (!url.includes('/commitments')) return undefined;
        return json({ entries: [], unreadable: [], trimmedClosed: 0 });
      });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));
      await screen.findByText('完了した仕事の記録はまだない。');
      expect(screen.queryByText(/残っている範囲/)).toBeNull();
    });
  });

  it('物理削除が0件なら断りを出さない', async () => {
    stubCommitments([commitment()]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.queryByText(/完了済みの仕事が合わせて/)).toBeNull();
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

  it('origin: human でも source（会話）が無い行には「未着手」を出さない: 返事を結べず判定できない（#4817）', async () => {
    stubCommitments([commitment({ origin: 'human', source: undefined })]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.queryByText('未着手')).toBeNull();
    expect(screen.getByText(/返事の判定なし/)).toBeTruthy();
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

// 台帳へ書く口は無い（段2b）ので、編集の入口は無い。それ以前に編集された行の印だけが残る
describe('編集済みの印', () => {
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
    expect(
      screen.getByText(`編集済み（${formatDateTime('2026-08-26T00:00:00.000Z')}）`),
    ).toBeTruthy();
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

  describe('会話の名前にした書き出しの秘密は、会話一覧・CLI と同じく伏せて出す', () => {
    const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

    it('直近の一覧から名前を取るとき', async () => {
      stubConversations({
        recent: [{ conversationId: CONV_ID, preview: `鍵 ${SECRET}` }],
        detail: () => json({ error: 'not found' }, 404),
      });
      renderPageWithRouter();

      const link = await screen.findByRole('link', { name: /会話「鍵 / });
      expect(link.textContent).not.toContain('sk-ant-api03');
    });

    it('1件引いた会話の本文から名前を取るとき', async () => {
      stubConversations({
        recent: [],
        detail: (id) =>
          json({
            conversationId: id,
            messages: [
              { id: 'm1', at: '2026-01-01T00:00:00.000Z', role: 'outbound', text: `鍵 ${SECRET}` },
            ],
            readThrough: null,
            unreadCount: 0,
            scanned: 1,
            reachedStart: true,
            supersededCount: 0,
          }),
      });
      renderPageWithRouter();

      const link = await screen.findByRole('link', { name: /会話「鍵 / });
      expect(link.textContent).not.toContain('sk-ant-api03');
    });
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
describe('会話の名前（24 字）の切れ目', () => {
  const CONV_ID = '2fa61863-1e7e-4bc2-acd6-48a465a650de';

  async function conversationLinkText(preview: string): Promise<string> {
    stubFetch((url) => {
      if (/\/conversations\/[^/?]+/.test(url)) return json({ error: 'not found' }, 404);
      if (url.includes('/conversations')) {
        return json({
          conversations: [
            {
              conversationId: CONV_ID,
              preview,
              updatedAt: new Date().toISOString(),
              messages: 1,
            },
          ],
          hiddenByLimit: 0,
        });
      }
      if (!url.includes('/commitments')) return undefined;
      return json({ entries: [commitment({ origin: 'human', source: CONV_ID })] });
    });
    renderPageWithRouter();
    const link = await screen.findByRole('link', { name: /^会話/ });
    return link.textContent ?? '';
  }

  it('会話の名前は 24 字ちょうどなら切らず、25 字なら 24 字で切る', async () => {
    expect(await conversationLinkText('あ'.repeat(24))).toBe(`会話「${'あ'.repeat(24)}」`);
    cleanup();
    expect(await conversationLinkText('あ'.repeat(25))).toBe(`会話「${'あ'.repeat(24)}…」`);
  });

  it('会話の名前は絵文字の途中で切らない（コードポイントで 24 字）', async () => {
    expect(await conversationLinkText(`${'あ'.repeat(23)}😀😀`)).toBe(
      `会話「${'あ'.repeat(23)}😀…」`,
    );
  });

  it('書き出しが空白だけの会話は「会話」とだけ出す', async () => {
    expect(await conversationLinkText(' \n ')).toBe('会話');
  });
});
