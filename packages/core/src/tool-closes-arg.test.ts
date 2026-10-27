import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSendResult } from './manager.js';
import { UnreadableCommitmentError, type Stores } from './store.js';
import { createMemoryStores, failingJournalAppend } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_send` / `journal_write` の任意引数 `closes`: 本来の作業が通ったときだけ、同じ呼びの中で台帳の行を閉じる。
// 閉じるかどうかは常にクローンが決める（省略したときは従来どおり、何も閉じない）

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

async function open(stores: Stores, id: string) {
  await stores.commitments.open({ id, at: AT, origin: 'self', body: `本文 ${id}` });
}

async function closeJournalRows(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['decision'] });
  return rows.map((row) => JSON.stringify(row)).filter((row) => row.includes('自分で片付けた'));
}

describe.each([
  ['manager_send', { managerId: 'mgr-1', message: '続けて' }],
  ['journal_write', { decision: '判断した', grounds: '根拠' }],
] as const)('%s の closes', (tool, base) => {
  it('closes を省くと従来どおりで、何も閉じず、応答に closes の行も出ない', async () => {
    const h = harness();
    await open(h.stores, 'c1');
    const out = await h.call(tool, { ...base });
    expect(out).not.toContain('closes');
    expect((await h.stores.commitments.get('c1'))?.closedAt).toBeUndefined();
  });

  it('本来の作業が通ったら閉じ、日誌に残り、応答の末尾に id ごとの結果が出る', async () => {
    const h = harness();
    await open(h.stores, 'c1');
    await open(h.stores, 'c2');
    const out = await h.call(tool, {
      ...base,
      closes: [
        { id: 'c1', reason: '済んだ' },
        { id: 'c2', reason: 'やらないと決めた' },
      ],
    });
    expect(out).toContain('closes c1: c1 を片付けた。');
    expect(out).toContain('closes c2: c2 を片付けた。');
    expect((await h.stores.commitments.get('c1'))?.closedReason).toBe('済んだ');
    expect((await h.stores.commitments.get('c2'))?.closedReason).toBe('やらないと決めた');
    expect(await closeJournalRows(h.stores)).toHaveLength(2);
  });

  it('既に閉じた id・存在しない id は応答に出るが、本来の作業は成功のまま', async () => {
    const h = harness();
    await open(h.stores, 'c1');
    await h.stores.commitments.close('c1', AT, '先に閉じた', 'clone');
    const out = await h.call(tool, {
      ...base,
      closes: [
        { id: 'c1', reason: '済んだ' },
        { id: 'ghost', reason: '済んだ' },
      ],
    });
    expect(out).toContain('closes c1: c1 は既に');
    expect(out).toContain('closes ghost: 引き受けた仕事 ghost は台帳に無い');
    if (tool === 'manager_send') expect(h.sent).toEqual(['続けて']);
    expect(await closeJournalRows(h.stores)).toHaveLength(0);
  });

  it('上限（5件）を超えたら、本来の作業もせず断る', async () => {
    const h = harness();
    const closes = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, reason: '済んだ' }));
    for (const entry of closes) await open(h.stores, entry.id);
    const out = await h.call(tool, { ...base, closes });
    expect(out).toContain('closes は使えない');
    expect(out).toContain('何もしていない');
    expect(h.sent).toEqual([]);
    for (const entry of closes) {
      expect((await h.stores.commitments.get(entry.id))?.closedAt).toBeUndefined();
    }
    if (tool === 'journal_write') {
      expect(await h.stores.journal.list({ types: ['decision'] })).toHaveLength(0);
    }
  });

  it('5件ちょうどは通る', async () => {
    const h = harness();
    const closes = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, reason: '済んだ' }));
    for (const entry of closes) await open(h.stores, entry.id);
    await h.call(tool, { ...base, closes });
    for (const entry of closes) {
      expect((await h.stores.commitments.get(entry.id))?.closedAt).toBeDefined();
    }
  });

  it.each([' ', '', '\u0000'])(
    'reason %j は commitment_close と同じく断り、何もしない',
    async (reason) => {
      const h = harness();
      await open(h.stores, 'c1');
      const out = await h.call(tool, { ...base, closes: [{ id: 'c1', reason }] });
      expect(out).toContain('reason は使えない');
      expect(out).toContain('何もしていない');
      expect(h.sent).toEqual([]);
      expect((await h.stores.commitments.get('c1'))?.closedAt).toBeUndefined();
    },
  );

  it('読めない行も commitment_close と同じく閉じられ、その旨が出る', async () => {
    const stores = createMemoryStores();
    const baseCommitments = stores.commitments;
    const closed: string[] = [];
    const h = harness({
      stores: {
        ...stores,
        commitments: {
          ...baseCommitments,
          get: async (id: string) => {
            throw new UnreadableCommitmentError(`${id} は読めない形で入っている`);
          },
          close: async (id: string) => {
            closed.push(id);
            return true;
          },
        },
      },
    });
    const out = await h.call(tool, { ...base, closes: [{ id: 'bad', reason: '済んだ' }] });
    expect(out).toContain('closes bad: bad（読めない形で入っていた仕事）を片付けた。');
    expect(closed).toEqual(['bad']);
    expect(await closeJournalRows(h.stores)).toHaveLength(1);
  });

  it('commitment_close と同じ言い方で返る（本体を共有している）', async () => {
    const viaClose = harness();
    await open(viaClose.stores, 'c1');
    const direct = await viaClose.call('commitment_close', { id: 'c1', reason: '済んだ' });
    const viaCloses = harness();
    await open(viaCloses.stores, 'c1');
    const out = await viaCloses.call(tool, { ...base, closes: [{ id: 'c1', reason: '済んだ' }] });
    expect(out).toContain(`closes c1: ${direct}`);
  });
});

describe('本来の作業が通らなかったら、1行も閉じない', () => {
  it.each([
    ['held', { outcome: 'held', detail: '保留した。' }],
    ['session_missing', { outcome: 'session_missing', detail: 'セッションが無い。' }],
    ['declined', { outcome: 'declined', detail: '断られた。' }],
    ['unknown', { outcome: 'unknown', detail: 'そんな id は無い。' }],
  ] as const)('manager_send が %s のとき', async (_name, send) => {
    const h = harness({ send: send as ManagerSendResult });
    await open(h.stores, 'c1');
    const out = await h.call('manager_send', {
      managerId: 'mgr-1',
      message: '続けて',
      closes: [{ id: 'c1', reason: '済んだ' }],
    });
    expect(out).toContain('1行も閉じていない');
    expect((await h.stores.commitments.get('c1'))?.closedAt).toBeUndefined();
    expect(await closeJournalRows(h.stores)).toHaveLength(0);
  });

  it('manager_send の早い断り（message が空）のとき', async () => {
    const h = harness();
    await open(h.stores, 'c1');
    const out = await h.call('manager_send', {
      managerId: 'mgr-1',
      message: '',
      closes: [{ id: 'c1', reason: '済んだ' }],
    });
    expect(out).toContain('message は使えない');
    expect(out).toContain('1行も閉じていない');
    expect((await h.stores.commitments.get('c1'))?.closedAt).toBeUndefined();
  });

  it('journal_write の書き込みが落ちたとき（投げる。台帳は閉じない）', async () => {
    const base = createMemoryStores();
    await open(base, 'c1');
    const h = harness({ stores: failingJournalAppend(base, '書けない') });
    await expect(
      h.call('journal_write', {
        decision: '判断した',
        grounds: '根拠',
        closes: [{ id: 'c1', reason: '済んだ' }],
      }),
    ).rejects.toThrow();
    expect((await base.commitments.get('c1'))?.closedAt).toBeUndefined();
  });
});

describe('閉じた後に日誌が書けなかったら、握り潰さず isError で事実どおり返す', () => {
  it('manager_send: 送信は済んでいる（先頭に残る）。行は閉じている・日誌に無い・isError', async () => {
    const base = createMemoryStores();
    await open(base, 'c1');
    const stores = failingJournalAppend(base, '書けない');
    const h = harness({ stores, send: { outcome: 'delivered', detail: '届けた。' } });
    const out = await h.call('manager_send', {
      managerId: 'mgr-1',
      message: '続けて',
      closes: [{ id: 'c1', reason: '済んだ' }],
    });
    expect(h.sent).toEqual(['続けて']);
    expect(out).toContain('届けた。');
    expect(out).toContain('closes c1: **台帳の行は閉じている**が、日誌に残せていない');
    expect(out).not.toContain('commitment_close を');
    expect(h.isError).toBe(true);
    expect((await base.commitments.get('c1'))?.closedAt).toBeDefined();
    expect(await closeJournalRows(base)).toHaveLength(0);
  });

  it('journal_write: 本体の書き込みは済んでいて、閉じた後の日誌が落ちると isError', async () => {
    const base = createMemoryStores();
    await open(base, 'c1');
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
      closes: [{ id: 'c1', reason: '済んだ' }],
    });
    expect(out).toContain('日誌に記録した');
    expect(out).toContain('**台帳の行は閉じている**');
    expect(h.isError).toBe(true);
    expect((await base.commitments.get('c1'))?.closedAt).toBeDefined();
    expect(await closeJournalRows(base)).toHaveLength(0);
  });

  it('成功時は isError ではない', async () => {
    const h = harness();
    await open(h.stores, 'c1');
    await h.call('journal_write', {
      decision: '判断した',
      grounds: '根拠',
      closes: [{ id: 'c1', reason: '済んだ' }],
    });
    expect(h.isError).toBe(false);
  });
});

describe('閉じた呼びを日誌の grounds に書く', () => {
  async function groundsOfClose(stores: Stores): Promise<string> {
    const rows = await stores.journal.list({ types: ['decision'] });
    const row = rows.find((r) => JSON.stringify(r).includes('自分で片付けた')) as
      { decision: string; grounds: string } | undefined;
    return `${row?.decision}|${row?.grounds}`;
  }

  it.each([
    ['commitment_close', 'commitment_close', { id: 'c1', reason: '済んだ' }],
    [
      'manager_send',
      'manager_send の closes',
      { managerId: 'mgr-1', message: '続けて', closes: [{ id: 'c1', reason: '済んだ' }] },
    ],
    [
      'journal_write',
      'journal_write の closes',
      { decision: 'd', grounds: 'g', closes: [{ id: 'c1', reason: '済んだ' }] },
    ],
  ])('%s で閉じた回は grounds に「%s」と書く（decision の形は同じ）', async (tool, via, args) => {
    const h = harness();
    await open(h.stores, 'c1');
    await h.call(tool, args);
    const got = await groundsOfClose(h.stores);
    expect(got).toContain('引き受けた仕事を自分で片付けた（c1）: 済んだ');
    expect(got).toContain(`クローン自身が ${via} で閉じた`);
  });
});
