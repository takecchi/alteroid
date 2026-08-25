import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE, type UsageRow } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';
import { renderUsage, usageCommand, type UsageView } from './usage.js';

/**
 * #361: `renderUsage`（文字列を返す純粋関数）だけでなく、実際に端末へ書く
 * `usageCommand`（書く側）も測る。`renderUsage` のテストが緑でも、
 * `usageCommand` が別のものを書く・書かない・書く先を間違える欠陥は別に
 * 測らないと緑のまま通る（`captureStdout` の doc に同じ注意がある。#333 の
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

function row(over: Partial<UsageRow> & { managerId: string; costUsd: number }): UsageRow {
  const { costUsd, ...rest } = over;
  return {
    date: '2026-08-14',
    model: 'claude-opus-4',
    layer: 'manager',
    site: 'session',
    updatedAt: '2026-08-14T10:00:00.000Z',
    ...rest,
    totals: { ...ZERO_USAGE, costUsd },
  };
}

/**
 * `GET /usage` の応答。
 *
 * **`account`（アカウント全体の残り）を既定で `unknown` にしてある。** ここを
 * 省略できる形にすると、渡し忘れた口が黙って落とせてしまう — それが実際に起きて
 * いた欠陥である（読んでいたのはクローンの `usage_read` だけだった）。
 */
function aggregate(over: Partial<UsageView>): UsageView {
  return {
    rows: [],
    since: '2026-08-01T00:00:00.000Z',
    layersSince: '2026-08-01T00:00:00.000Z',
    // **トークンの軸も既定で「観測している」側にしてある。** ここを null にすると
    // 全テストの出力に「まだ1件も記録していない」の行が入り、その行がある状態を
    // 正常として固定してしまう（この軸を測るテストは自分で null を渡す）。
    tokensSince: '2026-08-01T00:00:00.000Z',
    beforeLedger: false,
    beforeLayers: false,
    beforeTokens: false,
    notice: USAGE_ESTIMATE_NOTICE,
    account: { state: 'unknown' },
    // **既定で「取りこぼしは無い」側にしてある**（他の軸と同じ理由）。この軸を
    // 測るテストは自分で渡す。
    unrecordedManagers: [],
    ...over,
  };
}

describe('renderUsage', () => {
  it('台帳がまだ空（since が null）なら $0.00 とは言わず、記録が無いと言う', () => {
    const text = renderUsage(aggregate({ rows: [], since: null }));

    expect(text).not.toContain('$0.00');
    expect(text).toContain('まだ1件も記録が無い');
    // まだ何も出せていなくても但し書きは必ず添える。
    expect(text).toContain(USAGE_ESTIMATE_NOTICE);
  });

  it('beforeLedger が真なら 0 と言わず、記録が無い範囲だと明示する', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 0.5 })],
        beforeLedger: true,
      }),
    );

    expect(text).toContain('記録が無い');
    expect(text).not.toMatch(/合計\s*\$0\.00/);
  });

  it('$1 未満を $0.00 に丸めない（formatUsd をそのまま使う）', () => {
    const text = renderUsage(aggregate({ rows: [row({ managerId: 'm1', costUsd: 0.0123 })] }));

    expect(text).toContain('$0.0123');
    expect(text).not.toContain('$0.00');
  });

  it('但し書きを必ず出す', () => {
    const text = renderUsage(aggregate({ rows: [row({ managerId: 'm1', costUsd: 1.2 })] }));

    expect(text).toContain(USAGE_ESTIMATE_NOTICE);
  });

  it('軸の上限を超えたら、打ち切ったことを書く（黙って切り捨てない）', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ managerId: `m${String(i).padStart(2, '0')}`, costUsd: 1 }),
    );
    const text = renderUsage(aggregate({ rows }));

    expect(text).toContain('残り 5 件は出していない');
  });

  it('日別・マネージャー別・モデル別の内訳をすべて出す', () => {
    const rows = [
      row({ managerId: 'm1', model: 'opus', date: '2026-08-13', costUsd: 1 }),
      row({ managerId: 'm2', model: 'sonnet', date: '2026-08-14', costUsd: 2 }),
    ];
    const text = renderUsage(aggregate({ rows }));

    expect(text).toContain('日別:');
    expect(text).toContain('マネージャー別:');
    expect(text).toContain('モデル別:');
    expect(text).toContain('合計 $3.00');
  });

  it('層別（誰が）と場所別（どこで）も出す', () => {
    // **モデル名では層を見分けられない。** 3行とも同じモデル帯にしてあるのは、
    // `ALTEROID_CLONE_MODEL` を置いたときに実際に起きる並びだからである。
    const rows = [
      row({ managerId: 'clone', model: 'opus', layer: 'clone', site: 'session', costUsd: 1.5 }),
      row({ managerId: 'clone', model: 'opus', layer: 'clone', site: 'distill', costUsd: 0.5 }),
      row({ managerId: 'm1', model: 'opus', layer: 'manager', site: 'session', costUsd: 2 }),
    ];
    const text = renderUsage(aggregate({ rows }));

    expect(text).toContain('層別（誰が）:');
    expect(text).toContain('clone: $2.00');
    expect(text).toContain('manager: $2.00');
    expect(text).toContain('場所別（どこで）:');
    expect(text).toContain('session: $3.50');
    expect(text).toContain('distill: $0.5000');
  });

  it('層の軸の始点を台帳の始点と混ぜない', () => {
    // 台帳（#45）より層の軸のほうが後から入った器では、始点が2つある。
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 1 })],
        since: '2026-08-01T00:00:00.000Z',
        layersSince: '2026-08-19T00:00:00.000Z',
      }),
    );

    expect(text).toContain('台帳の始点: 2026-08-01T00:00:00.000Z');
    expect(text).toContain('層と場所の軸の始点: 2026-08-19T00:00:00.000Z');
  });

  it('beforeLayers が真なら、その範囲の層と場所は観測ではないと書く', () => {
    // ここを黙ると「クローンは使っていなかった」「蒸留は起きていなかった」と読める。
    const text = renderUsage(
      aggregate({ rows: [row({ managerId: 'm1', costUsd: 1 })], beforeLayers: true }),
    );

    expect(text).toContain('既定値であって観測ではない');
  });

  it('層の軸がまだ1件も無ければ、始点を偽らない', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 1 })],
        layersSince: null,
        beforeLayers: true,
      }),
    );

    expect(text).toContain('層と場所の軸はまだ1件も記録していない');
    expect(text).not.toContain('層と場所の軸の始点: null');
  });
});

