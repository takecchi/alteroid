// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import Integrations from './integrations';

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

const SECRET_VALUE = 'altk_SECRETVALUE0123456789';

function view(over: Record<string, unknown> = {}) {
  return {
    id: 'k-1',
    name: 'CI',
    source: 'ci.main',
    fingerprint: 'abcdef012345',
    createdAt: '2026-09-30T00:00:00.000Z',
    createdBy: '実行環境の持ち主による操作',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    limits: { maxBodyBytes: 1_048_576, ratePerMinute: 60 },
    ...over,
  };
}

type Reply = { status: number; body: unknown };

interface Stub {
  posts: { path: string; body: unknown }[];
  gets: () => number;
  setGet: (reply: Reply) => void;
  setPost: (reply: Reply) => void;
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので method も本文も落ちるため
function stubKeys(options: { get?: Reply; post?: Reply; revoke?: Reply } = {}): Stub {
  let getReply: Reply = options.get ?? { status: 200, body: { keys: [view()] } };
  let postReply: Reply = options.post ?? {
    status: 200,
    body: { key: view({ id: 'k-new', name: '新しい鍵', source: 'new.src' }), value: SECRET_VALUE },
  };
  const posts: Stub['posts'] = [];
  let gets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (!path.includes('/integration-keys')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'POST') {
      const text = request !== null ? await request.text() : String(init?.body ?? '');
      posts.push({ path, body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined });
      if (path.endsWith('/revoke')) {
        const reply = options.revoke ?? {
          status: 200,
          body: { key: view({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
        };
        return json(reply.body, reply.status);
      }
      return json(postReply.body, postReply.status);
    }
    gets += 1;
    return json(getReply.body, getReply.status);
  }) as typeof fetch;
  return {
    posts,
    gets: () => gets,
    setGet: (reply) => {
      getReply = reply;
    },
    setPost: (reply) => {
      postReply = reply;
    },
  };
}

function renderScreen() {
  render(
    <Providers>
      <TestDataRouter>
        <Integrations />
      </TestDataRouter>
    </Providers>,
  );
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('/integrations 画面 — 一覧', () => {
  it('名前・source・状態・作成者・最終使用・期限・指紋・上限を出し、MCP 登録への案内を置く', async () => {
    stubKeys({
      get: {
        status: 200,
        body: {
          keys: [
            view({ lastUsedAt: '2026-09-30T05:00:00.000Z' }),
            view({ id: 'k-2', name: '古い', revokedAt: '2026-09-30T12:00:00.000Z' }),
            view({ id: 'k-3', name: '切れた', expiresAt: '2020-01-01T00:00:00.000Z' }),
          ],
        },
      },
    });
    renderScreen();

    expect(await screen.findByText('CI')).toBeTruthy();
    expect(screen.getByText('有効')).toBeTruthy();
    expect(screen.getAllByText('失効')).toHaveLength(2);
    expect(screen.getByText('期限切れ')).toBeTruthy();
    expect(screen.getAllByText('ci.main').length).toBeGreaterThan(0);
    expect(screen.getAllByText('abcdef012345').length).toBe(3);
    expect(screen.getAllByText('（無期限）').length).toBe(2);
    expect(screen.getAllByText(/実行環境の持ち主による操作/).length).toBe(3);
    expect(screen.getAllByText('本文 1048576 バイト・60 回/分').length).toBe(3);
    expect(document.body.textContent).not.toContain('altk_');
    expect(screen.queryByRole('button', { name: '古い を失効する' })).toBeNull();
    expect(screen.getByRole('button', { name: 'CI を失効する' })).toBeTruthy();

    const link = screen.getByRole('link', { name: 'MCP サーバの登録' });
    expect(link.getAttribute('href')).toBe('/mcp-servers');
  });

  it('0件なら「まだ無い」と言い、発行の欄は出す', async () => {
    stubKeys({ get: { status: 200, body: { keys: [] } } });
    renderScreen();
    expect(await screen.findByText('連携の鍵はまだ無い。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '発行する' })).toBeTruthy();
  });

  it('最初の読み込みが失敗しても、発行の欄は出し、失敗を言う', async () => {
    stubKeys({ get: { status: 500, body: { error: '壊れた' } } });
    renderScreen();
    expect(await screen.findByText('連携の鍵の一覧を読み込めませんでした')).toBeTruthy();
    expect(screen.getByRole('button', { name: '発行する' })).toBeTruthy();
  });
});

describe('/integrations 画面 — 発行', () => {
  it('発行すると値を1回だけ見せ、二度と表示されない旨・写しの口・送り方の例（値なし）を出す', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');

    fill('名前（見分けるための呼び名）', '新しい鍵');
    fill('source', 'new.src');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));

    expect(await screen.findByText('発行した: 新しい鍵')).toBeTruthy();
    expect(stub.posts).toEqual([
      { path: '/integration-keys', body: { name: '新しい鍵', source: 'new.src' } },
    ]);
    expect(document.body.textContent?.split(SECRET_VALUE)).toHaveLength(2);
    expect(screen.getByText(/この値は二度と表示されない/)).toBeTruthy();
    const copies: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copies.push(text);
          return Promise.resolve();
        },
      },
    });
    const copyButtons = screen.getAllByRole('button', { name: /写す/ });
    expect(copyButtons).toHaveLength(3);
    fireEvent.click(copyButtons[0] as HTMLElement);
    fireEvent.click(copyButtons[1] as HTMLElement);
    expect(copies).toEqual([SECRET_VALUE, 'http://daemon.test']);
    const example = screen.getByText(/curl -X POST/).textContent ?? '';
    expect(example).toContain('curl -X POST http://daemon.test/events/new.src');
    expect(example).toContain('Authorization: Bearer <上の値>');
    expect(example).not.toContain(SECRET_VALUE);
    expect(screen.getByLabelText<HTMLInputElement>('source').value).toBe('');
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET_VALUE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET_VALUE);

