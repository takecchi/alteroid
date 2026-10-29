import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async () => {
  const actual = await vi.importActual<typeof import('./target.js')>('./target.js');
  return {
    ...actual,
    resolveTarget: vi.fn(() =>
      Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
    ),
  };
});

const {
  tasksCommand,
  renderTasks,
  tasksMigrateCommand,
  renderMigrationPlan,
  tasksShowCommand,
  tasksAddCommand,
  tasksCloseCommand,
  tasksReopenCommand,
  tasksMoveCommand,
  tasksEditCommand,
} = await import('./tasks.js');

let sent: string[] = [];
let sentCalls: { method: string; url: string; body: string }[] = [];
let originalFetch: typeof fetch;
let reply: { status: number; body: unknown } = { status: 200, body: {} };
// 実行（POST）だけ別の応答を返したいとき。指定が無ければ `reply` を全部の呼びへ返す
let postReply: { status: number; body: unknown } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  sentCalls = [];
  reply = { status: 200, body: { entries: [], unreadable: [] } };
  postReply = null;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    // 呼び出しは `fetch(Request)` でも `fetch(url, init)` でも来うる
    const request = input as Request;
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push(url);
    const method = (
      init?.method ??
      (typeof input === 'string' ? undefined : request.method) ??
      'GET'
    ).toUpperCase();
    const rawBody =
      typeof init?.body === 'string'
        ? init.body
        : (method === 'POST' || method === 'PATCH') && typeof input !== 'string'
          ? await request.clone().text()
          : '';
    sentCalls.push({ method, url, body: rawBody });
    const chosen =
      (method === 'POST' || method === 'PATCH') && postReply !== null ? postReply : reply;
    return new Response(JSON.stringify(chosen.body), {
      status: chosen.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const AT = '2026-10-01T00:00:00.000Z';
const row = (overrides: Record<string, unknown>) => ({
  id: 't',
  status: 'queued',
  origin: 'self',
  title: 'タイトル',
  body: '本文',
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

describe('renderTasks', () => {
  it('開いている行には並びの番号を振り、閉じた行には番号を振らず閉じた理由を出す', () => {
    const out = renderTasks(
      {
        entries: [
          row({ id: 'a', title: '一つ目' }),
          row({ id: 'b', title: '二つ目', status: 'waiting' }),
          row({
            id: 'c',
            title: '済んだ',
            status: 'done',
            closedAt: AT,
            closedReason: '済んだ理由',
          }),
        ],
        unreadable: [],
      },
      Date.parse(AT),
    );
    expect(out).toMatch(/^ {2}1 \[queued\] 一つ目/m);
    expect(out).toMatch(/^ {2}2 \[waiting\] 二つ目/m);
    expect(out).toMatch(/^ {2}✓ \[done\] 済んだ/m);
    expect(out).toContain('済んだ理由');
  });

  it('器が自動で閉じた行は閉じた主体を、「続く」の印の行は印を出す（#5469 P5）', () => {
    const out = renderTasks(
      {
        entries: [
          row({ id: 'k', title: '続ける件', keep: true }),
          row({
            id: 'd',
            title: '自動で済んだ',
            status: 'done',
            closedAt: AT,
            closedBy: 'daemon',
            closedReason: '起点の会話へ返答したので自動で閉じた',
          }),
        ],
        unreadable: [],
      },
      Date.parse(AT),
    );
    expect(out).toContain('続ける件  （続く）');
    expect(out).toContain(`閉じた: ${AT}（daemon）`);
  });

  it('本文は先頭の一行を80字で切り、全文は出さない', () => {
    const out = renderTasks({
      entries: [row({ body: `${'あ'.repeat(200)}\n二行目の印` })],
      unreadable: [],
    });
    expect(out).toContain('…');
    expect(out).not.toContain('二行目の印');
  });

  it('空のときは空と言い、読めない行は「終わったのではない」と添える', () => {
    expect(renderTasks({ entries: [], unreadable: [] })).toBe('（task は無い）');
    expect(renderTasks({ entries: [], unreadable: [{ id: 'x', reason: 'r' }] })).toContain(
      '終わったのではない',
    );
  });
});

describe('alteroid tasks', () => {
  it('既定は includeClosed=false で GET /tasks を叩く', async () => {
    reply = { status: 200, body: { entries: [row({ title: '見える' })], unreadable: [] } };
    const read = captureStdout();
    await tasksCommand();
    expect(sent[0]).toContain('/tasks');
    expect(sent[0]).toContain('includeClosed=false');
    expect(read()).toContain('見える');
  });

  it('--all は includeClosed=true', async () => {
    const read = captureStdout();
    await tasksCommand({ all: true });
    expect(sent[0]).toContain('includeClosed=true');
    read();
  });

  it('HTTP の失敗は黙らず例外にする', async () => {
    reply = { status: 500, body: {} };
    await expect(tasksCommand()).rejects.toThrow(/HTTP 500/);
  });
});

const FINGERPRINT = 'f'.repeat(64);

const planView = {
  dryRun: true,
  fingerprint: FINGERPRINT,
  unresolvedOriginIds: ['h8'],
  summary: {
    originConversation: { fromConversation: 1, fromApproval: 0, unresolved: 1 },
    total: 6,
    toTask: 2,
    closeOnly: 1,
    retire: 2,
    skipClosed: 1,
    byOrigin: {
      human: { toTask: 2, closeOnly: 1, retire: 0, skipClosed: 1 },
      manager: { toTask: 0, closeOnly: 0, retire: 1, skipClosed: 0 },
      external: { toTask: 0, closeOnly: 0, retire: 1, skipClosed: 0 },
      self: { toTask: 0, closeOnly: 0, retire: 0, skipClosed: 0 },
    },
    oldestAt: '2026-10-01T00:00:00.000Z',
    newestAt: '2026-10-02T00:00:00.000Z',
  },
  items: [],
  unreadableCommitments: [{ id: 'broken-1' }],
  unreadableTasks: 1,
  unreadableTaskCollisions: ['h9'],
};

describe('alteroid tasks migrate', () => {
  // P7a は「--dry-run なしはエラーで、実行は P7 本体で配線すると案内する」を固定していた。P7b が実行を配線したので反転した:
  // --dry-run なしは計画を取って表を出し、--yes が無ければ書かずに止まる（POST を1本も送らない）。
  it('--dry-run なし・--yes なしは、計画を出して書かずに止まる（POST を送らない）', async () => {
    reply = { status: 200, body: planView };
    const read = captureStdout();
    await tasksMigrateCommand();
    const out = read();
    expect(sentCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /tasks/migration-plan',
    ]);
    expect(out).toMatch(/移す（task にして台帳を閉じる）\s+2 件/);
    expect(out).toContain('まだ何も書いていない');
    expect(out).toContain('--yes');
    expect(out).toContain(FINGERPRINT);
  });

  it('--dry-run と --yes は同時に使えない（通信しない）', async () => {
    await expect(tasksMigrateCommand({ dryRun: true, yes: true })).rejects.toThrow(/同時/);
    expect(sent).toEqual([]);
  });

  it('--yes は、いま見た計画の指紋を付けて POST /tasks/migrate を送り、結果を件数と id で出す', async () => {
    reply = { status: 200, body: planView };
    postReply = {
      status: 200,
      body: {
        ...planView,
        dryRun: false,
        execution: {
          migrated: 2,
          closeOnly: 1,
          retired: 2,
          alreadyClosed: 0,
          ids: {
            migrated: ['h1', 'h2'],
            closeOnly: ['h9'],
            retired: ['m1', 'x1'],
            alreadyClosed: [],
          },
          originConversation: { fromConversation: 1, fromApproval: 0, unresolvedIds: ['h2'] },
          failed: [],
        },
      },
    };
    const read = captureStdout();
    await tasksMigrateCommand({ yes: true });
    const out = read();
    expect(sentCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /tasks/migration-plan',
      'POST /tasks/migrate',
    ]);
    expect(JSON.parse(sentCalls[1]?.body ?? '{}')).toEqual({ fingerprint: FINGERPRINT });
    expect(out).toMatch(/移した.*\s2 件: h1, h2/);
    expect(out).toMatch(/畳んだ.*\s2 件: m1, x1/);
    expect(out).toMatch(/既に移した.*\s1 件: h9/);
    expect(out).toMatch(/失敗\s+0 件/);
    expect(out).toContain('引けず付けなかった 1 件: h2');
    expect(process.exitCode).not.toBe(1);
  });

  it('--yes で 409（計画が動いた）なら、何も書かれていないと言って失敗にする', async () => {
    reply = { status: 200, body: planView };
    postReply = { status: 409, body: { error: '計画が dry-run のときから変わっている' } };
    const read = captureStdout();
    await expect(tasksMigrateCommand({ yes: true })).rejects.toThrow(/何も書かずに断られ/);
    read();
  });

  it('--yes で失敗した行があれば、id と段階を出して終了コードを非 0 にする', async () => {
    reply = { status: 200, body: planView };
    postReply = {
      status: 200,
      body: {
        ...planView,
        dryRun: false,
        execution: {
          migrated: 1,
          closeOnly: 0,
          retired: 0,
          alreadyClosed: 0,
          ids: { migrated: ['h1'], closeOnly: [], retired: [], alreadyClosed: [] },
          originConversation: { fromConversation: 1, fromApproval: 0, unresolvedIds: [] },
          failed: [{ id: 'h2', step: 'journal', error: 'Error' }],
        },
      },
    };
    const read = captureStdout();
    const before = process.exitCode;
    try {
      await tasksMigrateCommand({ yes: true });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
    const out = read();
    expect(out).toMatch(/失敗\s+1 件/);
    expect(out).toContain('h2: journal の段階で Error');
  });

  it('--dry-run は GET /tasks/migration-plan だけを叩き、内訳を出す', async () => {
    reply = { status: 200, body: planView };
    const read = captureStdout();
    await tasksMigrateCommand({ dryRun: true });
    const out = read();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('/tasks/migration-plan');
    expect(out).toContain('何も書いていない');
    expect(out).toMatch(/移す（task にして台帳を閉じる）\s+2 件/);
    expect(out).toMatch(/畳む.*\s2 件/);
    expect(out).toMatch(/既に移した.*\s1 件/);
    expect(out).toMatch(/移さない.*\s1 件/);
    expect(out).toMatch(/読めない台帳の行（触らない）\s+1 件/);
  });

  it('HTTP の失敗は黙らず例外にする', async () => {
    reply = { status: 500, body: {} };
    await expect(tasksMigrateCommand({ dryRun: true })).rejects.toThrow(/HTTP 500/);
  });
});

describe('renderMigrationPlan', () => {
  it('起点別の内訳・最古/最新・読めない行の id（本文は無い）を出す', () => {
    const out = renderMigrationPlan(planView);
    expect(out).toMatch(/human\s+2\s+1\s+0\s+1/);
    expect(out).toMatch(/manager\s+0\s+0\s+1\s+0/);
    expect(out).toContain('最古 2026-10-01T00:00:00.000Z / 最新 2026-10-02T00:00:00.000Z');
    expect(out).toContain('broken-1');
    expect(out).toContain('h9');
  });

  it('移す行が無ければ「無い」と言う', () => {
    const out = renderMigrationPlan({
      ...planView,
      summary: { ...planView.summary, toTask: 0, oldestAt: null, newestAt: null },
      unreadableCommitments: [],
      unreadableTasks: 0,
      unreadableTaskCollisions: [],
    });
    expect(out).toContain('移す行: 無い');
  });
});

describe('alteroid tasks show', () => {
  it('GET /tasks/:id を叩き、全文と編集に使う版を出す', async () => {
    reply = {
      status: 200,
      body: {
        entry: row({ id: 'abc', body: '長い本文\n二行目', editedAt: '2026-10-02T00:00:00.000Z' }),
      },
    };
    const read = captureStdout();
    await tasksShowCommand('abc');
    const out = read();
    expect(sentCalls[0]?.method).toBe('GET');
    expect(sentCalls[0]?.url).toContain('/tasks/abc');
    expect(out).toContain('二行目');
    expect(out).toContain('版（--if-match）: 2026-10-02T00:00:00.000Z');
  });

  it('404 は黙らず例外にする', async () => {
    reply = { status: 404, body: { error: 'not found' } };
    await expect(tasksShowCommand('x')).rejects.toThrow(/HTTP 404.*not found/);
  });
});

describe('alteroid tasks add', () => {
  it('POST /tasks に題・本文・置き場所・起点を送り、id を出す', async () => {
    postReply = { status: 200, body: { ok: true, id: 'new-1' } };
    const read = captureStdout();
    await tasksAddCommand({ title: '題', body: '本文', front: true, source: 'conv-1' });
    expect(read()).toContain('new-1');
    expect(sentCalls[0]?.method).toBe('POST');
    expect(JSON.parse(sentCalls[0]?.body ?? '{}')).toEqual({
      title: '題',
      body: '本文',
      source: 'conv-1',
      placement: { kind: 'front' },
    });
  });

  it('題か本文が無ければ、通信せずに断る。置き場所を2つ指定しても断る', async () => {
    await expect(tasksAddCommand({ body: 'b' })).rejects.toThrow(/--title/);
    await expect(tasksAddCommand({ title: 't' })).rejects.toThrow(/--body/);
    await expect(
      tasksAddCommand({ title: 't', body: 'b', front: true, after: 'x' }),
    ).rejects.toThrow(/1つだけ/);
    expect(sentCalls).toEqual([]);
  });

  it('400 は daemon の理由つきで例外にする', async () => {
    postReply = { status: 400, body: { error: 'placement の anchorId は開いている task に無い' } };
    await expect(tasksAddCommand({ title: 't', body: 'b', after: 'zz' })).rejects.toThrow(
      /HTTP 400.*anchorId/,
    );
  });
});

describe('alteroid tasks close / reopen', () => {
  it('close は POST /tasks/:id/close に status と reason を送る', async () => {
    postReply = { status: 200, body: { ok: true } };
    const read = captureStdout();
    await tasksCloseCommand('abc', { status: 'cancelled', reason: '不要' });
    expect(read()).toContain('cancelled');
    expect(sentCalls[0]?.url).toContain('/tasks/abc/close');
    expect(JSON.parse(sentCalls[0]?.body ?? '{}')).toEqual({ status: 'cancelled', reason: '不要' });
  });

  it('close は status が done / cancelled でなければ、reason が無ければ、通信せずに断る', async () => {
    await expect(tasksCloseCommand('a', { status: 'queued', reason: 'r' })).rejects.toThrow(
      /--status/,
    );
    await expect(tasksCloseCommand('a', { status: 'done' })).rejects.toThrow(/--reason/);
    expect(sentCalls).toEqual([]);
  });

  it('close の 409（既に閉じている）は例外にする', async () => {
    postReply = { status: 409, body: { error: 'abc は既に閉じている' } };
    await expect(tasksCloseCommand('abc', { status: 'done', reason: 'r' })).rejects.toThrow(
      /HTTP 409.*既に閉じている/,
    );
  });

  it('reopen は POST /tasks/:id/reopen に reason を送る。reason が無ければ通信しない', async () => {
    postReply = { status: 200, body: { entry: row({}) } };
    const read = captureStdout();
    await tasksReopenCommand('abc', { reason: 'まだ' });
    read();
    expect(sentCalls[0]?.url).toContain('/tasks/abc/reopen');
    expect(JSON.parse(sentCalls[0]?.body ?? '{}')).toEqual({ reason: 'まだ' });
    sentCalls = [];
    await expect(tasksReopenCommand('abc', {})).rejects.toThrow(/--reason/);
    expect(sentCalls).toEqual([]);
  });
});

describe('alteroid tasks move / edit', () => {
  it('move は POST /tasks/:id/move に placement を送る。置き場所が無ければ通信しない', async () => {
    postReply = { status: 200, body: { ok: true } };
    const read = captureStdout();
    await tasksMoveCommand('abc', { before: 'xyz' });
    read();
    expect(sentCalls[0]?.url).toContain('/tasks/abc/move');
    expect(JSON.parse(sentCalls[0]?.body ?? '{}')).toEqual({
      placement: { kind: 'before', anchorId: 'xyz' },
    });
    sentCalls = [];
    await expect(tasksMoveCommand('abc', {})).rejects.toThrow(/置き場所/);
    expect(sentCalls).toEqual([]);
  });

  it('move の 409（閉じている）は例外にする', async () => {
    postReply = { status: 409, body: { error: '閉じていて動かせない' } };
    await expect(tasksMoveCommand('abc', { back: true })).rejects.toThrow(/HTTP 409/);
  });

  it('edit は PATCH /tasks/:id に、渡した項目だけと ifMatch を送る', async () => {
    postReply = { status: 200, body: { ok: true } };
    const read = captureStdout();
    await tasksEditCommand('abc', { title: '新題', ifMatch: AT });
    read();
    expect(sentCalls[0]?.method).toBe('PATCH');
    expect(JSON.parse(sentCalls[0]?.body ?? '{}')).toEqual({ title: '新題', ifMatch: AT });
  });

  it('edit は title も body も無ければ通信せずに断る。403 / 409 は例外にする', async () => {
    await expect(tasksEditCommand('abc', {})).rejects.toThrow(/--title か --body/);
    expect(sentCalls).toEqual([]);
    postReply = { status: 403, body: { error: "origin:'self' の行は直せない" } };
    await expect(tasksEditCommand('abc', { body: 'b' })).rejects.toThrow(/HTTP 403/);
    postReply = { status: 409, body: { error: 'task が読んだ後に変わっています' } };
    await expect(tasksEditCommand('abc', { body: 'b', ifMatch: AT })).rejects.toThrow(/HTTP 409/);
  });
});
