// @vitest-environment jsdom
import { useApiContext, useJournalLive } from '@alteroid/swr';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat, { pendingOwnLines } from './chat';

const ID = 'conv-3593';
const QUESTION = '本番に出してよいか';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function CredentialSwitch() {
  const { setCredential } = useApiContext();
  return (
    <button
      type="button"
      onClick={() =>
        setCredential({
          token: 'token-next',
          account: { id: 'a1', name: 'テスト' } as never,
          grantedAtClaim: true,
          createdAt: '2026-10-01T00:00:00.000Z',
        })
      }
    >
      資格を替える
    </button>
  );
}

function Harness() {
  useJournalLive();
  const params = useParams();
  return (
    <>
      <CredentialSwitch />
      <ChatRoute loaderData={{ conversationId: params.conversationId }} />
    </>
  );
}

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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const text = (value: string) => ({ event: 'text', data: { type: 'text', text: value } });
const tool = (name: string) => ({ event: 'tool', data: { type: 'tool', tool: name } });
const ask = {
  event: 'ask_human',
  data: { type: 'ask_human', approvalId: 'ap-1', question: QUESTION },
};

const order = () =>
  within(screen.getByRole('list', { name: 'やりとり' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

function renderApp(initial: string) {
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
}

async function sendAndStream(
  frames: { event: string; data: unknown; after?: Promise<void> }[],
  { last }: { last: Promise<void> | undefined },
) {
  const now = new Date().toISOString();
  stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          ...frames,
          { event: 'done', data: { type: 'done' }, ...(last === undefined ? {} : { after: last }) },
        ],
        { signal: init?.signal, delayMs: 0 },
      );
    }
    if (url.includes('/approvals')) {
      return json({
        approvals: [
          { id: 'ap-1', createdAt: now, updatedAt: now, question: QUESTION, context: '台帳の文脈' },
        ],
      });
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({ conversationId: ID, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }], {
        keepOpen: true,
        signal: init?.signal,
        delayMs: 0,
      });
    }
    return undefined;
  });
  renderApp(`/chat/${ID}`);
  fireEvent.change(await screen.findByPlaceholderText(/クローンに話しかける/), {
    target: { value: '出して' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

describe('分かれた返信は、起きた順に別の行で出る（#3593）', () => {
  it('text → ask_human → text は、前半・カード・後半の順で、本文を連結しない', async () => {
    const end = gate();
    await sendAndStream([text('前半です'), ask, text('後半です')], { last: end.promise });
    await screen.findByText('後半です');
    const items = order();
    expect(items.some((item) => item === '前半です後半です')).toBe(false);
    const first = items.findIndex((item) => item === '前半です');
    const card = items.findIndex((item) => item.includes(QUESTION));
    const second = items.findIndex((item) => item === '後半です');
    expect(first).toBeGreaterThan(0);
    expect(card).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(card);
    end.open();
  });

  it('続きの text が届いたら、「〜を実行中…」の行は消える（done を待たない）', async () => {
    const end = gate();
    await sendAndStream([text('調べます。'), tool('Bash'), text('結果です。')], {
      last: end.promise,
    });
    await screen.findByText('結果です。');
    const items = order();
    expect(items.filter((item) => item.includes('実行中'))).toEqual([]);
    expect(items.slice(-2)).toEqual(['調べます。', '結果です。']);
    end.open();
  });

  it('道具の実行中は、前の返信の下に「〜を実行中…」が出る（続きの text が無いあいだ）', async () => {
    const end = gate();
    await sendAndStream([text('調べます。'), tool('Bash')], { last: end.promise });
    await screen.findByText('Bash を実行中…');
    expect(order().slice(-2)).toEqual(['調べます。', 'Bash を実行中…']);
    end.open();
  });

  const attachments = (name: string) => ({
    event: 'attachments',
    data: {
      type: 'attachments',
      attachments: [{ id: 'att-1', name, mediaType: 'application/pdf', size: 10, sha256: 'ab' }],
    },
  });

  it('クローンの返信に添えた添付は、その返信の行に即時に出る（ストリームの attachments）', async () => {
    const end = gate();
    await sendAndStream([text('資料です'), attachments('report.pdf')], { last: end.promise });
    await screen.findByText('report.pdf');
    expect(order().some((item) => item.includes('資料です') && item.includes('report.pdf'))).toBe(
      true,
    );
    end.open();
  });

  it('本文が無く添付だけの返信でも、返信の行が起きて添付が出る', async () => {
    const end = gate();
    await sendAndStream([attachments('only.pdf')], { last: end.promise });
    await screen.findByText('only.pdf');
    end.open();
  });
});

describe('再生の頭出しは、分かれた返信を全部捨ててから積み直す（#2662 × #3593）', () => {
  it('資格が替わって頭から再生し直されても、前半・後半が1行ずつのまま', async () => {
    let replays = 0;
    const more = gate();
    stubFetch((url, init) => {
      if (/\/chat\/[^/]+\/stream$/.test(url)) {
        replays += 1;
        const open = { event: 'open', data: { conversationId: ID, inProgress: true } };
        return sse(
          replays === 1
            ? [open, text('前半です'), tool('Bash'), text('後半です')]
            : [
                open,
                text('前半です'),
                tool('Bash'),
                text('後半です'),
                { ...text('。'), after: more.promise },
              ],
          { keepOpen: true, signal: init?.signal, delayMs: 0 },
        );
      }
      if (url.includes(`/conversations/${ID}`)) {
        return json({ conversationId: ID, messages: [], scanned: 0, reachedStart: true });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      if (url.endsWith('/journal/stream')) {
        return sse([{ event: 'open', data: { ok: true } }], {
          keepOpen: true,
          signal: init?.signal,
          delayMs: 0,
        });
      }
      return undefined;
    });
    renderApp(`/chat/${ID}`);
    await screen.findByText('後半です');
    fireEvent.click(screen.getByRole('button', { name: '資格を替える' }));
    await waitFor(() => expect(replays).toBe(2));
    more.open();
    await screen.findByText('後半です。');
    expect(order().filter((item) => item === '前半です')).toHaveLength(1);
    expect(order().filter((item) => item.startsWith('後半です'))).toEqual(['後半です。']);
  });
});

describe('履歴との突き合わせ（日誌は本文を1発言に連結して載せる）', () => {
  const line = (key: string, text: string, group: string | undefined) => ({
    key,
    role: 'clone' as const,
    text,
    of: ID,
    ...(group === undefined ? {} : { replyGroup: group }),
  });
  const history = (text: string) => ({
    key: 'm1',
    role: 'clone' as const,
    text,
    of: ID,
    journalId: 'm1',
  });

  it('分かれた行の連結が履歴の1発言と一致したら、手元の行は全部引き取られる', () => {
    const lines = [line('c-1', '前半です', 'g-1'), line('c-2', '後半です', 'g-1')];
    expect(pendingOwnLines(lines, ID, [history('前半です後半です')])).toEqual([]);
  });

  it('一致が確認できないあいだは、どの行も落とさない', () => {
    const lines = [line('c-1', '前半です', 'g-1'), line('c-2', '後半です', 'g-1')];
    expect(pendingOwnLines(lines, ID, [])).toHaveLength(2);
    expect(pendingOwnLines(lines, ID, [history('前半です')])).toHaveLength(1);
  });

  it('別のターン（別の印）の行は、連結に混ぜない', () => {
    const lines = [line('c-1', '前半です', 'g-1'), line('c-2', '後半です', 'g-2')];
    expect(pendingOwnLines(lines, ID, [history('前半です後半です')])).toHaveLength(2);
  });
});
