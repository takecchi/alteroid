// @vitest-environment jsdom
/**
 * 「いま走っているクローンのターンを止める」ボタン（#1398 c23-1/c30-2）。
 *
 * PR #1474（`0297103`）で `POST /clone/interrupt` と CLI の `alteroid interrupt`
 * が入ったが、Web UI にはこの口が無かった——docs/PRD.md の「入口の等価性」
 * （ある入口でできることが別の入口でできない状態を作らない）に反する状態だった。
 *
 * ここで固定したいのは3つ:
 *
 * 1. ボタンを押すと `POST /clone/interrupt`（本文 `{}`）が実際に飛ぶこと
 * 2. 応答の3値（`interrupted` / `idle` / `unsupported`）を、CLI の
 *    `describeInterruptOutcome`（`apps/cli/src/interrupt.ts`）と同じ文言で
 *    人間に見せること——`describeCloneInterruptOutcome`（`chat.tsx`）の直接の
 *    単体試験と、画面を通した結合試験の両方で見る
 * 3. 呼べなかった失敗（ネットワーク断・403 等）は結果ではなく `ErrorNote` に
 *    出ること——「止めた」と誤読させない
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat, { describeCloneInterruptOutcome } from './chat';

const CONVERSATION_ID = 'conv-interrupt-1';

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

/** `/approvals` はこの試験の対象ではない。未ハンドルのまま（`chat.edit-message.test.tsx` と同じ）。 */
function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
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
      'このデーモンのクローンは、ターンを止める口を持っていない。',
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
    // 「止めた」側の文言とは混ざらない。
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

    expect(
      await screen.findByText('このデーモンのクローンは、ターンを止める口を持っていない。'),
    ).toBeTruthy();
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
    // 3値のどの文言も出ていない——失敗を結果と取り違えていない。
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
    expect(screen.queryByText('走っているターンは無かった（止めるものが無い）。')).toBeNull();
    expect(
      screen.queryByText('このデーモンのクローンは、ターンを止める口を持っていない。'),
    ).toBeNull();
  });
});
