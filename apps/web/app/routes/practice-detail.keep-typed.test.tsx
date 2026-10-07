// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

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

const PRACTICE: Practice = {
  slug: 'daily-report',
  kind: '日報',
  title: '日報の書き方',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 42,
  content: '元の本文',
};

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'daily-report' } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function stubServer() {
  let practice = PRACTICE;
  let version = 'v1';
  const puts: { content: string; ifMatch: string | null | undefined }[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/practices/daily-report')) {
      throw new TypeError(`Failed to fetch: ${request.url}`);
    }
    if (request.url.includes('/versions')) return json({ versions: [] });
    if (request.method === 'PUT') {
      const body = (await request.json()) as {
        kind: string;
        title: string;
        content: string;
        ifMatch?: string | null;
      };
      puts.push({ content: body.content, ifMatch: body.ifMatch });
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          practice = { ...PRACTICE, content: body.content };
          version = `v${String(puts.length + 1)}`;
          resolve(json({ practice, version }));
        });
      });
    }
    return json({ practice, version });
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
  const router = createMemoryRouter([{ path: '/practices/:slug', Component: Harness }], {
    initialEntries: ['/practices/daily-report'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('やり方の保存中に打ち足した文字', () => {
  it('保存が成功しても残り、次の保存は保存できた版を前提にする', async () => {
    const server = stubServer();
    mount();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const content = (await screen.findByLabelText('本文')) as HTMLTextAreaElement;

    fireEvent.change(content, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({ content: 'A', ifMatch: 'v1' });

    fireEvent.change(content, { target: { value: 'AB' } });
    server.releaseNextPut();
    expect(await screen.findByText(/保存した/)).toBeTruthy();

    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('AB');
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]).toEqual({ content: 'AB', ifMatch: 'v2' });
    server.releaseNextPut();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  it('題を打ち足したときも残る', async () => {
    const server = stubServer();
    mount();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('本文'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('題'), { target: { value: '新しい題' } });
    server.releaseNextPut();
    expect(await screen.findByText(/保存した/)).toBeTruthy();
    expect((screen.getByLabelText('題') as HTMLInputElement).value).toBe('新しい題');
  });

  it('打ち足さなかったときは、これまでどおり下書きを畳む', async () => {
    const server = stubServer();
    mount();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('本文'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    server.releaseNextPut();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '変更なし' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });
});
