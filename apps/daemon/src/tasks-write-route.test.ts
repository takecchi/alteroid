import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, JournalEntry, Stores, Task } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// #5469 P7c-1: 人間が task を書く口（POST /tasks・GET /tasks/:id・close・reopen・move・PATCH）。
// 台帳（/commitments）の同じ働きの口と作法を揃えたことを測る: 先に日誌、効いた後の行だけが humanAction を持つ。

const AT = '2026-10-01T00:00:00.000Z';
const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

let stores: Stores;

function build(over: Stores = stores) {
  const clone: CloneHost = {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores: over, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
  const app = createApp({ clone, stores: over, token: 'test-token', shutdown: () => {} });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: AUTH,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, send };
}

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  createdAt: AT,
  updatedAt: AT,
  status: 'queued',
  origin: 'human',
  title: id,
  body: `${id}の本文`,
  ...overrides,
});

async function decisions(): Promise<Extract<JournalEntry, { type: 'decision' }>[]> {
  const rows = await stores.journal.list({ types: ['decision'], order: 'asc' });
  return rows.flatMap((row) => (row.type === 'decision' ? [row] : []));
}

async function openIds(): Promise<string[]> {
  return (await stores.tasks.list()).entries.map((entry) => entry.id);
}

function brokenJournal(): Stores {
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append: async () => {
        throw new Error('日誌が書けない');
      },
    },
  };
}

beforeEach(() => {
  stores = createMemoryStores();
});

describe('POST /tasks（積む）', () => {
  it('human 起点で積み、既定の置き場所は開いている human 起点の最後の直後。日誌に残り humanAction は付かない', async () => {
    await stores.tasks.add(task('h1'));
    await stores.tasks.add(task('s1', { origin: 'self' }));
    const { send } = build();
    const res = await send('POST', '/tasks', { title: '新しい仕事', body: '中身' });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { ok: true; id: string };
    expect(await openIds()).toEqual(['h1', id, 's1']);
    const added = (await stores.tasks.list()).entries.find((entry) => entry.id === id);
    expect(added).toMatchObject({ origin: 'human', status: 'queued', title: '新しい仕事' });
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.humanAction).toBeUndefined();
  });

  it('placement と source（起点の会話）を受ける', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    const res = await send('POST', '/tasks', {
      title: 't',
      body: 'b',
      source: 'conv-1',
      placement: { kind: 'front' },
    });
    const { id } = (await res.json()) as { id: string };
    const list = (await stores.tasks.list()).entries;
    expect(list.map((entry) => entry.id)).toEqual([id, 'a']);
    expect(list[0]).toMatchObject({ source: 'conv-1', originConversationId: 'conv-1' });
  });

  it('origin を本文で渡しても human のまま（本文の origin は読まれない）', async () => {
    const { send } = build();
    const res = await send('POST', '/tasks', { title: 't', body: 'b', origin: 'self' });
    const { id } = (await res.json()) as { id: string };
    expect((await stores.tasks.list()).entries.find((entry) => entry.id === id)?.origin).toBe(
      'human',
    );
  });

  it('基準が開いている task に無い placement は 400 で何も積まない', async () => {
    const { send } = build();
    const res = await send('POST', '/tasks', {
      title: 't',
      body: 'b',
      placement: { kind: 'after', anchorId: 'nope' },
    });
    expect(res.status).toBe(400);
    expect(await openIds()).toEqual([]);
  });

  it.each([
    ['title が空白だけ', { title: '  ', body: 'b' }],
    ['title が改行を含む', { title: 'a\nb', body: 'b' }],
    ['title が長すぎる', { title: 'あ'.repeat(201), body: 'b' }],
    ['body が空', { title: 't', body: '' }],
    ['before に anchorId が無い', { title: 't', body: 'b', placement: { kind: 'before' } }],
  ])('%s は 400', async (_name, payload) => {
    const { send } = build();
    expect((await send('POST', '/tasks', payload)).status).toBe(400);
    expect(await openIds()).toEqual([]);
  });

  it('積む行の humanAction 無し・origin は human（認証を切った構成でも積める）', async () => {
    const { app } = build();
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', body: 'b' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /tasks/:id', () => {
  it('閉じた行も全文で返し、無い id は 404', async () => {
    const long = 'あ'.repeat(5_000);
    await stores.tasks.add(task('a', { body: long }));
    await stores.tasks.setStatus('a', 'done', { reason: '済', by: 'human', at: AT });
    const { send } = build();
    const res = await send('GET', '/tasks/a');
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: Task };
    expect(entry.body).toBe(long);
    expect(entry.status).toBe('done');
    expect((await send('GET', '/tasks/none')).status).toBe(404);
  });

  it('固定のパス /tasks/migration-plan は :id に食われない', async () => {
    const { send } = build();
    const res = await send('GET', '/tasks/migration-plan');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('dryRun', true);
  });
});

