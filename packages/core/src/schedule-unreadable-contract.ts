import { UnreadableScheduleError } from './store.js';
import type { ScheduleStore } from './store.js';

/**
 * `ScheduleStore` の「在るが読めない行」への書き込み系の契約を、実装1つに対して測る（Issue #3859）。
 *
 * **契約:** 読めない行（`scheduledRequestSchema` に合わない。版ずれ・手編集）の kind に対し、
 * `editRequest`（`ifMatch` の有無・null・文字列を問わず）・`claimRun`（版が何であれ）・
 * `ifMatch` つきの `put`（null・文字列のどちらも）は、「無い」（`null`）にも版の衝突
 * （`ScheduleConflictError`）にも数えず `UnreadableScheduleError` を投げ、行は書き換えない。
 * `ifMatch` 省略の `put`（無条件の上書き）は従来どおり読めない行を置き換えられ、`remove` /
 * `removeIfPresent` は読めない行を外せる（#1944 / #1982。壊れた行を直す・外す口は塞がない）。
 *
 * **読めない行は `put` では作れない**（`scheduledRequestSchema` で断る）ので、呼ぶ側が実装ごとの手
 * （fs はファイルへ書く、pg は行を直に挿す）で作る関数を `plantUnreadableRow` として渡す。
 * **インメモリ実装（`testing.ts`）はこの契約の対象外**——`put` が形を断り行は private な `Map` に
 * しか入らないので、読めない行を持てない（`ScheduleStore.get` の doc）。
 */
export async function verifyScheduleUnreadableContract(
  store: ScheduleStore,
  plantUnreadableRow: (kind: string) => Promise<void>,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`予定の器の契約違反（読めない行）: ${message}`);
  }
  const bad = 'contract-unreadable';
  const good = 'contract-unreadable-good';
  const spec = { type: 'daily' as const, at: '09:00' };
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

  async function outcomeOf(run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (error) {
      return error;
    }
  }
  function describeOutcome(outcome: unknown): string {
    return outcome instanceof Error ? `${outcome.name}` : JSON.stringify(outcome);
  }
  async function expectUnreadable(label: string, run: () => Promise<unknown>): Promise<void> {
    const outcome = await outcomeOf(run);
    if (!(outcome instanceof UnreadableScheduleError) || outcome.kind !== bad) {
      fail(`${label} が UnreadableScheduleError（kind 付き）でない: ${describeOutcome(outcome)}`);
    }
  }
  async function expectStillUnreadable(label: string): Promise<void> {
    await expectUnreadable(`${label}の後の get`, () => store.get(bad));
    const listed = await store.list();
    if (!listed.unreadable.some((row) => row.kind === bad)) {
      fail(`${label}の後、読めない行が list().unreadable から消えた`);
    }
  }

  await store.put({ kind: good, spec, request: '読める行', createdAt: t(0), updatedAt: t(0) });
  await plantUnreadableRow(bad);

  // 編集は、版つきでも版なしでも「読めない」と断る（null にも衝突にもしない）。
  await expectUnreadable('editRequest（ifMatch 省略）', () =>
    store.editRequest(bad, { request: 'x', spec }, t(1)),
  );
  await expectUnreadable('editRequest（ifMatch: null）', () =>
    store.editRequest(bad, { request: 'x', spec }, t(1), { ifMatch: null }),
  );
  await expectUnreadable('editRequest（ifMatch: 文字列）', () =>
    store.editRequest(bad, { request: 'x', spec }, t(1), { ifMatch: t(0) }),
  );
  // 発火の引き受けも、版が何であれ「読めない」（null＝消された、と取り違えない）。
  await expectUnreadable('claimRun', () => store.claimRun(bad, t(0), t(2), 'schedule'));
  await expectUnreadable('claimRun（別の版）', () => store.claimRun(bad, t(9), t(2), 'manual'));
  // 版つきの put も、読めない行を「無い」側に数えて上書きしない。
  await expectUnreadable('put（ifMatch: null）', () =>
    store.put(
      { kind: bad, spec, request: 'x', createdAt: t(1), updatedAt: t(1) },
      { ifMatch: null },
    ),
  );
  await expectUnreadable('put（ifMatch: 文字列）', () =>
    store.put(
      { kind: bad, spec, request: 'x', createdAt: t(1), updatedAt: t(1) },
      { ifMatch: t(0) },
    ),
  );
  await expectStillUnreadable('断られた書き込み');

  // 読めない行が在っても、読める行の操作は変わらない。
  if ((await store.claimRun(good, t(0), t(2), 'schedule'))?.kind !== good) {
    fail('読めない行が在ると、読める行の claimRun が通らない');
  }
  if ((await store.editRequest(good, { request: '直した', spec }, t(3)))?.request !== '直した') {
    fail('読めない行が在ると、読める行の editRequest が通らない');
  }
  // 無い kind は従来どおり null。
  if (
    (await store.editRequest('contract-unreadable-ghost', { request: 'x', spec }, t(1))) !== null
  ) {
    fail('無い kind への editRequest が null を返さない');
  }

  // 外す口は塞がない（#1944 / #1982）。
  if ((await store.removeIfPresent(bad)) !== 'unreadable') {
    fail('removeIfPresent が読めない行を unreadable として外さない');
  }
  if ((await store.get(bad)) !== null) fail('外した後も行が残っている');

  // 無条件の put（ifMatch 省略）は、読めない行を置き換えられる（直す口）。
  await plantUnreadableRow(bad);
  await store.put({ kind: bad, spec, request: '直した後', createdAt: t(4), updatedAt: t(4) });
  if ((await store.get(bad))?.request !== '直した後')
    fail('ifMatch 省略の put が読めない行を置き換えない');

  // remove も同じ。
  await plantUnreadableRow(bad);
  await store.remove(bad);
  if ((await store.get(bad)) !== null) fail('remove が読めない行を外さない');

  await store.remove(good);
}
