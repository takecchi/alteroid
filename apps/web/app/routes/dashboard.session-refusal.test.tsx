// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
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

const REFUSAL = {
  streak: 2,
  category: 'cyber',
  since: '2026-08-14T08:00:00.000Z',
  sessionId: 's-1',
  autoReopen: 'disabled',
};

describe('ホームの帯（クローンのセッションが安全分類器に弾かれ続けている）', () => {
  it('弾かれているときだけ、連続数・category・自動の開き直しの状態を言い、設定画面へのリンクを置く（ボタンは置かない）', async () => {
    renderHome({ status: { storage: 'x', cloneSessionRefusal: REFUSAL } });

    const band = await screen.findByTestId('session-refusal-band');

    expect(band.textContent).toContain('安全分類器に 2 回続けて弾かれている');
    expect(band.textContent).toContain('cyber');
    expect(band.textContent).toContain('自動の開き直しは外してある');
    expect(band.querySelector('button')).toBeNull();
    expect(band.querySelector('a')?.getAttribute('href')).toBe('/settings');
  });

  it('自動の開き直しを止めたときは、そう言う', async () => {
    renderHome({
      status: {
        storage: 'x',
        cloneSessionRefusal: { ...REFUSAL, streak: 1, autoReopen: 'halted' },
      },
    });

    const band = await screen.findByTestId('session-refusal-band');

    expect(band.textContent).toContain('自動の開き直しは止めた');
  });

  it('欄が無い（弾かれていない）ときは帯を出さない', async () => {
    renderHome({ status: { storage: 'x' } });

    await screen.findByText(/^まだ記録が無い。/);

    expect(screen.queryByTestId('session-refusal-band')).toBeNull();
  });

  it('/status が取れないときも帯を出さない（取れないことを「弾かれている」とは言わない）', async () => {
    renderHome();

    await screen.findByText(/^まだ記録が無い。/);

    expect(screen.queryByTestId('session-refusal-band')).toBeNull();
  });
});