describe('POST /tasks/:id/close', () => {
  it('done にし、閉じた記録が human で残る。先の行に印は無く、効いた後の行が task_close を持つ', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    const res = await send('POST', '/tasks/a/close', { status: 'done', reason: '終わった' });
    expect(res.status).toBe(200);
    const row = (await stores.tasks.list({ includeClosed: true })).entries[0];
    expect(row).toMatchObject({
      status: 'done',
      closedReason: '終わった',
      closedBy: 'human',
    });
    const rows = await decisions();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.humanAction).toBeUndefined();
    expect(rows[1]?.humanAction).toMatchObject({ kind: 'task_close', target: 'a' });
  });

  it('cancelled にもできる', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    expect(
      (await send('POST', '/tasks/a/close', { status: 'cancelled', reason: 'やめた' })).status,
    ).toBe(200);
    expect((await stores.tasks.list({ includeClosed: true })).entries[0]?.status).toBe('cancelled');
  });

  it('無い id は 404、既に閉じていれば 409。どちらも日誌は書かない', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.setStatus('a', 'done', { reason: '済', by: 'human', at: AT });
    const { send } = build();
    expect((await send('POST', '/tasks/none/close', { status: 'done', reason: 'r' })).status).toBe(
      404,
    );
    const again = await send('POST', '/tasks/a/close', { status: 'cancelled', reason: 'r' });
    expect(again.status).toBe(409);
    expect(await decisions()).toHaveLength(0);
  });

  it('status は done か cancelled だけ、reason は必須で、違えば 400', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    expect((await send('POST', '/tasks/a/close', { status: 'queued', reason: 'r' })).status).toBe(
      400,
    );
    expect((await send('POST', '/tasks/a/close', { status: 'done' })).status).toBe(400);
    expect((await send('POST', '/tasks/a/close', { status: 'done', reason: ' ' })).status).toBe(
      400,
    );
    expect((await stores.tasks.list()).entries[0]?.status).toBe('queued');
  });

  it('日誌が書けなければ 500 で閉じない', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build(brokenJournal());
    const res = await send('POST', '/tasks/a/close', { status: 'done', reason: 'r' });
    expect(res.status).toBe(500);
    expect((await stores.tasks.list()).entries[0]?.status).toBe('queued');
  });

  it('閉じる直前に割り込まれて拒まれたら、先の行を打ち消して印は付けない', async () => {
    await stores.tasks.add(task('a'));
    const racing: Stores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        setStatus: async (...args: Parameters<Stores['tasks']['setStatus']>) => {
          await stores.tasks.setStatus('a', 'done', { reason: '先に', by: 'human', at: AT });
          return stores.tasks.setStatus(...args);
        },
      },
    };
    const { send } = build(racing);
    const res = await send('POST', '/tasks/a/close', { status: 'cancelled', reason: 'r' });
    expect(res.status).toBe(409);
    const rows = await decisions();
    expect(rows.some((row) => row.humanAction !== undefined)).toBe(false);
    expect(rows).toHaveLength(2);
  });
});

describe('POST /tasks/:id/reopen', () => {
  it('queued へ戻し、閉じた記録を外す。日誌には開き直す前の記録が逐語で残り、印は task_reopen', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.setStatus('a', 'done', { reason: '終わった理由', by: 'clone', at: AT });
    const { send } = build();
    const res = await send('POST', '/tasks/a/reopen', { reason: 'まだ残っていた' });
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: Task };
    expect(entry.status).toBe('queued');
    expect(entry).not.toHaveProperty('closedReason');
    const rows = await decisions();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.humanAction).toBeUndefined();
    expect(rows[0]?.grounds).toContain('終わった理由');
    expect(rows[1]?.grounds).toContain('終わった理由');
    expect(rows[1]?.humanAction).toMatchObject({ kind: 'task_reopen', target: 'a' });
    expect(await openIds()).toEqual(['a']);
  });

  it('閉じていなければ 409、無ければ 404。reason が無ければ 400', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    expect((await send('POST', '/tasks/a/reopen', { reason: 'r' })).status).toBe(409);
    expect((await send('POST', '/tasks/none/reopen', { reason: 'r' })).status).toBe(404);
    expect((await send('POST', '/tasks/a/reopen', {})).status).toBe(400);
    expect(await decisions()).toHaveLength(0);
  });

  it('日誌が書けなければ 500 で閉じたまま', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.setStatus('a', 'done', { reason: '済', by: 'human', at: AT });
    const { send } = build(brokenJournal());
    expect((await send('POST', '/tasks/a/reopen', { reason: 'r' })).status).toBe(500);
    expect((await stores.tasks.list({ includeClosed: true })).entries[0]?.status).toBe('done');
  });
});

