// @vitest-environment jsdom
/**
 * チャットの画像を押すと大きく見られる（#3811）。
 *
 * 画像の描かれ方は2経路ある。**どちらでも開くこと**を確かめる。
 * - 発言の添付（`message-attachments.tsx` の `ImageAttachment`）。自分の発言にも、
 *   クローンの発言（`role: 'outbound'`）にも付く
 * - クローンの本文（Markdown）の中の `![alt](url)`
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-lightbox';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

let originalFetch: typeof fetch;
const revoked: string[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  revoked.length = 0;
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${++n}`);
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const meta = (id: string, name: string) => ({
  id,
  name,
  mediaType: 'image/png',
  size: 4,
  sha256: 'a'.repeat(64),
});

function renderWith(messages: unknown[]) {
  stubFetch((url) => {
    if (url.includes('/attachments/')) return new Response(new Uint8Array([1, 2, 3, 4]));
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages,
        scanned: messages.length,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
    initialEntries: [`/chat/${CONVERSATION_ID}`],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function expectLightbox(name: string, opener: HTMLElement) {
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name });
  expect(within(dialog).getByAltText(name)).toBeTruthy();
  expect(within(dialog).getByRole('link', { name: /原寸/ }).getAttribute('target')).toBe('_blank');
  // Esc で閉じ、フォーカスが開いた button へ戻る。
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(document.activeElement).toBe(opener);
}

describe('画像を押すと大きく見られる', () => {
  it('自分の発言の添付', async () => {
    renderWith([
      {
        id: 'm1',
        at: '2026-10-06T00:00:00.000Z',
        role: 'inbound',
        text: '見て',
        attachments: [meta('a1', 'mine.png')],
      },
    ]);
    const img = await screen.findByAltText('mine.png');
    await expectLightbox('mine.png', img.closest('button') as HTMLElement);
  });

  it('クローンの発言に付いた添付', async () => {
    renderWith([
      {
        id: 'm2',
        at: '2026-10-06T00:00:00.000Z',
        role: 'outbound',
        text: '作った',
        attachments: [meta('a2', 'made.png')],
      },
    ]);
    const img = await screen.findByAltText('made.png');
    await expectLightbox('made.png', img.closest('button') as HTMLElement);
  });

  it('クローンの本文（Markdown）の外部の画像は、開いた瞬間に読み込まず、拡大の対象にもならない（#4063）', async () => {
    renderWith([
      {
        id: 'm3',
        at: '2026-10-06T00:00:00.000Z',
        role: 'outbound',
        text: '![図](https://example.com/a.png)',
      },
    ]);
    const link = await screen.findByRole('link', { name: '画像: 図' });
    expect(link.getAttribute('href')).toBe('https://example.com/a.png');
    expect(screen.queryByAltText('図')).toBeNull();
    expect(document.querySelector('img[src="https://example.com/a.png"]')).toBeNull();
  });

  it('外側（背景）を押すと閉じ、開いている間は blob: URL を解放しない', async () => {
    renderWith([
      {
        id: 'm1',
        at: '2026-10-06T00:00:00.000Z',
        role: 'inbound',
        text: '見て',
        attachments: [meta('a1', 'mine.png')],
      },
    ]);
    const img = await screen.findByAltText('mine.png');
    fireEvent.click(img.closest('button') as HTMLElement);
    await screen.findByRole('dialog');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    fireEvent.pointerDown(overlay);
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(revoked).toEqual([]);
  });
});
