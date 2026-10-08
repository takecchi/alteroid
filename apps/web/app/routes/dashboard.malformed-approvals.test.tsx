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
  ['approvals が null', { approvals: null }],
  ['approvals が配列でない', { approvals: 'x' }],
  ['本体が null', null],
];

describe('/approvals の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)(
    '%s でも落ちず、「承認待ち一覧」は0件でなく「読めていない」になる',
    async (_n, body) => {
      renderHome({ approvals: { raw: body } });

      const note = await screen.findByText(/承認待ちを読めていない/);
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.getByText('稼働状況')).toBeTruthy();
      // 範囲が取れなければここで落とす: 別の要素の中を見て緑になるのを防ぐため
      const card = note.closest<HTMLElement>('[data-slot="card"]');
      expect(card).not.toBeNull();
      expect(within(card!).getByText('承認待ち一覧')).toBeTruthy();
      expect(screen.queryByText('承認待ちはない')).toBeNull();
      expect(within(card!).queryByText('答える')).toBeNull();
    },
  );

  it('真っ当な空配列は今までどおり「待っているものはない」（読めていないにはしない）', async () => {
    renderHome({ approvals: [] });

    expect(await screen.findByText('承認待ちはない')).toBeTruthy();
    expect(screen.queryByText(/承認待ちを読めていない/)).toBeNull();
  });
});

describe('読めない承認待ちだけのとき（#3062）', () => {
  it('calm（承認待ちはない）の代わりに警告を出す', async () => {
    renderHome({
      approvals: {
        raw: { approvals: [], unreadable: [{ id: 'ap-bad', reason: 'x' }, { reason: 'y' }] },
      },
    });

    const note = await screen.findByText(/読めない承認待ちが 2 件ある/);
    expect(note.textContent).toContain('壊れた行であって、回答済みでも取り下げ済みでもない');
    expect(screen.queryByText('承認待ちはない')).toBeNull();
  });

  it('読める承認待ちと混在するときも、警告を一覧の上に足す', async () => {
    renderHome({
      approvals: {
        raw: {
          approvals: [
            { id: 'a-1', question: '質問1', createdAt: '2026-08-19T10:00:00.000Z', options: [] },
          ],
          unreadable: [{ reason: 'y' }],
        },
      },
    });

    expect(await screen.findByText(/読めない承認待ちが 1 件ある/)).toBeTruthy();
    expect(screen.getByText('質問1')).toBeTruthy();
  });

  it('対照: 読めない行が無く0件なら、従来どおり「承認待ちはない」', async () => {
    renderHome({ approvals: { raw: { approvals: [] } } });

    expect(await screen.findByText('承認待ちはない')).toBeTruthy();
    expect(screen.queryByText(/読めない承認待ち/)).toBeNull();
  });
});
