// @vitest-environment jsdom
/**
 * ホームの「いま動いているもの」（稼働の地図）。実データ（`GET /topology/stream` の SSE）から
 * 場面を作って `SystemTopology` へ渡すところまでを通す。
 *
 * 保証すること:
 * 1. スナップショットの委譲・作業者・状態が札に出る。**分からないものは「不明」**（待機・正常と言わない）
 * 2. 流れ（光）は時刻の窓で決まり、**窓が過ぎたら新しいスナップショットが来なくても消える**
 *    （基準はデーモンの `observedAt` から数える。ブラウザの時計がずれていても出っぱなし・出ずっぱなしにならない）
 * 3. 切れた・組めないときは、最後の地図を出しつつ**古いと断る**
 * 4. 載せきれなかった委譲の件数を言う。読めない委譲の行（#2345）は地図の下で断る
 * 5. 自由文（依頼の抜粋）は描画の直前に伏せる
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
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

const manager = (extra: Record<string, unknown> = {}) => ({
  managerId: 'abcdef1234567890',
  status: 'running',
  live: true,
  request: 'codex の駆動役を配線する',
  startedAt: '2026-08-14T08:00:00.000Z',
  updatedAt: '2026-08-14T08:30:00.000Z',
  waiting: [],
  workers: [],
  ...extra,
});

const snapshotOf = (patch: Record<string, unknown>) => ({
  event: 'snapshot',
  data: topologySnapshot(patch),
});

const mapCard = () =>
  screen.getByText('いま動いているもの').closest<HTMLElement>('[data-slot="card"]')!;

/** 札（ボタン）。名前は「層 ラベル 状態」。 */
const node = (name: RegExp) => within(mapCard()).getByRole('button', { name });

describe('スナップショットが札になる', () => {
  it('クローン・記憶・マネージャー・作業者が、状態の文言つきで出る', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            clone: { state: 'busy', turn: { kind: 'normal' } },
            managers: [
              manager({
                workers: [{ agentType: 'implementer', lastTool: 'Edit' }],
              }),
            ],
          }),
        ],
      },
    });

    expect(
      await within(mapCard()).findByRole('button', { name: /クローン .*実行中/ }),
    ).toBeTruthy();
    expect(node(/記憶ストア PostgreSQL 正常/)).toBeTruthy();
    expect(node(/マネージャー abcdef12 実行中/)).toBeTruthy();
    // 作業者は lastActivityAt が無い（線が無い）ので、実行中とは言わず待機。
    expect(node(/作業者 implementer 待機/)).toBeTruthy();
    expect(within(mapCard()).getByText('codex の駆動役を配線する')).toBeTruthy();
  });

  it('分からないものは「不明」と言い、待機・正常とは言わない', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            clone: { state: 'unknown' },
            storage: { state: 'unknown' },
            runners: [],
          }),
        ],
      },
    });

    expect(await within(mapCard()).findByRole('button', { name: /クローン .*不明/ })).toBeTruthy();
    expect(node(/記憶ストア .*不明/)).toBeTruthy();
    expect(within(mapCard()).queryByRole('button', { name: /クローン .*待機/ })).toBeNull();
    expect(within(mapCard()).queryByRole('button', { name: /記憶ストア .*正常/ })).toBeNull();
  });

  it('利用枠で止まったクローンは、承認待ちとは言わず、利用枠で止まっていると言う', async () => {
    renderHome({ topology: { frames: [snapshotOf({ clone: { state: 'usage_blocked' } })] } });

    const clone = await within(mapCard()).findByRole('button', { name: /クローン .*止まっている/ });
    expect(within(clone).getByText('利用枠の上限で止まっている')).toBeTruthy();
    expect(within(mapCard()).queryByText('承認待ち')).toBeNull();
  });

  it('記憶ストアへ繋がらないとき、理由（種別）を札に出す', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            storage: { state: 'unreachable', label: 'postgres', error: 'ECONNREFUSED' },
          }),
        ],
      },
    });

    const db = await within(mapCard()).findByRole('button', { name: /記憶ストア .*未接続/ });
    expect(within(db).getByText('ECONNREFUSED')).toBeTruthy();
  });

  it('依頼の抜粋は、描画の直前に伏せる（偽のトークン）', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    renderHome({
      topology: { frames: [snapshotOf({ managers: [manager({ request: `x ${token} y` })] })] },
    });

    await within(mapCard()).findByRole('button', { name: /マネージャー/ });
    expect(mapCard().textContent).not.toContain(token);
  });
});

