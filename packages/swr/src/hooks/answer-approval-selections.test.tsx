// @vitest-environment jsdom
/**
 * `useAnswerApproval` が `selections` を送れること（issue #2525）。
 *
 * - `(id, answer)` の呼び方は、これまでと同じ本文 `{ answer }` のまま
 * - `selections` を渡すと本文に載る。`answer` を渡さなければ `selections` だけ（補足なし）
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAnswerApproval } from './mutations';
import { json, Providers, storeTestBaseUrl } from '../test-support';

type Answer = ReturnType<typeof useAnswerApproval>;

let answer: Answer | undefined;
let originalFetch: typeof fetch;

function Probe() {
  const fn = useAnswerApproval();
  useEffect(() => {
    answer = fn;
  }, [fn]);
  return null;
}

/** 書き込みの本文は `Request` が持つので、`clone()` で読んで控える（`init.body` には来ない）。 */
function recordBodies(): unknown[] {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (/^\/approvals\/[^/]+\/answer$/.test(url.pathname) && input instanceof Request) {
      bodies.push(await input.clone().json());
      return json({ ok: true });
    }
    if (url.pathname === '/approvals') return json({ approvals: [] });
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return bodies;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  answer = undefined;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function mounted(): Promise<Answer> {
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  await waitFor(() => expect(answer).toBeDefined());
  return answer!;
}

describe('useAnswerApproval と selections', () => {
  it('(id, answer) は本文 { answer } のまま（selections の鍵を足さない）', async () => {
    const bodies = recordBodies();
    const fn = await mounted();
    await fn('a-1', 'はい');
    expect(bodies).toEqual([{ answer: 'はい' }]);
  });

  it('selections を渡すと本文に載り、answer は補足として並ぶ', async () => {
    const bodies = recordBodies();
    const fn = await mounted();
    await fn('a-1', '金曜は避けたい', [
      { questionId: 'q1', optionIds: ['o1'], other: 'ただし来週' },
    ]);
    expect(bodies).toEqual([
      {
        answer: '金曜は避けたい',
        selections: [{ questionId: 'q1', optionIds: ['o1'], other: 'ただし来週' }],
      },
    ]);
  });

  it('answer を undefined にすると selections だけを送る', async () => {
    const bodies = recordBodies();
    const fn = await mounted();
    await fn('a-1', undefined, [{ questionId: 'q1', optionIds: ['o1', 'o2'] }]);
    expect(bodies).toEqual([{ selections: [{ questionId: 'q1', optionIds: ['o1', 'o2'] }] }]);
  });
});