/**
 * 台帳に1行も無い委譲（Issue #98「台帳が取りこぼした委譲」）。
 *
 * **合計値の隣に必ず出す。** 文言そのものは `describeUnrecordedManagers`
 * （core）が1箇所で持つので、ここで測るのは「渡された内容がそのまま出るか」と
 * 「合計の近くという位置」である。
 */
describe('renderUsage は台帳に1行も無い委譲を合計値の隣に出す', () => {
  it('1件以上あれば、合計の直後に managerId と status と起こした時刻を出す', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 1 })],
        unrecordedManagers: [
          { managerId: 'mgr-unrecorded', status: 'running', startedAt: '2026-08-25T12:00:00.000Z' },
        ],
      }),
    );

    expect(text).toContain('mgr-unrecorded');
    expect(text).toContain('running');
    expect(text).toContain('2026-08-25T12:00:00.000Z');

    // **合計値の隣**——「合計 …」の行より後、マネージャー別などの軸の見出しより
    // 前に出ることを、出現位置の順序で確かめる。
    const totalIndex = text.indexOf('合計 $1.00');
    const unrecordedIndex = text.indexOf('mgr-unrecorded');
    const managerAxisIndex = text.indexOf('マネージャー別:');
    expect(totalIndex).toBeGreaterThanOrEqual(0);
    expect(unrecordedIndex).toBeGreaterThan(totalIndex);
    expect(unrecordedIndex).toBeLessThan(managerAxisIndex);
  });

  /**
   * **0件のときも黙らない。** 空配列は「取りこぼしが無い」であって「調べていない」
   * ではない——そう読める形で、0件でも必ず1行出す。
   */
  it('0件のときは「0件」と明示する（黙らない）', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 1 })],
        unrecordedManagers: [],
      }),
    );

    expect(text).toContain('0件');
  });

  it('rows が空でも、取りこぼしがあれば出す（照会範囲と無関係に全期間で判定するため）', () => {
    const text = renderUsage(
      aggregate({
        rows: [],
        unrecordedManagers: [
          { managerId: 'mgr-unrecorded', status: 'done', startedAt: '2026-08-25T12:00:00.000Z' },
        ],
      }),
    );

    expect(text).toContain('その範囲には記録が無い');
    expect(text).toContain('mgr-unrecorded');
  });

  it('台帳がまだ空（since が null）でも、取りこぼしがあれば出す', () => {
    const text = renderUsage(
      aggregate({
        rows: [],
        since: null,
        unrecordedManagers: [
          { managerId: 'mgr-unrecorded', status: 'running', startedAt: '2026-08-25T12:00:00.000Z' },
        ],
      }),
    );

    expect(text).toContain('まだ1件も記録が無い');
    expect(text).toContain('mgr-unrecorded');
  });
});

