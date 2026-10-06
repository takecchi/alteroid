// @vitest-environment jsdom
/**
 * `GET /reports` の応答が `reports` の配列を持たない形のとき（版のずれ）のホーム（issue #3702）。
 *
 * 測る保証は2つ — (1) ホームが落ちない（ErrorBoundary に捕まらず、他のカードも出る）
 * (2) 「最新の日報」は0件（「まだ日報がない」）ではなく「読めていない」の表示になる。
 * 承認待ちの #2308（`dashboard.malformed-approvals.test.tsx`）と同じ形。
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
  ['reports が null', { reports: null }],
  ['reports が配列でない', { reports: 'x' }],
  ['本体が null', null],
];

describe('/reports の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)(
    '%s でも落ちず、「最新の日報」は0件でなく「読めていない」になる',
    async (_n, body) => {
      renderHome({ reports: { raw: body } });

      const note = await screen.findByText(/最新の日報を読めていない/);
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.getByText('稼働状況')).toBeTruthy();
      // 範囲が取れなければここで落とす（別の要素の中を見て緑になるのを防ぐ）。
      const card = note.closest<HTMLElement>('[data-slot="card"]');
      expect(card).not.toBeNull();
      expect(within(card!).getByText('最新の日報')).toBeTruthy();
      expect(screen.queryByText(/まだ日報がない/)).toBeNull();
    },
  );

  it('真っ当な空配列は今までどおり「まだ日報がない」（読めていないにはしない）', async () => {
    renderHome({ reports: [] });

    expect(await screen.findByText(/まだ日報がない/)).toBeTruthy();
    expect(screen.queryByText(/最新の日報を読めていない/)).toBeNull();
  });
});
