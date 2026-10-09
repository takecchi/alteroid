// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Schedule from './schedule';

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

const KIND = 'morning-issues';

function entryOf(request: string, updatedAt: string) {
  return {
    kind: KIND,
    description: '毎日 09:00',
    nextAt: '2026-08-21T09:00:00.000Z',
    request,
    spec: { type: 'daily', at: '09:00' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt,
  };
}

type Reply = { type: 'ok' } | { type: 'conflict'; body: unknown } | { type: 'held' };

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので init が undefined になり、本文が落ちるため
function stubServer(reply: Reply) {
  let current = entryOf('元の本文', 'v1');
  let next = reply;
  const posts: { request: string; ifMatch: string | null | undefined }[] = [];
  const held: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/schedule')) {
      throw new TypeError(`Failed to fetch: ${request.url}`);
    }
    if (request.method === 'GET') return json({ entries: [current] });
    const body = (await request.json()) as { request: string; ifMatch?: string | null };
    posts.push({ request: body.request, ifMatch: body.ifMatch });
    if (next.type === 'conflict') return json(next.body, 409);
    const write = () => {
      current = entryOf(body.request, `v${String(posts.length + 1)}`);
    };
    if (next.type === 'held') {
      return new Promise<Response>((resolve) => {
        held.push(() => {
          write();
          resolve(json({ ok: true }));
        });
      });
    }
    write();
    return json({ ok: true });
  }) as typeof fetch;
  return {
    posts,
    setReply: (reply: Reply) => {
      next = reply;
    },
    releaseNext: () => {
      const release = held.shift();
      if (release === undefined) throw new Error('待っている POST が無い');
      release();
    },
    writeElsewhere: (request: string, updatedAt: string) => {
      current = entryOf(request, updatedAt);
    },
  };
}

function mount() {
  const router = createMemoryRouter([{ path: '/', Component: Schedule }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function openEdit() {
  fireEvent.click(await screen.findByRole('button', { name: `${KIND} を編集` }));
  const panel = await screen.findByRole('group', { name: `${KIND} を編集` });
  fireEvent.mouseDown(within(panel).getByRole('tab', { name: '編集' }));
  return panel;
}

async function type(panel: HTMLElement, text: string) {
  fireEvent.change(await within(panel).findByPlaceholderText(/依頼の本文/), {
    target: { value: text },
  });
}

function save(panel: HTMLElement) {
  fireEvent.click(within(panel).getByRole('button', { name: '保存する' }));
}

describe('予定の編集は読んだ版を照合して保存する（#3821）', () => {
  it('保存は、開いたときの updatedAt を ifMatch に載せる', async () => {
    const server = stubServer({ type: 'ok' });
    mount();
    const panel = await openEdit();
    await type(panel, '直した本文');
    save(panel);

    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toEqual({ request: '直した本文', ifMatch: 'v1' });
  });

  it('開いた後にほかが書いて一覧が入れ替わっても、読んだ版のまま送る（衝突が見えなくなる追従をしない）', async () => {
    const server = stubServer({
      type: 'conflict',
      body: { error: '読んだ後に変わった', current: entryOf('ほかの本文', 'v9') },
    });
    mount();
    const panel = await openEdit();
    server.writeElsewhere('ほかの本文', 'v9');
    await type(panel, '直した本文');
    save(panel);

    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]?.ifMatch).toBe('v1');
  });

  it('版の衝突（current あり）では、いまの内容を見せ、下書きを残し、押すといまの版を前提に上書きできる', async () => {
    const server = stubServer({
      type: 'conflict',
      body: { error: '読んだ後に変わった', current: entryOf('ほかの本文', 'v9') },
    });
    mount();
    const panel = await openEdit();
    await type(panel, '直した本文');
    save(panel);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ほかで書き換えられた');
    expect(screen.getByText('ほかの本文')).toBeTruthy();
    expect((within(panel).getByPlaceholderText(/依頼の本文/) as HTMLTextAreaElement).value).toBe(
      '直した本文',
    );

    server.setReply({ type: 'ok' });
    fireEvent.click(within(panel).getByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]).toEqual({ request: '直した本文', ifMatch: 'v9' });
  });

  it('ほかで消されていた（current が null）ときは言い分け、上書きは「無いときだけ作る」（ifMatch: null）で送る', async () => {
    const server = stubServer({
      type: 'conflict',
      body: { error: '読んだ後に変わった', current: null },
    });
    mount();
    const panel = await openEdit();
    await type(panel, '直した本文');
    save(panel);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ほかで消された');
    expect(alert.textContent).not.toContain('書き換えられた');

    server.setReply({ type: 'ok' });
    fireEvent.click(within(panel).getByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]).toEqual({ request: '直した本文', ifMatch: null });
  });

  it('current の無い 409 は版の衝突にせず、error の文言をそのまま出す（上書きの口は出さない）', async () => {
    const server = stubServer({
      type: 'conflict',
      body: { error: '読めない形の予定なので編集できない' },
    });
    mount();
    const panel = await openEdit();
    await type(panel, '直した本文');
    save(panel);

    expect(await screen.findByText(/読めない形の予定なので編集できない/)).toBeTruthy();
    expect(screen.queryByText(/ほかで書き換えられた/)).toBeNull();
    expect(screen.queryByText(/ほかで消された/)).toBeNull();
    expect(within(panel).queryByRole('button', { name: '自分の内容で上書きする' })).toBeNull();
    expect(server.posts).toHaveLength(1);
  });

  it('応答待ちに打ち足した分は残り、次の保存は保存できた版を前提にする', async () => {
    const server = stubServer({ type: 'held' });
    mount();
    const panel = await openEdit();
    await type(panel, 'A');
    save(panel);
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toEqual({ request: 'A', ifMatch: 'v1' });

    await type(panel, 'AB');
    server.releaseNext();
    await waitFor(() => {
      expect(
        (within(panel).getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect((within(panel).getByPlaceholderText(/依頼の本文/) as HTMLTextAreaElement).value).toBe(
      'AB',
    );

    save(panel);
    await waitFor(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]).toEqual({ request: 'AB', ifMatch: 'v2' });
    server.releaseNext();
  });
});

describe('新しく仕込む口の 409', () => {
  it('予約名の文言でない 409 は、日本語の予約名の案内に取り違えず、error の文言を出す', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'GET') return json({ entries: [] });
      return json({ error: '読めない形の予定があるので置き換えられない' }, 409);
    }) as typeof fetch;
    mount();

    fireEvent.change(await screen.findByLabelText(/依頼の名前/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('依頼の本文'), { target: { value: '本文' } });
    fireEvent.click(screen.getByRole('button', { name: '仕込む' }));

    expect(await screen.findByText(/読めない形の予定があるので置き換えられない/)).toBeTruthy();
    expect(screen.queryByText(/予約名/)).toBeNull();
  });
});
