import {
  createCloneTools,
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
} from '@alteroid/core';
import type { CloneHost, JournalEntry, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// POST /commitments/close-many（#5336）。クローンの道具 `commitment_close_many` と検証・絞り込み・塊ごとの閉じ方を共有し、日誌の順序だけは `POST /commitments/:id/close` と同じ（先に書き、書けなければ閉じない）

const AT = '2026-10-19T00:00:00.000Z';
const ORIGIN_EXTERNAL = ['external'];

function setup(stores: Stores = createMemoryStores()) {
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
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { stores, call };
}

async function openMany(stores: Stores, ids: readonly string[]) {
  for (const [index, id] of ids.entries()) {
    await stores.commitments.open({
      id,
      at: new Date(Date.parse(AT) + index * 1000).toISOString(),
      origin: 'external',
      source: 'github',
      body: `本文 ${id}`,
    });
  }
}

async function decisionRows(
  stores: Stores,
): Promise<Extract<JournalEntry, { type: 'decision' }>[]> {
  const rows = await stores.journal.list({ types: ['decision'], order: 'asc' });
  return rows.flatMap((row) => (row.type === 'decision' ? [row] : []));
}

// 日誌の append だけを落とす
function storesWithFailingJournal(): Stores {
  const base = createMemoryStores();
  return {
    ...base,
    journal: {
      ...base.journal,
      append: async () => {
        throw new Error('journal down');
      },
    },
  };
}

async function openIds(stores: Stores): Promise<string[]> {
  return (await stores.commitments.list()).entries.map((entry) => entry.id);
}

describe('POST /commitments/close-many: 試算（dryRun 既定 true）', () => {
  it('dryRun を省略すると 1件も閉じず、対象の件数・id・抜粋を返し、日誌も書かない', async () => {
    const { stores, call } = setup();
    await openMany(stores, ['a', 'b', 'c']);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '片付いた',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      matched: 3,
      targeted: 3,
      closed: 0,
      chunks: 0,
      remaining: 0,
      ids: ['a', 'b', 'c'],
      idsOmitted: 0,
      funnel: { open: 3, origin: 3 },
    });
    expect(body.samples).toEqual([
      { id: 'a', at: AT, origin: 'external', source: 'github', bodyExcerpt: '本文 a' },
      expect.objectContaining({ id: 'b' }),
      expect.objectContaining({ id: 'c' }),
    ]);
    expect(await openIds(stores)).toEqual(['a', 'b', 'c']);
    expect(await decisionRows(stores)).toEqual([]);
  });

  it('dryRun: true を明示しても同じで、何も閉じない', async () => {
    const { stores, call } = setup();
    await openMany(stores, ['a']);
    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '片付いた',
      dryRun: true,
    });
    expect(((await response.json()) as { dryRun: boolean }).dryRun).toBe(true);
    expect(await openIds(stores)).toEqual(['a']);
  });
});

