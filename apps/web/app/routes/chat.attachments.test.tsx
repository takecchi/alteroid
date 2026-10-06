// @vitest-environment jsdom
/**
 * 添付（Issue #3111 段1c）。入力欄で選んだファイルが `POST /attachments`（octet-stream）で
 * 上がり、その id が `POST /chat` の `attachments` へ入ること、そして添付のある発言の下に
 * 添付が出ること。
 *
 * **ファイルは Node の `File`（`node:buffer`）で作る。** jsdom の `File` は Node の
 * `Request` の本文として読めない（実ブラウザでは読める）ので、本文を確かめる試験では
 * Node のものを使う。
 */
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-attach';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [initial] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;
const created: Blob[] = [];
const revoked: string[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  created.length = 0;
  revoked.length = 0;
  // jsdom には `URL.createObjectURL` が無い。作った Blob を控え、解放も数える。
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:fake-${created.length}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const PNG_META = {
  id: 'att-png',
  name: 'shot.png',
  mediaType: 'image/png',
  size: 4,
  sha256: 'a'.repeat(64),
};
const PDF_META = {
  id: 'att-pdf',
  name: 'spec.pdf',
  mediaType: 'application/pdf',
  size: 2048,
  sha256: 'b'.repeat(64),
};

const nodeFile = (name: string, bytes: number[] | number, type: string) =>
  new NodeFile(
    [new Uint8Array(typeof bytes === 'number' ? new Array(bytes).fill(1) : bytes)],
    name,
    {
      type,
    },
  ) as unknown as File;

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const box = () => screen.findByPlaceholderText(/クローンに話しかける/);

/** `Request` の本文を通り道で控える（`chat.follow-up.test.tsx` の `captureChatBodies` と同じ形）。 */
function captureRequests() {
  const seen: { url: string; method: string; contentType: string | null; body: Uint8Array }[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      seen.push({
        url: input.url,
        method: input.method,
        contentType: input.headers.get('content-type'),
        body: new Uint8Array(await input.clone().arrayBuffer()),
      });
    }
    return inner(input, init);
  }) as typeof fetch;
  return seen;
}

