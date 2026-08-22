// @vitest-environment jsdom
/**
 * 設定画面の runner の札。**3つの主題が同居している。**
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
 * 3. **「版」欄（コミット sha）が、デーモンと runner の両方について出る。**
 *    `instanceId` が答えるのは「同じプロセスか」、版が答えるのは「そのプロセスが
 *    どのコミットのコードで走っているか」で、別の問いである
 *    （`packages/core/src/tools.test.ts` の「デーモンの版と runner の版を、同じ出力に
 *    並べて出す」と対になっている）。要点は「不明」（器が自分の版を知らない）と
 *    「未確認」（名乗りをまだ聞けていない）を畳まないことで、畳んだ画面でも
 *    「版が出ている」ようには見える。
 *
 * **3つとも「判定できないことを、判定した結果として出さない」という同じ形である。**
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DaemonRevision, RunnerSummary } from '~/lib/types';
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

/**
 * デーモン自身の版の既定。
 *
 * **`instanceId` の試験でも省略しない。** `GET /runners` の応答に必ず入る欄なので、
 * ここを省ける形にすると「画面が読んでいない」と「デーモンが返していない」が
 * 試料の側で混ざる。
 */
const DAEMON_UNKNOWN: DaemonRevision = { status: 'unknown' };

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

/**
 * `GET /runners` の応答の形。**生成 spec から導出する**（`lib/types.ts` の約束）。
 * 手で書いた形にすると、経路が変わってもこのテストだけが古いまま通る。
 */
interface RunnersResponse {
  runners: RunnerSummary[];
  daemonRevision: DaemonRevision;
}