describe('POST /commitments/close-many: 実行（dryRun: false）', () => {
  it('絞り込みに当たる未了だけを古い側から閉じ、closedBy は human、他の起点・出所の行は閉じない', async () => {
    const { stores, call } = setup();
    await openMany(stores, ['old', 'mid', 'new']);
    await stores.commitments.open({ id: 'mine', at: AT, origin: 'human', body: '人間の依頼' });
    await stores.commitments.open({
      id: 'other-source',
      at: AT,
      origin: 'external',
      source: 'sentry',
      body: '別の出所',
    });

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      source: ['github'],
      reason: '解消済み',
      dryRun: false,
      limit: 2,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      dryRun: false,
      matched: 3,
      targeted: 2,
      closed: 2,
      chunks: 1,
      remaining: 1,
      ids: ['old', 'mid'],
      raced: 0,
    });
    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    const closed = all.filter((entry) => entry.closedAt !== undefined);
    expect(closed.map((entry) => entry.id).sort()).toEqual(['mid', 'old']);
    for (const entry of closed) {
      expect(entry.closedBy).toBe('human');
      expect(entry.closedReason).toBe('解消済み');
    }
    expect((await openIds(stores)).sort()).toEqual(['mine', 'new', 'other-source']);
  });

  it('塊ごとに、先の行（印なし）→ 閉じる → 効いた後の行（印あり・件数入り）の順で日誌を残す', async () => {
    const { stores, call } = setup();
    // 1塊に収まらない長さの id にして、塊が2つ以上になるようにする
    const ids = Array.from(
      { length: 60 },
      (_, i) => `${String(i).padStart(2, '0')}-${'x'.repeat(97)}`,
    );
    await openMany(stores, ids);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: 'まとめて片付けた',
      dryRun: false,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      closed: number;
      chunks: number;
      ids: string[];
      idsOmitted: number;
    };
    expect(body.closed).toBe(60);
    expect(body.chunks).toBeGreaterThanOrEqual(2);
    expect(body.ids).toHaveLength(20);
    expect(body.idsOmitted).toBe(40);
    expect(await openIds(stores)).toEqual([]);

    const rows = await decisionRows(stores);
    const before = rows.filter((row) =>
      row.decision.startsWith('人間が引き受けた仕事を絞り込みで一括して片付ける（'),
    );
    const after = rows.filter((row) =>
      row.decision.startsWith('人間が引き受けた仕事を絞り込みで一括して片付けた（'),
    );
    expect(before).toHaveLength(body.chunks);
    expect(after).toHaveLength(body.chunks);
    // 印は効いた後の行だけが持ち、塊ごとに1行
    expect(before.every((row) => row.humanAction === undefined)).toBe(true);
    expect(after.every((row) => row.humanAction?.kind === 'commitment_close')).toBe(true);
    // 件数は文に入り、対象は塊の先頭の id
    const total = after.reduce((sum, row) => {
      const match = /この塊は (\d+) 件/u.exec(row.decision);
      return sum + Number(match?.[1] ?? 0);
    }, 0);
    expect(total).toBe(60);
    expect(after[0]?.humanAction?.target).toBe(ids[0]);
    expect(after[0]?.decision).toContain(`閉じた id: ${ids[0]}`);
    expect(after[0]?.decision).toContain('絞り込み: origin=[external]');
    // 全 id が塊ごとの日誌に残る（応答は先頭 20 件だけ）
    const journaledIds = after.flatMap(
      (row) => row.decision.split('閉じた id: ')[1]?.split(' ') ?? [],
    );
    expect(journaledIds.sort()).toEqual([...ids].sort());
    // 先の行が先に書かれている（時系列で、同じ塊の先の行が後の行より前）
    expect(rows[0]?.decision.startsWith('人間が引き受けた仕事を絞り込みで一括して片付ける（')).toBe(
      true,
    );
  });

  it('閉じる瞬間には、その塊の先の行が日誌に既に在る（順序）', async () => {
    const stores = createMemoryStores();
    await openMany(stores, ['a']);
    let seenAtClose: string[] = [];
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        closeMany: async (...args: Parameters<Stores['commitments']['closeMany']>) => {
          seenAtClose = (await decisionRows(stores)).map((row) => row.decision);
          return stores.commitments.closeMany(...args);
        },
      },
    };
    const { call } = setup(wrapped);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '片付いた',
      dryRun: false,
    });

    expect(response.status).toBe(200);
    expect(seenAtClose).toHaveLength(1);
    expect(seenAtClose[0]).toContain(
      '人間が引き受けた仕事を絞り込みで一括して片付ける（1/1 塊目、この塊は 1 件）: 片付いた',
    );
  });

  it('0件に当たる絞り込みは 200 で何も閉じず、どの段で0になったかを funnel が言う', async () => {
    const { stores, call } = setup();
    await openMany(stores, ['a']);
    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      source: ['無い出所'],
      reason: '片付いた',
      dryRun: false,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      closed: 0,
      matched: 0,
      funnel: { open: 1, origin: 1, source: 0 },
    });
    expect(await decisionRows(stores)).toEqual([]);
  });
});

