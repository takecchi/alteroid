// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  queryShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  type Route,
} from '~/test-support';

import Chat, { describeCloneInterruptOutcome } from './chat';

const CONVERSATION_ID = 'conv-interrupt-1';
const OTHER_CONVERSATION_ID = 'conv-interrupt-2';

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
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
  };
}

function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes(`/conversations/${OTHER_CONVERSATION_ID}`)) {
    return json({ conversationId: OTHER_CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/approvals')) {
    return json({ approvals: [] });
  }
  if (url.includes('/conversations')) {
    return json({ conversations: [], scanned: 0 });
  }
  return undefined;
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

async function findInterruptButton() {
  return screen.findByRole('button', { name: 'クローンのターンを止める' });
}

function interruptButton() {
  return screen.getByRole('button', { name: 'クローンのターンを止める' });
}

describe('describeCloneInterruptOutcome（CLI と文言を揃える単体試験）', () => {
  it('interrupted', () => {
    expect(describeCloneInterruptOutcome('interrupted')).toBe(
      'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。',
    );
  });

  it('idle', () => {
    expect(describeCloneInterruptOutcome('idle')).toBe(
      '走っているターンは無かった（止めるものが無い）。',
    );
  });

  it('unsupported', () => {
    expect(describeCloneInterruptOutcome('unsupported')).toBe(
      'このサーバのクローンは、ターンを止められない。',
    );
  });
});

describe('「ターンを止める」ボタン', () => {
  it('押すと POST /clone/interrupt を本文 {} で1回だけ叩く', async () => {
    const stub = stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'interrupted' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/clone/interrupt'))).toBe(true);
    });

    const calls = stub.entries.filter((entry) => entry.url.endsWith('/clone/interrupt'));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.request?.method).toBe('POST');
    const body = (await call?.request?.clone().json()) as unknown;
    expect(body).toEqual({});
  });

  it('interrupted: 止めたこと・セッションと受信箱が残ることを言う', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'interrupted' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(
      await screen.findByText(
        'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。',
      ),
    ).toBeTruthy();
  });

  it('idle: 止めるものが無かったことを、止めたとは言わずに伝える', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'idle' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(
      await screen.findByText('走っているターンは無かった（止めるものが無い）。'),
    ).toBeTruthy();
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  it('unsupported: この構成では止められないことを伝える', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'unsupported' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(await screen.findByText('このサーバのクローンは、ターンを止められない。')).toBeTruthy();
  });

  it('呼べなかった失敗（403）は結果ではなく ErrorNote に出る。「止めた」とは言わない', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ error: '許可が無い' }, 403);
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('許可が無い');
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
    expect(screen.queryByText('走っているターンは無かった（止めるものが無い）。')).toBeNull();
    expect(screen.queryByText('このサーバのクローンは、ターンを止められない。')).toBeNull();
  });
});

describe('会話を切り替えた後に届いた応答（#1548 / #1570）', () => {
  it('A で押した後 B へ切り替え、効果が走ってから応答が返っても B に出ない（act で効果を先に流す）', async () => {
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) {
        return interruptReleased.then(() => json({ outcome: 'interrupted' }));
      }
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/clone/interrupt'))).toBe(true);
    });

    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await findShownConversation(OTHER_CONVERSATION_ID)).toBeTruthy();

    // act() で効果を先に流す: 応答を返すのが早すぎると受動効果がまだ走っておらず、直っていないのに緑になりうるため
    await act(async () => {});

    releaseInterrupt();

    // 「出ない」は findBy/waitFor で直接待てないため、必ず起きる別の事実（ボタンの disabled が外れること）を待つ
    await waitFor(() => {
      expect((interruptButton() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  it('B の画面が commit された直後（効果が走る前）に応答が返っても、B に A の「止めた」が出ない（#1570）', async () => {
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) {
        return interruptReleased.then(() => json({ outcome: 'interrupted' }));
      }
      return undefined;
    };
    const stub = stubFetch(route);
    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());
    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/clone/interrupt'))).toBe(true);
    });

    // MutationObserver のコールバックで応答を返す: findBy や act() で待つと受動効果まで流れて窓を越えるため
    let releasedInWindow = false;
    const observer = new MutationObserver(() => {
      if (releasedInWindow || queryShownConversation(OTHER_CONVERSATION_ID) === null) return;
      releasedInWindow = true;
      observer.disconnect();
      releaseInterrupt();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await findShownConversation(OTHER_CONVERSATION_ID)).toBeTruthy();
    expect(releasedInWindow).toBe(true);
    await waitFor(() => {
      expect((interruptButton() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  it('同じ会話のまま応答が返れば、今までどおり出る（切り替えていない対照）', async () => {
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) {
        return interruptReleased.then(() => json({ outcome: 'interrupted' }));
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    releaseInterrupt();

    expect(
      await screen.findByText(
        'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。',
      ),
    ).toBeTruthy();
  });
});

describe('止めた結果の帯は、次の発言を送ると下りる（#4020）', () => {
  const BAND =
    'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';

  function stubWithChat(chatPosts: { count: number }) {
    return stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'interrupted' });
      if (url.endsWith('/chat')) {
        chatPosts.count += 1;
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });
  }

  async function sendText(value: string) {
    const textbox = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(textbox, { target: { value } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
  }

  it('止めたあとで次の発言を送ると、「止めた」の帯が消える', async () => {
    const chatPosts = { count: 0 };
    stubWithChat(chatPosts);

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());
    expect(await screen.findByText(BAND)).toBeTruthy();

    await sendText('続きをお願い');

    await waitFor(() => expect(chatPosts.count).toBe(1));
    await waitFor(() => expect(screen.queryByText(BAND)).toBeNull());
  });

  it('走っているターンへの追送でも、「止めた」の帯が消える', async () => {
    const chatPosts = { count: 0 };
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'interrupted' });
      if (url.endsWith('/chat')) {
        chatPosts.count += 1;
        // `done` を流さない: 1発言目のストリームが走ったまま、2発言目が追送になる
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          signal: init?.signal,
        });
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await sendText('一つ目');
    await waitFor(() => expect(chatPosts.count).toBe(1));
    fireEvent.click(await findInterruptButton());
    expect(await screen.findByText(BAND)).toBeTruthy();

    await sendText('二つ目');

    await waitFor(() => expect(chatPosts.count).toBe(2));
    await waitFor(() => expect(screen.queryByText(BAND)).toBeNull());
  });

  it('送らないうちは帯が残る（対照）', async () => {
    stubWithChat({ count: 0 });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());
    expect(await screen.findByText(BAND)).toBeTruthy();

    const textbox = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(textbox, { target: { value: '書きかけ' } });
    expect(screen.getByText(BAND)).toBeTruthy();
  });
});