describe('流れ（光）は時刻の窓で決まり、窓が過ぎれば消える', () => {
  const flows = () =>
    [...mapCard().querySelectorAll('[data-edge]')].map((edge) => ({
      key: edge.getAttribute('data-edge'),
      pulses: edge.querySelectorAll('animateMotion').length,
    }));

  it('直近の指示（down）がある線にだけ光が出て、窓（5秒）を過ぎたら新しいスナップショット無しで消える', async () => {
    // ブラウザの時計を使うのは「受け取ってからの経過」だけ。デーモンの時刻は observedAt が決める。
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-08-14T09:00:00.000Z'));

    renderHome({
      topology: {
        frames: [
          snapshotOf({
            observedAt: '2026-08-14T09:00:00.000Z',
            links: [{ key: 'human~clone', lastDownAt: '2026-08-14T08:59:59.000Z' }],
          }),
        ],
      },
    });

    // SSE の到着は実時間の setTimeout（偽にしていない）。届くのを待つ。
    await waitFor(() => expect(flows().find((e) => e.key === 'human')?.pulses).toBeGreaterThan(0));
    // 他の線には光が無い。
    expect(
      flows()
        .filter((e) => e.pulses > 0)
        .map((e) => e.key),
    ).toEqual(['human']);

    // 受け取ってから 10 秒経つ。新しいスナップショットは来ない（デーモンは変わったときだけ送る）。
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(flows().every((e) => e.pulses === 0)).toBe(true));
  });
});

describe('切れた・組めないとき、古いと断る', () => {
  it('組めない（unavailable）間は、最後の地図を出しつつ、理由を言って、いまの状態ではないと断る', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({ managers: [manager()] }),
          { event: 'unavailable', data: { error: 'ECONNREFUSED' } },
        ],
      },
    });

    const note = await within(mapCard()).findByText(
      /デーモンが稼働の地図を組めていない（ECONNREFUSED）/,
    );
    expect(note.textContent).toContain('いまの状態ではない');
    expect(node(/マネージャー abcdef12/)).toBeTruthy();
  });

  it('まだ何も届かず組めないときは、空の地図ではなく失敗として言う', async () => {
    renderHome({
      topology: { frames: [{ event: 'unavailable', data: { error: 'ECONNREFUSED' } }] },
    });

    expect(
      await within(mapCard()).findByText(/デーモンが稼働の地図を組めていない（ECONNREFUSED）/),
    ).toBeTruthy();
    expect(within(mapCard()).queryByText('走っているマネージャーはいません')).toBeNull();
  });
});

describe('載せきれなかった委譲・読めない委譲', () => {
  it('地図に載せなかった件数（managersOmitted）を言う。無ければ言わない', async () => {
    renderHome({
      topology: { frames: [snapshotOf({ managers: [manager()], managersOmitted: 4 })] },
    });

    expect(await screen.findByText(/ほか 4 本のマネージャーは地図に載せていない/)).toBeTruthy();
  });

  it('対照: 切っていなければ、載せていないとは言わない', async () => {
    renderHome({ topology: { frames: [snapshotOf({ managers: [manager()] })] } });

    await within(mapCard()).findByRole('button', { name: /マネージャー/ });
    expect(screen.queryByText(/地図に載せていない/)).toBeNull();
  });

  /**
   * **読めない委譲を「走っているマネージャーはいません」の顔で隠さない（#2345）。** 地図は読めた行
   * だけで組まれるので、壊れた行は地図から見えない。旧「稼働中のマネージャー」カードが持っていた
   * 約束を、カードを外したあともここで守る。
   */
  it('読めない委譲があれば、地図が空でも、居ないのでも畳まれたのでもないと断る', async () => {
    renderHome({
      managers: { managers: [], unreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }] },
      topology: { frames: [snapshotOf({})] },
    });

    const note = await screen.findByText(/読めない委譲が 1 件ある/);
    expect(note.textContent).toContain('id: mgr-bad');
    expect(note.textContent).toContain('居ないのでも、畳まれたのでもない');
  });

  it('対照: 鍵が無ければ（0件）、断りは出ない', async () => {
    renderHome({
      managers: { managers: [] },
      topology: { frames: [snapshotOf({})] },
    });

    expect(await screen.findByText('走っているマネージャーはいません')).toBeTruthy();
    expect(screen.queryByText(/読めない委譲/)).toBeNull();
  });

  it('マネージャー一覧へのリンクがある', async () => {
    renderHome({ topology: { frames: [snapshotOf({})] } });

    expect(
      (await screen.findByRole('link', { name: 'マネージャー一覧' })).getAttribute('href'),
    ).toBe('/managers');
  });
});
