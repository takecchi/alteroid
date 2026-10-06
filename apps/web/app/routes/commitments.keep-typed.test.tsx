// @vitest-environment jsdom
/**
 * 登録・本文の保存の応答を待つ間に打ち足した文字を、成功のあとも残す（issue #3515）。
 * 応答を返す時期は Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Commitment } from '@alteroid/core';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

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

const ENTRY: Commitment = {
  id: 'cmt-1',
  at: '2026-09-01T00:00:00.000Z',
  origin: 'human',
  body: 'もとの本文',
};

/** 一覧（GET）は即返し、POST・PATCH だけ手で返す。 */
function stubServer() {
  let body = ENTRY.body;
  const writes: { method: string; body: unknown }[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'GET') return json({ entries: [{ ...ENTRY, body }] });
    const sent = (await request.json()) as { body: string };
    writes.push({ method: request.method, body: sent });
    return new Promise<Response>((resolve) => {
      pending.push(() => {
        if (request.method === 'PATCH') body = sent.body;
        resolve(
          json(
            request.method === 'PATCH'
              ? { entry: { ...ENTRY, body: sent.body } }
              : { entry: { ...ENTRY, id: 'cmt-2', body: sent.body } },
          ),
        );
      });
    });
  }) as typeof fetch;
  return {
    writes,
    releaseNext: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている書き込みが無い');
      release();
    },
  };
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('仕事を登録する欄（積む）', () => {
  it('応答を待つ間に打ち足した分は、登録が成功しても欄に残る（送り済みの分は残さない）', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');

    const field = screen.getByLabelText('何を引き受けたか') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '週明けに設計を見直す' } });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0]).toEqual({ method: 'POST', body: { body: '週明けに設計を見直す' } });

    fireEvent.change(field, { target: { value: '週明けに設計を見直す\n次の件' } });
    server.releaseNext();

    await waitFor(() => {
      expect((screen.getByLabelText('何を引き受けたか') as HTMLTextAreaElement).value).toBe(
        '次の件',
      );
    });
  });

  it('打ち足さなかったときは、これまでどおり欄を空にする', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');

    fireEvent.change(screen.getByLabelText('何を引き受けたか'), { target: { value: '件' } });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    server.releaseNext();

    await waitFor(() => {
      expect((screen.getByLabelText('何を引き受けたか') as HTMLTextAreaElement).value).toBe('');
    });
  });
});

describe('本文の編集欄', () => {
  it('応答を待つ間に打ち足した分があれば、保存が成功しても編集欄を畳まず下書きを残す', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');

    fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0]).toEqual({ method: 'PATCH', body: { body: '直した本文' } });

    fireEvent.change(textarea, { target: { value: '直した本文に打ち足す' } });
    server.releaseNext();

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(false);
    });
    expect((within(tabsRoot).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      '直した本文に打ち足す',
    );
  });
});
