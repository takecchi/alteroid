import { spawnSync } from 'node:child_process';

import type { InboxBacklogBreakdown } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'http://127.0.0.1:4517',
      headers: {},
      note: null,
      remote: false,
    }),
}));

const { inboxRemoveCommand, inboxShowCommand, renderInboxBacklog } = await import('./inbox.js');

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method: init?.method ?? request.method ?? 'GET', body });
    const reply = replies.shift() ?? {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        totalPending: 0,
        matched: 0,
        targeted: 0,
        removedIds: [],
        remaining: 0,
      },
    };
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

describe('alteroid inbox remove — 送る本文', () => {
  it('既定（--execute を渡さない）は dryRun: true を送る', async () => {
    captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: '滞留の掃除' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/inbox/remove');
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body).toEqual({
      types: ['manager_message'],
      reason: '滞留の掃除',
      dryRun: true,
    });
  });

  it('--execute を渡すと dryRun: false を送る', async () => {
    captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: '滞留の掃除', execute: true });

    expect(sent[0]?.body).toEqual({
      types: ['manager_message'],
      reason: '滞留の掃除',
      dryRun: false,
    });
  });

  it('--types はカンマ区切りで配列へ、前後の空白を落とす', async () => {
    captureStdout();
    await inboxRemoveCommand({ types: ' manager_message , timer ', reason: 'r' });

    expect((sent[0]?.body as { types: string[] }).types).toEqual(['manager_message', 'timer']);
  });

  it('--sources / --before / --limit を渡すと本文に含める', async () => {
    captureStdout();
    await inboxRemoveCommand({
      types: 'external',
      sources: 'external:webhook-a, external:webhook-b',
      before: '2026-09-15T00:00:00.000Z',
      reason: 'r',
      limit: '50',
    });

    expect(sent[0]?.body).toEqual({
      types: ['external'],
      sources: ['external:webhook-a', 'external:webhook-b'],
      before: '2026-09-15T00:00:00.000Z',
      reason: 'r',
      dryRun: true,
      limit: 50,
    });
  });

  it('--sources / --before / --limit を渡さないときは本文にキーごと含めない', async () => {
    captureStdout();
    await inboxRemoveCommand({ types: 'external', reason: 'r' });

    const body = sent[0]?.body as Record<string, unknown>;
    expect('sources' in body).toBe(false);
    expect('before' in body).toBe(false);
    expect('limit' in body).toBe(false);
  });
});

describe('alteroid inbox remove — 入力の手前での断り（fetch を呼ばない。例外＝終了コード非0）', () => {
  it('--types が空（カンマだけ等）なら断って fetch しない', async () => {
    captureStdout();
    const error = await inboxRemoveCommand({ types: ' , ', reason: 'r' }).catch((e: unknown) => e);

    expect(sent).toHaveLength(0);
    expect(String(error)).toContain('--types に最低1種類');
  });

  it('--sources が空（カンマだけ等）なら断って fetch しない', async () => {
    captureStdout();
    const error = await inboxRemoveCommand({
      types: 'timer',
      reason: 'r',
      sources: ' , ',
    }).catch((e: unknown) => e);

    expect(sent).toHaveLength(0);
    expect(String(error)).toContain('--sources を渡すなら最低1件');
  });

  it('--limit が整数でないなら断って fetch しない', async () => {
    captureStdout();
    const error = await inboxRemoveCommand({ types: 'timer', reason: 'r', limit: 'abc' }).catch(
      (e: unknown) => e,
    );

    expect(sent).toHaveLength(0);
    expect(String(error)).toContain('--limit には1以上の整数');
  });

  it('--limit が0以下なら断って fetch しない', async () => {
    captureStdout();
    const error = await inboxRemoveCommand({ types: 'timer', reason: 'r', limit: '0' }).catch(
      (e: unknown) => e,
    );

    expect(sent).toHaveLength(0);
    expect(String(error)).toContain('--limit には1以上の整数');
  });
});

