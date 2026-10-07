// @vitest-environment jsdom
// ファイルは Node の File で作る: jsdom の File は Request の本文として読めないため
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-3779';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

const CSV = {
  id: 'att-1',
  name: 'table.csv',
  mediaType: 'text/csv',
  size: 2048,
  sha256: 'a'.repeat(64),
};
const NEW_META = {
  id: 'att-new',
  name: 'extra.txt',
  mediaType: 'text/plain',
  size: 4,
  sha256: 'b'.repeat(64),
};

const nodeFile = (name: string, size = 4, type = 'text/plain') =>
  new NodeFile([new Uint8Array(new Array(size).fill(1))], name, { type }) as unknown as File;

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function setup(options: { uploadFails?: boolean } = {}) {
  const stub = stubFetch((url, init) => {
    if (url.includes('/attachments') && !url.includes('/attachments/') && !url.includes('limits')) {
      return options.uploadFails === true ? json({ error: 'boom' }, 500) : json(NEW_META);
    }
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          {
            id: 'm1',
            at: '2026-10-06T00:00:00.000Z',
            role: 'inbound',
            text: 'この表を見て',
            attachments: [CSV],
          },
        ],
        scanned: 1,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:conversationId',
        Component: () => <ChatRoute loaderData={{ conversationId: CONVERSATION_ID }} />,
      },
    ],
    { initialEntries: [`/chat/${CONVERSATION_ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

async function startEditing() {
  const transcript = await screen.findByRole('list', { name: 'やりとり' });
  const row = (await within(transcript).findByText('この表を見て')).closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: /^発言を編集/ }));
  return screen.findByRole('textbox', { name: '発言を編集する下書き' });
}

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

async function postedBody(stub: ReturnType<typeof setup>) {
  await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
  const call = stub.entries.find((e) => e.url.endsWith('/chat'));
  return (await call?.request?.clone().json()) as Record<string, unknown>;
}

describe('発言の編集でファイルを足す（#3779）', () => {
  it('足して確定すると、上げてから、元の添付＋新しい添付で supersedes 付きで送る', async () => {
    const stub = setup();
    const textarea = await startEditing();
    expect(screen.getAllByRole('button', { name: 'ファイルを添付' })).toHaveLength(2);
    choose([nodeFile('extra.txt')]);
    expect(await screen.findByText('extra.txt')).toBeTruthy();
    expect(screen.getByText('table.csv')).toBeTruthy();
    expect(stub.entries.some((e) => e.url.includes('/attachments?'))).toBe(false);

    fireEvent.change(textarea, { target: { value: 'これも見て' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(await postedBody(stub)).toEqual({
      text: 'これも見て',
      conversationId: CONVERSATION_ID,
      supersedes: 'm1',
      attachments: ['att-1', 'att-new'],
      clientMessageId: expect.any(String),
    });
    const urls = stub.entries.map((e) => e.url);
    const uploads = urls.filter((u) => u.includes('/attachments?'));
    expect(uploads).toHaveLength(1);
    expect(urls.findIndex((u) => u.includes('/attachments?'))).toBeLessThan(
      urls.findIndex((u) => u.endsWith('/chat')),
    );
  });

  it('貼り付け（ファイルだけ）でも足せる', async () => {
    const stub = setup();
    const textarea = await startEditing();
    fireEvent.paste(textarea, {
      clipboardData: { files: [nodeFile('pasted.txt')], getData: () => '' },
    });
    expect(await screen.findByText('pasted.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '確定' }));
    expect(await postedBody(stub)).toMatchObject({ attachments: ['att-1', 'att-new'] });
  });

  it('ドロップでも足せる', async () => {
    setup();
    const textarea = await startEditing();
    fireEvent.drop(textarea, {
      dataTransfer: { types: ['Files'], files: [nodeFile('dropped.txt')] },
    });
    expect(await screen.findByText('dropped.txt')).toBeTruthy();
  });

  it('足した分の「外す」は、上げずに取り除く。元の添付を外す操作とも共存する', async () => {
    const stub = setup();
    const textarea = await startEditing();
    choose([nodeFile('extra.txt')]);
    await screen.findByText('extra.txt');
    fireEvent.click(screen.getByRole('button', { name: 'extra.txt を外す' }));
    expect(screen.queryByText('extra.txt')).toBeNull();
    choose([nodeFile('second.txt')]);
    await screen.findByText('second.txt');
    fireEvent.click(screen.getByRole('button', { name: 'table.csv を外す' }));

    fireEvent.change(textarea, { target: { value: '差し替え' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(await postedBody(stub)).toMatchObject({ attachments: ['att-new'] });
    expect(stub.entries.filter((e) => e.url.includes('/attachments?'))).toHaveLength(1);
  });

  it('個数は元の添付と足した分の合計で検査し、超えた分は断って理由を出す', async () => {
    const stub = setup();
    await startEditing();
    choose(Array.from({ length: 10 }, (_, i) => nodeFile(`f${i}.txt`)));
    await screen.findByText('f8.txt');
    expect(screen.queryByText('f9.txt')).toBeNull();
    expect(screen.getByText(/f9\.txt: 1 発言に添えられるのは 10 個まで（11 個）/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'この発言の添付' })).getAllByRole('listitem'),
    ).toHaveLength(10);
    expect(stub.entries.some((e) => e.url.includes('/attachments?'))).toBe(false);
  });

  it('上げるのに失敗したら、何も送らず、編集を開き直して書きかけと足したファイルを戻す', async () => {
    const stub = setup({ uploadFails: true });
    const textarea = await startEditing();
    choose([nodeFile('extra.txt')]);
    await screen.findByText('extra.txt');
    fireEvent.change(textarea, { target: { value: '直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: '確定' }));

    const again = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    await waitFor(() => expect((again as HTMLTextAreaElement).value).toBe('直した本文'));
    expect(screen.getByText('extra.txt')).toBeTruthy();
    expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(false);
  });

  it('再読み込みをまたぐと、足したファイルは外れる。名前を残し、開いたとき案内する（黙って落とさない）', async () => {
    setup();
    const textarea = await startEditing();
    fireEvent.change(textarea, { target: { value: '直した本文' } });
    choose([nodeFile('extra.txt')]);
    await screen.findByText('extra.txt');
    fireEvent(window, new Event('pagehide'));

    const stored = Object.entries(sessionStorage).filter(([k]) =>
      k.startsWith('alteroid.editDraft:'),
    );
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]![1])).toMatchObject({
      text: '直した本文',
      lostNames: ['extra.txt'],
    });

    cleanup();
    setup();
    const reopened = await startEditing();
    expect((reopened as HTMLTextAreaElement).value).toBe('直した本文');
    expect(screen.queryByText('extra.txt')).toBeNull();
    expect(screen.getByText(/再読み込みで、足していたファイルが外れた（extra\.txt）/)).toBeTruthy();
  });
});
