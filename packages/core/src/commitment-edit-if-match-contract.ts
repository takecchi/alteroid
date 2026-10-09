import { CommitmentConflictError } from './store.js';
import type { CommitmentStore } from './store.js';

// 空のストアに対して呼ぶこと。
export async function verifyCommitmentEditIfMatchContract(store: CommitmentStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`台帳の器の契約違反（editBody の ifMatch）: ${message}`);
  }
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const id = 'contract-if-match';

  async function conflictOf(run: () => Promise<unknown>): Promise<CommitmentConflictError | null> {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof CommitmentConflictError) return error;
      throw error;
    }
  }

  await store.open({ id, at: t(0), origin: 'human', body: '最初' });

  if (!(await store.editBody(id, '二番目', t(1), 'human', { ifMatch: t(0) }))) {
    fail('いまの版を前提にした editBody が書けない');
  }
  const afterFirst = await store.get(id);
  if (afterFirst?.body !== '二番目' || afterFirst.editedAt !== t(1))
    fail('版が合ったのに書けていない');

  const stale = await conflictOf(() =>
    store.editBody(id, '古い版から', t(2), 'human', { ifMatch: t(0) }),
  );
  if (stale === null) fail('古い版を前提にした editBody が断られない');
  if (stale.current?.body !== '二番目' || stale.current.editedAt !== t(1)) {
    fail('衝突の current が最新の行でない');
  }
  const unchanged = await store.get(id);
  if (unchanged?.body !== '二番目' || unchanged.editedAt !== t(1))
    fail('衝突したのに行が書き換わった');

  if (!(await store.editBody(id, '後勝ち', t(3), 'clone')))
    fail('ifMatch 省略の editBody が断られた');
  if ((await store.get(id))?.body !== '後勝ち') fail('ifMatch 省略の editBody が書けていない');

  const ghost = await conflictOf(() =>
    store.editBody('contract-if-match-ghost', 'x', t(1), 'human', { ifMatch: t(0) }),
  );
  if (ghost === null || ghost.current !== null)
    fail('無い行への版つき editBody が current: null の衝突にならない');
  if (await store.editBody('contract-if-match-ghost', 'x', t(1), 'human')) {
    fail('無い行への ifMatch 省略の editBody が true を返した');
  }

  if (!(await store.close(id, t(4), '片付けた', 'human'))) fail('close が通らない');
  const closedEdit = await store.editBody(id, '閉じた後', t(5), 'human', { ifMatch: t(3) });
  if (closedEdit) fail('片付いた行への版つき editBody が true を返した');
  if ((await store.get(id))?.body !== '後勝ち') fail('片付いた行が書き換わった');

  const raceId = 'contract-if-match-race';
  await store.open({ id: raceId, at: t(0), origin: 'human', body: '競争の前' });
  const edits = [1, 2, 3, 4].map((n) =>
    conflictOf(() => store.editBody(raceId, `編集${n}`, t(n), 'human', { ifMatch: t(0) })),
  );
  const written = (await Promise.all(edits)).filter((result) => result === null).length;
  if (written !== 1)
    fail(`同じ版を前提にした同時の editBody が ${written} 件通った（1件だけのはず）`);

  await store.clear();
}