function renderSettings(response: RunnersResponse) {
  stubFetch((url) => {
    if (url.includes('/runners')) return json(response);
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
    renderSettings({
      runners: [{ ...BASE, instanceId: 'boot-2', instanceSince: '2026-08-22T03:04:00.000Z' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

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
    renderSettings({ runners: [BASE], daemonRevision: DAEMON_UNKNOWN });

    expect(await screen.findByText(/名乗っていない（入れ替わりを判定できない）/)).toBeTruthy();
  });
});

const KNOWN_DAEMON: DaemonRevision = {
  status: 'known',
  commit: 'b'.repeat(40),
  short: 'b'.repeat(12),
  source: 'build',
};

describe('版の表示 — 人間もクローンと同じ材料を読める', () => {
  /**
   * **デーモンと runner の版が同じカードに並ぶ。** 別の場所に出すと人間が手で
   * 突き合わせることになり、突き合わせ忘れがそのまま見逃しになる。2つの Service は
   * 別々にデプロイされるので、ずれている窓が実際に在る。
   */
  it('デーモンの版と runner の版を、同じ画面に並べて出す', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
        },
      ],
      daemonRevision: KNOWN_DAEMON,
    });

    // フル sha を出す（短縮だけだと `gh api .../compare` へ貼れない）。
    expect(await screen.findByText(new RegExp('a'.repeat(40)))).toBeTruthy();
    expect(screen.getByText(new RegExp('b'.repeat(40)))).toBeTruthy();
  });

  /**
   * **0台のときこそ版が要る。** 0台は「まだ配線されていない」状態、つまり版を
   * 確かめたい状態そのものである。ここで落とすと、その状態でだけ答えが消える。
   */
  it('runner が0台でも、デーモンの版は出す', async () => {
    renderSettings({ runners: [], daemonRevision: KNOWN_DAEMON });

    expect(await screen.findByText(new RegExp('b'.repeat(40)))).toBeTruthy();
  });

  /**
   * **`unknown` と `unheard` を同じ言葉に畳まない。** 前者は器の設定を疑う側、
   * 後者は登録とネットワークを疑う側で、次の手が違う。畳んだ画面でも「版が出て
   * いる」ようには見えるので、区別が消えたことは眺めていても分からない。
   */
  it('版の「不明」と「未確認」を、別の言葉で出す', async () => {
    renderSettings({
      runners: [
        { ...BASE, label: 'runner-knows-nothing', revision: { status: 'unknown' } },
        { ...BASE, label: 'runner-silent', state: 'unreachable', revision: { status: 'unheard' } },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/未確認/)).toBeTruthy();
    expect(screen.getAllByText(/不明/).length).toBeGreaterThan(0);
  });

  /**
   * **取れていない版を、それらしい sha で埋めない。** ハイフンやゼロ埋めを出すと、
   * 人間は「版が取れている」と読む。
   */
  it('版が取れていないとき、sha らしきものを作らない', async () => {
    renderSettings({ runners: [], daemonRevision: DAEMON_UNKNOWN });

    const line = await screen.findByText(/^版: /);
    expect(line.textContent).not.toMatch(/[0-9a-f]{7,}/);
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
    renderSettings({
      runners: [{ ...BASE, credentials: [], credentialsProbe: { status: 'unheard' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/確かめていない/)).toBeTruthy();
    expect(screen.queryByText('渡している鍵は無い')).toBeNull();
  });

  /** 【B-2】失敗したときは理由が出る。 */
  it('失敗したときは理由が出る', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          credentials: [],
          credentialsProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

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
    renderSettings({
      runners: [{ ...BASE, credentials: [], credentialsProbe: { status: 'asked' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('渡している鍵は無い')).toBeTruthy();
  });
});

/**
 * 折り返しの付け忘れ（本2）。
 *
 * `runnerId` / `label` / `workspacePath` は空白を含まない識別子・パスなので
 * `break-all`、`instanceId` 混じり文・`error` 系は自然文に識別子が混じる形
 * なので `break-words` を、値の性質で選んでいる。`credential.name` は
 * `CREDENTIAL_NAME`（`/^[A-Z][A-Z0-9_]*$/`）に長さの上限が無く空白も持たない
 * ので、slug と同じ形として `break-all` を当てた（`Badge` は `className` を
 * 受け取れる）。
 *
 * **⚠️ これは「はみ出しが直った」ことの試験ではない。** jsdom はレイアウトを
 * 持たないので、固定できるのは「そのクラス名が書かれていること」までである。
 * それでも置くのは、戻す変更（クラスを消す）を黙って通さないため。
 */
describe('折り返しの付け忘れ（本2）', () => {
  it('runnerId（宛先の1行目）に break-all が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, runnerId: 'runner-primary' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('runner-primary');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('label（宛先の補助表示）に break-all が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, runnerId: 'runner-primary', label: 'http://runner:4518' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('http://runner:4518');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('workspacePath に break-all が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, workspacePath: '/very/long/workspace/path' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('/very/long/workspace/path');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('instanceId 混じり文（プロセス: ...）に break-words が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, instanceId: 'boot-2', instanceSince: '2026-08-22T03:04:00.000Z' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/プロセス: boot-2/);
    expect(line.className.split(/\s+/)).toContain('break-words');
  });

  it('runner.error に break-words が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, error: 'ETIMEDOUT: 応答が無い' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('ETIMEDOUT: 応答が無い');
    expect(el.className.split(/\s+/)).toContain('break-words');
  });

  it('credentialsProbe が failed のときの理由に break-words が付いている', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          credentials: [],
          credentialsProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    // ラベル文とエラー文は同じ `<span>` の中に同居しているので、その要素を見る。
    const el = await screen.findByText(/ECONNRESET: 途中で切れた/);
    expect(el.className.split(/\s+/)).toContain('break-words');
  });

  it('資格情報バッジ（credential.name）に break-all が付いている', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          credentials: [{ name: 'ANTHROPIC_API_KEY', sha256: 'a'.repeat(12), updatedAt: 'now' }],
          credentialsProbe: { status: 'asked' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const badge = await screen.findByText('ANTHROPIC_API_KEY');
    expect(badge.className.split(/\s+/)).toContain('break-all');
  });
});

/**
 * 横並びの積み替え（本4-A）。
 *
 * `Account` の `dl`（`grid-cols-[6rem_1fr]`）は breakpoint 無しで固定されて
 * いたので、375px 幅でもラベル列（6rem）が値の取り分を持っていっていた。
 * `sm:` 未満は1列、`sm:` 以上で固定幅ラベル列に切り替える。積んだときに
 * `dt`/`dd` の対応が読めるよう、`dt` に `mt-3 first:mt-0 sm:mt-0` を足して
 * 組の境目を間隔の差で表す。
 *
 * この `dl` は `auth.status !== 'open'` なら常に描かれる（この harness の
 * `/health` は `auth` を持たない応答なので `useAuth` は `checking` のまま
 * 落ち着き、「open」にはならない — 上のテスト群と同じ前提）。
 *
 * **⚠️ これは「積み替わった」ことの試験ではない。** jsdom はレイアウトを
 * 持たない（`offsetWidth` / `scrollWidth` / `getBoundingClientRect()` は
 * すべて 0）ので、`sm:grid-cols-[6rem_1fr]` が実際に効いていることは
 * ここでは1つも観測できない。固定できるのは「そのクラス名が書かれていること」
 * までである。本2・本3 のテストより歯が弱い — breakpoint は CSS の話なので、
 * jsdom では「効いている」ことそのものが原理的に見えない。
 */
describe('横並びの積み替え（本4-A）: アカウントの dl', () => {
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderSettings({ runners: [], daemonRevision: DAEMON_UNKNOWN });

    const dt = await screen.findByText('アカウント');
    const dl = dt.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dlTokens).toContain('sm:grid-cols-[6rem_1fr]');
    expect(dlTokens).not.toContain('grid-cols-[6rem_1fr]');
  });

  it('dt に mt-3 first:mt-0 sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderSettings({ runners: [], daemonRevision: DAEMON_UNKNOWN });

    const dt = await screen.findByText('アカウント');
    const tokens = dt.className.split(/\s+/);
    expect(tokens).toContain('mt-3');
    expect(tokens).toContain('first:mt-0');
    expect(tokens).toContain('sm:mt-0');
  });
});