describe('POST /commitments/close-many: 断る入力は 400 で、1件も閉じない（文言はクローンの道具と同じ）', () => {
  function toolText(stores: Stores, args: Record<string, unknown>): Promise<string> {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const found = tools.find((entry) => entry.name === 'commitment_close_many');
    if (!found) throw new Error('commitment_close_many が無い');
    return found
      .handler(args as never, {})
      .then((result) =>
        (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join(''),
      );
  }

  const base = { origin: ORIGIN_EXTERNAL, reason: '片付いた', dryRun: false };
  const cases: [string, Record<string, unknown>, string][] = [
    ['origin が空', { ...base, origin: [] }, 'origin は使えない'],
    [
      '在る起点を全部並べた',
      { ...base, origin: ['human', 'manager', 'external', 'self'] },
      '全部（human / manager / external / self）並べた呼びは断る',
    ],
    [
      'reason が空白だけ',
      { ...base, reason: ' \t　' },
      'reason は使えない（空白だけの値は空と同じ',
    ],
    ['reason が NUL だけ', { ...base, reason: '\u0000' }, 'reason は使えない'],
    ['until に時差が無い', { ...base, until: '2026-10-19T00:00:00' }, 'until'],
    ['source が空配列', { ...base, source: [] }, 'source は使えない'],
    ['source の要素が NUL だけ', { ...base, source: ['\u0000'] }, 'source は使えない'],
    ['q が NUL だけ', { ...base, q: '\u0000' }, 'q は使えない'],
    ['limit が 0', { ...base, limit: 0 }, 'limit 0 は使えない'],
    ['limit が上限超え', { ...base, limit: 2001 }, 'limit 2001 は使えない'],
    ['limit が小数', { ...base, limit: 1.5 }, 'limit 1.5 は使えない'],
  ];

  it.each(cases)('%s', async (_name, args, fragment) => {
    const { stores, call } = setup();
    await openMany(stores, ['a']);

    const response = await call('POST', '/commitments/close-many', args);

    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(fragment);
    // 道具が返す断り文と1文字も違わない
    expect(error).toBe(await toolText(stores, args));
    expect(await openIds(stores)).toEqual(['a']);
    expect(await decisionRows(stores)).toEqual([]);
  });

  it('origin を渡さない・reason を渡さない本文は 400（形の不正）', async () => {
    const { stores, call } = setup();
    await openMany(stores, ['a']);
    expect((await call('POST', '/commitments/close-many', { reason: 'x' })).status).toBe(400);
    expect(
      (await call('POST', '/commitments/close-many', { origin: ORIGIN_EXTERNAL })).status,
    ).toBe(400);
    expect(await openIds(stores)).toEqual(['a']);
  });
});

describe('POST /commitments/close-many: :id の close と衝突しない', () => {
  it('id が close-many の行も POST /commitments/close-many/close で1件閉じられ、一括の口は一括のまま動く', async () => {
    const { stores, call } = setup();
    await stores.commitments.open({
      id: 'close-many',
      at: AT,
      origin: 'human',
      body: '紛らわしい id',
    });
    await openMany(stores, ['a']);

    const single = await call('POST', '/commitments/close-many/close', { reason: '1件' });
    expect(single.status).toBe(200);
    expect((await stores.commitments.get('close-many'))?.closedAt).toBeDefined();
    expect(await openIds(stores)).toEqual(['a']);

    const bulk = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: 'まとめて',
      dryRun: false,
    });
    expect(bulk.status).toBe(200);
    expect(await bulk.json()).toMatchObject({ closed: 1, ids: ['a'] });
  });

  it('1件を閉じる口は従来どおり（id の close は一括の口に取られない）', async () => {
    const { stores, call } = setup();
    await openMany(stores, ['a']);
    const response = await call('POST', '/commitments/a/close', { reason: '1件' });
    expect(response.status).toBe(200);
    expect((await stores.commitments.get('a'))?.closedBy).toBe('human');
  });
});

