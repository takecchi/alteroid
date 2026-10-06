// @vitest-environment jsdom
/**
 * ホームの「稼働状況」（稼働状況の図）。実データ（`GET /topology/stream` の SSE）から
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

const mapCard = () => screen.getByText('稼働状況').closest<HTMLElement>('[data-slot="card"]')!;

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
    // 作業者は lastActivityAt が無い（線が無い）。親は走行中なので、長い道具の実行中か終わったかを
    // 確かめられない。待機とは言わず「不明」（#2726 で反転。以前は「待機」と言っていた＝
    // 確かめられないものを待機に寄せていた欠陥を固定していた。保証は「実行中とは言わない」まで残る）。
    expect(node(/作業者 implementer 不明/)).toBeTruthy();
    expect(
      within(mapCard()).queryByRole('button', { name: /作業者 implementer 実行中/ }),
    ).toBeNull();
    expect(within(mapCard()).getByText('codex の駆動役を配線する')).toBeTruthy();
  });

  it('「仕事なし」と「完了待ち」を分ける（背景処理待ちで畳んだマネージャーは完了待ち）', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            clone: { state: 'idle' },
            managers: [
              manager({
                status: 'done',
                awaitingBackground: {
                  tasks: 2,
                  withheldReports: 1,
                  breakdown: 'local_agent×2',
                  since: '2026-08-14T08:20:00.000Z',
                },
              }),
              manager({ managerId: 'ffffffff00000000', status: 'done' }),
            ],
          }),
        ],
      },
    });

    expect(
      await within(mapCard()).findByRole('button', { name: /クローン .*完了待ち/ }),
    ).toBeTruthy();
    expect(node(/マネージャー abcdef12 完了待ち/)).toBeTruthy();
    expect(node(/マネージャー ffffffff 仕事なし/)).toBeTruthy();
    expect(within(mapCard()).queryByRole('button', { name: /待機/ })).toBeNull();
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
      /サーバが稼働状況の図を組めていない（ECONNREFUSED）/,
    );
    expect(note.textContent).toContain('いまの状態ではない');
    expect(node(/マネージャー abcdef12/)).toBeTruthy();
  });

  it('まだ何も届かず組めないときは、空の地図ではなく失敗として言う', async () => {
    renderHome({
      topology: { frames: [{ event: 'unavailable', data: { error: 'ECONNREFUSED' } }] },
    });

    expect(
      await within(mapCard()).findByText(/サーバが稼働状況の図を組めていない（ECONNREFUSED）/),
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
      topology: {
        frames: [snapshotOf({ unreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }] })],
      },
    });

    // 空の地図は「居ない」と言い切らない。
    expect(await screen.findByText(/読めない行が 1 件ある。居ないとは限らない/)).toBeTruthy();
    expect(screen.queryByText('走っているマネージャーはいません')).toBeNull();
    const note = await screen.findByText(/読めない委譲が 1 件ある/);
    expect(note.textContent).toContain('id: mgr-bad');
    expect(note.textContent).toContain('居ないのでも、畳まれたのでもない');
  });

  it('マネージャーが居て読めない行もあるとき、地図の下で件数を言う（居る分だけ見せて黙らない）', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            managers: [manager()],
            unreadable: [{ reason: 'r' }, { id: 'b', reason: 'r' }],
          }),
        ],
      },
    });

    await within(mapCard()).findByRole('button', { name: /マネージャー/ });
    expect(await screen.findByText(/読めない委譲が 2 件ある/)).toBeTruthy();
  });

  it('一覧（/managers）は読まない。読めない行は /topology の snapshot から（#2705）', async () => {
    const stub = renderHome({ topology: { frames: [snapshotOf({})] } });

    await screen.findByText('走っているマネージャーはいません');
    expect(stub.calls.filter((url) => url.includes('/managers'))).toEqual([]);
  });

  it('対照: 鍵が無ければ（0件・古いデーモンも同じ）、断りは出ない', async () => {
    renderHome({
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

/**
 * 外部サービス（連携の鍵）の札と線（Issue #3676）。**札は `snapshot.externals` からだけ作る**。
 * 版ずれ（古いデーモンが載せない・新しいデーモンが知らない key を返す）で落ちず、他の線を壊さない。
 */
describe('外部サービス（連携の鍵）', () => {
  const external = (keyId: string, name: string, lastAt: string) => ({
    keyId,
    name,
    source: 'github',
    lastAt,
  });
  const pulses = (key: string) =>
    mapCard().querySelectorAll(`[data-edge="${key}"] animateMotion`).length;

  it('連携の鍵で受けた呼び出しは、その札と外部 → クローンの線を光らせ、窓（5秒）を過ぎたら消える', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-08-14T09:00:00.000Z'));

    renderHome({
      topology: {
        frames: [
          snapshotOf({
            observedAt: '2026-08-14T09:00:00.000Z',
            externals: [
              external('k1', 'GitHub 連携', '2026-08-14T08:59:59.000Z'),
              external('k2', 'CI', '2026-08-14T08:50:00.000Z'),
            ],
            links: [
              { key: 'external:k1~clone', lastDownAt: '2026-08-14T08:59:59.000Z' },
              { key: 'external:k2~clone', lastDownAt: '2026-08-14T08:50:00.000Z' },
            ],
          }),
        ],
      },
    });

    // 札は状態を言わない（外部サービスの状態は観測していない）。
    expect(
      await within(mapCard()).findByRole('button', { name: '外部サービス GitHub 連携' }),
    ).toBeTruthy();
    expect(node(/^外部サービス CI$/)).toBeTruthy();
    await waitFor(() => expect(pulses('x-external:k1')).toBeGreaterThan(0));
    expect(pulses('x-external:k2')).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(pulses('x-external:k1')).toBe(0));
  });

  it('上限を超えた分は「ほか N 件」の札になる', async () => {
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            externals: [external('k1', 'GitHub 連携', '2026-08-14T08:50:00.000Z')],
            externalsOmitted: 3,
          }),
        ],
      },
    });

    expect(
      await within(mapCard()).findByRole('button', { name: '外部サービス ほか 3 件' }),
    ).toBeTruthy();
  });

  it('古いデーモン（externals を載せない）では外部の札を出さず、他の札は今までどおり', async () => {
    renderHome({ topology: { frames: [snapshotOf({ managers: [manager()] })] } });

    await within(mapCard()).findByRole('button', { name: /マネージャー abcdef12/ });
    expect(within(mapCard()).queryByRole('button', { name: /外部サービス/ })).toBeNull();
  });

  it('新しいデーモンが知らない key の線を返しても落ちず、札も作らない（他の線は光る）', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-08-14T09:00:00.000Z'));
    renderHome({
      topology: {
        frames: [
          snapshotOf({
            observedAt: '2026-08-14T09:00:00.000Z',
            links: [
              { key: 'external:ghost~clone', lastDownAt: '2026-08-14T08:59:59.000Z' },
              { key: 'future-kind~clone', lastDownAt: '2026-08-14T08:59:59.000Z' },
              { key: 'human~clone', lastDownAt: '2026-08-14T08:59:59.000Z' },
            ],
          }),
        ],
      },
    });

    await waitFor(() => expect(pulses('human')).toBeGreaterThan(0));
    expect(within(mapCard()).queryByRole('button', { name: /外部サービス/ })).toBeNull();
  });
});