function background(url: string): Response | undefined {
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations/'))
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

describe('添えて送る', () => {
  it('選んだファイルは octet-stream で上がり、その id が /chat の attachments に入る', async () => {
    stubFetch((url, init) => {
      if (url.includes('/attachments') && !url.includes('/attachments/')) return json(PNG_META);
      if (url.includes('/attachments/att-png')) return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });
    const seen = captureRequests();
    renderChat('/chat');

    await box();
    choose([nodeFile('shot.png', [1, 2, 3, 4], 'image/png')]);
    // 送る前にチップが並ぶ: 名前・大きさ・外すボタン・縮小表示
    const tray = await screen.findByRole('list', { name: '添付' });
    expect(within(tray).getByText('shot.png')).toBeTruthy();
    expect(within(tray).getByText('4 B')).toBeTruthy();
    expect(within(tray).getByRole('button', { name: 'shot.png を外す' })).toBeTruthy();
    expect(await within(tray).findByAltText('shot.png の縮小表示')).toBeTruthy();

    fireEvent.change(await box(), { target: { value: 'これを見て' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));

    await waitFor(() => {
      expect(seen.some((r) => r.url.endsWith('/chat'))).toBe(true);
    });
    const upload = seen.find((r) => r.method === 'POST' && r.url.includes('/attachments?'));
    expect(upload?.contentType).toBe('application/octet-stream');
    const uploadUrl = new URL(upload?.url ?? '');
    expect(uploadUrl.searchParams.get('name')).toBe('shot.png');
    expect(uploadUrl.searchParams.get('type')).toBe('image/png');
    expect([...(upload?.body ?? [])]).toEqual([1, 2, 3, 4]);

    const chat = seen.find((r) => r.url.endsWith('/chat'));
    expect(JSON.parse(new TextDecoder().decode(chat?.body))).toEqual({
      text: 'これを見て',
      attachments: ['att-png'],
    });
    // 送ったあとは入力欄のチップが消える。
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'shot.png を外す' })).toBeNull();
    });
  });

  it('外すと送らない（チップが消え、/chat に attachments が載らない）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          signal: init?.signal,
        });
      }
      return background(url);
    });
    const seen = captureRequests();
    renderChat('/chat');
    await box();
    choose([nodeFile('a.txt', 3, 'text/plain')]);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt を外す' }));
    fireEvent.change(await box(), { target: { value: 'なし' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => {
      expect(seen.some((r) => r.url.endsWith('/chat'))).toBe(true);
    });
    expect(seen.some((r) => r.url.includes('/attachments?'))).toBe(false);
    const chat = seen.find((r) => r.url.endsWith('/chat'));
    expect(JSON.parse(new TextDecoder().decode(chat?.body))).toEqual({ text: 'なし' });
  });

  it('上げるのに失敗したら、書きかけも添付も残してエラーを出し、/chat は呼ばない', async () => {
    stubFetch((url) => {
      if (url.includes('/attachments?')) {
        return json({ error: '大きすぎる', code: 'too_large' }, 413);
      }
      return background(url);
    });
    const seen = captureRequests();
    renderChat('/chat');
    await box();
    choose([nodeFile('a.txt', 3, 'text/plain')]);
    fireEvent.change(await box(), { target: { value: '書きかけ' } });
    fireEvent.click(await screen.findByRole('button', { name: '送る' }));

    expect(await screen.findByText(/a\.txt を上げられなかった: 大きすぎる/)).toBeTruthy();
    expect(((await box()) as HTMLTextAreaElement).value).toBe('書きかけ');
    expect(screen.getByRole('button', { name: 'a.txt を外す' })).toBeTruthy();
    expect(seen.some((r) => r.url.endsWith('/chat'))).toBe(false);
    // 上げ終えて送信ボタンが戻っている（止めっぱなしにしない）。
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('個数・大きさの上限はクライアントでも先に断り、理由を出す', async () => {
    stubFetch((url) => background(url));
    renderChat('/chat');
    await box();
    choose([
      nodeFile('big.png', 5 * 1024 * 1024 + 1, 'image/png'),
      nodeFile('ok.txt', 3, 'text/plain'),
    ]);
    expect(await screen.findByText(/big\.png: 画像は 1 つ 5\.0 MB まで/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ok.txt を外す' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'big.png を外す' })).toBeNull();
  });

  describe('上限はデーモンの値で先に検査する（#3204）', () => {
    const MIB = 1024 * 1024;
    const DEFAULTS = {
      maxImageBytes: 5 * MIB,
      maxFileBytes: 25 * MIB,
      maxPerMessage: 10,
      maxTotalBytes: 50 * MIB,
      retentionDays: 30,
    };

    /** 上限の口を `limits` で答える（`null` は古いデーモンの 404）。上限が届くまで待つ。 */
    async function renderWithLimits(limits: typeof DEFAULTS | null) {
      const stub = stubFetch((url) => {
        if (url.endsWith('/attachments/limits')) {
          return limits === null ? json({ error: 'not found' }, 404) : json(limits);
        }
        return background(url);
      });
      renderChat('/chat');
      await box();
      await waitFor(() => {
        expect(stub.calls.some((url) => url.endsWith('/attachments/limits'))).toBe(true);
      });
      await act(async () => {});
      return stub;
    }

    it('上限を上げたデーモンでは、既定値を超えてデーモンの内側にある添付を先に断らない。取るのは1回', async () => {
      const stub = await renderWithLimits({
        ...DEFAULTS,
        maxImageBytes: 40 * MIB,
        maxFileBytes: 200 * MIB,
        maxTotalBytes: 400 * MIB,
      });
      choose([nodeFile('big.png', 6 * MIB, 'image/png')]);
      expect(await screen.findByRole('button', { name: 'big.png を外す' })).toBeTruthy();
      choose([nodeFile('huge.bin', 26 * MIB, 'application/octet-stream')]);
      expect(await screen.findByRole('button', { name: 'huge.bin を外す' })).toBeTruthy();
      expect(screen.queryByText(/まで/)).toBeNull();
      expect(stub.calls.filter((url) => url.endsWith('/attachments/limits'))).toHaveLength(1);
    });

    it('上限を下げたデーモンでは、既定値の内側でも先に断る', async () => {
      await renderWithLimits({ ...DEFAULTS, maxFileBytes: 1024, maxPerMessage: 1 });
      choose([nodeFile('a.txt', 2048, 'text/plain'), nodeFile('b.txt', 3, 'text/plain')]);
      expect(await screen.findByText(/a\.txt: ファイルは 1 つ 1\.0 KB まで/)).toBeTruthy();
      choose([nodeFile('c.txt', 3, 'text/plain')]);
      expect(await screen.findByText(/c\.txt: 1回に添えられるのは 1 個まで/)).toBeTruthy();
    });

    it('口が取れない（古いデーモンの 404）ときは既定値で検査する', async () => {
      await renderWithLimits(null);
      choose([nodeFile('big.png', 5 * MIB + 1, 'image/png')]);
      expect(await screen.findByText(/big\.png: 画像は 1 つ 5\.0 MB まで/)).toBeTruthy();
    });
  });

  it('本文が空でも添付があれば送れる（/chat は text が空文字で attachments つき）。添付も本文も無ければ送れない', async () => {
    stubFetch((url, init) => {
      if (url.includes('/attachments?')) return json(PNG_META);
      if (url.includes('/attachments/att-png')) return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.endsWith('/chat')) {
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          signal: init?.signal,
        });
      }
      return background(url);
    });
    const seen = captureRequests();
    renderChat('/chat');
    await box();
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true);
    choose([nodeFile('shot.png', [1, 2, 3, 4], 'image/png')]);
    await screen.findByRole('button', { name: 'shot.png を外す' });
    const sendButton = screen.getByRole('button', { name: '送る' }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    fireEvent.click(sendButton);
    await waitFor(() => {
      expect(seen.some((r) => r.url.endsWith('/chat'))).toBe(true);
    });
    const chat = seen.find((r) => r.url.endsWith('/chat'));
    expect(JSON.parse(new TextDecoder().decode(chat?.body))).toEqual({
      text: '',
      attachments: ['att-png'],
    });
  });

  it('貼り付けとドロップでも添えられる', async () => {
    stubFetch((url) => background(url));
    renderChat('/chat');
    const textarea = await box();
    fireEvent.paste(textarea, {
      clipboardData: { files: [nodeFile('pasted.png', 3, 'image/png')], getData: () => '' },
    });
    expect(await screen.findByRole('button', { name: 'pasted.png を外す' })).toBeTruthy();

    fireEvent.drop(textarea, {
      dataTransfer: { types: ['Files'], files: [nodeFile('dropped.txt', 3, 'text/plain')] },
    });
    expect(await screen.findByRole('button', { name: 'dropped.txt を外す' })).toBeTruthy();
  });
});

