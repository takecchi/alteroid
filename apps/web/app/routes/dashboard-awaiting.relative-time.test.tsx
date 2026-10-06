// @vitest-environment jsdom
/**
 * #3700。ホームの承認待ちの「N分前」は、再描画のきっかけが無くても分単位で更新される。
 * **実時間を待たない**（偽のタイマー。`waitFor` は偽のタイマーと噛み合わないので、約束の解決は
 * `advanceTimersByTimeAsync(0)` で流す）。進捗の30秒の取り直しが再描画の代わりをしないよう、
 * 進捗は読み込み中のまま止める（`hold`）。
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { renderHome } from './dashboard-test-helpers';

const START = new Date('2026-10-07T12:00:00.000Z').getTime();

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  vi.useFakeTimers({ now: START, toFake: ['setInterval', 'clearInterval', 'Date'] });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

describe('ホームの承認待ちの相対の時刻（#3700）', () => {
  it('分が進むと「たった今」が「N分前」に変わる', async () => {
    const createdAt = new Date(START).toISOString();
    renderHome({
      approvals: [{ id: 'a-1', question: '出してよいか', createdAt, options: [] }],
      hold: ['progress'],
    });
    await flush();
    expect(screen.getByText('出してよいか')).toBeTruthy();
    expect(screen.getByText('たった今')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText('3分前')).toBeTruthy();
    expect(screen.queryByText('たった今')).toBeNull();
  });
});
