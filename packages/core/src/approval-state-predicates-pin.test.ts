import { describe, expect, it } from 'vitest';

import { traceApproval } from './approval-trace.js';
import type { PendingApproval } from './schema.js';
import { createMemoryStores } from './testing.js';

// 承認の状態（未回答・回答済・取り下げ）を見る判定の、いまの端の振る舞いを固定する（現状の挙動を固定。まとめる PR で見直す）。
// 本番コードは変えない。状態は `answeredAt` と `withdrawnAt` の有無の組み合わせで決まり、両方立った行（回答の後で取り下げた・取り下げの後に回答が届いた）が端になる。

const AT = '2026-10-29T00:00:00.000Z';
const LATER = '2026-10-29T01:00:00.000Z';

const SHAPES = {
  neither: {},
  answered: { answeredAt: AT, answer: 'はい' },
  withdrawn: { withdrawnAt: AT, withdrawnReason: '不要になった' },
  both: { answeredAt: AT, answer: 'はい', withdrawnAt: LATER, withdrawnReason: '不要になった' },
} as const satisfies Record<string, Partial<PendingApproval>>;

type Shape = keyof typeof SHAPES;
const SHAPE_NAMES = Object.keys(SHAPES) as Shape[];

function approval(id: string, shape: Shape): PendingApproval {
  return { id, createdAt: AT, question: `q-${id}`, ...SHAPES[shape] };
}

describe('承認の状態 × 組み合わせ（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('approval-trace.ts traceApproval の state: 両方立った行は withdrawn（取り下げが先）', async () => {
    const stores = createMemoryStores();
    for (const shape of SHAPE_NAMES) await stores.jobs.putApproval(approval(shape, shape));
    const states: Record<string, string | undefined> = {};
    for (const shape of SHAPE_NAMES) {
      states[shape] = (await traceApproval(stores, shape))?.state;
    }
    expect(states).toEqual({
      neither: 'unanswered',
      // 回答済みで、日誌に回答のターンの開始が無い行（この試験は日誌を空にしている）。回答のターンがあれば別の状態になる
      answered: 'no_turn_start',
      withdrawn: 'withdrawn',
      both: 'withdrawn',
    });
  });

  it('testing.ts（メモリ実装）listApprovals({ pendingOnly: true }): どちらも立っていない行だけ。両方立った行は載らない', async () => {
    const stores = createMemoryStores();
    for (const shape of SHAPE_NAMES) await stores.jobs.putApproval(approval(shape, shape));
    const pending = (await stores.jobs.listApprovals({ pendingOnly: true })).entries.map(
      (a) => a.id,
    );
    expect(pending).toEqual(['neither']);
    const all = (await stores.jobs.listApprovals({ pendingOnly: false })).entries.map((a) => a.id);
    expect(all.sort()).toEqual([...SHAPE_NAMES].sort());
  });
});