describe('alteroid inbox remove — 応答の表示', () => {
  it('試算（dryRun）の結果を件数つきで出し、1件も消していないと明言する', async () => {
    replies = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          totalPending: 30,
          matched: 12,
          targeted: 10,
          removedIds: ['e-1', 'e-2'],
          remaining: 2,
        },
      },
    ];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: 'r', limit: '10' });

    const text = read();
    expect(text).toContain('[試算]');
    expect(text).toContain('30 件中 12 件');
    expect(text).toContain('対象 10 件');
    expect(text).toContain('上限で持ち越し 2 件');
    expect(text).toContain('1件も消していません');
    expect(text).toContain('--execute');
    expect(text).toContain(
      "alteroid inbox remove --types 'manager_message' --reason 'r' --limit '10' --execute",
    );
  });

  it('⭐ 試算でも対象の id を「消すことになる id」として全部並べ、実行コマンドの案内より前に出す（Issue #4082）', async () => {
    const removedIds = Array.from({ length: 5 }, (_, index) => `e-${index}`);
    replies = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          totalPending: 5,
          matched: 5,
          targeted: 5,
          removedIds,
          remaining: 0,
        },
      },
    ];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: 'r' });

    const text = read();
    expect(text).toContain('消すことになる id（5件、古い順）:');
    expect(text).not.toContain('消した id');
    for (const id of removedIds) expect(text).toContain(`  ${id}\n`);
    expect(text.indexOf('e-4')).toBeLessThan(text.indexOf('--execute を付けて'));
  });

  it('試算で対象が0件なら、id の見出しを出さない', async () => {
    replies = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          totalPending: 3,
          matched: 0,
          targeted: 0,
          removedIds: [],
          remaining: 0,
        },
      },
    ];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: 'r' });

    expect(read()).not.toContain('消すことになる id');
  });

  it('実行（--execute）の結果は消した id を全部出す（打ち切らない）', async () => {
    const removedIds = Array.from({ length: 5 }, (_, index) => `e-${index}`);
    replies = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: false,
          totalPending: 5,
          matched: 5,
          targeted: 5,
          removedIds,
          remaining: 0,
        },
      },
    ];
    const read = captureStdout();
    await inboxRemoveCommand({ types: 'manager_message', reason: 'r', execute: true });

    const text = read();
    expect(text).not.toContain('[試算]');
    expect(text).not.toContain('1件も消していません');
    for (const id of removedIds) expect(text).toContain(id);
  });
});

describe('alteroid inbox remove — サーバの断りをそのまま投げる', () => {
  it('400（絞り込みが無いのと同じ呼び等）はサーバの error 文言をそのまま投げる', async () => {
    replies = [
      { status: 400, body: { error: '絞り込みが無いのと同じ呼びは断る。1件も消していません。' } },
    ];

    await expect(
      inboxRemoveCommand({
        types: 'human_message,human_answer,distill,timer,external,self_initiative,manager_message',
        reason: 'r',
      }),
    ).rejects.toThrow('絞り込みが無いのと同じ呼びは断る。1件も消していません。');
  });

  it('403 は access grant の案内を投げる（describeAuthFailure と同じ文言）', async () => {
    replies = [{ status: 403, body: { error: 'このアカウントには alteroid を使う許可が無い' } }];

    await expect(inboxRemoveCommand({ types: 'timer', reason: 'r' })).rejects.toThrow(
      /alteroid access grant/,
    );
  });

  it('5xx も握り潰さずに投げる（終了コードが 0 にならない）', async () => {
    replies = [{ status: 500, body: { error: 'internal' } }];

    await expect(inboxRemoveCommand({ types: 'timer', reason: 'r' })).rejects.toThrow(
      '受信箱を畳めませんでした（500）',
    );
    replies = [{ status: 500, body: { error: '受信箱の書き込みが失敗した（テスト用）' } }];
    await expect(inboxRemoveCommand({ types: 'timer', reason: 'r' })).rejects.toThrow(
      '受信箱の書き込みが失敗した（テスト用）',
    );
  });

  it('繋がらない（fetch そのものが失敗する）も投げる', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch;

    await expect(inboxRemoveCommand({ types: 'timer', reason: 'r' })).rejects.toThrow(
      'fetch failed',
    );
  });
});

const EMPTY_BACKLOG: InboxBacklogBreakdown = {
  total: 0,
  byType: [],
  bySource: [],
  bySourceOverflowKinds: 0,
  bySourceOverflowCount: 0,
  bySourceUnknownCount: 0,
  distinct: 0,
  distinctAcrossManagers: 0,
  undelivered: 0,
  deliveredOnce: 0,
  redelivered: 0,
  maxDeliveries: 0,
  undeliveredByType: [],
  ageBuckets: [],
  observedAt: '2026-09-23T00:00:00.000Z',
  humanOriginated: { total: 0, byType: [], undelivered: 0 },
};

const BACKLOG_WITH_ROWS: InboxBacklogBreakdown = {
  total: 3,
  oldestAt: '2026-08-10T00:00:00.000Z',
  byType: [
    { type: 'human_message', count: 1 },
    { type: 'manager_message', count: 2 },
  ],
  bySource: [{ source: 'manager:mgr-1', count: 2 }],
  bySourceOverflowKinds: 0,
  bySourceOverflowCount: 0,
  bySourceUnknownCount: 1,
  distinct: 3,
  distinctAcrossManagers: 3,
  undelivered: 3,
  deliveredOnce: 0,
  redelivered: 0,
  maxDeliveries: 0,
  undeliveredByType: [
    { type: 'human_message', count: 1 },
    { type: 'manager_message', count: 2 },
  ],
  ageBuckets: [{ label: '1時間未満', count: 3 }],
  observedAt: '2026-09-23T00:00:00.000Z',
  humanOriginated: {
    total: 1,
    byType: [{ type: 'human_message', count: 1 }],
    oldestAt: '2026-08-11T00:00:00.000Z',
    undelivered: 1,
  },
};

