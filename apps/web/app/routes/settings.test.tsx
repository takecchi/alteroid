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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential, type Credential } from '@alteroid/logic';
import type { DaemonRevision, RunnerSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Settings, { RESET_CONFIRM_GROUPS_FOR_TEST, RESET_SUMMARY_LABELS } from './settings';

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
  cloneProvider?: string;
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

    expect(
      await screen.findByText(/名乗っていない（入れ替わったかどうか判定できない）/),
    ).toBeTruthy();
  });
});

/**
 * #1948: runner の `since`（この状態になった時刻）。
 *
 * **「作成」「更新」とは書かない**（#211 の決定）。名簿（Registry）はインメモリ
 * なので、デーモンを再起動すると作り直される——これを言わないと、`since` を
 * 「ずっと保持されている記録」と誤読しうる。
 */
describe('runner の since（この状態になった時刻）', () => {
  // **`runner` ごとの行は「この状態になった: 」（コロン付き）で名乗る。**
  // ヘッダの注記（下のテスト）は同じ語を「「この状態になった」は」（コロン無し）
  // という別の文で使っているので、コロン込みで探して両者を混同しない
  // （そうしないと `findByText` が2件ヒットして曖昧になる）。
  it('since を出す', async () => {
    renderSettings({
      runners: [{ ...BASE, since: '2026-09-01T00:00:00.000Z' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/この状態になった: /);
    // 時分は器の時間帯で変わるので、日付だけ固定して見る（直上のブロックと同じ理由）。
    expect(line.textContent).toMatch(/09\/01/);
  });

  it('「作成」「更新」とは書かない', async () => {
    renderSettings({ runners: [BASE], daemonRevision: DAEMON_UNKNOWN });

    await screen.findByText(/この状態になった: /);
    expect(screen.queryByText(/作成/)).toBeNull();
    expect(screen.queryByText(/更新/)).toBeNull();
  });

  /**
   * **`getByText('再起動')` は使わない。** この画面には無関係な「再起動」が
   * 他にも在る（`ShutdownDaemon` の「Railway では…再起動として働く」）ので、
   * 曖昧になる。この一覧のヘッダに添えた注記の文そのもの（一意な言い回し）で
   * 探す。
   */
  it('名簿は保存されず、再起動で作り直されることを添える', async () => {
    renderSettings({ runners: [BASE], daemonRevision: DAEMON_UNKNOWN });

    expect(
      await screen.findByText(
        /「この状態になった」の時刻は保存されない.*再起動すると記録し直される/,
      ),
    ).toBeTruthy();
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
  it('クローンの provider を出す。欄が無ければ claude と推測せず「不明」と書く', async () => {
    renderSettings({ runners: [], daemonRevision: KNOWN_DAEMON, cloneProvider: 'claude' });
    expect(await screen.findByText(/クローンが使うモデル提供元: claude/)).toBeTruthy();
    cleanup();

    renderSettings({ runners: [], daemonRevision: KNOWN_DAEMON });
    const unknown = await screen.findByText(/クローンが使うモデル提供元: 不明/);
    expect(unknown.textContent).not.toContain('claude');
  });

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
 * #1947: プロファイルの指紋（`profile`/`profileProbe`）。鍵欄
 * （`credentialsProbe`）と同じ3状態を、同じ理由で潰さない。
 */
describe('runner のプロファイル欄は、聞けた分しか言わない', () => {
  it('聞いていないときは「置いていない」と言わない', async () => {
    renderSettings({
      runners: [{ ...BASE, profileProbe: { status: 'unheard' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/プロファイルは確かめていない/)).toBeTruthy();
    expect(screen.queryByText('プロファイルは置いていない')).toBeNull();
  });

  it('失敗したときは理由が出る', async () => {
    renderSettings({
      runners: [{ ...BASE, profileProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/ECONNRESET: 途中で切れた/)).toBeTruthy();
    expect(screen.queryByText('プロファイルは置いていない')).toBeNull();
  });

  it('聞いて profile が無ければ「置いていない」と言う', async () => {
    renderSettings({
      runners: [{ ...BASE, profileProbe: { status: 'asked' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('プロファイルは置いていない')).toBeTruthy();
  });

  /**
   * **指紋（先頭12桁。既に切り詰め済み）に加えて `updatedAt` も出す**
   * （CLI の `renderProfileFingerprint` と同じ形に揃える）。
   */
  it('聞けて profile があれば指紋と更新時刻を出す', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          profile: { sha256: 'abc123456789', bytes: 42, updatedAt: '2026-09-01T00:00:00.000Z' },
          profileProbe: { status: 'asked' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/abc123456789/);
    expect(line.textContent).toContain('プロファイル: 置いてある');
    // 時分は器の時間帯で変わるので、日付だけ固定して見る（他のブロックと同じ理由）。
    expect(line.textContent).toMatch(/09\/01/);
  });
});

/**
 * `pushHealth`（押し込みの直近結果）は `credentialsProbe`/`profileProbe`（指紋・
 * 聞き直し）とは別物。**「一度も試みていない」ときは行そのものを出さない**
 * （AGENTS.md「取れない軸に0の行を作らない」）。3種類は独立の軸なので、1つが
 * 失敗していても他は畳まずに出す。
 */
describe('runner の押し込み結果（pushHealth）', () => {
  it('pushHealth 自体が無ければ、押し込みの行を出さない', async () => {
    renderSettings({
      runners: [{ ...BASE }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    await screen.findByText(BASE.label);
    expect(screen.queryByText(/押し込み/)).toBeNull();
  });

  it('成功した種類は ok、失敗した種類は理由付きで出て、互いを畳まない', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          pushHealth: {
            profile: { status: 'ok', at: '2026-09-01T00:00:00.000Z' },
            credentials: {
              status: 'failed',
              at: '2026-09-01T00:00:05.000Z',
              error: 'ECONNRESET: 途中で切れた',
            },
            mcpServers: { status: 'ok', at: '2026-09-01T00:00:06.000Z' },
          },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/プロファイル: 反映済み/)).toBeTruthy();
    expect(await screen.findByText(/環境変数: 反映に失敗/)).toBeTruthy();
    expect(await screen.findByText(/ECONNRESET: 途中で切れた/)).toBeTruthy();
    // #325 段4: MCP の登録も独立の軸として出る。
    expect(await screen.findByText(/MCP の登録: 反映済み/)).toBeTruthy();
    // **3つ目（認証トークン）は一度も試みていない——出ないことを確かめる。**
    // （`認証トークン` 単独は他の静的文言にも現れるので、押し込みバッジの
    // 文言そのもの——コロン区切り——で絞る）
    expect(screen.queryByText(/認証トークン: 押し込み/)).toBeNull();
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
 *
 * **追記: この一覧は `KeyValueList`（`packages/ui`）へ移した。** 以前は `dl` に
 * 固定幅の列指定と、`dt` に「上の余白・先頭だけ余白なし・`sm:` で余白なし」の
 * class を手書きしていた。`KeyValueList` は同じ意図を別の形で書く — ラベル列の幅は
 * CSS 変数 `--kv-label`（この画面は 6rem）で渡し、`sm:` の grid がその変数を使い、
 * 組の境目は先頭以外の `dt` に上の余白と `sm:mt-0` を付けて作る（先頭かどうかは添字で
 * 決める。各項目が `contents` の包みに入り、`dt` が常に包みの最初の子になるため）。
 * class の文字が変わったので、下の assert は文字ではなく意図を測る形へ書き換えた。
 * 意図は3つ: (a) 狭い画面は1列（基底の grid が1列で、`sm:` で2列に切り替わる）、
 * (b) 広い画面はラベル列が固定幅（`--kv-label` に 6rem が入り、`sm:` の grid がそれを使う）、
 * (c) 積んだときの組の境目（先頭以外の `dt` に上の余白と `sm:mt-0`、先頭には無い）。
 * jsdom はレイアウトを持たないので、測れるのは class と style の有無までである
 * （上の警告のとおり。`KeyValueList` 自身の class の試験は
 * `packages/ui/src/components/features/key-value-list.test.tsx`）。
 */
describe('横並びの積み替え（本4-A）: アカウントの dl', () => {
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderSettings({ runners: [], daemonRevision: DAEMON_UNKNOWN });

    const anchor = await screen.findByText('アカウント');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    // (a) 基底は1列。
    expect(dlTokens).toContain('grid-cols-1');
    // (b) sm: 以上はラベル列が変数の幅（固定幅）で、値の列が残りを取る。
    expect(dl!.style.getPropertyValue('--kv-label')).toBe('6rem');
    const smCols = dlTokens.filter((token) => token.startsWith('sm:grid-cols-'));
    expect(smCols).toHaveLength(1);
    expect(smCols[0]).toContain('var(--kv-label)');
    // sm: 無しの列指定は 1 列のものだけ（残っていれば狭い画面でも2列のままになる）。
    expect(dlTokens.filter((token) => /^grid-cols-/.test(token))).toEqual(['grid-cols-1']);
  });

  it('先頭以外の dt に上の余白と sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    // 組の境目は2組以上ないと測れない。`renderSettings` の応答にはアカウントの
    // メールが無く `dt` が1つだけになるので、メールまで描く `renderAuthedAccount`
    // （下の定義。呼び出しは実行時なので前方参照で足りる）を使う。
    renderAuthedAccount(() => undefined);

    const anchor = await screen.findByText('アカウント');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dts = Array.from(dl!.querySelectorAll('dt'));
    expect(dts.length).toBeGreaterThan(1);
    // (c) 先頭には上の余白も sm:mt-0 も無い。
    const first = dts[0]!.className.split(/\s+/);
    expect(first).not.toContain('mt-3');
    expect(first).not.toContain('sm:mt-0');
    // 先頭以外は、狭い画面で上の余白、sm: 以上で打ち消し。
    for (const dt of dts.slice(1)) {
      const tokens = dt.className.split(/\s+/);
      expect(tokens).toContain('mt-3');
      expect(tokens).toContain('sm:mt-0');
    }
  });
});

const AUTH_HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const CREDENTIAL: Credential = {
  token: 'alt_settings',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

/** ログインしてある `Account` を描く（`renderSettings` は認証を対象外にしているため別立て）。 */
function renderAuthedAccount(logoutRoute: (url: string) => Response | undefined) {
  storeCredential(TEST_BASE_URL, CREDENTIAL);
  stubFetch((url) => {
    if (url.includes('/runners')) return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
    if (url.endsWith('/health')) return json(AUTH_HEALTH);
    if (url.endsWith('/auth/me')) {
      return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
    }
    const logoutResponse = logoutRoute(url);
    if (logoutResponse !== undefined) return logoutResponse;
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

/**
 * `Account` のログアウトボタン（issue #1757）——`auth.logout()` の実体は
 * `use-auth.test.tsx` が見る。ここは画面（ボタン・エラー表示）を見る。
 */
describe('Account のログアウト（issue #1757）', () => {
  it('成功 → サーバ側のトークンを失効させ、鍵を捨てる', async () => {
    renderAuthedAccount((url) => (url.endsWith('/auth/logout') ? json({ ok: true }) : undefined));

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
    });
  });

  it('失敗 → 鍵は残したままエラーを出し、「この画面から鍵だけを捨てる」で個別に捨てられる', async () => {
    renderAuthedAccount((url) =>
      url.endsWith('/auth/logout') ? json({ error: 'internal' }, 500) : undefined,
    );

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);

    await screen.findByText(/サーバ側を失効させられなかった/);
    expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'この画面から鍵だけを捨てる' }));

    await waitFor(() => {
      expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
    });
  });
});

/**
 * デーモンを止める（`ShutdownDaemon`。issue #1124 の (A)）。
 *
 * **CLI（`alteroid daemon stop`）にしか無かった口を Web UI からも押せるように
 * したもの。** 確認は `ResetWorkspace` と同じ「文字を打って確認」形だが、
 * 打つ語は別にする（`stop`）——`reset`（ワークスペース全消去の確認語）と
 * 混ざると、押し間違いの結果が逆方向に重くなる。
 *
 * ここで固定したいのは4点:
 * 1. 打つ文字が一致しないとボタンが押せない（`disabled`）。押そうとしても
 *    `/shutdown` を呼ばない
 * 2. 一致すると押せて、押すと `POST /shutdown` を1回呼ぶ
 * 3.（陽性対照）`ResetWorkspace` の確認語（`reset`）を打っても、止めるボタンは
 *    押せない——2つの確認が混ざらない
 * 4. 文言に「記憶も各種の記録も消さない」と「Railway では再起動として働く」が載る
 */
describe('デーモンを止める（ShutdownDaemon）', () => {
  function renderWithShutdownStub(options: { shutdownStatus?: number } = {}) {
    const { shutdownStatus = 200 } = options;
    const stub = stubFetch((url) => {
      if (url.includes('/shutdown')) return json({ ok: true }, shutdownStatus);
      if (url.includes('/runners')) {
        return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
      }
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
    return stub;
  }

  function shutdownCallCount(stub: ReturnType<typeof stubFetch>): number {
    return stub.calls.filter((url) => url.includes('/shutdown')).length;
  }

  async function openShutdownDialog(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'alteroid のサーバを止める' }));
    await screen.findByPlaceholderText('stop');
  }

  it('【歯4】文言に「記憶も各種の記録も消さない」と Railway の再起動が載る', async () => {
    renderWithShutdownStub();

    expect(await screen.findByText(/記憶も各種の記録も消さない/)).toBeTruthy();
    expect(await screen.findByText(/再起動として働く/)).toBeTruthy();
  });

  it('【歯1】打つ文字が一致しないとボタンは押せず、/shutdown を呼ばない', async () => {
    const stub = renderWithShutdownStub();
    await openShutdownDialog();

    fireEvent.change(screen.getByPlaceholderText('stop'), { target: { value: 'sto' } });
    const confirmButton = screen.getByRole('button', { name: '止める' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.click(confirmButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownCallCount(stub)).toBe(0);
  });

  it('【歯2】一致すると押せて、押すと POST /shutdown を1回呼ぶ', async () => {
    const stub = renderWithShutdownStub();
    await openShutdownDialog();

    fireEvent.change(screen.getByPlaceholderText('stop'), { target: { value: 'stop' } });
    const confirmButton = screen.getByRole('button', { name: '止める' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);

    await screen.findByText(/止めました/);
    expect(shutdownCallCount(stub)).toBe(1);
    const entry = stub.entries.find((e) => e.url.includes('/shutdown'));
    expect(entry?.request?.method).toBe('POST');
  });

  it('【歯3・陽性対照】ResetWorkspace の確認語「reset」を打っても止めるボタンは押せない', async () => {
    renderWithShutdownStub();
    await openShutdownDialog();

    fireEvent.change(screen.getByPlaceholderText('stop'), { target: { value: 'reset' } });
    const confirmButton = screen.getByRole('button', { name: '止める' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });
});

/**
 * ワークスペースのリセット（`ResetWorkspace`。issue #2196）。
 *
 * **消す前の確認の文が、消した後の報告の見出し（`RESET_SUMMARY_LABELS`）と
 * 食い違わないことを固定する。** 実装は `practices`（仕事のやり方）を消して
 * いるのに、確認の文には元々載っていなかった——やり方を育てていた人間が
 * 「これは残る」と思ったまま `reset` と打ちうる、という欠落だった。
 */
describe('ワークスペースのリセット（ResetWorkspace） — issue #2196', () => {
  function renderWithReset() {
    stubFetch((url) => {
      if (url.includes('/runners')) return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
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

  it('カード本体の文に「仕事のやり方」が出る（ダイアログを開く前）', async () => {
    renderWithReset();

    // ダイアログ（未オープン）とカード本体、両方の <p> がこの文言を持つので
    // 単数の `findByText` だと「複数一致」になる。「1件以上出るか」を見る。
    const matches = await screen.findAllByText(/仕事のやり方/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('ダイアログを開いた確認の文にも「仕事のやり方」が出る', async () => {
    renderWithReset();

    fireEvent.click(await screen.findByRole('button', { name: 'リセットする' }));
    await screen.findByPlaceholderText('reset');

    const matches = await screen.findAllByText(/仕事のやり方/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('消した後の報告の見出し（RESET_SUMMARY_LABELS）が、全キーどこかの確認の group に載っている', () => {
    const covered = new Set(RESET_CONFIRM_GROUPS_FOR_TEST.flatMap((group) => group.keys));
    const labelKeys = RESET_SUMMARY_LABELS.map(([key]) => key);

    for (const key of labelKeys) {
      expect(covered.has(key), `${key} が確認の group に見当たらない`).toBe(true);
    }
    expect(covered.size).toBe(labelKeys.length);
  });
});

/**
 * **器を空ける（drain）を画面から起こせる。** 経路は `POST /runners/vacate` の1本だけで、
 * CLI の `alteroid runners vacate` と同じ口である（片方でしかできないことを作らない）。
 * 走っているマネージャーを他の器へ動かす操作なので、確認の一手を挟むまで叩かない。
 */
describe('runner を空ける（vacate）', () => {
  function renderWithVacate(runners: RunnerSummary[], vacateBody: object = { ok: true }) {
    const stub = stubFetch((url) => {
      if (url.includes('/runners/vacate')) return json(vacateBody);
      if (url.includes('/runners')) return json({ runners, daemonRevision: DAEMON_UNKNOWN });
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
    return stub;
  }

  it('確認の一手を挟むまで叩かず、確認したら runnerId を渡して POST /runners/vacate を叩く', async () => {
    const stub = renderWithVacate([BASE]);

    fireEvent.click(await screen.findByText('この実行環境から仕事を移す'));
    expect(stub.calls.some((url) => url.includes('/runners/vacate'))).toBe(false);

    // やめれば戻り、叩かない。
    fireEvent.click(screen.getByText('移すのをやめる'));
    expect(stub.calls.some((url) => url.includes('/runners/vacate'))).toBe(false);

    fireEvent.click(screen.getByText('この実行環境から仕事を移す'));
    fireEvent.click(screen.getByText('本当に移す'));
    expect(
      await screen.findByText(/仕事を他へ移す指示を出した。まだ終わってはいない/),
    ).toBeTruthy();

    const entry = stub.entries.find((e) => e.url.includes('/runners/vacate'));
    expect(entry).toBeDefined();
    expect(await entry?.request?.clone().json()).toEqual({ runnerId: 'runner-primary' });
  });

  it('「仕事を移す」まわりのボタンと確認の文に、どの実行環境か分かる名前が付く（#3372）', async () => {
    renderWithVacate([BASE]);
    fireEvent.click(await screen.findByRole('button', { name: 'runner-primary から仕事を移す' }));
    expect(screen.getByText(/runner-primary）で動いている委譲を止めて/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'runner-primary から仕事を移すのを確定する' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'runner-primary から仕事を移すのをやめる' }),
    ).toBeTruthy();
  });

  it('普通の成功には、握手を飛ばしたとは言わない（対照。#2376）', async () => {
    renderWithVacate([BASE]);
    fireEvent.click(await screen.findByText('この実行環境から仕事を移す'));
    fireEvent.click(screen.getByText('本当に移す'));
    expect(
      await screen.findByText(/仕事を他へ移す指示を出した。まだ終わってはいない/),
    ).toBeTruthy();
    expect(screen.queryByText(/引き継ぎの連絡は飛ばした/)).toBeNull();
  });

  it('握手を飛ばした応答（handshakeSkipped）には、飛ばしたことと呼び直しを言う（#2376）', async () => {
    renderWithVacate([BASE], {
      ok: true,
      handshakeSkipped: {
        reason: 'jobs_unreadable',
        message: '一覧を読めなかったので握手を飛ばした',
        retry: true,
      },
    });
    fireEvent.click(await screen.findByText('この実行環境から仕事を移す'));
    fireEvent.click(screen.getByText('本当に移す'));
    expect(
      await screen.findByText(/引き継ぎの連絡は飛ばした（一覧を読めなかったので握手を飛ばした）/),
    ).toBeTruthy();
  });

  it('仕事を他へ移している最中の器と、名乗っていない器には出さない', async () => {
    renderWithVacate([
      { ...BASE, state: 'vacating' },
      { ...BASE, label: 'http://runner-2:4518', runnerId: undefined, state: 'connecting' },
    ]);

    await screen.findByText('仕事を他へ移している最中');
    expect(screen.queryByText('この実行環境から仕事を移す')).toBeNull();
  });
});

/**
 * **知らない `state` でも `/settings` 画面ごと落ちない**（issue #2010。#1623 で
 * `managers.tsx` の `ManagerStatusBadge` に入れた形の横展開）。Web とデーモンは
 * 別々にデプロイされるので、デーモンが先に新しい状態値を返す時間が在る。型は
 * `as RunnerSummary['state']` で迂回する——実機でも型はコンパイル時の飾りで、
 * JSON はそのまま届く。
 */
describe('知らない runner の state に倒れ先がある（#2010）', () => {
  it('知らない state が混ざっても、他の runner の行は見え、その行は生の値を出す', async () => {
    renderSettings({
      runners: [
        { ...BASE, label: 'http://runner-good:4518', runnerId: 'runner-good' },
        {
          ...BASE,
          label: 'http://runner-bad:4518',
          runnerId: 'runner-bad',
          state: 'draining' as RunnerSummary['state'],
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('runner-good')).toBeTruthy();
    expect(screen.getByText('runner-bad')).toBeTruthy();
    expect(screen.getByText('知らない状態（draining）')).toBeTruthy();
  });

  /** 継承したキー（`constructor`）は `RUNNER_STATES[...]` が `undefined` にならないので別に測る。 */
  it('Object の継承したキーと同じ名前の state でも落ちない', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          label: 'http://runner-proto:4518',
          runnerId: 'runner-proto',
          state: 'constructor' as RunnerSummary['state'],
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('runner-proto')).toBeTruthy();
    expect(screen.getByText('知らない状態（constructor）')).toBeTruthy();
  });

  it('既知の state は今までどおりのラベルと tone で出す', async () => {
    renderSettings({
      runners: [{ ...BASE, state: 'unreachable' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('繋がらない（つなぎ直しを試している）')).toBeTruthy();
  });
});