    fireEvent.click(screen.getByRole('button', { name: '値を消して閉じる' }));
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
  });

  it('名前が 200 文字を超えたら、黙って切らず欄の下で言い、送らない（CLI と同じ上限）', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');
    const long = 'あ'.repeat(201);
    fill('名前（見分けるための呼び名）', long);
    fill('source', 'new.src');
    expect(screen.getByLabelText<HTMLInputElement>('名前（見分けるための呼び名）').value).toBe(
      long,
    );
    expect(screen.getByText(/名前は 1〜200 文字で指定してください/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(stub.posts).toEqual([]);
    fill('名前（見分けるための呼び名）', 'あ'.repeat(200));
    expect(screen.queryByText(/名前は 1〜200 文字で指定してください/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText(/発行した:/);
    expect(stub.posts).toHaveLength(1);
  });

  it('期限と上限の上書きを送る。上限の既定は畳んだ欄に出す', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');

    expect(screen.getByText(/本文 1 MiB = 1048576 バイト・60 回\/分/)).toBeTruthy();
    fill('名前（見分けるための呼び名）', 'x');
    fill('source', 'a-b_c.d');
    fill(/期限/, '2099-01-01T00:00');
    fill('本文の上限（バイト）', '2048');
    fill('1分あたりの回数', '5');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText(/発行した:/);

    expect(stub.posts[0]?.body).toEqual({
      name: 'x',
      source: 'a-b_c.d',
      expiresAt: new Date('2099-01-01T00:00').toISOString(),
      maxBodyBytes: 2048,
      ratePerMinute: 5,
    });
  });

  it('入力の誤り（source の形・過去の期限・上限）は送らず、入力を残して言う', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');

    fill('名前（見分けるための呼び名）', '名前');
    fill('source', 'Bad Source');
    fill(/期限/, '2000-01-01T00:00');
    fill('1分あたりの回数', '0');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('source は英小文字');
    expect(alert.textContent).toContain('期限が過去です');
    expect(alert.textContent).toContain('1分あたりの回数');
    expect(stub.posts).toEqual([]);
    expect(screen.getByLabelText<HTMLInputElement>('source').value).toBe('Bad Source');
  });

  it('発行が失敗しても書きかけを残し、失敗を出す（値は出ない）', async () => {
    const stub = stubKeys({ post: { status: 500, body: { error: '保存できなかった' } } });
    renderScreen();
    await screen.findByText('CI');

    fill('名前（見分けるための呼び名）', '書きかけの名前');
    fill('source', 'keep.me');
    fill(/期限/, '2099-01-01T00:00');
    fill('本文の上限（バイト）', '2048');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));

    expect(await screen.findByText('保存できなかった')).toBeTruthy();
    expect(stub.posts).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>('名前（見分けるための呼び名）').value).toBe(
      '書きかけの名前',
    );
    expect(screen.getByLabelText<HTMLInputElement>('source').value).toBe('keep.me');
    expect(screen.getByLabelText<HTMLInputElement>(/期限/).value).toBe('2099-01-01T00:00');
    expect(screen.getByLabelText<HTMLInputElement>('本文の上限（バイト）').value).toBe('2048');
    expect(screen.getByText(/入力はそのまま残してある/)).toBeTruthy();
    expect(screen.queryByText(/発行した:/)).toBeNull();
    expect(screen.getByText('CI')).toBeTruthy();

    stub.setPost({
      status: 200,
      body: {
        key: view({ id: 'k-new', name: '書きかけの名前', source: 'keep.me' }),
        value: SECRET_VALUE,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText('発行した: 書きかけの名前')).toBeTruthy();
  });
});

