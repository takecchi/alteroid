// @vitest-environment jsdom
/**
 * **会話の画面の外枠（会話の一覧・入力欄の帯）が、従来の見た目のまま描かれていること。**
 *
 * この3つ（`ConversationList` / `ChatHeader` / `ChatComposer`）を `@alteroid/ui` の部品へ
 * 置き換えるとき、部品をそのまま使うと新しいテーマの見た目になる差が4つあった:
 * 往復の数を `data-numeric` で包む、選択中の行が `lumen-edge bg-accent`、入力欄の帯に
 * `bg-background`、新しい会話のボタンを Tab の順路から外す。**置き換えは見た目の
 * 置き換えに限る**ので、画面は部品の口で従来の形に合わせている。この歯はその
 * 「合わせた」側を押さえる。
 *
 * 見出しと入力欄の safe-area・ラベルの `hidden md:inline` は `chat.test.tsx` が見ている。
 * ここは、そこが見ていない差だけを見る。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ACTIVE_ID = 'conv-active';

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

const CONVERSATIONS = [
  {
    conversationId: ACTIVE_ID,
    startedAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    messages: 4,
    preview: '選んでいる会話',
  },
  {
    conversationId: 'conv-other',
    startedAt: '2026-08-19T00:00:00Z',
    updatedAt: '2026-08-19T00:00:00Z',
    messages: 2,
    preview: '別の会話',
  },
];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  stubFetch((url) => {
    if (url.includes(`/conversations/${ACTIVE_ID}`)) {
      return json({ conversationId: ACTIVE_ID, messages: [] });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) {
      return json({ conversations: CONVERSATIONS, scanned: 40, reachedStart: true });
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function rowOf(preview: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', { name: '会話' });
  const row = within(list).getByText(preview).closest('a');
  if (row === null) throw new Error(`${preview} の行（リンク）が見つからない`);
  return row;
}

describe('会話の一覧', () => {
  it('選択中の行は bg-muted。新しいテーマの lumen-edge / bg-accent / transition-colors は付かない', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const active = (await rowOf('選んでいる会話')).className.split(/\s+/);
    expect(active).toContain('bg-muted');
    expect(active).toContain('hover:bg-muted');
    for (const theme of [
      'lumen-edge',
      'bg-accent',
      'text-accent-foreground',
      'transition-colors',
    ]) {
      expect(active).not.toContain(theme);
    }

    // 選んでいない行には bg-muted（常時）が付かない。hover 用だけ。
    const other = (await rowOf('別の会話')).className.split(/\s+/);
    expect(other).not.toContain('bg-muted');
    expect(other).toContain('hover:bg-muted');
  });

  it('「更新時刻 · N 往復」は1つの <p> の文字で、数字を data-numeric の span で包まない', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const row = await rowOf('選んでいる会話');
    expect(row.querySelector('[data-numeric]')).toBeNull();
    const paragraphs = row.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]?.textContent).toMatch(/ · 4 往復$/);
    expect(paragraphs[1]?.children).toHaveLength(0);
  });

  it('「新しい会話」のボタンは Tab の順路に残り（tabindex を付けない）、リンクは class を持たない', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const button = await screen.findByRole('button', { name: '新しい会話' });
    expect(button.hasAttribute('tabindex')).toBe(false);
    const link = button.closest('a');
    expect(link?.getAttribute('href')).toBe('/chat');
    expect(link?.hasAttribute('class')).toBe(false);
  });

  it('走査した件数の但し書きを、一覧の下に <p> で出す', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const note = await screen.findByText('人間との往復 40 件を走査');
    expect(note.tagName).toBe('P');
    expect(note.className.split(/\s+/)).toContain('border-t');
  });
});

describe('入力欄の帯', () => {
  it('背景色（bg-background）を敷かない', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const textbox = await screen.findByPlaceholderText(/クローンに話しかける/);
    // `<textarea>` → `min-w-0 flex-1` → `flex items-end gap-2` → 帯本体
    const band = textbox.parentElement?.parentElement?.parentElement;
    if (band === undefined || band === null) throw new Error('入力欄の帯が見つからない');
    const classes = band.className.split(/\s+/);
    expect(classes).toContain('border-t');
    expect(classes).not.toContain('bg-background');
  });
});
