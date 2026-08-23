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
vi.mock('./target.js', () => ({
  // `vi.fn()` にしてあるのは、「ログインしていない」note 分岐だけ1件
  // `mockResolvedValueOnce` で上書きしたいため（`login.test.ts` と同じ理由）。
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
}));

const { renderRunners, runnersCommand } = await import('./runners.js');
const target = await import('./target.js');

interface Sent {
  url: string;
  method: string;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({ url, method: init?.method ?? request.method ?? 'GET' });
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
  runnerId: 'runner-a',
  workspacePath: '/work',
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
          revision: { status: 'unheard' },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('[lost]');
    expect(text).toContain('[unreachable]');
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

  it('応答が失敗（ok でない）なら、読めなかったと書く（renderRunners は呼ばない）', async () => {
    replies.push({ status: 500, body: {} });
    const read = captureStdout();

    await runnersCommand();

    expect(read()).toBe('runner の一覧を読めませんでした\n');
  });
});
