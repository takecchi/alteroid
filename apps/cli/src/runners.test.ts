import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
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
  since: '2026-08-22T00:00:00.000Z',
  runnerId: 'runner-a',
  workspacePath: '/work',
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

    expect(text).toContain('a'.repeat(40));
    expect(text).toContain('b'.repeat(40));
  });

  it('クローンの provider の行を出さない（層は常に Claude。2026-10-07 の決定）', () => {
    expect(renderRunners({ runners: [], daemonRevision: KNOWN_DAEMON })).not.toContain('provider');
  });

  it('peer を名乗った器は「Codex に作業を頼める」、旧い runner は「不明」、開いていない器は行を出さない（#3940）', () => {
    const text = renderRunners({
      runners: [
        {
          ...RUNNER,
          revision: { status: 'unheard' },
          managerPeers: { status: 'named', peers: [{ provider: 'codex', models: ['gpt-5.5'] }] },
        },
        {
          ...RUNNER,
          runnerId: 'runner-old',
          revision: { status: 'unheard' },
          managerPeers: { status: 'unknown' },
        },
        {
          ...RUNNER,
          runnerId: 'runner-none',
          revision: { status: 'unheard' },
          managerPeers: { status: 'named', peers: [] },
        },
      ],
      daemonRevision: KNOWN_DAEMON,
    });
    expect(text).toContain('  peer: Codex に作業を頼める（peer: codex。名指しできるモデル: gpt-5.5）');
    expect(text).toContain('  peer: 不明');
    expect(text.split('\n').filter((line) => line.startsWith('  peer:'))).toHaveLength(2);
  });

  it('runner が0台でも、デーモンの版は出す', () => {
    const text = renderRunners({ runners: [], daemonRevision: KNOWN_DAEMON });

    expect(text).toContain('0台');
    expect(text).toContain('b'.repeat(40));
  });

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

  it('プロセスを名乗らない器では「判定できない」と書く', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('入れ替わりを判定できない');
  });

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
    expect(text).toContain(
      'MCP の登録 失敗（2026-09-01T00:00:06.000Z）: runner に MCP の登録を受け取る口が無い',
    );
    expect(text).not.toContain('認証トークン');
  });

  it('pushHealth 自体が無ければ、押し込みの行を出さない', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).not.toContain('直近の押し込み');
  });

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

    it('「作成」「更新」とは書かない', () => {
      const text = renderRunners({
        runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
        daemonRevision: { status: 'unknown' },
      });

      expect(text).not.toContain('作成');
      expect(text).not.toContain('更新');
    });

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

describe('runnersVacateCommand', () => {
  function roster(...runnerIds: string[]): { status: number; body: unknown } {
    return {
      status: 200,
      body: { runners: runnerIds.map((runnerId) => ({ label: `http://${runnerId}`, runnerId })) },
    };
  }

  it('POST /runners/vacate へ runnerId を渡し、終わったとは言わずに進捗を追う口を名指しする', async () => {
    replies.push(roster('runner-1', 'runner-2'));
    replies.push({ status: 200, body: { ok: true } });
    const read = captureStdout();
    await runnersVacateCommand('runner-2');
    const out = read();

    expect(sent.map((entry) => entry.method)).toEqual(['GET', 'POST']);
    expect(sent[0]?.url).toMatch(/\/runners$/);
    expect(sent[1]?.url).toContain('/runners/vacate');
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({ runnerId: 'runner-2' });
    expect(out).toContain('runner runner-2 を空けると立てた');
    expect(out).toContain('まだ空き終わってはいない');
    expect(out).toContain('alteroid runners');
    expect(out).not.toContain('握手は飛ばした');
  });

  it('握手を飛ばした応答（handshakeSkipped）には、飛ばしたことと呼び直しを言う（#2376）', async () => {
    replies.push(roster('runner-2'));
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

  it('デーモンが断ったら、立てたとは言わない（例外の文言で確かめる。#1641）', async () => {
    replies.push(roster('runner-2'));
    replies.push({ status: 400, body: { error: 'runnerId の形が不正（空けていない）' } });

    const error = await runnersVacateCommand('runner-2').catch((e: unknown) => e);

    expect(String(error)).toContain('空けると立てられませんでした（HTTP 400）');
    expect(String(error)).not.toContain('空けると立てた。');
  });

  it('#1641: デーモンが 500 を返しても投げる（「立てた」と言わない）', async () => {
    replies.push(roster('runner-2'));
    replies.push({ status: 500, body: { error: '内部エラー' } });

    const error = await runnersVacateCommand('runner-2').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('空けると立てた。');
    expect(String(error)).toContain('内部エラー');
  });

  it('#1641: デーモンが 401 を返しても投げる', async () => {
    replies.push(roster('runner-2'));
    replies.push({ status: 401, body: {} });

    await expect(runnersVacateCommand('runner-2')).rejects.toThrow();
  });

  it('#3451: 名簿に無い runnerId は、POST せずに断る（成功と言わない）', async () => {
    replies.push(roster('runner-1', 'runner-2'));
    const read = captureStdout();

    const error = await runnersVacateCommand('runner-9').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('runner-9');
    expect(String(error)).toContain('名簿に無い');
    expect(String(error)).toContain('alteroid runners');
    expect(String(error)).toContain('空けると立てていません');
    expect(sent.map((entry) => entry.method)).toEqual(['GET']);
    expect(read()).not.toContain('空けると立てた');
  });

  it('#3451: 名簿を読めなかった（HTTP の失敗）ときも、POST せずに失敗にする', async () => {
    replies.push({ status: 500, body: { error: '名簿が壊れている' } });
    const read = captureStdout();

    const error = await runnersVacateCommand('runner-2').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('HTTP 500');
    expect(String(error)).toContain('名簿が壊れている');
    expect(String(error)).toContain('空けると立てていません');
    expect(sent.map((entry) => entry.method)).toEqual(['GET']);
    expect(read()).not.toContain('空けると立てた');
  });
});
