// @vitest-environment jsdom
/**
 * `useAnswerApprovals`（まとめ送信）は、答えが通ったあとの一覧の取り直しが失敗しても
 * `results` を返す（issue #3627）。投げるのは `POST /approvals/answer` が失敗したときだけ。
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAnswerApprovals } from './mutations';
import { useApprovals } from './queries';
import { json, Providers, storeTestBaseUrl } from '../test-support';

type AnswerAll = ReturnType<typeof useAnswerApprovals>;

let answerAll: AnswerAll | undefined;
let originalFetch: typeof fetch;

/** 一覧を購読して（取り直しの口を作って）から、まとめ送信の関数を取り出す。 */
function Probe() {
  useApprovals(true);
  const fn = useAnswerApprovals();
  useEffect(() => {
    answerAll = fn;
  }, [fn]);
  return null;
}

/**
 * `GET /approvals` は `answerPosted` が立つまで成功し、立ったあとは繋がらない
 * （＝答えを送ったあとの取り直しだけが失敗する）。
 */
function stubApprovals(post: () => Response): { gets: () => number } {
  let answerPosted = false;
  let gets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === '/approvals/answer') {
      answerPosted = true;
      return post();
    }
    if (url.pathname === '/approvals') {
      gets += 1;
      if (answerPosted) return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
      return json({ approvals: [] });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return { gets: () => gets };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  answerAll = undefined;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function mounted(): Promise<AnswerAll> {
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  await waitFor(() => expect(answerAll).toBeDefined());
  return answerAll!;
}

describe('useAnswerApprovals と取り直しの失敗', () => {
  it('POST が通り、取り直しだけが失敗しても、投げずに results を返す', async () => {
    const stub = stubApprovals(() =>
      json({
        results: [
          { id: 'a-1', ok: true },
          { id: 'a-2', ok: false, error: 'already answered' },
        ],
      }),
    );
    const fn = await mounted();
    await waitFor(() => expect(stub.gets()).toBeGreaterThanOrEqual(1));
    const before = stub.gets();

    await expect(
      fn([
        { id: 'a-1', answer: 'はい' },
        { id: 'a-2', answer: 'いいえ' },
      ]),
    ).resolves.toEqual([
      { id: 'a-1', ok: true },
      { id: 'a-2', ok: false, error: 'already answered' },
    ]);
    // 取り直しは試みている（試みずに通ったのではない）。
    expect(stub.gets()).toBeGreaterThan(before);
  });

  it('POST そのものが失敗したときは、これまでどおり投げる', async () => {
    stubApprovals(() => json({ error: 'boom' }, 500));
    const fn = await mounted();
    await expect(fn([{ id: 'a-1', answer: 'はい' }])).rejects.toBeDefined();
  });
});
