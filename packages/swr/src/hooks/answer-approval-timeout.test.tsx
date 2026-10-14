// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnswerApproval, useAnswerApprovals } from './mutations';
import { useApprovals } from './queries';
import { json, Providers, storeTestBaseUrl } from '../test-support';

// 応答しないデーモンの前で、承認の回答が「送信中」のまま解けない（#4713）

type AnswerOne = ReturnType<typeof useAnswerApproval>;
type AnswerAll = ReturnType<typeof useAnswerApprovals>;

let answerOne: AnswerOne | undefined;
let answerAll: AnswerAll | undefined;
let originalFetch: typeof fetch;
let listGets = 0;

function Probe() {
  useApprovals(false);
  const one = useAnswerApproval();
  const all = useAnswerApprovals();
  useEffect(() => {
    answerOne = one;
    answerAll = all;
  }, [one, all]);
  return null;
}

// 繋がるが何も返さない相手の代わり: signal が切れるまで決着しない
function hanging(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason as Error), {
      once: true,
    });
  });
}

function stubServer(options: { post: 'ok' | 'hang'; listHangs: () => boolean }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/approvals/') && request.method === 'POST') {
      if (options.post === 'hang') return hanging(request);
      return url.pathname === '/approvals/answer'
        ? json({ results: [{ id: 'a-1', ok: true }] })
        : json({ ok: true });
    }
    if (url.pathname === '/approvals') {
      listGets += 1;
      if (options.listHangs()) return hanging(request);
      return json({ approvals: [] });
    }
    throw new TypeError(`Failed to fetch: ${url.href}`);
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  answerOne = undefined;
  answerAll = undefined;
  listGets = 0;
  localStorage.clear();
  storeTestBaseUrl();
  // 期限を縮める（掛けている長さは本番の値のまま）
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => original(20));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

async function mounted(): Promise<void> {
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  await waitFor(() => expect(answerOne).toBeDefined());
  await waitFor(() => expect(listGets).toBeGreaterThan(0));
}

describe('承認の回答の期限（#4713）', () => {
  it('⭐ 1件の回答の POST が返らなければ、期限で見切り「届いたかは分からない」と言って失敗する', async () => {
    stubServer({ post: 'hang', listHangs: () => false });
    await mounted();

    await expect(answerOne!('a-1', 'はい')).rejects.toThrow(/届いたかは分からない/);
  });

  it('⭐ まとめ回答の POST が返らなければ、期限で見切って失敗する', async () => {
    stubServer({ post: 'hang', listHangs: () => false });
    await mounted();

    await expect(answerAll!([{ id: 'a-1', answer: 'はい' }])).rejects.toThrow(
      /届いたかは分からない/,
    );
  });

  it('⭐ 回答は通ったが一覧の取り直しが返らないときは、待ち切らずに成功として返る', async () => {
    let hangList = false;
    stubServer({ post: 'ok', listHangs: () => hangList });
    await mounted();
    hangList = true;

    await expect(answerOne!('a-1', 'はい')).resolves.toBeUndefined();
    await expect(answerAll!([{ id: 'a-1', answer: 'はい' }])).resolves.toEqual([
      { id: 'a-1', ok: true },
    ]);
  });
});
