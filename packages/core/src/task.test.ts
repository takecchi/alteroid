import { describe, expect, it } from 'vitest';

import type { TaskStatus } from './schema.js';
import { taskSchema } from './schema.js';
import {
  isTaskClosed,
  placeTask,
  planTaskTransition,
  TASK_RANK_STEP,
  type TaskRankRow,
} from './task.js';
import { verifyTaskStoreContract } from './task-store-contract.js';
import { createMemoryStores } from './testing.js';

const STATUSES: TaskStatus[] = ['queued', 'waiting', 'needs_decision', 'done', 'cancelled'];

describe('Task の状態遷移（planTaskTransition）', () => {
  it('開いている3状態は相互に行き来でき、どれからも done / cancelled へ行ける', () => {
    for (const from of ['queued', 'waiting', 'needs_decision'] as const) {
      for (const to of STATUSES) {
        expect(planTaskTransition(from, to).kind).toBe(from === to ? 'noop' : 'allowed');
      }
    }
  });

  it('done / cancelled からは queued へだけ戻せる', () => {
    for (const from of ['done', 'cancelled'] as const) {
      for (const to of STATUSES) {
        const expected = to === from ? 'noop' : to === 'queued' ? 'allowed' : 'rejected';
        expect(planTaskTransition(from, to).kind, `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('closed の判定は done / cancelled だけ', () => {
    expect(STATUSES.filter(isTaskClosed)).toEqual(['done', 'cancelled']);
  });
});

describe('Task の位置（placeTask）', () => {
  const row = (id: string, rank: number, origin: TaskRankRow['origin'] = 'self'): TaskRankRow => ({
    id,
    rank,
    origin,
  });

  it('空のとき、どの指定でも最初の rank になる', () => {
    expect(placeTask([], undefined, 'human')).toEqual({
      kind: 'placed',
      rank: TASK_RANK_STEP,
      renumber: [],
    });
  });

  it('隣との隙間が尽きたら、既存の行だけを振り直して順序を保つ', () => {
    const a = 1;
    // 隣り合う double: 中点が a か b のどちらかに丸まる
    const b = a + Number.EPSILON;
    const result = placeTask([row('a', a), row('b', b)], { kind: 'after', anchorId: 'a' }, 'self');
    if (result.kind !== 'placed') throw new Error('置けない');
    expect(result.renumber.map((item) => item.id)).toEqual(['a', 'b']);
    const rankOf = (id: string) =>
      result.renumber.find((item) => item.id === id)?.rank ?? result.rank;
    expect(rankOf('a')).toBeLessThan(result.rank);
    expect(result.rank).toBeLessThan(rankOf('b'));
  });

  it('既定の置き場所: human 起点は開いている human 起点の最後の直後（無ければ先頭）、それ以外は末尾', () => {
    const open = [row('s1', 1000), row('h1', 2000, 'human'), row('s2', 3000)];
    const human = placeTask(open, undefined, 'human');
    if (human.kind !== 'placed') throw new Error('置けない');
    expect(human.rank).toBeGreaterThan(2000);
    expect(human.rank).toBeLessThan(3000);

    const noHuman = placeTask([row('s1', 1000)], undefined, 'human');
    if (noHuman.kind !== 'placed') throw new Error('置けない');
    expect(noHuman.rank).toBeLessThan(1000);

    for (const origin of ['self', 'manager', 'external'] as const) {
      const other = placeTask(open, undefined, origin);
      if (other.kind !== 'placed') throw new Error('置けない');
      expect(other.rank, origin).toBeGreaterThan(3000);
    }
  });

  it('無いアンカーは置けない', () => {
    expect(placeTask([row('a', 1)], { kind: 'before', anchorId: 'zz' }, 'self').kind).toBe(
      'anchor-not-found',
    );
  });
});

describe('taskSchema', () => {
  it('originConversationId と keep は任意で、無くても読める', () => {
    const parsed = taskSchema.parse({
      id: 't',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      origin: 'self',
      title: 't',
      body: 'b',
    });
    expect(parsed.originConversationId).toBeUndefined();
    expect(parsed.keep).toBeUndefined();
  });

  it('未知の status の行は読めない（保存層はそれを unreadable に回す）', () => {
    expect(
      taskSchema.safeParse({
        id: 't',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        origin: 'self',
        title: 't',
        body: 'b',
      }).success,
    ).toBe(false);
  });
});

describe('TaskStore の契約（インメモリ。fs / pg にも同じ歯を当てる）', () => {
  it('並び・状態遷移・closed・隙間切れ・NUL の契約', async () => {
    await verifyTaskStoreContract(createMemoryStores().tasks);
  });
});
