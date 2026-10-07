import { ScheduleConflictError } from './store.js';
import type { ScheduleStore } from './store.js';

/**
 * `ScheduleStore` の前提の版（`ifMatch`。Issue #3821）の契約を、実装1つに対して測る。
 * fs / pg / インメモリの3つが同じ関数を呼ぶ（`practice-contract.ts` の 9b と同じ形）。
 * 版は `ScheduledRequest.updatedAt`。**時計は呼び出し側が渡す文字列で動かす**（実時間の待ちは使わない）。
 */
export async function verifyScheduleIfMatchContract(store: ScheduleStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`予定の器の契約違反（ifMatch）: ${message}`);
  }
  const kind = 'contract-if-match';
  const spec = { type: 'daily' as const, at: '09:00' };
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

  async function conflictOf(run: () => Promise<unknown>): Promise<ScheduleConflictError | null> {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof ScheduleConflictError) return error;
      throw error;
    }
  }

  // 無いものへ `ifMatch: null` で作れる。2回目（もう在る）は衝突で、何も書き換わらない。
  const entry = { kind, spec, request: '最初', createdAt: t(0), updatedAt: t(0) };
  if ((await conflictOf(() => store.put(entry, { ifMatch: null }))) !== null) {
    fail('ifMatch: null が、無い kind への初回の書き込みで断られた');
  }
  const dup = await conflictOf(() =>
    store.put({ ...entry, request: '二番目', updatedAt: t(1) }, { ifMatch: null }),
  );
  if (dup === null) fail('ifMatch: null が、在る kind への書き込みを断らない');
  if (dup.current?.request !== '最初') fail('衝突の current が、いまの依頼ではない');
  if ((await store.get(kind))?.request !== '最初') fail('衝突したのに本文が書き換わった');
  // editRequest も、`ifMatch: null` は在る kind を断る。無い kind では従来どおり null。
  const nullEdit = await conflictOf(() =>
    store.editRequest(kind, { request: '三番目', spec }, t(2), { ifMatch: null }),
  );
  if (nullEdit === null) fail('editRequest の ifMatch: null が、在る kind を断らない');
  if (
    (await store.editRequest('contract-if-match-ghost', { request: 'x', spec }, t(2), {
      ifMatch: null,
    })) !== null
  ) {
    fail('無い kind への editRequest(ifMatch: null) が null を返さない');
  }

  // 無い kind へ版つき（文字列）は、「読んだ後に消された」衝突（current は null）。
  const ghostEdit = await conflictOf(() =>
    store.editRequest('contract-if-match-ghost', { request: 'x', spec }, t(2), { ifMatch: t(0) }),
  );
  if (ghostEdit === null || ghostEdit.current !== null) {
    fail('無い kind への版つき editRequest が、current: null の衝突にならない');
  }
  const ghostPut = await conflictOf(() =>
    store.put(
      { kind: 'contract-if-match-ghost', spec, request: 'x', createdAt: t(0), updatedAt: t(0) },
      { ifMatch: t(0) },
    ),
  );
  if (ghostPut === null || ghostPut.current !== null) {
    fail('無い kind への版つき put が、current: null の衝突にならない');
  }
  if ((await store.get('contract-if-match-ghost')) !== null) fail('衝突したのに行ができている');

  // 読んだ版つきなら書ける。書くと版（updatedAt）が進む。
  const v1 = (await store.get(kind))?.updatedAt;
  if (v1 !== t(0)) fail(`読んだ版が updatedAt でない: ${v1}`);
  const second = await store.editRequest(kind, { request: '二番目', spec }, t(1), { ifMatch: v1 });
  if (second?.request !== '二番目' || second.updatedAt !== t(1)) {
    fail('いまの版を前提にした editRequest が書けない');
  }

  // 発火（claimRun / completeRun）では版が動かない。挟んでも、読んだ版で書ける。
  const claimed = await store.claimRun(kind, t(1), t(3), 'schedule');
  if (claimed === null) fail('claimRun が通らない');
  await store.completeRun(kind, t(3), 'schedule');
  if ((await store.get(kind))?.updatedAt !== t(1)) fail('発火で updatedAt（版）が動いた');
  const afterRun = await store.editRequest(kind, { request: '発火の後', spec }, t(4), {
    ifMatch: t(1),
  });
  if (afterRun?.request !== '発火の後') fail('発火を挟むと、読んだ版で書けなくなった');
  if (afterRun.lastScheduledRunAt !== t(3)) fail('版つきの編集が発火の印を消した');

  // 古い版（t(1)）を前提にした書き込みは、書かずに衝突する（editRequest / put のどちらも）。
  const stale = await conflictOf(() =>
    store.editRequest(kind, { request: '古い版から', spec }, t(5), { ifMatch: t(1) }),
  );
  if (stale === null) fail('古い版を前提にした editRequest が断られない');
  if (stale.current?.request !== '発火の後') fail('衝突の current が最新でない');
  const stalePut = await conflictOf(() =>
    store.put(
      { kind, spec, request: '古い版から', createdAt: t(0), updatedAt: t(5) },
      { ifMatch: t(1) },
    ),
  );
  if (stalePut === null) fail('古い版を前提にした put が断られない');
  if ((await store.get(kind))?.request !== '発火の後') fail('衝突したのに本文が書き換わった');

  // 版つきの put は、合っていれば置き換える。
  await store.put(
    { kind, spec, request: 'putで置換', createdAt: t(0), updatedAt: t(6) },
    { ifMatch: t(4) },
  );
  if ((await store.get(kind))?.request !== 'putで置換') fail('いまの版を前提にした put が書けない');

  // 省略は従来どおり後勝ち（クローンの道具・CLI を壊さない）。
  const last = await store.editRequest(kind, { request: '後勝ち', spec }, t(7));
  if (last?.request !== '後勝ち')
    fail('ifMatch 省略の editRequest が断られた（後勝ちでなくなった）');
  await store.put({ kind, spec, request: '後勝ちput', createdAt: t(0), updatedAt: t(8) });
  if ((await store.get(kind))?.request !== '後勝ちput') fail('ifMatch 省略の put が書けない');

  // 同時の書き込みは、照合と書き込みが1つの排他の中にあるので、ちょうど1つだけが通る。
  await store.remove(kind);
  const racers = [1, 2, 3, 4].map((n) =>
    conflictOf(() =>
      store.put(
        { kind, spec, request: `競争${n}`, createdAt: t(0), updatedAt: t(n) },
        { ifMatch: null },
      ),
    ),
  );
  const created = (await Promise.all(racers)).filter((result) => result === null).length;
  if (created !== 1) fail(`同時の ifMatch: null の作成が ${created} 件通った（1件だけのはず）`);
  const base = await store.get(kind);
  if (base === null) fail('競争の後に行が無い');
  const edits = [1, 2, 3, 4].map((n) =>
    conflictOf(() =>
      store.editRequest(kind, { request: `編集${n}`, spec }, t(n + 4), { ifMatch: base.updatedAt }),
    ),
  );
  const edited = (await Promise.all(edits)).filter((result) => result === null).length;
  if (edited !== 1)
    fail(`同じ版を前提にした同時の editRequest が ${edited} 件通った（1件だけのはず）`);

  await store.remove(kind);
}
