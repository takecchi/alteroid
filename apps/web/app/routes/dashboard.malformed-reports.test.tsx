// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { fixHomeClock, renderHome } from './dashboard-test-helpers';

fixHomeClock();

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
      // 範囲が取れなければここで落とす: 別の要素の中を見て緑になるのを防ぐため
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
