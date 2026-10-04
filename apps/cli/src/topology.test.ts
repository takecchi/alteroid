import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid topology` の文言と経路。
 *
 * 純粋関数（`renderTopology`）だけでなく、実際に端末へ書く `topologyCommand` も測る
 * （#361。`runners.test.ts` と同じ理由）。`fetch` を差し替えて本物の型付きクライアントを通す。
 */
vi.mock('./target.js', () => ({
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
  ),
  describeAuthFailure: (status: number) => (status === 401 ? '認証されませんでした' : null),
}));

const { formatAge, renderTopology, topologyCommand } = await import('./topology.js');
const target = await import('./target.js');

const NOW = Date.parse('2026-10-04T10:00:10.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function view(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: ago(1),
    clone: { state: 'busy', turn: { conversationId: 'conv-1', kind: 'normal' } },
    storage: { label: 'postgres', state: 'ok', checkedAt: ago(5) },
    runners: [{ label: 'http://r', runnerId: 'r1', state: 'connected', since: ago(3600) }],
    managers: [
      {
        managerId: 'mgr-1',
        status: 'waiting_human',
        live: true,
        request: '認証まわりを直して',
        startedAt: ago(600),
        updatedAt: ago(2),
        lastReportAt: ago(30),
        waiting: [
          { requestId: 'q1', kind: 'question', summary: 'どちらにしますか', askedAt: ago(8) },
        ],
        workers: [{ agentType: 'worker', lastTool: 'Edit', lastToolAt: ago(4) }],
      },
    ],
    links: [
      { key: 'human~clone', lastDownAt: ago(3), lastUpAt: ago(1) },
      { key: 'clone~storage', lastUpAt: ago(7) },
      { key: 'clone~manager:mgr-1', lastDownAt: ago(100), lastUpAt: ago(30) },
      { key: 'manager:mgr-1~worker:worker', lastDownAt: ago(90), lastActivityAt: ago(4) },
    ],
    ...overrides,
  };
}

describe('formatAge', () => {
  it('秒・分・時間・日で言い、読めない時刻は経過不明', () => {
    expect(formatAge(ago(3), NOW)).toBe('3s ago');
    expect(formatAge(ago(125), NOW)).toBe('2m ago');
    expect(formatAge(ago(7200), NOW)).toBe('2h ago');
    expect(formatAge(ago(3 * 86_400), NOW)).toBe('3d ago');
    expect(formatAge('not-a-date', NOW)).toBe('経過不明');
    // 時計のずれで未来になっても負の値を出さない
    expect(formatAge(ago(-5), NOW)).toBe('0s ago');
  });
});

describe('renderTopology', () => {
  it('各層の状態と、線ごとの向き別の経過を出す', () => {
    const out = renderTopology(view() as never, NOW);
    expect(out).toContain('クローン [busy（normal・会話 conv-1）]');
    expect(out).toContain('記憶 [postgres: ok（5s agoに確認）]');
    expect(out).toContain('↓ 発言 3s ago   ↑ 応答 1s ago');
    expect(out).toContain('↓ 書き込み —（未観測）   ↑ 読み出し 7s ago');
    expect(out).toContain('mgr-1 [waiting_human・live]  認証まわりを直して');
    expect(out).toContain('↓ 指示 1m ago   ↑ 報告・確認 30s ago');
    expect(out).toContain('返事待ち question（8s agoから）: どちらにしますか');
    expect(out).toContain('作業者 worker（種類ごとに束ねた1行）: 最後の道具 Edit（4s ago）');
    expect(out).toContain('↓ 背景で起動 1m ago   ↑ 結果が戻った —（未観測）   ・ 活動 4s ago');
    expect(out).toContain('runner r1 [connected]');
  });

  it('分からない軸は unknown のまま出し、idle / ok に化けさせない', () => {
    const out = renderTopology(
      view({
        clone: { state: 'unknown' },
        storage: { state: 'unknown' },
        managers: [],
        runners: [],
        links: [],
      }) as never,
      NOW,
    );
    expect(out).toContain('クローン [unknown（この器はターンの有無を答えられない）]');
    expect(out).toContain('記憶 [unknown（確かめる手段が無い、またはまだ確かめていない）]');
    expect(out).not.toContain('idle');
    expect(out).toContain('runner: 名簿に載っていない');
    expect(out).toContain('マネージャー: 走行中・返事待ち・直近10分に終わった委譲は無い');
    // 線の無い向きは「未観測」であって、経過0ではない
    expect(out).toContain('↓ 発言 —（未観測）   ↑ 応答 —（未観測）');
  });

  it('記憶に届かないときは理由（種別）を出す。省略された件数も言う', () => {
    const out = renderTopology(
      view({
        storage: {
          label: 'postgres',
          state: 'unreachable',
          error: 'ECONNREFUSED',
          checkedAt: ago(2),
        },
        managersOmitted: 4,
      }) as never,
      NOW,
    );
    expect(out).toContain('unreachable');
    expect(out).toContain('理由: ECONNREFUSED');
    expect(out).toContain('ほか 4 本は文字数の予算で省略');
  });

  it('読めなかった委譲の行が在るときは件数と id を言い、マネージャーが0本でも「居ない」で終わらせない（#2705）', () => {
    const out = renderTopology(
      view({
        managers: [],
        unreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }, { reason: '不正な欄: id' }],
      }) as never,
      NOW,
    );
    expect(out).toContain('台帳から読めなかった委譲の行が 2 件ある');
    expect(out).toContain('mgr-bad: 不正な欄: status');
    expect(out).toContain('（id 不明）: 不正な欄: id');
  });

  it('読めない行が0件（欄が無い）なら、出力は変わらない（#2705）', () => {
    const base = renderTopology(view() as never, NOW);
    expect(base).not.toContain('読めなかった');
    // 空配列が来ても（来ない契約だが）警告は出さない
    expect(renderTopology(view({ unreadable: [] }) as never, NOW)).toBe(base);
  });

  it('背景処理待ちで畳んだマネージャーには「完了待ち」の印を出し、欄が無ければ出さない（#2726）', () => {
    const waiting = view({
      managers: [
        {
          managerId: 'mgr-bg',
          status: 'done',
          live: true,
          request: '背景で CI を回している',
          startedAt: ago(600),
          updatedAt: ago(120),
          waiting: [],
          awaitingBackground: {
            tasks: 2,
            withheldReports: 1,
            breakdown: 'local_agent×2',
            since: ago(90),
          },
          workers: [],
        },
      ],
    });
    expect(renderTopology(waiting as never, NOW)).toContain(
      '完了待ち: 背景処理 2 件（local_agent×2）（1m agoから）',
    );
    expect(renderTopology(view() as never, NOW)).not.toContain('完了待ち');
  });

  it('自由文（依頼・返事待ち）に混じったトークンは伏せる', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const base = view();
    const out = renderTopology(
      view({
        managers: [
          {
            ...base.managers[0],
            request: `push して ${token}`,
            waiting: [{ requestId: 'q', summary: `鍵は ${token}` }],
          },
        ],
      }) as never,
      NOW,
    );
    expect(out).not.toContain(token);
    expect(out).not.toContain('ghp_a1B2c3D4e5');
  });
});

describe('topologyCommand', () => {
  let originalFetch: typeof fetch;
  let urls: string[];
  let reply: { status: number; body: unknown } | { stream: string[] };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    urls = [];
    reply = { status: 200, body: view() };
    globalThis.fetch = ((input: unknown) => {
      const request = input as { url?: string };
      urls.push(typeof input === 'string' ? input : (request.url ?? String(input)));
      if ('stream' in reply) {
        const encoder = new TextEncoder();
        const frames = reply.stream;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('既定は GET /topology を1回読んで木にして書く', async () => {
    const read = captureStdout();
    await topologyCommand();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/topology');
    expect(urls[0]).not.toContain('stream');
    expect(read()).toContain('稼働の地図');
    expect(read()).toContain('mgr-1');
  });

  it('--json はデーモンが返した JSON をそのまま出す', async () => {
    const read = captureStdout();
    await topologyCommand({ json: true });
    expect(JSON.parse(read())).toEqual(view());
  });

  it('--json は unreadable も載せたまま出し、tree 出力にも警告が出る（#2705）', async () => {
    const withBad = view({ unreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }] });
    reply = { status: 200, body: withBad };
    const json = captureStdout();
    await topologyCommand({ json: true });
    expect(JSON.parse(json())).toEqual(withBad);
    vi.restoreAllMocks();
    const tree = captureStdout();
    await topologyCommand();
    expect(tree()).toContain('台帳から読めなかった委譲の行が 1 件ある');
  });

  it('失敗は握り潰さず、理由つきの例外で上へ通す（認証は案内）', async () => {
    reply = { status: 500, body: { error: '内部の理由' } };
    await expect(topologyCommand()).rejects.toThrow(/HTTP 500.*内部の理由/);
    reply = { status: 401, body: {} };
    await expect(topologyCommand()).rejects.toThrow('認証されませんでした');
  });

  it('ログインしていないときは案内だけ書いて、デーモンを叩かない', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'http://x',
      headers: {},
      note: 'ログインしていません',
      remote: true,
    } as never);
    const read = captureStdout();
    await topologyCommand();
    expect(read()).toContain('ログインしていません');
    expect(urls).toEqual([]);
  });

  it('--watch --json は GET /topology/stream の snapshot を1行ずつ出す（他のイベント・heartbeat は読み飛ばす）', async () => {
    const first = view();
    const second = view({ clone: { state: 'idle' } });
    reply = {
      stream: [
        `event: snapshot\ndata: ${JSON.stringify(first)}\n\n`,
        ': hb\n\n',
        'event: other\ndata: {}\n\n',
        `event: snapshot\ndata: ${JSON.stringify(second)}\n\n`,
      ],
    };
    const read = captureStdout();
    // 本文が閉じると「デーモンが接続を閉じました」で落ちる（黙って止まらない）
    await expect(topologyCommand({ watch: true, json: true })).rejects.toThrow(
      'デーモンが接続を閉じました',
    );
    expect(urls[0]).toContain('/topology/stream');
    const lines = read().trim().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);
  });

  it('--watch: unavailable は1行の注意になり、次のスナップショットで消える（--json は type 付きの1行）', async () => {
    const snap = view();
    const frames = [
      `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`,
      'event: unavailable\ndata: {"error":"ECONNREFUSED"}\n\n',
    ];
    reply = { stream: frames };
    const readText = captureStdout();
    await expect(topologyCommand({ watch: true })).rejects.toThrow();
    expect(readText()).toContain('理由の種別: ECONNREFUSED');
    vi.restoreAllMocks();

    reply = { stream: frames };
    const readJson = captureStdout();
    await expect(topologyCommand({ watch: true, json: true })).rejects.toThrow();
    const lines = readJson()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([snap, { type: 'unavailable', error: 'ECONNREFUSED' }]);
  });

  it('--watch（端末でない出力）は届いたスナップショットを描き足す', async () => {
    reply = { stream: [`event: snapshot\ndata: ${JSON.stringify(view())}\n\n`] };
    const read = captureStdout();
    await expect(topologyCommand({ watch: true })).rejects.toThrow();
    const out = read();
    expect(out).toContain('稼働の地図');
    expect(out).not.toContain('\u001b[2J');
  });
});
