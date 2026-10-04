// @vitest-environment jsdom
/**
 * `GET /approvals` の応答が `approvals` の配列を持たない形のとき（版のずれ）のホーム（issue #2308）。
 *
 * 測る保証は2つ — (1) ホームが落ちない（ErrorBoundary に捕まらず、他のカードも出る）
 * (2) 「あなたを待っている」は 0件（「待っているものはない」）ではなく「読めていない」の表示になる。
 * 型は `approvals` を配列と言っているので、ここが守るのは実行時の倒れ先だけである。
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { renderHome } from './dashboard-test-helpers';

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

const MALFORMED: [string, unknown][] = [
  ['空のオブジェクト', {}],
  ['approvals が null', { approvals: null }],
  ['approvals が配列でない', { approvals: 'x' }],
  ['本体が null', null],
];

describe('/approvals の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)(
    '%s でも落ちず、「あなたを待っている」は0件でなく「読めていない」になる',
    async (_n, body) => {
      renderHome({ approvals: { raw: body } });

      // (2) 「読めていない」の表示（エラーのときと同じ `role="alert"`）
      const note = await screen.findByText(/承認待ちを読めていない/);
      // (1) 落ちていない（React Router 既定の ErrorBoundary に代わっていない）
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.getByText('いま動いているもの')).toBeTruthy();
      // カードは「あなたを待っている」のもので、0件の表示も「答える」リンクも出ていない。
      // 範囲が取れなければここで落とす（別の要素の中を見て緑になるのを防ぐ）。
      const card = note.closest<HTMLElement>('[data-slot="card"]');
      expect(card).not.toBeNull();
      expect(within(card!).getByText('あなたを待っている')).toBeTruthy();
      expect(screen.queryByText('あなたを待っているものはない')).toBeNull();
      expect(within(card!).queryByText('答える')).toBeNull();
    },
  );

  it('真っ当な空配列は今までどおり「待っているものはない」（読めていないにはしない）', async () => {
    renderHome({ approvals: [] });

    expect(await screen.findByText('あなたを待っているものはない')).toBeTruthy();
    expect(screen.queryByText(/承認待ちを読めていない/)).toBeNull();
  });
});