describe('添付のある発言の表示', () => {
  function history() {
    return json({
      conversationId: CONVERSATION_ID,
      messages: [
        {
          id: 'm1',
          at: '2026-10-06T00:00:00.000Z',
          role: 'inbound',
          text: '資料です',
          attachments: [PNG_META, PDF_META],
        },
      ],
      scanned: 1,
      reachedStart: true,
      supersededCount: 0,
    });
  }

  it('画像は fetch で取った blob: URL で縮小表示し、画像以外は名前・種類・大きさとダウンロード', async () => {
    stubFetch((url) => {
      if (url.includes('/attachments/att-png')) return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.includes('/attachments/att-pdf')) return new Response(new Uint8Array([9, 9]));
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) return history();
      return background(url);
    });
    const seen = captureRequests();
    renderChat(`/chat/${CONVERSATION_ID}`);

    const image = await screen.findByAltText('shot.png');
    // `<img src>` に API の URL を直接入れない（Bearer を運べない）。blob: だけが入る。
    expect(image.getAttribute('src')).toMatch(/^blob:/);
    expect(seen.some((r) => r.method === 'GET' && r.url.endsWith('/attachments/att-png'))).toBe(
      true,
    );

    expect(screen.getByText('spec.pdf')).toBeTruthy();
    expect(screen.getByText('application/pdf / 2.0 KB')).toBeTruthy();
    const clicked: string[] = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(`${this.download}|${this.href}`);
    };
    fireEvent.click(screen.getByRole('button', { name: 'spec.pdf をダウンロード' }));
    await waitFor(() => {
      expect(clicked).toEqual(['spec.pdf|blob:fake-2']);
    });
  });

  it('404 は「取り出せない（期限切れの可能性）」と出す', async () => {
    stubFetch((url) => {
      if (url.includes('/attachments/')) return json({ error: 'ない' }, 404);
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) return history();
      return background(url);
    });
    renderChat(`/chat/${CONVERSATION_ID}`);
    const alerts = await screen.findAllByText(/取り出せない（期限切れの可能性）/);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('添付の無い発言は添付の部品を読み込まない（一覧に添付の中身を出さない）', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm1', at: '2026-10-06T00:00:00.000Z', role: 'inbound', text: 'ただの文' },
          ],
          scanned: 1,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return background(url);
    });
    const seen = captureRequests();
    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('ただの文');
    expect(screen.queryByRole('list', { name: '添付' })).toBeNull();
    expect(
      seen.some((r) => r.url.includes('/attachments') && !r.url.endsWith('/attachments/limits')),
    ).toBe(false);
  });
});

describe('会話ごとの添えかけの添付', () => {
  const A = 'conv-att-a';
  const B = 'conv-att-b';
  function route(url: string): Response | undefined {
    if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
    if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
    return background(url);
  }
  function renderRouted(initial: string) {
    const router = createMemoryRouter(
      [
        { path: '/chat', Component: Harness },
        { path: '/chat/:conversationId', Component: Harness },
      ],
      { initialEntries: [initial] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return router;
  }

  it('A で添えて B へ移ると B には出ず、A へ戻ると添付が戻る', async () => {
    stubFetch(route);
    const router = renderRouted(`/chat/${A}`);
    await box();
    choose([nodeFile('only-a.txt', 3, 'text/plain')]);
    await screen.findByRole('button', { name: 'only-a.txt を外す' });

    await router.navigate(`/chat/${B}`);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'only-a.txt を外す' })).toBeNull();
    });

    await router.navigate(`/chat/${A}`);
    expect(await screen.findByRole('button', { name: 'only-a.txt を外す' })).toBeTruthy();
  });
});
