// @vitest-environment jsdom
import { mcpServersSchema } from '@alteroid/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import AccessTokens from './access-tokens';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const SECRET_VALUE = 'alt_SECRETVALUE0123456789';
const NAME_LABEL = '名前（見分けるための呼び名）';

function view(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    accountId: 'acc-1',
    name: '読み取り用',
    kind: 'read',
    origin: 'issued',
    issuedBy: 'acc-1',
    fingerprint: 'abcdef012345',
    createdAt: '2026-11-15T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  };
}

type Reply = { status: number; body: unknown };

interface Stub {
  posts: { path: string; body: unknown }[];
  gets: () => number;
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので method も本文も落ちるため
function stubTokens(options: { get?: Reply; post?: Reply; revoke?: Reply } = {}): Stub {
  const getReply: Reply = options.get ?? { status: 200, body: { tokens: [view()] } };
  const postReply: Reply = options.post ?? {
    status: 200,
    body: { token: view({ id: 't-new', name: '新しいトークン' }), value: SECRET_VALUE },
  };
  const posts: Stub['posts'] = [];
  let gets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (!path.includes('/access-tokens')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'POST') {
      const text = request !== null ? await request.text() : String(init?.body ?? '');
      posts.push({ path, body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined });
      if (path.endsWith('/revoke')) {
        const reply = options.revoke ?? {
          status: 200,
          body: { token: view({ revokedAt: '2026-11-16T00:00:00.000Z' }) },
        };
        return json(reply.body, reply.status);
      }
      return json(postReply.body, postReply.status);
    }
    gets += 1;
    return json(getReply.body, getReply.status);
  }) as typeof fetch;
  return { posts, gets: () => gets };
}

