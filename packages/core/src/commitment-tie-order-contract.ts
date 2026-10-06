import type { CommitmentStore } from './store.js';

/**
 * `CommitmentStore.list` の**同じ `at` の未了の行の並び**の契約を、実装1つに対して測る（issue #3285）。
 *
 * **同じ時刻の行は入れた順（`open` した順）に並ぶ。** 台帳は未了を `at` の古い順に見せるが、
 * `at` はミリ秒精度で、同じ時刻の行は実在する。in-memory と fs は安定整列なので入れた順のまま
 * だが、pg は `order by at` だけでは同順位の決め手が無く、行を書き直す（`editBody` / `close`
 * ——`jsonb_set` は別のタプルを作る）と物理順が変わって並びが入れ替わった。決め手は pg の
 * `commitments.seq`（挿入順の列）で、この契約が3実装で同じ並びを測る。
 *
 * 他の契約と同じく vitest に依存しない素の非同期関数にしてある（`commitment-fold-contract.ts`
 * の doc）。**空のストアに対して呼ぶこと**（他の行が混ざっても相対順は測れるが、
 * 意図が読みにくくなる）。
 *
 * ## 測ること
 *
 * 1. 同じ `at` の3行 a, b, c を開くと、未了は a, b, c
 * 2. `editBody('a')` の後も a, b, c（本文は直っている）
 * 3. `close('b')` の後は a, c（残りの相対順が変わらない）
 * 4. 続けて d, e を同じ `at` で開き、`closeMany([a, e])` の後は c, d
 *
 * ⛔ **閉じた側（`closedAt` 降順）の同じ時刻の並びは、この契約では測らない** — 決め方が
 * まだ決まっていない（#3285）。
 */
export async function verifyCommitmentTieOrderContract(store: CommitmentStore): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`CommitmentStore.list の同時刻の並びの契約違反: ${message}`);
  };
  const at = '2026-01-01T00:00:00.000Z';
  const row = (id: string) => ({ id, at, origin: 'self', body: `body ${id}` }) as const;
  const ids = async (): Promise<string> =>
    (await store.list()).entries.map((entry) => entry.id).join(',');
  const expectIds = async (expected: string, when: string): Promise<void> => {
    const actual = await ids();
    if (actual !== expected) fail(`${when}（期待: ${expected}、実際: ${actual}）`);
  };

  for (const id of ['a', 'b', 'c']) await store.open(row(id));
  await expectIds('a,b,c', '同じ at の行が入れた順でない');

  if (!(await store.editBody('a', '直した', '2026-01-02T00:00:00.000Z', 'clone')))
    fail('editBody が false を返した');
  await expectIds('a,b,c', 'editBody の後に並びが変わった');

  if (!(await store.close('b', '2026-01-03T00:00:00.000Z', '片付けた', 'clone')))
    fail('close が false を返した');
  await expectIds('a,c', 'close の後に残りの並びが変わった');

  for (const id of ['d', 'e']) await store.open(row(id));
  await expectIds('a,c,d,e', '閉じた後に開いた行が末尾に来ていない');
  const closed = await store.closeMany(['a', 'e'], '2026-01-04T00:00:00.000Z', '片付けた', 'clone');
  if ([...closed].sort().join(',') !== 'a,e') fail(`closeMany の戻りが違う（${closed.join(',')}）`);
  await expectIds('c,d', 'closeMany の後に残りの並びが変わった');
}
