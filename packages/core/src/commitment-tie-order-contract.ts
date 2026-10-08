import type { CommitmentStore } from './store.js';

// vitest に依存しない素の関数にする: storage-fs と storage-pg が core を実行時の依存として読むため。空のストアに対して呼ぶ: 他の行が混ざると意図が読みにくくなるため
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

  const sameClosedAt = '2026-01-04T00:00:00.000Z';
  for (const id of ['c', 'd'])
    if (!(await store.close(id, sameClosedAt, '片付けた', 'clone'))) fail(`close(${id}) が false`);
  const closedIds = async (): Promise<string> =>
    (await store.list({ includeClosed: true })).entries
      .filter((entry) => entry.closedAt !== undefined)
      .map((entry) => entry.id)
      .join(',');
  const expectClosed = async (expected: string, when: string): Promise<void> => {
    const actual = await closedIds();
    if (actual !== expected) fail(`${when}（期待: ${expected}、実際: ${actual}）`);
  };
  await expectClosed('a,c,d,e,b', '閉じた側の同じ closedAt が入れた順（昇順）でない');
  if (await store.editBody('c', '閉じた後の直し', '2026-01-05T00:00:00.000Z', 'clone'))
    fail('閉じた行の editBody が true を返した');
  await expectClosed('a,c,d,e,b', '閉じた行を直そうとした後に閉じた側の並びが変わった');
}
