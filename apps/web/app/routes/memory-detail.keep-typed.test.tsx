// @vitest-environment jsdom
/**
 * 保存の応答を待つ間に打ち足した文字を、保存が成功したあとも残す（issue #3515）。
 *
 * 応答を返す時期は Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/memory-detail';
import MemoryDetail, { clientLoader } from './memory-detail';

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

const DOC: MemoryDocument = {
  slug: 'notes',
  title: 'notes',
  updatedAt: '2026-08-22T00:00:00.000Z',
  createdAt: { kind: 'unknown' },
  bytes: 42,
  frontmatter: { kind: 'none' },
  kind: 'fact',
  descriptionFreshness: { kind: 'absent' },
  content: '元の本文',
};

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'notes' } } as Route.ClientLoaderArgs);
  return <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />;
}

/** サーバ役。PUT の応答は `releaseNextPut` で手で返す。 */
function stubServer() {
  let doc = DOC;
  let version = 'v1';
  const puts: { content: string; ifMatch: string | null | undefined }[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/memory/notes'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      const body = (await request.json()) as { content: string; ifMatch?: string | null };
      puts.push({ content: body.content, ifMatch: body.ifMatch });
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          doc = { ...DOC, content: body.content, updatedAt: '2026-08-22T01:00:00.000Z' };
          version = `v${String(puts.length + 1)}`;
          resolve(json({ document: doc, version }));
        });
      });
    }
    return json({ document: doc, version });
  }) as typeof fetch;
  return {
    puts,
    releaseNextPut: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている PUT が無い');
      release();
    },
  };
}

function mount() {
  const router = createMemoryRouter([{ path: '/memory/:slug', Component: Harness }], {
    initialEntries: ['/memory/notes'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('記憶の保存中に打ち足した文字', () => {
  it('保存が成功しても残り、次の保存は保存できた版を前提にする（自分の保存と衝突しない）', async () => {
    const server = stubServer();
    mount();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({ content: 'A', ifMatch: 'v1' });

    // 応答を待つ間に打ち足す。
    fireEvent.change(textarea, { target: { value: 'AB' } });
    server.releaseNextPut();
    expect(await screen.findByText(/保存した/)).toBeTruthy();

    // 打ち足した分が残り、まだ未保存として保存できる。
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('AB');
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(2));
    // 1回目に保存できた版（v2）を前提に送る。古い v1 を送ると偽の 409 になる。
    expect(server.puts[1]).toEqual({ content: 'AB', ifMatch: 'v2' });
    server.releaseNextPut();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  it('打ち足さなかったときは、これまでどおり下書きを畳む', async () => {
    const server = stubServer();
    mount();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    server.releaseNextPut();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A');
  });
});
