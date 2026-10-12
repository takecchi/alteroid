// @vitest-environment jsdom
// ファイルは Node の File で作る: jsdom の File は Request の本文として読めないため
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-edit-race';
const EDITOR = { name: '発言を編集する下書き' } as const;

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

const nodeFile = (name: string) =>
  new NodeFile([new Uint8Array([1, 2, 3, 4])], name, { type: 'text/plain' }) as unknown as File;

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

// アップロード（POST /attachments?...）の応答を保留し、failUpload() で 500 にする
function setup() {
  const held = { count: 0 };
  let failUpload: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    failUpload = resolve;
  });
  stubFetch((url, init) => {
    if (url.includes('/attachments?')) return json({ error: 'boom' }, 500);
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
          { id: 'mx', at: '2026-10-06T00:00:00.000Z', role: 'inbound', text: '発言X' },
          { id: 'rx', at: '2026-10-06T00:00:01.000Z', role: 'outbound', text: '返事X' },
          { id: 'my', at: '2026-10-06T00:00:02.000Z', role: 'inbound', text: '発言Y' },
          { id: 'ry', at: '2026-10-06T00:00:03.000Z', role: 'outbound', text: '返事Y' },
        ],
        scanned: 4,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  // アップロードは openapi-fetch ではなく Request で来るので、URL で見分けて保留する
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url.includes('/attachments?')) {
      held.count += 1;
      await gate;
    }
    return inner(input, init);
  }) as typeof fetch;
  const router = createMemoryRouter(
    [
      {
        path: 'chat/:conversationId?',
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
  return { held, failUpload: () => failUpload() };
}

async function rowOf(text: string) {
  const transcript = await screen.findByRole('list', { name: 'やりとり' });
  return (await within(transcript).findByText(text)).closest('li') as HTMLElement;
}

async function pencil(text: string) {
  const row = await rowOf(text);
  fireEvent.click(within(row).getByRole('button', { name: /^発言を編集/ }));
}

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

// X を編集 → ファイルを足して確定 → アップロードが保留のまま編集欄が閉じるところまで
async function confirmXWithPendingUpload(held: { count: number }) {
  await pencil('発言X');
  const textarea = await screen.findByRole('textbox', EDITOR);
  choose([nodeFile('extra.txt')]);
  await screen.findByText('extra.txt');
  fireEvent.change(textarea, { target: { value: 'Xの最初の下書き' } });
  fireEvent.click(screen.getByRole('button', { name: '確定' }));
  await waitFor(() => expect(screen.queryByRole('textbox', EDITOR)).toBeNull());
  await waitFor(() => expect(held.count).toBe(1));
}

async function waitForUploadFailure() {
  await waitFor(() => expect(screen.queryByText(/extra\.txt を上げられなかった/)).not.toBeNull());
}

describe('編集の確定中のアップロードが失敗したとき、そのあいだに始めた編集を壊さない（#4543）', () => {
  it('(a) 同じ発言 X を書き直していたら、書き直した本文を残し、上げそこねた添付も下書きへ戻す', async () => {
    const { held, failUpload } = setup();
    await confirmXWithPendingUpload(held);

    await pencil('発言X');
    const textarea = (await screen.findByRole('textbox', EDITOR)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Xの書き直し' } });
    expect(textarea.value).toBe('Xの書き直し');

    failUpload();
    await waitForUploadFailure();
    const after = screen.getByRole('textbox', EDITOR) as HTMLTextAreaElement;
    expect(after.value).toBe('Xの書き直し');
    // 足したファイルは黙って失わない
    expect(screen.getAllByText('extra.txt').length).toBeGreaterThan(0);
  });

  it('(b) 別の発言 Y を編集していたら、Y の編集欄は閉じず、X の下書きは押し直せば戻る', async () => {
    const { held, failUpload } = setup();
    await confirmXWithPendingUpload(held);

    await pencil('発言Y');
    const textarea = (await screen.findByRole('textbox', EDITOR)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Yを書いている' } });
    expect(textarea.value).toBe('Yを書いている');

    failUpload();
    await waitForUploadFailure();
    const after = screen.getByRole('textbox', EDITOR) as HTMLTextAreaElement;
    expect(after.value).toBe('Yを書いている');

    // X の下書き（確定前の本文と、上げそこねた添付）は残っている
    await pencil('発言X');
    await waitFor(() =>
      expect((screen.getByRole('textbox', EDITOR) as HTMLTextAreaElement).value).toBe(
        'Xの最初の下書き',
      ),
    );
    expect(screen.getAllByText('extra.txt').length).toBeGreaterThan(0);
  });
});