describe('renderInboxBacklog', () => {
  it('0件は「クローンの受信箱に未処理の合図は無い。」', () => {
    expect(renderInboxBacklog(EMPTY_BACKLOG)).toBe('クローンの受信箱に未処理の合図は無い。');
  });

  it('読めた行が0件でも、読めない行が在れば「未処理の合図は無い」と言わず、読めない件数を言う', () => {
    const text = renderInboxBacklog({
      ...EMPTY_BACKLOG,
      unreadable: [
        { id: 'evt-bad', at: '2026-09-27T00:00:00.000Z', reason: '不正な欄: event.type' },
      ],
    });
    expect(text).not.toContain('未処理の合図は無い。');
    expect(text).toContain('読めた未処理の合図は無い（ただし、読めない行が在る');
    expect(text).toContain('読めない合図が 1 件ある（id: evt-bad）');
    expect(text).toContain('処理済みで消えたのではない');
  });

  it('読めた行が在り、読めない行も在れば、内訳の末尾に読めない件数を足す（計には入っていない）', () => {
    const text = renderInboxBacklog({
      ...BACKLOG_WITH_ROWS,
      unreadable: [{ reason: '不正な行' }],
    });
    expect(text).toContain('内訳（計 3 件）');
    expect(text).toContain('読めない合図が 1 件ある（id も取れない）');
    expect(text).toContain('上の計には入っていない');
  });

  it('対照: unreadable が無ければ、読めない行の文言は出ない', () => {
    expect(renderInboxBacklog(BACKLOG_WITH_ROWS)).not.toContain('読めない');
  });

  it('人間起点の滞留を、内訳より前・単独の行で出す（issue #917 と同じ並び）', () => {
    const text = renderInboxBacklog(BACKLOG_WITH_ROWS);
    const alertIndex = text.indexOf('人間起点');
    const breakdownIndex = text.indexOf('内訳（計');
    expect(alertIndex).toBeGreaterThanOrEqual(0);
    expect(breakdownIndex).toBeGreaterThan(alertIndex);
  });

  it('種類別・送信元別の内訳を含む（manager_list と同じ描画関数を通した証拠）', () => {
    const text = renderInboxBacklog(BACKLOG_WITH_ROWS);
    expect(text).toContain('計 3 件');
    expect(text).toContain('human_message 1');
    expect(text).toContain('manager_message 2');
    expect(text).toContain('manager:mgr-1 2');
  });
});

describe('alteroid inbox show', () => {
  it('GET /inbox を叩く（POST ではない）', async () => {
    replies = [{ status: 200, body: EMPTY_BACKLOG }];
    const read = captureStdout();
    await inboxShowCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/inbox');
    expect(sent[0]?.method).toBe('GET');
    expect(read()).toContain('クローンの受信箱に未処理の合図は無い。');
  });

  it('内訳を出力する', async () => {
    replies = [{ status: 200, body: BACKLOG_WITH_ROWS }];
    const read = captureStdout();
    await inboxShowCommand();

    const text = read();
    expect(text).toContain('計 3 件');
    expect(text).toContain('human_message 1');
  });

  it('403（許可が無い）は例外にする（stdout に書かない）', async () => {
    replies = [{ status: 403, body: { error: 'このアカウントには alteroid を使う許可が無い' } }];
    const read = captureStdout();

    await expect(inboxShowCommand()).rejects.toThrow('access grant');
    expect(read()).toBe('');
  });

  it('401 は describeAuthFailure の文で例外にする', async () => {
    replies = [{ status: 401, body: {} }];
    const read = captureStdout();

    await expect(inboxShowCommand()).rejects.toThrow('認証されませんでした');
    expect(read()).toBe('');
  });

  it('5xx も例外にする', async () => {
    replies = [{ status: 500, body: { error: '受信箱の集計が失敗した（テスト用）' } }];
    const read = captureStdout();

    const error = await inboxShowCommand().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain('受信箱の内訳を読めませんでした（500）');
    expect(error?.message).toContain('受信箱の集計が失敗した（テスト用）');
    expect(read()).toBe('');
  });

  it('繋がらない（fetch そのものが失敗する）も投げる', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch;

    await expect(inboxShowCommand()).rejects.toThrow('fetch failed');
  });
});

describe('alteroid inbox remove — 試算が案内するコマンド', () => {
  function argsWhenPasted(output: string): string[] {
    const line = output.split('\n').find((l) => l.trimStart().startsWith('alteroid inbox remove'));
    if (line === undefined) throw new Error(`案内の行が無い: ${output}`);
    const script = `alteroid() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n${line}`;
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { HOME: '/home/x' } });
    return run.stdout.split('\0').slice(0, -1);
  }

  it('--reason の " $ ` \\ \' と、--sources / --types の空白は、貼っても元の値のまま', async () => {
    const out = captureStdout();
    const reason = 'cleanup "old" $HOME `id` back\\slash it\'s';
    await inboxRemoveCommand({
      types: 'manager_message, timer',
      sources: 'a, b',
      before: '2026-09-15T00:00:00.000Z',
      reason,
      limit: '5',
    });

    expect(argsWhenPasted(out())).toEqual([
      'inbox',
      'remove',
      '--types',
      'manager_message, timer',
      '--sources',
      'a, b',
      '--before',
      '2026-09-15T00:00:00.000Z',
      '--reason',
      reason,
      '--limit',
      '5',
      '--execute',
    ]);
  });
});