function renderScreen() {
  render(
    <Providers>
      <TestDataRouter>
        <AccessTokens />
      </TestDataRouter>
    </Providers>,
  );
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('/access-tokens 画面 — 一覧', () => {
  it('名前・種類・発行元・状態・期限・最終使用・指紋を出し、値は出さず、/tokens と取り違えない案内を置く', async () => {
    stubTokens({
      get: {
        status: 200,
        body: {
          tokens: [
            view({ lastUsedAt: '2026-11-15T05:00:00.000Z' }),
            view({
              id: 't-2',
              name: 'ログインの端末',
              kind: 'full',
              origin: 'login',
              issuedBy: null,
              expiresAt: null,
            }),
            view({ id: 't-3', name: '古い', revokedAt: '2026-11-15T12:00:00.000Z' }),
            view({ id: 't-4', name: '切れた', expiresAt: '2020-01-01T00:00:00.000Z' }),
          ],
        },
      },
    });
    renderScreen();

    expect(await screen.findByText('読み取り用')).toBeTruthy();
    expect(screen.getAllByText('有効').length).toBe(2);
    expect(screen.getAllByText('失効', { selector: 'span' }).length).toBeGreaterThan(0);
    expect(screen.getByText('期限切れ')).toBeTruthy();
    expect(screen.getAllByText('abcdef012345').length).toBe(4);
    expect(screen.getAllByText('（無期限）').length).toBe(1);
    expect(screen.getAllByText('発行（acc-1）').length).toBe(3);
    expect(screen.getByText('ログイン（alteroid login）')).toBeTruthy();
    expect(screen.getAllByText('full').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('alt_');
    expect(document.body.textContent).not.toContain('sha256:');
    expect(screen.queryByRole('button', { name: '古い を失効する' })).toBeNull();
    expect(screen.getByRole('button', { name: '読み取り用 を失効する' })).toBeTruthy();

    // 設定のタブ帯にも同名のリンクがあるので、本文の案内（p の中）だけを見る
    const guide = screen
      .getAllByRole('link', { name: '認証トークン' })
      .find((link) => link.closest('p') !== null);
    expect(guide?.getAttribute('href')).toBe('/tokens');
  });

  it('0件なら「まだ無い」と言い、発行の欄は出す', async () => {
    stubTokens({ get: { status: 200, body: { tokens: [] } } });
    renderScreen();
    expect(await screen.findByText('アクセストークンはまだ無い。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '発行する' })).toBeTruthy();
  });

  it('最初の読み込みが失敗しても、発行の欄は出し、失敗を言う', async () => {
    stubTokens({ get: { status: 500, body: { error: '壊れた' } } });
    renderScreen();
    expect(await screen.findByText('アクセストークンの一覧を読み込めませんでした')).toBeTruthy();
    expect(screen.getByRole('button', { name: '発行する' })).toBeTruthy();
  });

  it('発行したトークンの資格で開いて 403 のときは、ログインした人か持ち主だけが管理できると言い、発行の欄は出さない', async () => {
    stubTokens({ get: { status: 403, body: { error: '発行したアクセストークンでは…' } } });
    renderScreen();
    expect(await screen.findByText(/この資格ではアクセストークンを管理できない/)).toBeTruthy();
    expect(screen.getByText(/alteroid にログインした人か、実行環境の持ち主だけ/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '発行する' })).toBeNull();
    expect(screen.queryByText('アクセストークンの一覧を読み込めませんでした')).toBeNull();
  });
});

describe('/access-tokens 画面 — 発行フォーム', () => {
  it('種類は read と full の2択だけで既定は read。期限の既定は 30 日（無期限は明示の選択のとき）', async () => {
    stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    const kinds = screen.getAllByRole('radio', { hidden: false });
    const kindRadios = kinds.filter((r) => r.getAttribute('name') === 'access-token-kind');
    expect(kindRadios.map((r) => (r as HTMLInputElement).value)).toEqual(['read', 'full']);
    expect(kindRadios.map((r) => (r as HTMLInputElement).checked)).toEqual([true, false]);

    const expiry = kinds.filter((r) => r.getAttribute('name') === 'access-token-expiry');
    expect(expiry.map((r) => (r as HTMLInputElement).value)).toEqual(['30d', 'date', 'never']);
    expect(expiry.map((r) => (r as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(screen.getByText('30 日（既定）')).toBeTruthy();
    expect(screen.queryByText(/scopes/)).toBeNull();
  });

  it('種類ごとの説明を出し、full を選んだときだけ強い資格の注意を出す', async () => {
    stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    expect(
      screen.getByText(/読むだけ。記憶・日誌・利用・\/self\/prompt の読み取りと \/mcp/),
    ).toBeTruthy();
    expect(
      screen.getByText(/ログインのトークンと同じ強さ。ただし発行したトークンからは/),
    ).toBeTruthy();
    expect(screen.queryByText(/full は強い資格/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /full（ログインと同じ強さ）/ }));
    expect(screen.getByText(/full は強い資格/)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /read（読むだけ）/ }));
    expect(screen.queryByText(/full は強い資格/)).toBeNull();
  });

  it('既定のまま発行すると name と kind=read だけを送る（期限は省略＝デーモンの 30 日）', async () => {
    const stub = stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    fill(NAME_LABEL, '  新しいトークン ');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText('発行した: 新しいトークン');

    expect(stub.posts).toEqual([
      { path: '/access-tokens', body: { name: '新しいトークン', kind: 'read' } },
    ]);
  });

  it('full・無期限は明示して選んだときだけ送る（expiresAt: null）', async () => {
    const stub = stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    fill(NAME_LABEL, '本番');
    fireEvent.click(screen.getByRole('radio', { name: /full/ }));
    fireEvent.click(screen.getByRole('radio', { name: /無期限/ }));
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText('発行した: 新しいトークン');

    expect(stub.posts[0]?.body).toEqual({ name: '本番', kind: 'full', expiresAt: null });
  });

  it('日時を指定すると ISO で送り、空や過去は送らず欄の下で言う', async () => {
    const stub = stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    fill(NAME_LABEL, '期限付き');
    fireEvent.click(screen.getByRole('radio', { name: /日時を指定/ }));
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText('期限の日時を入れてください')).toBeTruthy();
    fill('期限の日時', '2000-01-01T00:00');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText('期限が過去です')).toBeTruthy();
    expect(stub.posts).toEqual([]);

    fill('期限の日時', '2099-01-01T00:00');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText('発行した: 新しいトークン');
    const body = stub.posts[0]?.body as { expiresAt: string };
    expect(body.expiresAt).toBe(new Date('2099-01-01T00:00').toISOString());
  });

  it('名前が空・200 文字超なら送らない', async () => {
    const stub = stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText('名前を入れてください')).toBeTruthy();
    fill(NAME_LABEL, 'あ'.repeat(201));
    expect(screen.getByText(/名前は 1〜200 文字で指定してください/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(stub.posts).toEqual([]);
  });
});

describe('/access-tokens 画面 — 発行直後の値', () => {
  it('値と MCP サーバの JSON（キー alteroid-remote）を1度だけ見せ、閉じると消える。保存しない', async () => {
    stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    fill(NAME_LABEL, '新しいトークン');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    await screen.findByText('発行した: 新しいトークン');

    // 値が出るのは「アクセストークンの値」と MCP サーバの JSON の2か所だけ
    expect(document.body.textContent?.split(SECRET_VALUE)).toHaveLength(3);
    expect(screen.getByText(/この値は二度と表示されない/)).toBeTruthy();
    const text = screen.getByText(/"alteroid-remote"/, { selector: 'pre, code' }).textContent ?? '';
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({
      'alteroid-remote': {
        type: 'http',
        url: 'http://daemon.test/mcp',
        headers: { Authorization: `Bearer ${SECRET_VALUE}` },
      },
    });
    expect(mcpServersSchema.safeParse(parsed).success).toBe(true);
    expect(screen.queryByText(/予約されているので/)).toBeNull();
    expect(text).not.toContain('alteroid-report');
    expect(screen.getByText(/alteroid-report とは別の名前/, { exact: false })).toBeTruthy();
    expect(
      screen.getByText(/平文で入り、そこのクローン・マネージャー・作業者から見える/),
    ).toBeTruthy();
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET_VALUE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET_VALUE);

    fireEvent.click(screen.getByRole('button', { name: '値を消して閉じる' }));
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET_VALUE);
  });

  it('発行に失敗したら値は出ず、入力は残り、失敗を言う', async () => {
    stubTokens({ post: { status: 500, body: { error: '壊れた' } } });
    renderScreen();
    await screen.findByText('読み取り用');

    fill(NAME_LABEL, '残る名前');
    fireEvent.click(screen.getByRole('radio', { name: /full/ }));
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText(/トークンは発行していない/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(NAME_LABEL).value).toBe('残る名前');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /full/ }).checked).toBe(true);
    expect(screen.queryByRole('button', { name: '値を消して閉じる' })).toBeNull();
  });

  it('発行が 403 のときは、一般の失敗ではなく管理できない資格だと言う', async () => {
    stubTokens({ post: { status: 403, body: { error: '発行したアクセストークンでは…' } } });
    renderScreen();
    await screen.findByText('読み取り用');

    fill(NAME_LABEL, 'x');
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText(/この資格ではアクセストークンを管理できない/)).toBeTruthy();
  });
});

