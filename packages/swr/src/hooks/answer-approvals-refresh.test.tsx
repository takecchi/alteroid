// @vitest-environment jsdom
/**
 * `useAnswerApprovals`（まとめ送信）は、答えが通ったあとの一覧の取り直しが失敗しても
 * `results` を返す（issue #3627）。投げるのは `POST /approvals/answer` が失敗したときだけ。
 *
 * **取り直しの失敗は `mutate` を拒否させて作る。** fetch を繋がらなくしても、SWR の
 * `mutate(key)` は拒否されない（失敗はキャッシュの `error` に入るだけ）ので、hook の
 * 「取り直しが投げた」経路には届かない。
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnswerApprovals } from './mutations';
import { json, Providers, storeTestBaseUrl } from '../test-support';

const refresh = vi.hoisted(() => ({ rejects: false, attempts: 0 }));
vi.mock('swr', async (importOriginal) => {
  const original = await importOriginal<typeof import('swr')>();
  return {
    ...original,
    useSWRConfig: () => {
      const config = original.useSWRConfig();
      return {
        ...config,
        mutate: ((...args: Parameters<typeof config.mutate>) => {
          refresh.attempts += 1;
          return refresh.rejects
            ? Promise.reject(new Error('refresh failed'))
            : config.mutate(...args);
        }) as typeof config.mutate,
      };
    },
  };
});

type AnswerAll = ReturnType<typeof useAnswerApprovals>;

let answerAll: AnswerAll | undefined;
let originalFetch: typeof fetch;

function Probe() {
  const fn = useAnswerApprovals();
  useEffect(() => {
    answerAll = fn;
  }, [fn]);
  return null;
}

function stubPost(post: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === '/approvals/answer') return post();
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  answerAll = undefined;
  refresh.rejects = false;
  refresh.attempts = 0;
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
    const results = [
      { id: 'a-1', ok: true },
      { id: 'a-2', ok: false, error: 'already answered' },
    ];
    stubPost(() => json({ results }));
    const fn = await mounted();
    refresh.rejects = true;

    await expect(
      fn([
        { id: 'a-1', answer: 'はい' },
        { id: 'a-2', answer: 'いいえ' },
      ]),
    ).resolves.toEqual(results);
    // 取り直しは試みている（試みずに通ったのではない）。
    expect(refresh.attempts).toBeGreaterThan(0);
  });

  it('POST そのものが失敗したときは、これまでどおり投げる', async () => {
    stubPost(() => json({ error: 'boom' }, 500));
    const fn = await mounted();
    await expect(fn([{ id: 'a-1', answer: 'はい' }])).rejects.toBeDefined();
  });
});