describe('POST /commitments/close-many: 日誌が書けないとき・閉じられなかったとき', () => {
  it('先の日誌が書けないときは 500 で、1件も閉じない', async () => {
    const stores = storesWithFailingJournal();
    await openMany(stores, ['a', 'b']);
    const { call } = setup(stores);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '片付いた',
      dryRun: false,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: 'journal_write_failed',
      closed: 0,
      closedIds: [],
    });
    expect(await openIds(stores)).toEqual(['a', 'b']);
  });

  it('2つ目の塊の先の日誌が書けなければ、そこで止め、1つ目の塊は閉じたまま 500 で何を閉じたかを返す', async () => {
    const base = createMemoryStores();
    let appended = 0;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (...args: Parameters<Stores['journal']['append']>) => {
          appended += 1;
          // 1塊目の先の行（1）と後の行（2）は通し、2塊目の先の行（3）で落とす
          if (appended === 3) throw new Error('journal down');
          return base.journal.append(...args);
        },
      },
    };
    const ids = Array.from(
      { length: 60 },
      (_, i) => `${String(i).padStart(2, '0')}-${'x'.repeat(97)}`,
    );
    await openMany(stores, ids);
    const { call } = setup(stores);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '片付いた',
      dryRun: false,
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; closed: number; closedIds: string[] };
    expect(body.code).toBe('journal_write_failed');
    expect(body.closed).toBeGreaterThan(0);
    expect(body.closed).toBeLessThan(60);
    expect((await openIds(stores)).length).toBe(60 - body.closed);
    expect(body.closedIds).toEqual(ids.slice(0, body.closed));
  });

  it('closeMany が1件も閉じなかった塊は、先の行を打ち消す行を足し、印の付いた行は無い', async () => {
    const stores = createMemoryStores();
    await openMany(stores, ['a', 'b']);
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        closeMany: async (ids: readonly string[], ...rest: [string, string, 'human']) => {
          // 読んだ後・閉じる前に別の手が先に閉じた
          await stores.commitments.closeMany(
            ids,
            '2026-10-20T00:00:00.000Z',
            '先に閉じた',
            'clone',
          );
          return stores.commitments.closeMany(ids, ...rest);
        },
      } as Stores['commitments'],
    };
    const { call } = setup(wrapped);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '遅れた人間',
      dryRun: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ closed: 0, chunks: 0, raced: 2 });
    const rows = await decisionRows(stores);
    expect(rows.map((row) => row.decision)).toEqual([
      expect.stringContaining(
        '人間が引き受けた仕事を絞り込みで一括して片付ける（1/1 塊目、この塊は 2 件）',
      ),
      expect.stringContaining('直前の引き受けた仕事を絞り込みで一括して片付けるの行は効いていない'),
    ]);
    expect(rows.every((row) => row.humanAction === undefined)).toBe(true);
    expect((await stores.commitments.get('a'))?.closedBy).toBe('clone');
  });

  it('一部だけ閉じられた塊は、閉じた id だけを効いた後の行に書き、閉じなかった id を打ち消す', async () => {
    const stores = createMemoryStores();
    await openMany(stores, ['a', 'b']);
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        closeMany: async (ids: readonly string[], ...rest: [string, string, 'human']) => {
          await stores.commitments.closeMany(
            ['a'],
            '2026-10-20T00:00:00.000Z',
            '先に閉じた',
            'clone',
          );
          return stores.commitments.closeMany(ids, ...rest);
        },
      } as Stores['commitments'],
    };
    const { call } = setup(wrapped);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '遅れた人間',
      dryRun: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ closed: 1, chunks: 1, raced: 1, ids: ['b'] });
    const rows = await decisionRows(stores);
    const marked = rows.filter((row) => row.humanAction !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.humanAction?.target).toBe('b');
    expect(marked[0]?.decision).toContain('この塊は 1 件');
    expect(
      rows.some(
        (row) =>
          row.decision.includes('1 件は効いていない（閉じていない）') &&
          row.decision.includes('閉じていない id: a'),
      ),
    ).toBe(true);
  });

  it('closeMany が投げたときは打ち消しの行を足して 500（閉じていない）', async () => {
    const stores = createMemoryStores();
    await openMany(stores, ['a']);
    const wrapped: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        closeMany: async () => {
          throw new Error('store down');
        },
      },
    };
    const { call } = setup(wrapped);

    const response = await call('POST', '/commitments/close-many', {
      origin: ORIGIN_EXTERNAL,
      reason: '片付いた',
      dryRun: false,
    });

    expect(response.status).toBe(500);
    expect(await openIds(stores)).toEqual(['a']);
    const rows = await decisionRows(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.decision).toContain('の行は効いていない（変えていない）');
    expect(rows[1]?.decision).not.toContain('store down');
    expect(rows.every((row) => row.humanAction === undefined)).toBe(true);
  });
});
