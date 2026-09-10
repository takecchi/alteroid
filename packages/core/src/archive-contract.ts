import type { TranscriptArchive } from './store.js';

/**
 * `TranscriptArchive`（#698）の契約を、実装1つに対して測る。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか**は
 * `journal-search-contract.ts` の doc と同じ（`packages/storage-fs` /
 * `packages/storage-pg` へ vitest を持ち込まないため）。食い違ったら `throw`
 * する。
 *
 * **測る6性質。3実装（`packages/core/src/testing.ts` のインメモリ /
 * `packages/storage-fs/src/archive.ts` / `packages/storage-pg/src/archive.ts`）
 * すべてがこれを呼ぶこと**（`journal-search-contract.ts` と同じ作法。1つで
 * 測って3つとも測ったことにしない）:
 *
 * 1. **`remove()` の後も行は在る**（`list()` に出続ける）。本文だけが落ちる
 * 2. **`read()` が3つの顔を返し分ける**（`body` / `removed` / `missing`）。
 *    `missing` と `removed` は別物である
 * 3. **id A を消しても id B は読める**（巻き添えが無い）
 * 4. **存在しない id への `remove()` は黙って成功しない**（`missing`）
 * 5. **空の生ログを退避した行は、消していないのに `removed` にならない**
 *    （判定は印だけで行う。本文が空かどうかを見ない）
 * 6. **二重の `remove()` は `removed` → `already` になり、バイト数と
 *    `removedAt` は最初の `remove()` のまま変わらない**（冪等）
 *
 * 呼び出し側は使い捨ての archive を渡すこと（後始末はしない）。
 */
export async function verifyTranscriptArchiveContract(archive: TranscriptArchive): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(
      `TranscriptArchive contract violated: ${label} — ${JSON.stringify(detail)}`,
    );
  }

  const missingId = 'archive-contract-never-archived-id';

  // 4. 存在しない id への remove() は missing（成功にならない）。
  const removeMissing = await archive.remove(missingId);
  if (removeMissing.kind !== 'missing') fail('remove(存在しないid)', removeMissing);

  // 2前提. 存在しない id の read() も missing。
  const readMissing = await archive.read(missingId);
  if (readMissing.kind !== 'missing') fail('read(存在しないid)', readMissing);

  // 積んで読める（2つ。巻き添えの検査に使う）。
  const idA = await archive.archive('archive-contract-session-a', 'BODY-A\n');
  const idB = await archive.archive('archive-contract-session-b', 'BODY-B\n');
  const bodyA = await archive.read(idA);
  if (bodyA.kind !== 'body' || bodyA.body !== 'BODY-A\n') fail('積んで読める(A)', bodyA);
  const bodyB = await archive.read(idB);
  if (bodyB.kind !== 'body' || bodyB.body !== 'BODY-B\n') fail('積んで読める(B)', bodyB);

  // 5. 空の生ログを退避しても removed にならない（判定に本文の中身を使わない）。
  const idEmpty = await archive.archive('archive-contract-session-empty', '');
  const bodyEmpty = await archive.read(idEmpty);
  if (bodyEmpty.kind !== 'body' || bodyEmpty.body !== '') fail('空の生ログはremovedにならない', bodyEmpty);

  const listBefore = await archive.list();
  if (![idA, idB, idEmpty].every((id) => listBefore.includes(id))) {
    fail('list()に3件とも出る', listBefore);
  }

  // A を消す。
  const expectedBytesA = Buffer.byteLength('BODY-A\n', 'utf8');
  const removedA = await archive.remove(idA);
  if (removedA.kind !== 'removed') fail('remove(A)', removedA);
  if (removedA.bytes !== expectedBytesA) fail('remove(A)のバイト数', removedA);

  // 1. remove() の後も行は在る（list() に出続ける）。
  const listAfterRemove = await archive.list();
  if (!listAfterRemove.includes(idA)) fail('remove後も行は残る', listAfterRemove);

  // 2. read() が removed を返す（missing とは別物）。
  const readA = await archive.read(idA);
  if (readA.kind !== 'removed') fail('read(消したid)はremoved', readA);
  if (readA.bytes !== expectedBytesA) fail('removedのバイト数', readA);
  if (typeof readA.removedAt !== 'string' || Number.isNaN(Date.parse(readA.removedAt))) {
    fail('removedAtがISO8601文字列', readA);
  }

  // 3. 巻き添えなし: id B はまだ読める（body のまま）。
  const readBAfter = await archive.read(idB);
  if (readBAfter.kind !== 'body' || readBAfter.body !== 'BODY-B\n') {
    fail('巻き添えなし(Bはbodyのまま)', readBAfter);
  }

  // 5(再確認). 空の生ログ（未 remove）は依然として body（removed ではない）。
  const readEmptyAfter = await archive.read(idEmpty);
  if (readEmptyAfter.kind !== 'body' || readEmptyAfter.body !== '') {
    fail('空の生ログは他のidのremoveに巻き込まれてremovedにならない', readEmptyAfter);
  }

  // 6. 二重の remove() は冪等（already。バイト数・removedAt は変わらない）。
  const removedAgain = await archive.remove(idA);
  if (removedAgain.kind !== 'already') fail('二重remove()はalready', removedAgain);
  if (removedAgain.bytes !== expectedBytesA) fail('二重removeのバイト数', removedAgain);
  if (removedAgain.removedAt !== readA.removedAt) {
    fail('二重removeのremovedAtは最初のままである', { first: readA.removedAt, second: removedAgain.removedAt });
  }
}
