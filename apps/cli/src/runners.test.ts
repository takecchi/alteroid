import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid runners` の**文言**。
 *
 * ここで固定したいのは、**端末に居る人間がクローンと同じ材料を読めること**である。
 * 同じ状態をクローンは `runner_list` で読み（`packages/core/src/tools.test.ts` の
 * 「デーモンの版と runner の版を、同じ出力に並べて出す」）、人間は Web UI の設定画面
 * （`apps/web/app/routes/settings.test.tsx`）とこの口で読む。**3つのどれかにだけ
 * 出ると、「自分が走っているコードはどれか」の答えが口によって違うことになる。**
 *
 * **#361: `renderRunners`（文字列を返す純粋関数）だけでなく、実際に端末へ書く
 * `runnersCommand`（書く側）も測る。** `renderRunners` のテストが緑でも、
 * `runnersCommand` が別のものを書く・書かない・書く先を間違えるという欠陥は
 * 別に測らないと緑のまま通る（`captureStdout` の doc に同じ注意がある。#333 の
 * 実例と同じ形）。`fetch` を差し替えて本物の型付きクライアント（`hono/client`）を
 * 通す形は `conversations.test.ts` / `memory.test.ts` と同じ。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  // `vi.fn()` にしてあるのは、「ログインしていない」note 分岐だけ1件
  // `mockResolvedValueOnce` で上書きしたいため（`login.test.ts` と同じ理由）。
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
  // `describeAuthFailure` は本物を使う（401/403 を例外にする歯のため。#3446）。
}));

const { renderRunners, runnersCommand, runnersVacateCommand } = await import('./runners.js');
const target = await import('./target.js');

interface Sent {
  url: string;
  method: string;
  body?: string;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({
      url,
      method: init?.method ?? request.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const KNOWN_DAEMON = {
  status: 'known',
  commit: 'b'.repeat(40),
  short: 'b'.repeat(12),
  source: 'build',
} as const;

const RUNNER = {
  label: 'https://runner-a.internal',
  state: 'connected',
  // この状態になった時刻（#1948）。**省略できない欄なので、対象にしない試験でも
  // 既定を明示して置く。**
  since: '2026-08-22T00:00:00.000Z',
  runnerId: 'runner-a',
  workspacePath: '/work',
  // 鍵・プロファイルの指紋を聞きに行けたか（#1947）。**省略できない欄なので、
  // 対象にしない試験でも既定を明示して置く**（`asked` かつ空——`settings.test.tsx`
  // の `BASE` と同じ理由）。
  credentials: [],
  credentialsProbe: { status: 'asked' as const },
  profileProbe: { status: 'asked' as const },
};

describe('renderRunners', () => {
  it('デーモンの版と runner の版を、同じ出力に並べて出す', () => {
    const text = renderRunners({
      runners: [
        {
          ...RUNNER,
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

    // フル sha を両方出す（短縮だけだと `gh api .../compare` へ貼れない）。
    expect(text).toContain('a'.repeat(40));
    expect(text).toContain('b'.repeat(40));
  });

  /**
   * **0台のときこそ版が要る。** 0台は「まだ配線されていない」状態、つまり版を
   * 確かめたい状態そのものである。早期 return の側に版を載せ忘れると、そこでだけ
   * 答えが消える——1台以上のテストは通るので、落ちる場所がここにしか無い。
   */
  it('クローンの provider を出す。欄が無ければ claude と推測せず「不明」と書く', () => {
    const given = renderRunners({
      runners: [],
      daemonRevision: KNOWN_DAEMON,
      cloneProvider: 'claude',
    });
    expect(given).toContain('クローンの provider: claude');

    const absent = renderRunners({ runners: [], daemonRevision: KNOWN_DAEMON });
    expect(absent).toContain('クローンの provider: 不明');
    expect(absent).not.toContain('provider: claude');
  });

  it('runner が0台でも、デーモンの版は出す', () => {
    const text = renderRunners({ runners: [], daemonRevision: KNOWN_DAEMON });

    expect(text).toContain('0台');
    expect(text).toContain('b'.repeat(40));
  });

  /**
   * **`unknown` と `unheard` を畳まない。** 前者は器の設定を疑う側、後者は登録と
   * ネットワークを疑う側で、次の手が違う。
   */
  it('版の「不明」と「未確認」を、別の言葉で出す', () => {
    const text = renderRunners({
      runners: [
        { ...RUNNER, revision: { status: 'unknown' } },
        {
          label: 'https://runner-silent.internal',
          state: 'unreachable',
          since: '2026-08-22T00:00:00.000Z',
          credentials: [],
          credentialsProbe: { status: 'unheard' },
          profileProbe: { status: 'unheard' },
          revision: { status: 'unheard' },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('不明');
    expect(text).toContain('未確認');
  });

  it('版が取れていないとき、それらしい sha を作らない', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).not.toMatch(/[0-9a-f]{7,}/);
  });

  /**
   * **いま応えているプロセスも出す（版と並べて）。**
   *
   * クローンの `runner_list` と Web UI の設定画面は既に両方を出している
   * （`packages/core/src/tools.test.ts` / `apps/web/app/routes/settings.test.tsx`）。
   * **ここに片方しか出ないと、この口でだけ判定材料が欠ける** — まさにこの PR が
   * 直している非対称と同じ形である。
   */
  it('応えているプロセスと版を、両方出す', () => {
    const text = renderRunners({
      runners: [
        {
          ...RUNNER,
          instanceId: 'boot-2',
          instanceSince: '2026-08-22T03:04:00.000Z',
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('boot-2');
    expect(text).toContain('a'.repeat(40));
  });

  /**
   * **名乗らない器について黙らない。** 空欄にすると「入れ替わっていない」と
   * 「判定できない」が同じに見える。
   */
  it('プロセスを名乗らない器では「判定できない」と書く', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('入れ替わりを判定できない');
  });

  /**
   * **state を5値のまま出す。** `unreachable`（まだ開けていない）と `lost`
   * （開けていたのに黙った）を畳むと、走っていた仕事ごと黙った器を人間が見逃す。
   */
  it('state を畳まずそのまま出す', () => {
    const text = renderRunners({
      runners: [
        { ...RUNNER, state: 'lost', revision: { status: 'unheard' } },
        {
          label: 'https://runner-b.internal',
          state: 'unreachable',
          since: '2026-08-22T00:00:00.000Z',
          credentials: [],
          credentialsProbe: { status: 'unheard' },
          profileProbe: { status: 'unheard' },
          revision: { status: 'unheard' },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('[lost]');
    expect(text).toContain('[unreachable]');
  });

  /**
   * **押し込み（push）の直近結果。** 指紋（`credentialsProbe`/`profileProbe`。この
   * 口はまだ持たない）とは別物で、デーモンが最後に送ろうとして何が起きたかの記憶
   * である。3種類は独立の軸なので、1つが失敗していても他は畳まずに出す
   * （`packages/core/src/tools.ts` の `runner_list` と同じ判断）。
   */
  it('押し込みの結果を、種類ごとに畳まずに出す', () => {
    const text = renderRunners({
      runners: [
        {
          ...RUNNER,
          revision: { status: 'unheard' },
          pushHealth: {
            profile: { status: 'ok', at: '2026-09-01T00:00:00.000Z' },
            credentials: {
              status: 'failed',
              at: '2026-09-01T00:00:05.000Z',
              error: 'ECONNRESET',
            },
            mcpServers: {
              status: 'failed',
              at: '2026-09-01T00:00:06.000Z',
              error: 'runner に MCP の登録を受け取る口が無い',
            },
          },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('プロファイル ok（2026-09-01T00:00:00.000Z）');
    expect(text).toContain('環境変数 失敗（2026-09-01T00:00:05.000Z）: ECONNRESET');
    // #325 段4: MCP の登録も独立の軸として同じ1行に並ぶ。
    expect(text).toContain(
      'MCP の登録 失敗（2026-09-01T00:00:06.000Z）: runner に MCP の登録を受け取る口が無い',
    );
    // **3つ目（認証トークン）は一度も試みていない——出ないことを確かめる。**
    expect(text).not.toContain('認証トークン');
  });

  /** **`pushHealth` 自体が無ければ、行そのものを出さない**（取れない軸に0の行を作らない）。 */
  it('pushHealth 自体が無ければ、押し込みの行を出さない', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).not.toContain('直近の押し込み');
  });

  /**
   * #1947: 鍵とプロファイルの指紋・聞けたかの3状態
   * （`credentials`/`credentialsProbe`/`profile`/`profileProbe`）。
   *
   * Web（`apps/web/app/routes/settings.test.tsx`）と同じ3状態を、同じ意味で
   * 潰さずに言い分ける——**繋がっていないので聞いていない**（`unheard`）／
   * **聞いたが失敗した**（`failed`）／**聞いて0件だった**（`asked` かつ空）を、
   * どれも「渡している鍵は無い」に潰すと、確かめられなかったことが確かめた
   * 結果として端末に届く。
   */
  describe('鍵の指紋（credentials/credentialsProbe）', () => {
    it('unheard のとき「確かめていない」と書き、「無い」とは言わない', () => {
      const text = renderRunners({
        runners: [
          {
            ...RUNNER,
            credentials: [],
            credentialsProbe: { status: 'unheard' },
            revision: { status: 'unheard' },
          },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('鍵: 確かめていない（繋がっていないので聞いていない）');
      expect(text).not.toContain('渡している鍵は無い');
    });

    it('failed のとき理由を書き、「無い」とは言わない', () => {
      const text = renderRunners({
        runners: [
          {
            ...RUNNER,
            credentials: [],
            credentialsProbe: { status: 'failed', error: 'ECONNRESET' },
            revision: { status: 'unheard' },
          },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('鍵を確かめられなかった: ECONNRESET');
      expect(text).not.toContain('渡している鍵は無い');
    });

    it('asked かつ空なら「渡している鍵は無い」と書く', () => {
      const text = renderRunners({
        runners: [
          {
            ...RUNNER,
            credentials: [],
            credentialsProbe: { status: 'asked' },
            revision: { status: 'unheard' },
          },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('鍵: 渡している鍵は無い');
    });

    /**
     * **名前だけを出す。sha256 は出さない**（Web の `Credentials` と同じ
     * 見せ方に揃える——マネージャーの差し戻しで直した）。複数件でも1行に
     * 収まることを、2件で確かめる。
     */
    it('asked かつ1件以上あれば、名前だけを出す（sha256 は出さない）', () => {
      const text = renderRunners({
        runners: [
          {
            ...RUNNER,
            credentials: [
              { name: 'GH_TOKEN', sha256: 'deadbeef0001', updatedAt: '2026-09-01T00:00:00.000Z' },
              { name: 'NPM_TOKEN', sha256: 'cafef00d0002', updatedAt: '2026-09-01T00:00:00.000Z' },
            ],
            credentialsProbe: { status: 'asked' },
            revision: { status: 'unheard' },
          },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('鍵: GH_TOKEN, NPM_TOKEN');
      expect(text).not.toContain('deadbeef0001');
      expect(text).not.toContain('cafef00d0002');
    });
  });

  /** #1947: プロファイルの指紋（`profile`/`profileProbe`）。上と同じ3状態。 */
  describe('プロファイルの指紋（profile/profileProbe）', () => {
    it('unheard のとき「確かめていない」と書き、「置いていない」とは言わない', () => {
      const text = renderRunners({
        runners: [
          { ...RUNNER, profileProbe: { status: 'unheard' }, revision: { status: 'unheard' } },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('プロファイル: 確かめていない（繋がっていないので聞いていない）');
      expect(text).not.toContain('プロファイル: 置いていない');
    });

    it('failed のとき理由を書き、「置いていない」とは言わない', () => {
      const text = renderRunners({
        runners: [
          {
            ...RUNNER,
            profileProbe: { status: 'failed', error: 'ECONNRESET' },
            revision: { status: 'unheard' },
          },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('プロファイルを確かめられなかった: ECONNRESET');
      expect(text).not.toContain('プロファイル: 置いていない');
    });

    it('asked かつ profile が無ければ「置いていない」と書く', () => {
      const text = renderRunners({
        runners: [
          { ...RUNNER, profileProbe: { status: 'asked' }, revision: { status: 'unheard' } },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('プロファイル: 置いていない');
    });

    /**
     * **指紋（先頭12桁。既に切り詰め済み）に加えて `updatedAt` を出す**
     * （マネージャーの差し戻しで、いつの内容かも分かる形に直した）。
     */
    it('asked かつ profile があれば指紋と更新時刻を出す', () => {
      const text = renderRunners({
        runners: [
          {
            ...RUNNER,
            profile: { sha256: 'abc123456789', bytes: 42, updatedAt: '2026-09-01T00:00:00.000Z' },
            profileProbe: { status: 'asked' },
            revision: { status: 'unheard' },
          },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain(
        'プロファイル: 置いてある（指紋 abc123456789、2026-09-01T00:00:00.000Z 更新）',
      );
    });
  });

  /**
   * #1948: runner の `since`（この状態になった時刻）。
   *
   * **「作成」「更新」とは書かない**（#211 の決定——`packages/core/src/
   * tools.test.ts` の `AXIS_UNDECIDED` が持つ「runner_list には作成時刻を
   * 置かない」とは別の軸である。こちらは単に「いまの state に変わった時刻」を
   * 出すだけで、作成時刻の議論には触れない）。
   */
  describe('since（この状態になった時刻）', () => {
    it('runner ごとに since を出す', () => {
      const text = renderRunners({
        runners: [
          { ...RUNNER, since: '2026-09-01T00:00:00.000Z', revision: { status: 'unheard' } },
        ],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('この状態になった: 2026-09-01T00:00:00.000Z');
    });

    /**
     * issue #2141 段1: ISO の横に経過を添える。ISO はそのまま残る
     * （消えていない）ことも合わせて確かめる。
     */
    it('この状態になった の横に経過を添える。ISO は消えない', () => {
      const text = renderRunners(
        {
          runners: [
            { ...RUNNER, since: '2026-09-01T00:00:00.000Z', revision: { status: 'unheard' } },
          ],
          daemonRevision: { status: 'unknown' },
        },
        new Date('2026-09-04T00:00:00.000Z').getTime(),
      );

      expect(text).toContain('この状態になった: 2026-09-01T00:00:00.000Z（3日前）');
    });

    /** **「作成」「更新」と書かない**（#211）。 */
    it('「作成」「更新」とは書かない', () => {
      const text = renderRunners({
        runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).not.toContain('作成');
      expect(text).not.toContain('更新');
    });

    /**
     * **名簿（Registry）はインメモリで、デーモンを再起動すると作り直される。**
     * ここを言わないと、`since` を「ずっと保持されている記録」と誤読しうる
     * （実際には daemon プロセスの再起動で全 runner の since が現在時刻へ
     * 巻き戻る）。
     */
    it('名簿がインメモリで、再起動で作り直されることを添える', () => {
      const text = renderRunners({
        runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).toContain('インメモリ');
      expect(text).toContain('再起動');
    });
  });
});

/**
 * #361: 「書く側」— `renderRunners` が正しい文字列を作っても、`runnersCommand`
 * がそれを書かない・別のものを書く・書く先を間違えれば、上の `renderRunners` の
 * テストは全部緑のまま通る。ここではその経路自体を測る。
 */
describe('runnersCommand', () => {
  it('GET /runners を叩き、renderRunners の出力をそのまま端末へ書く', async () => {
    const view = {
      runners: [{ ...RUNNER, revision: { status: 'unheard' as const } }],
      daemonRevision: KNOWN_DAEMON,
    };
    replies.push({ status: 200, body: view });
    const read = captureStdout();

    await runnersCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/runners');
    expect(sent[0]?.method).toBe('GET');
    // **書く側が別のものを書く／書き忘れる変異を狙って名指す。** 「何か出た」では
    // なく、`renderRunners` がこの入力に対して作る文字列そのものと一致することを
    // 見る（末尾の改行1つも含めて）。
    expect(read()).toBe(`${renderRunners(view)}\n`);
  });

  it('ログインしていなければ note をそのまま書き、runners を叩かない', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await runnersCommand();

    expect(sent).toHaveLength(0);
    expect(read()).toBe('https://runner.example.com にログインしていません（alteroid login）\n');
  });

  it('応答が失敗（ok でない）なら、読めなかったと例外で言う（stdout に書かず、renderRunners は呼ばない。#3446）', async () => {
    replies.push({ status: 500, body: {} });
    const read = captureStdout();

    // 理由が読めない本文（`{}`）でも、状態コードは載せる（固定の文言だけにしない）。
    await expect(runnersCommand()).rejects.toThrow('runner の一覧を読めませんでした（HTTP 500）');
    expect(read()).toBe('');
  });

  it.each([
    [401, '認証されませんでした'],
    [403, 'access grant'],
  ])('%i は describeAuthFailure の文を例外で言う（#3446）', async (status, phrase) => {
    replies.push({ status, body: {} });
    const read = captureStdout();

    await expect(runnersCommand()).rejects.toThrow(phrase);
    expect(read()).toBe('');
  });

  it('応答が失敗（500 + { error }）なら、状態コードとデーモンの理由も書く', async () => {
    replies.push({
      status: 500,
      body: { error: '一覧の読み出しが失敗した（runners のテスト用）' },
    });
    const read = captureStdout();

    await expect(runnersCommand()).rejects.toThrow(
      'runner の一覧を読めませんでした（HTTP 500）: 一覧の読み出しが失敗した（runners のテスト用）',
    );
    expect(read()).toBe('');
  });
});

/**
 * `alteroid runners vacate <runnerId>`（#1377 の前提）。経路は `POST /runners/vacate`
 * の1本だけで、応答は「立てた」ことの確認であって「空き終わった」ではない。
 */
describe('runnersVacateCommand', () => {
  it('POST /runners/vacate へ runnerId を渡し、終わったとは言わずに進捗を追う口を名指しする', async () => {
    replies.push({ status: 200, body: { ok: true } });
    const read = captureStdout();
    await runnersVacateCommand('runner-2');
    const out = read();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toContain('/runners/vacate');
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({ runnerId: 'runner-2' });
    expect(out).toContain('runner runner-2 を空けると立てた');
    expect(out).toContain('まだ空き終わってはいない');
    expect(out).toContain('alteroid runners');
    // 対照（#2376）: 握手を飛ばしていない応答には、飛ばした旨を足さない。
    expect(out).not.toContain('握手は飛ばした');
  });

  it('握手を飛ばした応答（handshakeSkipped）には、飛ばしたことと呼び直しを言う（#2376）', async () => {
    replies.push({
      status: 200,
      body: {
        ok: true,
        handshakeSkipped: {
          reason: 'runner_unreadable',
          message: '名簿を読めなかったので握手を飛ばした',
          retry: true,
        },
      },
    });
    const read = captureStdout();
    await runnersVacateCommand('runner-2');
    const out = read();

    expect(out).toContain('握手は飛ばした（名簿を読めなかったので握手を飛ばした）');
    expect(out).toContain('呼び直す');
  });

  /**
   * ⚠️ 2026-09-26（#1641）: 以前はここで `stdout.write` して正常 return して
   * いた（＝終了コードは常に 0）。**「立てた」の意味が緩いのは成功側の話**で、
   * 失敗（HTTP の 4xx/5xx）は「立てた」ことすら起きていないので、
   * `reset.ts` / `access.ts` / `token.ts` / `alteroid interrupt`（#1621）と
   * 同じく例外を投げる形に揃えた。アサーションは消さず、見る先を「書いた
   * 文字列」から「投げた例外の文言」へ反転しただけである——保証していること
   * （「立てられませんでした」を言う／「立てた」と言わない）は変わらない。
   */
  it('デーモンが断ったら、立てたとは言わない（例外の文言で確かめる。#1641）', async () => {
    replies.push({ status: 400, body: { error: 'runnerId の形が不正（空けていない）' } });

    const error = await runnersVacateCommand('').catch((e: unknown) => e);

    expect(String(error)).toContain('空けると立てられませんでした（HTTP 400）');
    expect(String(error)).not.toContain('空けると立てた。');
  });

  /**
   * #1641 本文の対象外（`runners vacate` は本文には無いが、コーディネーターの
   * 判断で同じ形として揃えた）。401/500 でも「立てた」ことにしない。
   */
  it('#1641: デーモンが 500 を返しても投げる（「立てた」と言わない）', async () => {
    replies.push({ status: 500, body: { error: '内部エラー' } });

    const error = await runnersVacateCommand('runner-2').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('空けると立てた。');
    // デーモンが返した理由も添える（状態コードだけを見せない）。
    expect(String(error)).toContain('内部エラー');
  });

  it('#1641: デーモンが 401 を返しても投げる', async () => {
    replies.push({ status: 401, body: {} });

    await expect(runnersVacateCommand('runner-2')).rejects.toThrow();
  });
});
