import type { CloneHost, JournalEntry, Stores } from '@alteroid/core';
import {
  createMemoryStores,
  MemoryConflictError,
  memoryVersion,
  PracticeConflictError,
  practiceVersion,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// 人間が API から直接した取り消し・書き換え（台帳を閉じる・やり方の書き直しと削除・記憶の削除）は、
// 状態を変える前に日誌へ先の行を書く（#5243）。先の行は humanAction を持たず、効いた後の行だけが持つ。

const JSON_HEADERS = { 'content-type': 'application/json' };

let stores: Stores;

function fakeClone(): CloneHost {
  return {
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: { list: () => Promise.resolve([]) },
  } as unknown as CloneHost;
}

function appOver(over: Stores) {
  return createApp({
    clone: fakeClone(),
    stores: over,
    token: 'test-token',
    shutdown: () => undefined,
  });
}

async function journalRows(): Promise<JournalEntry[]> {
  return stores.journal.list({ order: 'asc' });
}

function decisionTexts(rows: JournalEntry[]): string[] {
  return rows.flatMap((row) => (row.type === 'decision' ? [row.decision] : []));
}

function humanActionRows(rows: JournalEntry[]): JournalEntry[] {
  return rows.filter((row) => row.type === 'decision' && row.humanAction !== undefined);
}

beforeEach(() => {
  stores = createMemoryStores();
});

describe('台帳を閉じる（POST /commitments/:id/close）', () => {
  async function openOne(): Promise<string> {
    await stores.commitments.open({
      id: 'cm-undo-1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'human',
      body: '閉じる対象',
    });
    return 'cm-undo-1';
  }

  it('閉じる瞬間には、先の行が日誌に既に在る（順序）', async () => {
    const id = await openOne();
    let seenAtClose: string[] = [];
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        close: async (...args: Parameters<Stores['commitments']['close']>) => {
          seenAtClose = decisionTexts(await journalRows());
          return stores.commitments.close(...args);
        },
      },
    };
    const res = await appOver(wrapped).request(`/commitments/${id}/close`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ reason: '片付いた' }),
    });
    expect(res.status).toBe(200);
    expect(seenAtClose).toEqual([`人間が引き受けた仕事を片付ける（${id}）: 片付いた`]);
    // 印は効いた後の行だけ
    const marked = humanActionRows(await journalRows());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      decision: `人間が引き受けた仕事を片付けた（${id}）: 片付いた`,
    });
  });

  it('close が false（読んだ後に閉じられた）なら、打ち消しの行を足し、印の付いた行は無い', async () => {
    const id = await openOne();
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        close: async (...args: Parameters<Stores['commitments']['close']>) => {
          // 読んだ後・閉じる前に別の手が閉じた
          await stores.commitments.close(id, '2026-01-02T00:00:00.000Z', '先に閉じた', 'clone');
          return stores.commitments.close(...args);
        },
      },
    };
    const res = await appOver(wrapped).request(`/commitments/${id}/close`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ reason: '遅れた人間' }),
    });
    expect(res.status).toBe(409);
    const rows = await journalRows();
    expect(decisionTexts(rows)).toEqual([
      `人間が引き受けた仕事を片付ける（${id}）: 遅れた人間`,
      expect.stringContaining('直前の引き受けた仕事を片付けるの行は効いていない'),
    ]);
    expect(humanActionRows(rows)).toEqual([]);
  });

  it('既に閉じている行は、日誌を書かずに 409', async () => {
    const id = await openOne();
    await stores.commitments.close(id, '2026-01-02T00:00:00.000Z', '先に閉じた', 'clone');
    const res = await appOver(stores).request(`/commitments/${id}/close`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ reason: '二度目' }),
    });
    expect(res.status).toBe(409);
    expect(await journalRows()).toEqual([]);
  });
});

