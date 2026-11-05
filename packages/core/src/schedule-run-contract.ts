import type { ScheduleStore } from './store.js';

/**
 * `ScheduleStore` の発火の印（`claimRun` / `completeRun`）と本文の編集（`editRequest`）の契約。
 * 版の前提（ifMatch）・NUL・読めない行は別の契約が持つので、ここは「行がどう変わるか」だけを測る。
 */
export async function verifyScheduleRunContract(store: ScheduleStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`予定の器の契約違反（発火の印・編集）: ${message}`);
  }
  const kind = 'contract-run';
  const other = 'contract-run-other';
  const spec = { type: 'daily' as const, at: '09:00' };
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const fired = '2026-01-02T00:00:00.000Z';
  const plan = { kind, spec, request: '最初の依頼', createdAt: t(0), updatedAt: t(0) };

  async function reset(): Promise<void> {
    await store.removeIfPresent(kind);
    await store.removeIfPresent(other);
    await store.put(plan);
  }

  // claimRun: 返るのは更新前の姿。行には lastRunAt と pendingRun が入り、版と定期の基準は動かない
  await reset();
  await store.put({ ...plan, kind: other, request: '別の依頼' });
  const claimed = await store.claimRun(kind, t(0), fired, 'schedule');
  if (claimed === null) fail('claimRun が通らない');
  if (claimed.request !== plan.request) fail('claimRun が返したのが更新前の依頼でない');
  if (claimed.lastRunAt !== undefined || claimed.pendingRun !== undefined) {
    fail('claimRun が返した姿に、発火の印が先に載っている（更新前の姿のはず）');
  }
  const held = await store.get(kind);
  if (held?.lastRunAt !== fired) fail('claimRun が lastRunAt を進めない');
  if (held.pendingRun?.at !== fired || held.pendingRun.cause !== 'schedule') {
    fail('claimRun が pendingRun を立てない');
  }
  if (held.updatedAt !== t(0)) fail('claimRun が updatedAt（版）を動かした');
  if (held.lastScheduledRunAt !== undefined) {
    fail('claimRun が定期の基準 lastScheduledRunAt を進めた（進めるのは completeRun）');
  }
  const untouched = await store.get(other);
  if (untouched?.lastRunAt !== undefined || untouched?.pendingRun !== undefined) {
    fail('claimRun が別の kind の行に印を立てた');
  }
  if ((await store.list()).entries.filter((entry) => entry.kind === kind).length !== 1) {
    fail('claimRun で同じ kind の行が増減した');
  }

  // completeRun: 別の発火の印は消さない
  await store.completeRun(kind, t(9), 'schedule');
  const stillHeld = await store.get(kind);
  if (stillHeld?.pendingRun?.at !== fired) fail('別の発火の completeRun が、いまの印を消した');
  if (stillHeld.lastScheduledRunAt !== undefined) {
    fail('別の発火の completeRun が、定期の基準を進めた');
  }

  // completeRun: 定期の発火は印を消して定期の基準を進める
  await store.completeRun(kind, fired, 'schedule');
  const done = await store.get(kind);
  if (done?.pendingRun !== undefined) fail('completeRun が pendingRun を消さない');
  if (done?.lastScheduledRunAt !== fired)
    fail('定期の completeRun が lastScheduledRunAt を進めない');
  if (done.lastRunAt !== fired) fail('completeRun が lastRunAt を動かした');
  if (done.updatedAt !== t(0)) fail('completeRun が updatedAt（版）を動かした');

  // completeRun: 印の無い行・無い kind は何もしない（投げず、行も作らない）
  await store.completeRun(kind, fired, 'schedule');
  await store.completeRun('contract-run-ghost', fired, 'schedule');
  if ((await store.get('contract-run-ghost')) !== null)
    fail('completeRun が無い kind の行を作った');

  // 手動の発火: 観測用の lastRunAt だけを進め、定期の基準は動かさない
  await reset();
  await store.claimRun(kind, t(0), fired, 'manual');
  if ((await store.get(kind))?.pendingRun?.cause !== 'manual') {
    fail('claimRun が cause を pendingRun に残さない');
  }
  await store.completeRun(kind, fired, 'manual');
  const manual = await store.get(kind);
  if (manual?.pendingRun !== undefined) fail('手動の completeRun が pendingRun を消さない');
  if (manual?.lastRunAt !== fired) fail('手動の発火で lastRunAt が進まない');
  if (manual.lastScheduledRunAt !== undefined) {
    fail('手動の completeRun が定期の基準 lastScheduledRunAt を進めた');
  }

  // 古い版・消えた行・無い kind では印を立てない
  await reset();
  if ((await store.claimRun('contract-run-ghost', t(0), fired, 'schedule')) !== null) {
    fail('無い kind への claimRun が null を返さない');
  }
  await store.put({ ...plan, request: '人間が直した依頼', updatedAt: t(1) });
  if ((await store.claimRun(kind, t(0), fired, 'schedule')) !== null) {
    fail('書き換わった後の古い版への claimRun が null を返さない');
  }
  const rewritten = await store.get(kind);
  if (rewritten?.lastRunAt !== undefined || rewritten?.pendingRun !== undefined) {
    fail('断られた claimRun が印を立てた');
  }
  if (rewritten?.request !== '人間が直した依頼') fail('断られた claimRun が本文を書き換えた');
  await store.removeIfPresent(kind);
  if ((await store.claimRun(kind, t(1), fired, 'schedule')) !== null) {
    fail('消えた後の claimRun が null を返さない');
  }
  if ((await store.get(kind)) !== null) fail('断られた claimRun が行を作り直した');

  // editRequest: 発火の印を消さず、本文・spec・updatedAt だけが変わる
  await reset();
  await store.claimRun(kind, t(0), fired, 'schedule');
  const nextSpec = { type: 'daily' as const, at: '10:00' };
  const edited = await store.editRequest(kind, { request: '本文だけ直した', spec: nextSpec }, t(5));
  if (edited === null) fail('editRequest が在る kind に null を返した');
  if (edited.request !== '本文だけ直した' || edited.updatedAt !== t(5)) {
    fail('editRequest が本文と updatedAt を書き換えない');
  }
  if (edited.spec.type !== 'daily' || edited.spec.at !== '10:00') {
    fail('editRequest が spec を書き換えない');
  }
  if (edited.createdAt !== t(0)) fail('editRequest が createdAt を動かした');
  if (edited.lastRunAt !== fired || edited.pendingRun?.at !== fired) {
    fail('editRequest が claimRun 済みの印（lastRunAt / pendingRun）を消した');
  }
  if (JSON.stringify(await store.get(kind)) !== JSON.stringify(edited)) {
    fail('editRequest が返した行と、読み戻した行が違う');
  }
  await store.completeRun(kind, fired, 'schedule');
  const afterEdit = await store.get(kind);
  if (afterEdit?.pendingRun !== undefined || afterEdit?.lastScheduledRunAt !== fired) {
    fail('editRequest を挟むと completeRun が空振りした');
  }

  // editRequest: 印の無い行に、発火の印を作らない
  await reset();
  const plain = await store.editRequest(kind, { request: '直した', spec }, t(2));
  if (plain?.lastRunAt !== undefined || plain?.pendingRun !== undefined) {
    fail('editRequest が、発火していない行に発火の印を作った');
  }

  // editRequest: 無い kind は null（呼び出し側が put() で新規に作る側へ倒れる）。行も作らない
  if ((await store.editRequest('contract-run-ghost', { request: 'x', spec }, t(2))) !== null) {
    fail('無い kind への editRequest が null を返さない');
  }
  if ((await store.get('contract-run-ghost')) !== null)
    fail('editRequest が無い kind の行を作った');

  // editRequest: 空の request は put() と同じく断り、行は変わらない
  await reset();
  let rejected = false;
  try {
    await store.editRequest(kind, { request: '', spec }, t(3));
  } catch {
    rejected = true;
  }
  if (!rejected) fail('空の request への editRequest が断られない');
  const intact = await store.get(kind);
  if (intact?.request !== plan.request || intact.updatedAt !== t(0)) {
    fail('断られた editRequest が行を書き換えた');
  }

  await store.removeIfPresent(kind);
  await store.removeIfPresent(other);
}