describe('POST /tasks/:id/move', () => {
  it('並びを変え、印は task_move。先の行に印は無い', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.add(task('b'));
    const { send } = build();
    const res = await send('POST', '/tasks/b/move', { placement: { kind: 'front' } });
    expect(res.status).toBe(200);
    expect(await openIds()).toEqual(['b', 'a']);
    const rows = await decisions();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.humanAction).toBeUndefined();
    expect(rows[1]?.humanAction).toMatchObject({ kind: 'task_move', target: 'b' });
  });

  it('before / after で相手を指せる', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.add(task('b'));
    await stores.tasks.add(task('c'));
    const { send } = build();
    await send('POST', '/tasks/a/move', { placement: { kind: 'after', anchorId: 'b' } });
    expect(await openIds()).toEqual(['b', 'a', 'c']);
  });

  it('閉じた行は 409、無い id は 404、基準が無い・自分自身は 400。どれも並びは変わらず印は付かない', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.add(task('b'));
    await stores.tasks.add(task('c'));
    await stores.tasks.setStatus('c', 'done', { reason: '済', by: 'human', at: AT });
    const { send } = build();
    expect((await send('POST', '/tasks/c/move', { placement: { kind: 'front' } })).status).toBe(
      409,
    );
    expect((await send('POST', '/tasks/none/move', { placement: { kind: 'front' } })).status).toBe(
      404,
    );
    expect(
      (await send('POST', '/tasks/a/move', { placement: { kind: 'after', anchorId: 'zzz' } }))
        .status,
    ).toBe(400);
    expect(
      (await send('POST', '/tasks/a/move', { placement: { kind: 'after', anchorId: 'a' } })).status,
    ).toBe(400);
    expect(await openIds()).toEqual(['a', 'b']);
    const rows = await decisions();
    expect(rows.some((row) => row.humanAction !== undefined)).toBe(false);
  });

  it('日誌が書けなければ 500 で動かさない', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.add(task('b'));
    const { send } = build(brokenJournal());
    expect((await send('POST', '/tasks/b/move', { placement: { kind: 'front' } })).status).toBe(
      500,
    );
    expect(await openIds()).toEqual(['a', 'b']);
  });
});

describe('PATCH /tasks/:id（title / body の編集）', () => {
  it('human 起点の開いた行の title と body を直す。順位・状態は変わらず、編集前の本文は日誌に逐語で残る。humanAction は付けない', async () => {
    await stores.tasks.add(task('a'));
    await stores.tasks.add(task('b'));
    const { send } = build();
    const res = await send('PATCH', '/tasks/a', { title: '直した題', body: '直した本文' });
    expect(res.status).toBe(200);
    const entries = (await stores.tasks.list()).entries;
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(entries[0]).toMatchObject({ title: '直した題', body: '直した本文', status: 'queued' });
    expect(entries[0]?.editedAt).toBeDefined();
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toContain('aの本文');
    expect(rows[0]?.decision).toContain('直した本文');
    expect(rows[0]?.humanAction).toBeUndefined();
  });

  it('title だけ、body だけでも直せる。どちらも無いのは 400', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    expect((await send('PATCH', '/tasks/a', { body: '本文だけ' })).status).toBe(200);
    const row = (await stores.tasks.list()).entries[0];
    expect(row).toMatchObject({ title: 'a', body: '本文だけ' });
    expect((await send('PATCH', '/tasks/a', {})).status).toBe(400);
  });

  it('human 以外が立てた行は 403、閉じた行は 409、無い id は 404。日誌は書かない', async () => {
    await stores.tasks.add(task('s', { origin: 'self' }));
    await stores.tasks.add(task('d'));
    await stores.tasks.setStatus('d', 'done', { reason: '済', by: 'human', at: AT });
    const { send } = build();
    expect((await send('PATCH', '/tasks/s', { title: 'x' })).status).toBe(403);
    expect((await send('PATCH', '/tasks/d', { title: 'x' })).status).toBe(409);
    expect((await send('PATCH', '/tasks/none', { title: 'x' })).status).toBe(404);
    expect(await decisions()).toHaveLength(0);
  });

  it('ifMatch が読んだ版と違えば 409 で current を返し、何も書かない。合っていれば通る', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build();
    const stale = await send('PATCH', '/tasks/a', {
      title: 'x',
      ifMatch: '1999-01-01T00:00:00.000Z',
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { current: Task };
    expect(conflict.current.id).toBe('a');
    expect((await stores.tasks.list()).entries[0]?.title).toBe('a');
    const fresh = await send('PATCH', '/tasks/a', { title: 'x', ifMatch: AT });
    expect(fresh.status).toBe(200);
    expect((await stores.tasks.list()).entries[0]?.title).toBe('x');
  });

  it('日誌が書けなければ 500 で書き直さない', async () => {
    await stores.tasks.add(task('a'));
    const { send } = build(brokenJournal());
    expect((await send('PATCH', '/tasks/a', { title: 'x' })).status).toBe(500);
    expect((await stores.tasks.list()).entries[0]?.title).toBe('a');
  });
});
