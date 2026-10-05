// @vitest-environment jsdom
/**
 * ホームの「承認待ち一覧」と「稼働状況」が、読み込み中に空の文言を出さないこと
 * （issue #2325）。
 *
 * まだ一度も取れていない（`data` も `error` も無い）間に「承認待ちはない」
 * 「走っているマネージャーはいません」を描くと、取れた結果が0件だったように読める。失敗
 * （`error`）は従来どおり `ErrorNote` が先に拾う。
 *
 * 旧ダッシュボードの「稼働中のマネージャー」カードの同じ保証は、地図（`LiveMapCard`）の
 * 「接続中は読み込み、まだ何も届いていなければ空の地図を描かない」へ移した。
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { renderHome, topologySnapshot } from './dashboard-test-helpers';

// TZ の固定は `dashboard.test.tsx` の冒頭と同じ形（`vi.hoisted` でなければ静かに効かない）。
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

    // 他のカードが取れ終わるまで待つ（保留の側だけが読み込み中のまま残る）。
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

    // 他のカードが取れ終わるまで待つ（地図の側だけが読み込み中のまま残る）。
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
    // 経路を置かない = 繋がらない（`stubFetch` の既定）。
    renderHome();

    const card = cardOf('稼働状況');
    await waitFor(() => expect(within(card).getByText(/稼働状況の図に繋がらない/)).toBeTruthy());
    expect(within(card).queryByText(NO_MANAGERS)).toBeNull();
  });
});