describe('/integrations 画面 — 再取得の失敗', () => {
  it('一覧の再取得が失敗しても、一覧・発行の欄・書きかけを残し、帯で言う（再試行で戻る）', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');
    fill('名前（見分けるための呼び名）', '書きかけ');

    stub.setGet({ status: 500, body: { error: '一時的な失敗' } });
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText('連携の鍵の一覧を読み込めませんでした')).toBeTruthy();
    expect(screen.getByText('CI')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('名前（見分けるための呼び名）').value).toBe(
      '書きかけ',
    );
    expect(screen.getByRole('button', { name: '発行する' })).toBeTruthy();

    stub.setGet({ status: 200, body: { keys: [view(), view({ id: 'k-9', name: '追加' })] } });
    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }));
    expect(await screen.findByText('追加')).toBeTruthy();
    expect(screen.queryByText('連携の鍵の一覧を読み込めませんでした')).toBeNull();
  });

  it('発行は済んだが一覧の取り直しが失敗したとき、値は見せたまま、発行の失敗にしない', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');

    stub.setGet({ status: 500, body: { error: '一時的な失敗' } });
    fill('名前（見分けるための呼び名）', '新しい鍵');
    fill('source', 'new.src');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));

    expect(await screen.findByText('発行した: 新しい鍵')).toBeTruthy();
    expect(document.body.textContent?.split(SECRET_VALUE)).toHaveLength(2);
    expect(await screen.findByText('連携の鍵の一覧を読み込めませんでした')).toBeTruthy();
    expect(screen.queryByText(/入力はそのまま残してある/)).toBeNull();
    expect(screen.getByText('CI')).toBeTruthy();
  });
});

