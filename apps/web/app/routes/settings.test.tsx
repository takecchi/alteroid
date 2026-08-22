// @vitest-environment jsdom
/**
 * 設定画面の runner の札 — **「いま応えているプロセス」を人間にも見せる。**
 *
 * `runnerId` は宛先の名前で、器を作り直しても同じである。だから名前だけでは
 * 「さっき仕事を渡した相手と同じプロセスか」が分からない。**同じ状態をクローンは
 * `runner_list` で読み、人間はこの画面で読む**ので、片方だけに出す形を作らない
 * （PRD「インターフェース」— 片方でしかできないことを作らない）。
 *
 * そして**名乗らない器についてそう言う**ことがもう一方の歯である。黙ると、人間からは
 * 「入れ替わっていない」と「判定できない」が同じに見える（`packages/core/src/lease.ts`
 * の `undecidable` を出力から消さない、と同じ判断）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunnerSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Settings from './settings';

const BASE: RunnerSummary = {
  label: 'http://runner:4518',
  state: 'connected',
  since: '2026-08-22T00:00:00.000Z',
  runnerId: 'runner-primary',
  workspacePath: '/workspace',
  credentials: [],
};

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

function renderSettings(runners: RunnerSummary[]) {
  stubFetch((url) => {
    if (url.includes('/runners')) return json({ runners });
    // 他の口（認証・接続の札）はこの試験の対象ではない。**握り潰さず**、
    // 空の応答を返して runner の札だけを見る。
    if (url.includes('/auth/providers')) return json({ providers: [] });
    if (url.includes('/me')) return json({ status: 'open' });
    if (url.includes('/health')) return json({ ok: true });
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('runner の札は、いま応えているプロセスを出す', () => {
  it('名乗っているプロセスと、それを見始めた時刻を出す', async () => {
    renderSettings([{ ...BASE, instanceId: 'boot-2', instanceSince: '2026-08-22T03:04:00.000Z' }]);

    const line = await screen.findByText(/プロセス: boot-2/);
    expect(line.textContent).toContain('から');
  });

  /**
   * **名乗らない器について黙らない。** ここが空欄になると、人間は「入れ替わって
   * いない」と読むしかなくなる（実際には判定材料が無いだけである）。
   */
  it('名乗らない器では「判定できない」と書く', async () => {
    renderSettings([BASE]);

    expect(await screen.findByText(/名乗っていない（入れ替わりを判定できない）/)).toBeTruthy();
  });
});
