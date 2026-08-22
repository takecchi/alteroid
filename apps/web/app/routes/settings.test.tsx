// @vitest-environment jsdom
/**
 * 設定画面の runner の札。**2つの主題が同居している。**
 *
 * 1. **「いま応えているプロセス」を人間にも見せる**（`instanceId`）。`runnerId` は
 *    宛先の名前で、器を作り直しても同じである。だから名前だけでは「さっき仕事を
 *    渡した相手と同じプロセスか」が分からない。**同じ状態をクローンは
 *    `runner_list` で読み、人間はこの画面で読む**ので、片方だけに出す形を作らない
 *    （PRD「インターフェース」— 片方でしかできないことを作らない）。
 *    そして**名乗らない器についてそう言う**ことがもう一方の歯である。黙ると、人間からは
 *    「入れ替わっていない」と「判定できない」が同じに見える（`packages/core/src/lease.ts`
 *    の `undecidable` を出力から消さない、と同じ判断）。
 *
 * 2. **「渡している鍵」欄が、`credentialsProbe` の3状態を混ぜずに出す。**
 *    `GET /runners` は「繋がっていないので叩いていない」（`unheard`）／「叩いたが
 *    失敗した」（`failed`）／「叩いて0件だった」（`asked` かつ `credentials: []`）を
 *    別の値として返す（`apps/daemon/src/openapi.ts` の `runnerProbeSchema`）。
 *    この画面（`settings.tsx` の `Credentials`）がそれを読み分けずに
 *    `credentials.length === 0` だけで「渡している鍵は無い」と断定すると、
 *    確かめられなかったことが確かめた結果として人間に届く。
 *
 * **どちらも「判定できないことを、判定した結果として出さない」という同じ形である。**
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunnerSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Settings from './settings';

const BASE: RunnerSummary = {
  label: 'http://runner:4518',
  state: 'connected',
  since: '2026-08-22T00:00:00.000Z',
  runnerId: 'runner-primary',
  workspacePath: '/workspace',
  credentials: [],
  // 指紋を聞きに行けたか。**省略できない欄なので、既定は「聞けた」に置く** —
  // `instanceId` 側の試験はここを対象にしていないので、そちらの結果を
  // 鍵欄の状態が動かさないようにする。
  credentialsProbe: { status: 'asked' },
  profileProbe: { status: 'asked' },
  // 版の名乗りはこの試験の対象ではない（`instanceId` の見え方だけを見る）。
  // **省略できない欄なので、聞けていない状態を明示して置く。**
  revision: { status: 'unheard' },
};

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

function renderSettings(runners: RunnerSummary[]) {
  stubFetch((url) => {
    if (url.includes('/runners')) return json({ runners });
    // 他の口（認証・接続の札）はこの試験の対象ではない。**握り潰さず**、
    // 空の応答を返して runner の札だけを見る。
    if (url.includes('/auth/providers')) return json({ providers: [] });
    if (url.includes('/me')) return json({ status: 'open' });
    if (url.includes('/health')) return json({ ok: true });
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('runner の札は、いま応えているプロセスを出す', () => {
  it('名乗っているプロセスと、それを見始めた時刻を出す', async () => {
    renderSettings([{ ...BASE, instanceId: 'boot-2', instanceSince: '2026-08-22T03:04:00.000Z' }]);

    const line = await screen.findByText(/プロセス: boot-2/);
    /*
     * **時刻が整形されて出ていることまで見る。** `toContain('から')` だけだと、
     * 整形が壊れても（空文字・`Invalid Date`）緑になる。
     *
     * 見るのは日付だけである — **時分は器の時間帯で変わる**（手元は JST、CI の
     * runner は UTC で9時間ずれる。AGENTS.md「時刻の扱い」）。この試料
     * （03:04Z ＝ JST 12:04）はどちらでも同じ日に落ちるので、日付なら固定できる。
     */
    expect(line.textContent).toMatch(/08\/22.*から/);
  });

  /**
   * **名乗らない器について黙らない。** ここが空欄になると、人間は「入れ替わって
   * いない」と読むしかなくなる（実際には判定材料が無いだけである）。
   */
  it('名乗らない器では「判定できない」と書く', async () => {
    renderSettings([BASE]);

    expect(await screen.findByText(/名乗っていない（入れ替わりを判定できない）/)).toBeTruthy();
  });
});

describe('runner の鍵欄は、聞けた分しか言わない', () => {
  /**
   * 【B-1】聞いていないときは「無い」と言わない。
   *
   * `credentialsProbe.status === 'unheard'` は「繋がっていないので聞いていない」で
   * あって「鍵が配られていない」ではない。`credentials` はどちらの場合も `[]` に
   * なるので、この行を見ずに `credentials.length === 0` だけで判定する実装は
   * ここで「渡している鍵は無い」と誤って言う。
   */
  it('聞いていないときは『無い』と言わない', async () => {
    renderSettings([{ ...BASE, credentials: [], credentialsProbe: { status: 'unheard' } }]);

    expect(await screen.findByText(/確かめていない/)).toBeTruthy();
    expect(screen.queryByText('渡している鍵は無い')).toBeNull();
  });

  /** 【B-2】失敗したときは理由が出る。 */
  it('失敗したときは理由が出る', async () => {
    renderSettings([
      {
        ...BASE,
        credentials: [],
        credentialsProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' },
      },
    ]);

    expect(await screen.findByText(/ECONNRESET: 途中で切れた/)).toBeTruthy();
    expect(screen.queryByText('渡している鍵は無い')).toBeNull();
  });

  /**
   * 【B-3】要である。聞いて0件なら「無い」と言う。
   *
   * これが無いと、画面が常に「確かめていない」と言う方向へ倒れても緑のまま
   * になる。`asked` かつ空配列という「聞けたうえで0件だった」場合を単独で見る。
   */
  it('聞いて0件なら『無い』と言う', async () => {
    renderSettings([{ ...BASE, credentials: [], credentialsProbe: { status: 'asked' } }]);

    expect(await screen.findByText('渡している鍵は無い')).toBeTruthy();
  });
});