describe('/access-tokens 画面 — 失効', () => {
  it('確認を挟み、本当に失効するで POST する。やめるなら送らない', async () => {
    const stub = stubTokens();
    renderScreen();
    await screen.findByText('読み取り用');

    fireEvent.click(screen.getByRole('button', { name: '読み取り用 を失効する' }));
    expect(screen.getByText(/失効するとすぐ効き/)).toBeTruthy();
    expect(stub.posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByText(/失効するとすぐ効き/)).toBeNull();
    expect(stub.posts).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '読み取り用 を失効する' }));
    fireEvent.click(screen.getByRole('button', { name: '読み取り用 を本当に失効する' }));
    await waitFor(() => expect(stub.posts).toHaveLength(1));
    expect(stub.posts[0]?.path).toBe('/access-tokens/t-1/revoke');
  });

  it('ログインで発行したトークンの失効の確認には、再ログインが要ると添える', async () => {
    stubTokens({
      get: {
        status: 200,
        body: { tokens: [view({ origin: 'login', issuedBy: null, name: '端末' })] },
      },
    });
    renderScreen();
    await screen.findByText('端末');
    fireEvent.click(screen.getByRole('button', { name: '端末 を失効する' }));
    expect(screen.getByText(/その端末は再ログインが必要/)).toBeTruthy();
  });
});