describe('やり方（PUT・DELETE /practices/:slug）', () => {
  it('書き直す瞬間には、先の行が日誌に既に在り、先の行に印は無い（順序）', async () => {
    await stores.practices.write({ slug: 'p1', kind: 'k', title: '題', content: '旧' });
    let seenAtWrite: JournalEntry[] = [];
    const wrapped: Stores = {
      ...stores,
      practices: {
        ...stores.practices,
        write: async (...args: Parameters<Stores['practices']['write']>) => {
          seenAtWrite = await journalRows();
          return stores.practices.write(...args);
        },
      },
    };
    const res = await appOver(wrapped).request('/practices/p1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'k', title: '新題', content: '新' }),
    });
    expect(res.status).toBe(200);
    expect(decisionTexts(seenAtWrite)).toEqual(['人間がやり方 p1（k）を書き直す: 新題']);
    expect(humanActionRows(seenAtWrite)).toEqual([]);
    expect(humanActionRows(await journalRows())).toHaveLength(1);
  });

  it('書き直しが競合したら、打ち消しの行を足し、印の付いた行は無い', async () => {
    const written = await stores.practices.write({
      slug: 'p1',
      kind: 'k',
      title: '題',
      content: '旧',
    });
    const wrapped: Stores = {
      ...stores,
      practices: {
        ...stores.practices,
        write: () => Promise.reject(new PracticeConflictError('p1', written)),
      },
    };
    const res = await appOver(wrapped).request('/practices/p1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'k', title: '新題', content: '新' }),
    });
    expect(res.status).toBe(409);
    const rows = await journalRows();
    expect(decisionTexts(rows)).toHaveLength(2);
    expect(decisionTexts(rows)[1]).toContain('直前のやり方を書き直すの行は効いていない');
    expect(humanActionRows(rows)).toEqual([]);
  });

  it('読んだ版が既に合わない PUT は、日誌を書かずに 409', async () => {
    await stores.practices.write({ slug: 'p1', kind: 'k', title: '題', content: '旧' });
    const res = await appOver(stores).request('/practices/p1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'k', title: '新題', content: '新', ifMatch: 'stale' }),
    });
    expect(res.status).toBe(409);
    expect(await journalRows()).toEqual([]);
  });

  it('新しく置く PUT は、今までどおり書いた後に印なしの行を1行だけ残す', async () => {
    const res = await appOver(stores).request('/practices/fresh', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'k', title: '題', content: '本文' }),
    });
    expect(res.status).toBe(200);
    const rows = await journalRows();
    expect(rows).toHaveLength(1);
    expect(humanActionRows(rows)).toEqual([]);
  });

  it('消す瞬間には、先の行が日誌に既に在り、先の行に印は無い（順序）', async () => {
    const p = await stores.practices.write({ slug: 'p2', kind: 'k', title: '題', content: '本文' });
    let seenAtRemove: JournalEntry[] = [];
    const wrapped: Stores = {
      ...stores,
      practices: {
        ...stores.practices,
        remove: async (...args: Parameters<Stores['practices']['remove']>) => {
          seenAtRemove = await journalRows();
          return stores.practices.remove(...args);
        },
      },
    };
    const res = await appOver(wrapped).request(
      `/practices/p2?ifMatch=${encodeURIComponent(practiceVersion(p))}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(decisionTexts(seenAtRemove)).toEqual(['人間がやり方 p2（k）を消す: 題']);
    expect(humanActionRows(seenAtRemove)).toEqual([]);
    expect(humanActionRows(await journalRows())).toHaveLength(1);
  });

  it('消すのが競合したら、打ち消しの行を足し、印の付いた行は無い', async () => {
    const p = await stores.practices.write({ slug: 'p2', kind: 'k', title: '題', content: '本文' });
    const wrapped: Stores = {
      ...stores,
      practices: {
        ...stores.practices,
        remove: () => Promise.reject(new PracticeConflictError('p2', p)),
      },
    };
    const res = await appOver(wrapped).request(
      `/practices/p2?ifMatch=${encodeURIComponent(practiceVersion(p))}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(409);
    const rows = await journalRows();
    expect(decisionTexts(rows)).toHaveLength(2);
    expect(decisionTexts(rows)[1]).toContain('直前のやり方を消すの行は効いていない');
    expect(humanActionRows(rows)).toEqual([]);
  });

  it('版が既に合わない DELETE は、日誌を書かずに 409', async () => {
    await stores.practices.write({ slug: 'p2', kind: 'k', title: '題', content: '本文' });
    const res = await appOver(stores).request('/practices/p2?ifMatch=stale', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await journalRows()).toEqual([]);
  });
});

describe('記憶の削除（DELETE /memory/:slug）', () => {
  it('消す瞬間には、先の行が日誌に既に在り、先の行は memory_update ではなく decision（順序）', async () => {
    await stores.persona.write('m1', '# 本文\n');
    let seenAtRemove: JournalEntry[] = [];
    const wrapped: Stores = {
      ...stores,
      persona: Object.assign(Object.create(stores.persona) as Stores['persona'], {
        remove: async (...args: Parameters<Stores['persona']['remove']>) => {
          seenAtRemove = await journalRows();
          return stores.persona.remove(...args);
        },
      }),
    };
    const res = await appOver(wrapped).request(`/memory/m1?ifMatch=${memoryVersion('# 本文\n')}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(seenAtRemove.map((row) => row.type)).toEqual(['decision']);
    expect(decisionTexts(seenAtRemove)).toEqual(['人間が記憶 m1 を消す']);
    // 効いた後の行は今までどおり memory_update（remove）
    const rows = await journalRows();
    expect(rows.map((row) => row.type)).toEqual(['decision', 'memory_update']);
    expect(rows[1]).toMatchObject({ cause: 'human', action: 'remove', slug: 'm1' });
  });

  it('消すのが競合したら、打ち消しの行を足し、memory_update の行は残らない', async () => {
    await stores.persona.write('m1', '# 本文\n');
    const doc = await stores.persona.read('m1');
    const wrapped: Stores = {
      ...stores,
      persona: Object.assign(Object.create(stores.persona) as Stores['persona'], {
        remove: () => Promise.reject(new MemoryConflictError('m1', doc)),
      }),
    };
    const res = await appOver(wrapped).request(`/memory/m1?ifMatch=${memoryVersion('# 本文\n')}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    const rows = await journalRows();
    expect(rows.map((row) => row.type)).toEqual(['decision', 'decision']);
    expect(decisionTexts(rows)[1]).toContain('直前の記憶を消すの行は効いていない');
  });

  it('版が既に合わない DELETE は、日誌を書かずに 409。版なしは 428 で日誌を書かない', async () => {
    await stores.persona.write('m1', '# 本文\n');
    const before = (await journalRows()).length;
    const stale = await appOver(stores).request('/memory/m1?ifMatch=stale', { method: 'DELETE' });
    expect(stale.status).toBe(409);
    const missing = await appOver(stores).request('/memory/m1', { method: 'DELETE' });
    expect(missing.status).toBe(428);
    expect((await journalRows()).length).toBe(before);
    expect(await stores.persona.read('m1')).not.toBeNull();
  });
});
