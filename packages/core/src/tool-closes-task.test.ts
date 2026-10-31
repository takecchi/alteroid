import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSendResult } from './manager.js';
import type { Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, failingJournalAppend } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_send` / `journal_write` の任意引数 `closes`: Task の id を受け取り、本来の作業が通ったときだけ、同じ呼びの中でその Task を done にする（#5923。台帳の行ではない）。
// 閉じるかどうかは常にクローンが決める（省略したときは何も閉じない）

const AT = '2026-10-07T00:00:00.000Z';

function harness(options: { stores?: Stores; send?: ManagerSendResult } = {}) {
  const stores = options.stores ?? createMemoryStores();
  const sent: string[] = [];
  const managers = {
    async send(_managerId: string, message: string) {
      sent.push(message);
      return options.send ?? { outcome: 'delivered' as const, detail: '届けた。' };
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers,
  });
  return {
    stores,
    sent,
    isError: false,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      this.isError = result.isError === true;
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

function seeded(id: string): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status: 'queued',
    origin: 'self',
    title: `タイトル ${id}`,
    body: `本文 ${id}`,
  };
}

async function open(stores: Stores, id: string) {
  await stores.tasks.add(seeded(id));
}

async function statusOf(stores: Stores, id: string) {
  return (await stores.tasks.get(id))?.status;
}

async function closeJournalRows(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['decision'] });
  return rows.map((row) => JSON.stringify(row)).filter((row) => row.includes('→ done'));
}

describe.each([
  ['manager_send', { managerId: 'mgr-1', message: '続けて' }],
  ['journal_write', { decision: '判断した', grounds: '根拠' }],
] as const)('%s の closes（Task の id）', (tool, base) => {
  it('closes を省くと何も閉じず、応答に closes の行も出ない', async () => {
    const h = harness();
    await open(h.stores, 't1');
    const out = await h.call(tool, { ...base });
    expect(out).not.toContain('closes');
    expect(await statusOf(h.stores, 't1')).toBe('queued');
  });

  it('本来の作業が通ったら Task を done にし、理由・主体を残し、日誌に残り、応答の末尾に id ごとの結果が出る', async () => {
    const h = harness();
    await open(h.stores, 't1');
    await open(h.stores, 't2');
    const out = await h.call(tool, {
      ...base,
      closes: [
        { id: 't1', reason: '済んだ' },
        { id: 't2', reason: '別の理由' },
      ],
    });
    expect(out).toContain('closes t1:');
    expect(out).toContain('closes t2:');
    const t1 = await h.stores.tasks.get('t1');
    expect(t1?.status).toBe('done');
    expect(t1?.closedReason).toBe('済んだ');
    expect(t1?.closedBy).toBe('clone');
    expect((await h.stores.tasks.get('t2'))?.closedReason).toBe('別の理由');
    expect(await closeJournalRows(h.stores)).toHaveLength(2);
  });

  it('既に閉じた id・存在しない id は応答に出るが、本来の作業は成功のまま', async () => {
    const h = harness();
    await open(h.stores, 't1');
    await h.stores.tasks.setStatus('t1', 'done', { reason: '先に閉じた', by: 'clone', at: AT });
    const out = await h.call(tool, {
      ...base,
      closes: [
        { id: 't1', reason: '済んだ' },
        { id: 'ghost', reason: '済んだ' },
      ],
    });
    expect(out).toContain('closes t1: t1 は既に');
    expect(out).toContain('closes ghost: task ghost は無い');
    if (tool === 'manager_send') expect(h.sent).toEqual(['続けて']);
    expect(await closeJournalRows(h.stores)).toHaveLength(0);
    expect((await h.stores.tasks.get('t1'))?.closedReason).toBe('先に閉じた');
  });

  it('上限（5件）を超えたら、本来の作業もせず断る。5件ちょうどは通る', async () => {
    const h = harness();
    const closes = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, reason: '済んだ' }));
    for (const entry of closes) await open(h.stores, entry.id);
    const out = await h.call(tool, { ...base, closes });
    expect(out).toContain('closes は使えない');
    expect(out).toContain('何もしていない');
    expect(h.sent).toEqual([]);
    for (const entry of closes) expect(await statusOf(h.stores, entry.id)).toBe('queued');

    await h.call(tool, { ...base, closes: closes.slice(0, 5) });
    for (const entry of closes.slice(0, 5)) expect(await statusOf(h.stores, entry.id)).toBe('done');
  });

  it.each([' ', '', '\u0000'])('reason %j は断り、何もしない', async (reason) => {
    const h = harness();
    await open(h.stores, 't1');
    const out = await h.call(tool, { ...base, closes: [{ id: 't1', reason }] });
    expect(out).toContain('reason は使えない');
    expect(out).toContain('何もしていない');
    expect(h.sent).toEqual([]);
    expect(await statusOf(h.stores, 't1')).toBe('queued');
  });

  it('日誌の grounds に、どの呼びで閉じたかを書く', async () => {
    const h = harness();
    await open(h.stores, 't1');
    await h.call(tool, { ...base, closes: [{ id: 't1', reason: '済んだ' }] });
    const rows = await closeJournalRows(h.stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('t1');
    expect(rows[0]).toContain(`${tool} の closes`);
  });
});

describe('本来の作業が通らなかったら、1件も閉じない', () => {
  it.each([
    ['held', { outcome: 'held', detail: '保留した。' }],
    ['session_missing', { outcome: 'session_missing', detail: 'セッションが無い。' }],
    ['declined', { outcome: 'declined', detail: '断られた。' }],
    ['unknown', { outcome: 'unknown', detail: 'そんな id は無い。' }],
  ] as const)('manager_send が %s のとき', async (_name, send) => {
    const h = harness({ send: send as ManagerSendResult });
    await open(h.stores, 't1');
    const out = await h.call('manager_send', {
      managerId: 'mgr-1',
      message: '続けて',
      closes: [{ id: 't1', reason: '済んだ' }],
    });
    expect(out).toContain('1行も閉じていない');
    expect(await statusOf(h.stores, 't1')).toBe('queued');
  });

  it('journal_write の書き込みが落ちたとき（投げる。Task は閉じない）', async () => {
    const base = createMemoryStores();
    await open(base, 't1');
    const h = harness({ stores: failingJournalAppend(base, '書けない') });
    await expect(
      h.call('journal_write', {
        decision: '判断した',
        grounds: '根拠',
        closes: [{ id: 't1', reason: '済んだ' }],
      }),
    ).rejects.toThrow();
    expect(await statusOf(base, 't1')).toBe('queued');
  });
});

describe('閉じた後に日誌が書けなかったら、握り潰さず isError で事実どおり返す', () => {
  it('journal_write: 本体の書き込みは済んでいて、閉じた後の日誌が落ちると isError', async () => {
    const base = createMemoryStores();
    await open(base, 't1');
    let appends = 0;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          appends += 1;
          if (appends > 1) throw new Error('書けない');
          return base.journal.append(entry);
        },
      },
    };
    const h = harness({ stores });
    const out = await h.call('journal_write', {
      decision: '判断した',
      grounds: '根拠',
      closes: [{ id: 't1', reason: '済んだ' }],
    });
    expect(out).toContain('日誌に記録した');
    expect(out).toContain('**task は done にしている**');
    expect(h.isError).toBe(true);
    expect(await statusOf(base, 't1')).toBe('done');
  });

  it('成功時は isError ではない', async () => {
    const h = harness();
    await open(h.stores, 't1');
    await h.call('journal_write', {
      decision: '判断した',
      grounds: '根拠',
      closes: [{ id: 't1', reason: '済んだ' }],
    });
    expect(h.isError).toBe(false);
  });
});
