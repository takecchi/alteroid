import { expectNulRejected } from './nul-contract-support.js';
import type { ScheduleStore } from './store.js';

/**
 * `ScheduleStore` の NUL の約束（issue #3011。teto の判断、2026-10-06）を、**実装1つに対して**測る。
 * 3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - **読むだけの口**（`get`・`remove`・`removeIfPresent`・`editRequest`・`claimRun`・`completeRun`・`getPhase`）:
 *   NUL を含む kind で引かれたら、断らず「無い」と同じ結果を返す（投げない）。pg は DB に投げる前に短絡する
 * - **書き込みの口**: 依頼の kind は入口のスキーマ（`scheduleKindSchema` の正規表現）が NUL を弾くので、
 *   追加の処理は要らない（3実装とも投げ、何も書かない）。位相の kind（`putPhase`）はスキーマが `min(1)` だけなので
 *   `NulNotAllowedError` で断る。依頼の本文（`request`）の NUL は落として残す（`put`・`editRequest`）
 *
 * 書いたものは消して終わる。vitest に依存しない。
 */
export async function verifyScheduleNulContract(store: ScheduleStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`ScheduleStore の NUL の契約違反: ${message}`);
  }
  const at = '2026-10-06T00:00:00.000Z';
  const later = '2026-10-06T01:00:00.000Z';
  const nulKind = 'schedule-nul-c\u0000ontract';
  const kind = 'schedule-nul-contract';
  const spec = { type: 'every', minutes: 5 } as const;

  const before = JSON.stringify(await store.list());

  // 読むだけの口: 「無い」と同じ結果。
  const readOutcomes: Array<[string, () => Promise<unknown>, unknown]> = [
    ['get(NULを含むkind)はnull', () => store.get(nulKind), null],
    ['remove(NULを含むkind)は何も返さない', () => store.remove(nulKind), undefined],
    ['removeIfPresent(NULを含むkind)はnull', () => store.removeIfPresent(nulKind), null],
    [
      'editRequest(NULを含むkind)はnull',
      () => store.editRequest(nulKind, { request: 'r', spec }, later),
      null,
    ],
    ['claimRun(NULを含むkind)はnull', () => store.claimRun(nulKind, at, later, 'manual'), null],
    [
      'completeRun(NULを含むkind)は何も返さない',
      () => store.completeRun(nulKind, later, 'manual'),
      undefined,
    ],
    ['getPhase(NULを含むkind)はnull', () => store.getPhase(nulKind), null],
  ];
  for (const [label, call, expected] of readOutcomes) {
    let outcome: unknown;
    try {
      outcome = await call();
    } catch (error) {
      fail(`${label}（投げた: ${error instanceof Error ? error.name : typeof error}）`);
    }
    if (outcome !== expected) fail(`${label}（実際: ${JSON.stringify(outcome)}）`);
  }

  // 書き込みの口: kind の NUL はスキーマが弾く。何も書かない。
  let putThrown: unknown;
  try {
    await store.put({ kind: nulKind, spec, request: 'r', createdAt: at, updatedAt: at });
  } catch (error) {
    putThrown = error;
  }
  if (putThrown === undefined) fail('NULを含むkindの依頼をputで受け付けた');
  await expectNulRejected(
    fail,
    'putPhase(NULを含むkind)',
    () => store.putPhase({ kind: nulKind }),
    'schedule-nul-c',
  );
  if ((await store.getPhase(nulKind)) !== null) fail('断ったはずの位相が在る');

  // 本文は落として残す。落とすと空になる本文は、入口のスキーマ（min(1)）が断る。
  await store.put({ kind, spec, request: '依\u0000頼', createdAt: at, updatedAt: at });
  if ((await store.get(kind))?.request !== '依頼') fail('putの本文の NUL が残る');
  const edited = await store.editRequest(kind, { request: '直\u0000し', spec }, later);
  if (edited?.request !== '直し')
    fail(`editRequestの返り値に NUL が残る: ${JSON.stringify(edited?.request)}`);
  if ((await store.get(kind))?.request !== '直し') fail('editRequestの本文の NUL が残る');
  let emptyThrown: unknown;
  try {
    await store.put({ kind, spec, request: '\u0000', createdAt: at, updatedAt: at });
  } catch (error) {
    emptyThrown = error;
  }
  if (emptyThrown === undefined) fail('NULだけの本文を受け付けた（落とすと空になる）');
  if ((await store.get(kind))?.request !== '直し') fail('NULだけの本文を断ったのに行が変わった');

  await store.remove(kind);
  if (JSON.stringify(await store.list()) !== before)
    fail('読んだだけ・断っただけなのに行が変わった');
}