/**
 * アカウント全体の残り（claude.ai 側の値）を、**人間の面にも出す。**
 *
 * `GET /usage` は最初からこれを返していたが、読んでいたのはクローンの
 * `usage_read` だけだった。クローンに見えているものが人間に見えないのは能力の
 * 差である（north_star 禁止1）。
 *
 * ここで見るのは「出ていること」と「取れなかったものを 0 と書かないこと」。
 * 文言そのものの試験は core（`describeAccountUsage`）が持つ。
 */
describe('renderUsage はアカウント全体の残りも出す', () => {
  it('台帳に記録があるときに出る', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 1 })],
        account: {
          state: 'ok',
          usage: {
            at: '2026-08-14T10:00:00.000Z',
            plan: 'Claude Max',
            limitsAvailable: true,
            windows: [
              {
                kind: 'five_hour',
                utilization: 42,
                resetsAt: Date.parse('2026-08-14T13:00:00.000Z'),
              },
            ],
          },
        },
      }),
    );

    expect(text).toContain('アカウント全体の残り（claude.ai 側の値）');
    expect(text).toContain('Claude Max');
    expect(text).toContain('42% 使用');
    // 端末は Markdown を解釈しないので、強調記号を素で出さない。
    expect(text).not.toContain('**');
  });

  it('台帳がまだ空でも出る（台帳が空なことと、枠が分からないことは別）', () => {
    const text = renderUsage(aggregate({ since: null, account: { state: 'unknown' } }));

    expect(text).toContain('アカウント全体の残り（claude.ai 側の値）');
    expect(text).toContain('まだ取りに行っていない');
    expect(text).toContain('0 ではなく、分からない');
  });

  it('取れなかったときに 0 と書かない', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 1 })],
        account: {
          state: 'failed',
          at: '2026-08-14T10:00:00.000Z',
          reason: '2つの口のどちらも答えなかった',
        },
      }),
    );

    expect(text).toContain('取れなかった');
    expect(text).toContain('0 ではなく、分からない');
    expect(text).not.toContain('0% 使用');
  });
});

/**
 * #361: 「書く側」— `renderUsage` が正しい文字列を作っても、`usageCommand` が
 * それを書かない・別のものを書く・書く先を間違えれば、上の `renderUsage` の
 * テストは全部緑のまま通る。ここではその経路自体を測る。
 */
describe('usageCommand', () => {
  it('GET /usage を叩き、renderUsage の出力をそのまま端末へ書く', async () => {
    const view = aggregate({ rows: [row({ managerId: 'm1', costUsd: 1.5 })] });
    replies.push({ status: 200, body: view });
    const read = captureStdout();

    await usageCommand({});

    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]?.url ?? '');
    expect(url.pathname).toBe('/usage');
    // **書く側が別のものを書く／書き忘れる変異を狙って名指す。** 「何か出た」では
    // なく、`renderUsage` がこの入力に対して作る文字列そのものと一致することを
    // 見る（末尾の改行1つも含めて）。
    expect(read()).toBe(`${renderUsage(view)}\n`);
  });

  it('from / to / manager / layer / site をクエリへそのまま渡す', async () => {
    replies.push({ status: 200, body: aggregate({}) });
    captureStdout();

    await usageCommand({
      from: '2026-08-01',
      to: '2026-08-14',
      manager: 'mgr-1',
      layer: 'clone',
      site: 'session',
    });

    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]?.url ?? '');
    expect(url.searchParams.get('from')).toBe('2026-08-01');
    expect(url.searchParams.get('to')).toBe('2026-08-14');
    expect(url.searchParams.get('managerId')).toBe('mgr-1');
    expect(url.searchParams.get('layer')).toBe('clone');
    expect(url.searchParams.get('site')).toBe('session');
  });

  it('--layer が許された値でなければ、そう書いて叩かない', async () => {
    const read = captureStdout();

    await usageCommand({ layer: 'not-a-layer' });

    expect(sent).toHaveLength(0);
    expect(read()).toContain('--layer は');
    expect(read()).toContain('のどれかを指定してください');
  });

  it('--site が許された値でなければ、そう書いて叩かない', async () => {
    const read = captureStdout();

    await usageCommand({ site: 'not-a-site' });

    expect(sent).toHaveLength(0);
    expect(read()).toContain('--site は');
    expect(read()).toContain('のどれかを指定してください');
  });

  it('ログインしていなければ note をそのまま書き、usage を叩かない', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await usageCommand({});

    expect(sent).toHaveLength(0);
    expect(read()).toBe('https://runner.example.com にログインしていません（alteroid login）\n');
  });

  it('応答が失敗（ok でない）なら、読めなかったと書く（renderUsage は呼ばない）', async () => {
    replies.push({ status: 500, body: {} });
    const read = captureStdout();

    await usageCommand({});

    expect(read()).toBe('利用状況を読めませんでした（クエリの形を確かめてください）\n');
  });
});
