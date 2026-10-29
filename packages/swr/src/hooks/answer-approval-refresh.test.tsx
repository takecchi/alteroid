// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAnswerApproval } from './mutations';
import { useApprovals } from './queries';
import { json, Providers, storeTestBaseUrl } from '../test-support';

type AnswerOne = ReturnType<typeof useAnswerApproval>;
type Stub = { listGets: number };

let answerOne: AnswerOne | undefined;
let originalFetch: typeof fetch;

function Probe() {
  // 取り直しの相手（一覧の購読）が居ないと、mutate は何も取り直さない
  useApprovals();
  const fn = useAnswerApproval();
  useEffect(() => {
    answerOne = fn;
  }, [fn]);
  return null;
}

// 本物の SWR を通す: `mutate(key)` は取り直しの失敗で reject しない
function stubServer(options: { post: () => Response; listFails?: () => boolean }): Stub {
  const stub: Stub = { listGets: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/approvals/a-1/answer') return options.post();
    if (url.pathname === '/approvals') {
      stub.listGets += 1;
      if (options.listFails?.()) throw new TypeError('Failed to fetch');
      return json({ approvals: [] });
    }
    throw new TypeError(`Failed to fetch: ${url.href}`);
  }) as typeof fetch;
  return stub;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  answerOne = undefined;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function mounted(stub: Stub): Promise<AnswerOne> {
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  await waitFor(() => expect(answerOne).toBeDefined());
  await waitFor(() => expect(stub.listGets).toBeGreaterThan(0));
  return answerOne!;
}

describe('useAnswerApproval と取り直し', () => {
  it('POST が通れば一覧を取り直し、取り直しだけが失敗しても投げない', async () => {
    let failList = false;
    const stub = stubServer({ post: () => json({ ok: true }), listFails: () => failList });
    const fn = await mounted(stub);
    failList = true;
    const before = stub.listGets;

    await expect(fn('a-1', 'はい')).resolves.toBeUndefined();
    expect(stub.listGets).toBeGreaterThan(before);
  });

  it('POST が 409（裏で先に片付いていた）でも一覧を取り直し、元の失敗を投げる', async () => {
    const stub = stubServer({ post: () => json({ error: 'already answered' }, 409) });
    const fn = await mounted(stub);
    const before = stub.listGets;

    await expect(fn('a-1', 'はい')).rejects.toMatchObject({ status: 409 });
    expect(stub.listGets).toBeGreaterThan(before);
  });

  it('応答が接続断で失われても一覧を取り直し、元の失敗を投げる', async () => {
    const stub = stubServer({
      post: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const fn = await mounted(stub);
    const before = stub.listGets;

    await expect(fn('a-1', 'はい')).rejects.toThrow('Failed to fetch');
    expect(stub.listGets).toBeGreaterThan(before);
  });
});