describe('/integrations 画面 — 失効', () => {
  it('1回目では POST せず、「本当に失効する」で失効して一覧を取り直す', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');

    fireEvent.click(screen.getByRole('button', { name: 'CI を失効する' }));
    expect(stub.posts).toEqual([]);
    expect(screen.getByText(/すぐ効き、この鍵で送っている外のサービスは 401/)).toBeTruthy();

    const before = stub.gets();
    stub.setGet({
      status: 200,
      body: { keys: [view({ revokedAt: '2026-10-01T00:00:00.000Z' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'CI を本当に失効する' }));
    expect((await screen.findAllByText('失効')).length).toBe(2);
    expect(stub.posts).toEqual([{ path: '/integration-keys/k-1/revoke', body: {} }]);
    expect(stub.gets()).toBeGreaterThan(before);
    expect(screen.queryByRole('button', { name: 'CI を失効する' })).toBeNull();
  });

  it('「やめる」で確認を畳み、POST しない', async () => {
    const stub = stubKeys();
    renderScreen();
    await screen.findByText('CI');
    fireEvent.click(screen.getByRole('button', { name: 'CI を失効する' }));
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(stub.posts).toEqual([]);
    expect(screen.getByRole('button', { name: 'CI を失効する' })).toBeTruthy();
  });

  it('失効が失敗したら、その行に失敗を出し、一覧は残す', async () => {
    stubKeys({ revoke: { status: 500, body: { error: '失効を保存できなかった' } } });
    renderScreen();
    await screen.findByText('CI');
    fireEvent.click(screen.getByRole('button', { name: 'CI を失効する' }));
    fireEvent.click(screen.getByRole('button', { name: 'CI を本当に失効する' }));
    expect(await screen.findByText('失効を保存できなかった')).toBeTruthy();
    const row = screen.getByText('CI').closest('li');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText('有効')).toBeTruthy();
  });
});

describe('/integrations 画面 — 読めない行（#3216）', () => {
  it('読めない行が無ければ、その断りは出ない（鍵ごと無い）', async () => {
    stubKeys();
    renderScreen();
    await screen.findByText('CI');
    expect(screen.queryByText(/読めない連携の鍵の行/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'bad-1 の行を消す' })).toBeNull();
  });

  it('読めない行しか無いとき、「まだ無い」と言わず、件数と id・不正な欄名を断る。id の無い行にはボタンが無い', async () => {
    stubKeys({
      get: {
        status: 200,
        body: {
          keys: [],
          rowsUnreadable: { count: 2, rows: [{ id: 'bad-1', reason: '不正な欄: source' }] },
        },
      },
    });
    renderScreen();
    expect(await screen.findByText(/読めない連携の鍵の行が 2 件ある/)).toBeTruthy();
    expect(screen.getByText('bad-1')).toBeTruthy();
    expect(screen.getByText(/不正な欄: source/)).toBeTruthy();
    expect(screen.getByText(/id が取れない行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/連携の鍵がまだ無い、とは言えない/)).toBeTruthy();
    expect(screen.queryByText('連携の鍵はまだ無い。')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'bad-1 の行を消す' })).toHaveLength(1);
  });

  it('「この行を消す」は確認を経て id を指して POST し、再取得で断りが消える（確認で止めたら POST しない）', async () => {
    const posts: unknown[] = [];
    let unreadable = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.includes('/integration-keys/unreadable/remove') && method === 'POST') {
        posts.push(request !== null ? await request.json() : JSON.parse(String(init?.body)));
        unreadable = false;
        return json({ removedIds: ['bad-1'], count: 1 });
      }
      if (url.includes('/integration-keys')) {
        return json({
          keys: [view()],
          ...(unreadable
            ? { rowsUnreadable: { count: 1, rows: [{ id: 'bad-1', reason: '不正な欄: source' }] } }
            : {}),
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;

    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'bad-1 の行を消す' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('元に戻せません');
    expect(dialog.textContent).toContain('bad-1');
    expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'bad-1 の行を消す' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '消す' }),
    );
    await waitFor(() => {
      expect(posts).toEqual([{ ids: ['bad-1'] }]);
    });
    await waitFor(() => {
      expect(screen.queryByText(/読めない連携の鍵の行が/)).toBeNull();
    });
    expect(screen.getByText('CI')).toBeTruthy();
  });
});

describe('/integrations 画面 — 離れる前の確認（#3556）', () => {
  function unload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('発行が成功して欄が空に戻ったら、確認しない。失敗して入力が残るあいだは確認する', async () => {
    const stub = stubKeys({ post: { status: 500, body: { error: '壊れた' } } });
    renderScreen();
    await screen.findByText('CI');

    fill('名前（見分けるための呼び名）', '新しい鍵');
    fill('source', 'new.src');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await waitFor(() => expect(stub.posts).toHaveLength(1));
    await screen.findByText(/壊れた/);
    expect(unload()).toBe(true);

    stub.setPost({
      status: 200,
      body: {
        key: view({ id: 'k-new', name: '新しい鍵', source: 'new.src' }),
        value: SECRET_VALUE,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText('発行した: 新しい鍵')).toBeTruthy();
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '値を消して閉じる' }));
    await waitFor(() => expect(unload()).toBe(false));
  });

  it('発行した値が出ている間は移動の前に「写していない鍵の値」の確認を出し（値は文に出さない）、閉じた後は出さない（#3571）', async () => {
    stubKeys();
    let router:
      Parameters<NonNullable<Parameters<typeof TestDataRouter>[0]['onRouter']>>[0] | undefined;
    render(
      <Providers>
        <TestDataRouter onRouter={(created) => (router = created)}>
          <Integrations />
        </TestDataRouter>
      </Providers>,
    );
    await screen.findByText('CI');
    fill('名前（見分けるための呼び名）', '新しい鍵');
    fill('source', 'new.src');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText('発行した: 新しい鍵');

    await act(async () => {
      void router?.navigate('/elsewhere');
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('写していない鍵の値があります')).toBeTruthy();
    expect(dialog.textContent).not.toContain(SECRET_VALUE);
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('発行した: 新しい鍵')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '値を消して閉じる' }));
    await act(async () => {
      void router?.navigate('/elsewhere');
    });
    expect(await screen.findByText('別の画面')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
