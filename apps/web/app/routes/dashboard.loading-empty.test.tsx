// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { fixHomeClock, renderHome, topologySnapshot } from './dashboard-test-helpers';

fixHomeClock();

// vi.hoisted にする: import の評価より後だと TZ の固定が静かに効かないため
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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

const CALM = '承認待ちはない';
const NO_MANAGERS = '走っているマネージャーはいません';

function cardOf(title: string): HTMLElement {
  const card = screen.getByText(title).closest<HTMLElement>('[data-slot="card"]');
  if (card === null) throw new Error(`カードが見つからない: ${title}`);
  return card;
}

describe('ホームの読み込み中', () => {
  it('承認待ちの応答が保留のあいだは「待っているものはない」を出さない', async () => {
    renderHome({ hold: ['approvals'] });

    await screen.findByText(/^まだ記録が無い。/);

    expect(screen.queryByText(CALM)).toBeNull();
    expect(within(cardOf('承認待ち一覧')).getByText('読み込み中')).toBeTruthy();
  });

  it('地図の最初のメッセージが届くまでは、空の地図（走っているマネージャーはいません）を描かない', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderHome({
      topology: { frames: [{ event: 'snapshot', data: topologySnapshot(), after: gate }] },
    });

    await screen.findByText(/^まだ記録が無い。/);
    const card = cardOf('稼働状況');
    expect(within(card).getByText('稼働状況の図を読み込み中')).toBeTruthy();
    expect(within(card).queryByText(NO_MANAGERS)).toBeNull();

    release();
    expect(await within(card).findByText(NO_MANAGERS)).toBeTruthy();
    expect(within(card).queryByText('稼働状況の図を読み込み中')).toBeNull();
  });

  it('対照: 0件で成功したら、どちらの文言も出る', async () => {
    renderHome({ topology: { frames: [{ event: 'snapshot', data: topologySnapshot() }] } });

    expect(await screen.findByText(CALM)).toBeTruthy();
    expect(await screen.findByText(NO_MANAGERS)).toBeTruthy();
  });

  it('地図に繋がらなければ、読み込み中のまま止めず失敗として言う（空の地図にもしない）', async () => {
    renderHome();

    const card = cardOf('稼働状況');
    await waitFor(() => expect(within(card).getByText(/稼働状況の図に繋がらない/)).toBeTruthy());
    expect(within(card).queryByText(NO_MANAGERS)).toBeNull();
  });
});
