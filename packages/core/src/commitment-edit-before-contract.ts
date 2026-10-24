import type { CommitmentStore } from './store.js';

// 空のストアに対して呼ぶこと。
// `editBody` が返す `before` が、書き換えと同じ排他の中で読んだ行（実際に上書きした本文）であることを測る（#5251）。
export async function verifyCommitmentEditBeforeContract(store: CommitmentStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`台帳の器の契約違反（editBody の before）: ${message}`);
  }
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const id = 'contract-edit-before';

  await store.open({ id, at: t(0), origin: 'human', body: '最初' });

  // 読んだ後に別の書き手が本文を変えても、before は読んだ行ではなく上書きした行になる
  const stale = await store.get(id);
  if (stale?.body !== '最初') fail('開いた行が読めない');
  const other = await store.editBody(id, '別の書き手', t(1), 'human');
  if (other.kind !== 'edited') fail('別の書き手の editBody が通らない');
  if (other.before.body !== '最初') fail(`before が上書き前の本文でない: ${other.before.body}`);
  const mine = await store.editBody(id, '最後', t(2), 'clone');
  if (mine.kind !== 'edited') fail('editBody が通らない');
  if (mine.before.body !== '別の書き手') {
    fail(`before が先に読んだ本文のまま（上書きした本文は「別の書き手」）: ${mine.before.body}`);
  }
  if (mine.before.editedAt !== t(1) || mine.before.editedBy !== 'human') {
    fail('before の editedAt / editedBy が上書き前の行のものでない');
  }
  if ((await store.get(id))?.body !== '最後') fail('書けていない');

  // 書けなかったときは before を持たない
  if (!(await store.close(id, t(3), '片付けた', 'human'))) fail('close が通らない');
  if ((await store.editBody(id, '閉じた後', t(4), 'human')).kind !== 'not-edited') {
    fail('片付いた行への editBody が not-edited でない');
  }

  // 同時の書き直し: 各 before は、直前に書かれた本文でなければならない（本文の連鎖が切れない）。
  // 排他の外で読んだ行を返す実装は、同じ本文を2つの before が指して連鎖が切れる。
  const raceId = 'contract-edit-before-race';
  await store.open({ id: raceId, at: t(0), origin: 'human', body: '競争の前' });
  const bodies = [1, 2, 3, 4].map((n) => `編集${n}`);
  const results = await Promise.all(
    bodies.map((body, i) => store.editBody(raceId, body, t(i + 1), 'human')),
  );
  const befores: string[] = [];
  for (const result of results) {
    if (result.kind !== 'edited') fail('同時の editBody が通らない');
    befores.push(result.before.body);
  }
  const last = (await store.get(raceId))?.body;
  if (last === undefined) fail('同時の書き直しの後に行が読めない');
  const written = ['競争の前', ...bodies].sort().join(',');
  const observed = [...befores, last].sort().join(',');
  if (written !== observed) {
    fail(
      `同時の editBody の before が連鎖していない（書いた本文: ${written}、before と最後: ${observed}）`,
    );
  }

  await store.clear();
}
