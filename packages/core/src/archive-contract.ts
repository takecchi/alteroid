import type { TranscriptArchive } from './store.js';

/**
 * `TranscriptArchive`（#698）の契約を、実装1つに対して測る。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか**は
 * `journal-search-contract.ts` の doc と同じ（`packages/storage-fs` /
 * `packages/storage-pg` へ vitest を持ち込まないため）。食い違ったら `throw`
 * する。
 *
 * **測る性質。3実装（`packages/core/src/testing.ts` のインメモリ /
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
 * 7. **`list()` の各行が `id` / `sessionId` / `at` / `storedBytes` を持つ**
 *    （#698 で `string[]` から拡張。`sessionId` は `archive()` に渡した値と
 *    一致し、`at` はパースできる ISO 8601 である）
 * 8. **tombstone 済みの行だけが `removedAt` / `removedBytes` を伴って
 *    `list()` に出る**（消していない行にはこの2キーが無い）
 * 9. ⭐ **同一 `sessionId` を複数回 `archive()` すると、`sessions()` の
 *    `rows` がその回数を正しく数える**（tombstone 済みの行も含む）。
 *    Issue #698 でいちばん効いたのはこの `rows` である——「同じセッションの
 *    生ログが68回積まれている」という重複が、個々の大きさより先に問題の
 *    所在を特定した
 * 10. **`sessions()` の `storedBytes` / `maxStoredBytes` / `firstAt` /
 *     `lastAt` は、`list()` の該当 `sessionId` の行から集計した値と一致する**
 *     （実装ごとの単位の違いを比べるのではなく、同じ実装の中で一覧と集計が
 *     整合しているかを測る——`ArchiveEntry.storedBytes` の doc「置き場を
 *     またいで比較しない」と同じ理由で、絶対値は検査しない）
 * 11. **`sessions()` の並びが決まっている**（`storedBytes` の降順、同値なら
 *     `sessionId` の昇順）
 * 12. **`storedBytes` が本当にその行の量を測っている**（常に0を返す実装を落とす）
 *
 * **13〜19 は #698 の「畳んでよいかどうかを積む瞬間に判定して記録する門」
 * （`archive-continuity.ts`）の検査である:**
 *
 * 13. 同じ `sessionId` の1本目は `'first'`
 * 14. 前方一致する2本目は `'continues'`、`comparedTo` が1本目の id
 * 15. 🔴 **本文が短くなった3本目は `'diverged'`**（本番の「6,900万文字
 *     *縮んだ*」行に相当）
 * 16. 🔴 **伸びているのに前方一致しない本文は `'diverged'`**（本番の
 *     「1%伸びたのに偽」に相当。⭐ 長さ比較へ退化したら赤くなる歯）
 * 17. 別の `sessionId` は互いに影響しない（それぞれ `'first'` から始まり、
 *     元の `sessionId` の連続性も乱さない）
 * 18. `'continues'` の後にさらに前方一致する本文を積むと、また `'continues'`
 *     （鎖が続く）
 * 19. 🔴🔴 **指紋を持たない行の直後は `'unknown'`**（`'continues'` ではない）
 *
 * 呼び出し側は使い捨ての archive を渡すこと（後始末はしない）。
 *
 * @param deps.seedFingerprintlessRow 指紋（`bodyChars`/`bodyMd5`）を持たない
 *   行を作る（この機能より前に積まれた行の再現）。積んだ id を返す——検査19
 *   のためだけに要る、実装ごとの裏口（pg は生 SQL で null のまま insert、fs は
 *   これらのフィールドを持たない `.meta.json` を書く、インメモリは
 *   `seedFingerprintlessArchiveRow` を経由する）。
 */
export async function verifyTranscriptArchiveContract(
  archive: TranscriptArchive,
  deps: { seedFingerprintlessRow(sessionId: string, body: string): Promise<string> },
): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(`TranscriptArchive contract violated: ${label} — ${JSON.stringify(detail)}`);
  }

  const missingId = 'archive-contract-never-archived-id';

  // 4. 存在しない id への remove() は missing（成功にならない）。
  const removeMissing = await archive.remove(missingId);
  if (removeMissing.kind !== 'missing') fail('remove(存在しないid)', removeMissing);

  // 2前提. 存在しない id の read() も missing。
  const readMissing = await archive.read(missingId);
  if (readMissing.kind !== 'missing') fail('read(存在しないid)', readMissing);

  // 積んで読める（2つ。巻き添えの検査に使う）。
  const idA = (await archive.archive('archive-contract-session-a', 'BODY-A\n')).id;
  const idB = (await archive.archive('archive-contract-session-b', 'BODY-B\n')).id;
  const bodyA = await archive.read(idA);
  if (bodyA.kind !== 'body' || bodyA.body !== 'BODY-A\n') fail('積んで読める(A)', bodyA);
  const bodyB = await archive.read(idB);
  if (bodyB.kind !== 'body' || bodyB.body !== 'BODY-B\n') fail('積んで読める(B)', bodyB);

  // 5. 空の生ログを退避しても removed にならない（判定に本文の中身を使わない）。
  const idEmpty = (await archive.archive('archive-contract-session-empty', '')).id;
  const bodyEmpty = await archive.read(idEmpty);
  if (bodyEmpty.kind !== 'body' || bodyEmpty.body !== '')
    fail('空の生ログはremovedにならない', bodyEmpty);

  const listBefore = await archive.list();
  if (![idA, idB, idEmpty].every((id) => listBefore.some((entry) => entry.id === id))) {
    fail('list()に3件とも出る', listBefore);
  }

  // 7. list() の各行が id / sessionId / at / storedBytes を持つ。
  const entryA = listBefore.find((entry) => entry.id === idA);
  if (entryA === undefined) fail('list()にAの行がある', listBefore);
  if (entryA.sessionId !== 'archive-contract-session-a') {
    fail('list()のsessionIdがarchive()に渡した値と一致する', entryA);
  }
  if (typeof entryA.at !== 'string' || Number.isNaN(Date.parse(entryA.at))) {
    fail('list()のatがISO8601文字列', entryA);
  }
  if (typeof entryA.storedBytes !== 'number' || entryA.storedBytes < 0) {
    fail('list()のstoredBytesが非負の数値', entryA);
  }
  // 8前提. 消す前は removedAt / removedBytes を持たない。
  if ('removedAt' in entryA || 'removedBytes' in entryA) {
    fail('消す前のlist()行はremovedAt/removedBytesを持たない', entryA);
  }

  // A を消す。
  const expectedBytesA = Buffer.byteLength('BODY-A\n', 'utf8');
  const removedA = await archive.remove(idA);
  if (removedA.kind !== 'removed') fail('remove(A)', removedA);
  if (removedA.bytes !== expectedBytesA) fail('remove(A)のバイト数', removedA);

  // 1. remove() の後も行は在る（list() に出続ける）。
  const listAfterRemove = await archive.list();
  const entryAAfterRemove = listAfterRemove.find((entry) => entry.id === idA);
  if (entryAAfterRemove === undefined) fail('remove後も行は残る', listAfterRemove);

  // 8. tombstone 済みの行は removedAt / removedBytes を伴って list() に出る。
  if (
    entryAAfterRemove.removedAt === undefined ||
    Number.isNaN(Date.parse(entryAAfterRemove.removedAt)) ||
    entryAAfterRemove.removedBytes !== expectedBytesA
  ) {
    fail('remove後のlist()行はremovedAt/removedBytesを伴う', entryAAfterRemove);
  }
  // 消していない行（B）は引き続き removedAt / removedBytes を持たない。
  const entryBAfterRemove = listAfterRemove.find((entry) => entry.id === idB);
  if (
    entryBAfterRemove === undefined ||
    'removedAt' in entryBAfterRemove ||
    'removedBytes' in entryBAfterRemove
  ) {
    fail('消していない行(B)はremovedAt/removedBytesを持たない', entryBAfterRemove);
  }

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
    fail('二重removeのremovedAtは最初のままである', {
      first: readA.removedAt,
      second: removedAgain.removedAt,
    });
  }

  // 9. ⭐ 同一 sessionId を複数回 archive() すると、sessions() の rows が
  // その回数を正しく数える（tombstone 済みの行を1本混ぜて、8 と同じ扱いに
  // なることも確かめる——「行は残る」を rows の数え上げの側でも測る）。
  // ⚠ **1ミリ秒ずつ空ける。** `archive()` の id は
  // `${sanitize(sessionId)}-${stamp}.jsonl` で `stamp` はミリ秒精度なので、
  // **同じミリ秒に2回積むと id が衝突し、pg 側は `onConflictDoUpdate` で
  // 黙って上書きする**（fs 側も `writeFile` で上書きになる）。これは
  // `list()`/`sessions()` とは別に元から在る欠陥で、ここで測りたいのは
  // 「同一 sessionId の複数行を `rows` が数えられること」のほうである。
  // ⟹ 衝突を踏まないように間隔を空けて、測りたいものだけを測る。
  // **衝突そのものを塞ぐのはこの契約の仕事ではない**（id の形を変えると
  // fs 側の `STAMP_SUFFIX_RE` による id からの復元も一緒に変わるため）。
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  const multiSessionId = 'archive-contract-session-multi';
  const idM1 = (await archive.archive(multiSessionId, 'M1\n')).id;
  await tick();
  const idM2 = (await archive.archive(multiSessionId, 'M2-longer\n')).id;
  await tick();
  const idM3 = (await archive.archive(multiSessionId, 'M3\n')).id;
  if (new Set([idM1, idM2, idM3]).size !== 3) {
    fail('3回の archive() が別々の id になる（同じなら id がミリ秒で衝突している）', [
      idM1,
      idM2,
      idM3,
    ]);
  }
  await archive.remove(idM2); // 積んだうちの1本を消す。rows は減らないはず。

  const listAfterMulti = await archive.list();
  const multiEntries = listAfterMulti.filter((entry) => entry.sessionId === multiSessionId);
  if (
    multiEntries.length !== 3 ||
    ![idM1, idM2, idM3].every((id) => multiEntries.some((e) => e.id === id))
  ) {
    fail('list()は同一sessionIdの3行を全部返す（tombstone済みも含む）', multiEntries);
  }

  const sessionSummaries = await archive.sessions();
  const multiSummary = sessionSummaries.find((s) => s.sessionId === multiSessionId);
  if (multiSummary === undefined) fail('sessions()にmultiSessionIdの行がある', sessionSummaries);
  if (multiSummary.rows !== 3) {
    fail('sessions().rowsは同一sessionIdの行数(tombstone済み込み)を正しく数える', multiSummary);
  }

  // 10. sessions() の集計は list() の該当行から求めた値と一致する
  // （絶対値は実装ごとに単位が違うので検査しない——内部の整合性だけを測る）。
  const expectedStoredBytes = multiEntries.reduce((sum, e) => sum + e.storedBytes, 0);
  const expectedMaxStoredBytes = Math.max(...multiEntries.map((e) => e.storedBytes));
  const expectedFirstAt = multiEntries.map((e) => e.at).sort()[0];
  const expectedLastAt = multiEntries
    .map((e) => e.at)
    .sort()
    .at(-1);
  if (multiSummary.storedBytes !== expectedStoredBytes) {
    fail('sessions().storedBytesはlist()の該当行の合計と一致する', {
      summary: multiSummary,
      expected: expectedStoredBytes,
    });
  }
  if (multiSummary.maxStoredBytes !== expectedMaxStoredBytes) {
    fail('sessions().maxStoredBytesはlist()の該当行の最大値と一致する', {
      summary: multiSummary,
      expected: expectedMaxStoredBytes,
    });
  }
  if (multiSummary.firstAt !== expectedFirstAt || multiSummary.lastAt !== expectedLastAt) {
    fail('sessions().firstAt/lastAtはlist()の該当行のat の最小/最大と一致する', {
      summary: multiSummary,
      expectedFirstAt,
      expectedLastAt,
    });
  }

  // 11. sessions() の並びが決まっている（storedBytes の降順、同値なら
  // sessionId の昇順）。⚠ 並びを決めないと、同じ問い合わせが呼ぶたびに違う順で
  // 返りうる——容量を追う面（大きいセッションから見たい）で黙った揺れになる。
  const ordered = await archive.sessions();
  const expectedOrder = [...ordered].sort(
    (a, b) =>
      b.storedBytes - a.storedBytes ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  if (ordered.some((summary, index) => summary.sessionId !== expectedOrder[index]?.sessionId)) {
    fail('sessions()はstoredBytesの降順・同値ならsessionIdの昇順で返る', ordered);
  }

  // 12. `storedBytes` が本当にその行の量を測っていること。
  //
  // 🔴 **これが無いと `storedBytes` が常に 0 でも上の検査は全部緑になる。**
  // 9〜11 は「`sessions()` の集計が `list()` と整合するか」しか見ておらず、
  // 全部 0 なら合計 0・最大 0 で整合してしまう——変異試験（storedBytes を
  // 常に 0 にする）で実際に素通りした。⟹ **定数を返す実装を落とす。**
  //
  // ⚠ 絶対値は実装ごとに単位が違う（pg は圧縮後、fs はファイル長、
  // インメモリは文字列長）ので**値そのものは検査しない**。検査するのは
  // 「正であること」と「同じ実装の中で大きい本文のほうが大きいこと」だけ——
  // この2つなら単位に依らない。
  const bytesSessionId = 'archive-contract-bytes';
  const smallId = (await archive.archive(bytesSessionId, 'x\n')).id;
  await tick();
  const bigId = (await archive.archive(bytesSessionId, 'ログの1行 {"k":"v"}\n'.repeat(600))).id;
  const bytesEntries = await archive.list();
  const smallEntry = bytesEntries.find((entry) => entry.id === smallId);
  const bigEntry = bytesEntries.find((entry) => entry.id === bigId);
  if (smallEntry === undefined || bigEntry === undefined) {
    fail('storedBytesの検査に使った2行がlist()に在る', { smallId, bigId });
  }
  if (!(smallEntry.storedBytes > 0)) {
    fail('storedBytesは空でない本文に対して正の値を返す（定数0を落とす）', smallEntry);
  }
  if (!(bigEntry.storedBytes > smallEntry.storedBytes)) {
    fail('storedBytesは本文の大きい行のほうが大きい（定数を落とす）', { smallEntry, bigEntry });
  }

  // --- ここから #698 の連続性判定（archive-continuity.ts）--------------------

  // 13. 同じ sessionId の1本目は 'first'（comparedTo 無し）。
  const continuitySessionId = 'archive-contract-continuity';
  const write1 = await archive.archive(continuitySessionId, 'AAAA\n');
  if (write1.continuity !== 'first' || write1.comparedTo !== undefined) {
    fail('同一sessionIdの1本目はfirst（comparedTo無し）', write1);
  }

  // 14. 前方一致する2本目は continues、comparedTo が1本目の id。
  await tick();
  const write2 = await archive.archive(continuitySessionId, 'AAAA\nBBBB\n');
  if (write2.continuity !== 'continues' || write2.comparedTo !== write1.id) {
    fail('前方一致する2本目はcontinues（comparedToは1本目のid）', { write1, write2 });
  }

  // 15. 🔴 本文が短くなった3本目は diverged
  // （本番の「6,900万文字*縮んだ*」行に相当。長さの大小では判定しない —
  // slice が短い文字列を返して md5 が外れ、自然に diverged になる）。
  await tick();
  const write3 = await archive.archive(continuitySessionId, 'AAAA\n');
  if (write3.continuity !== 'diverged' || write3.comparedTo !== write2.id) {
    fail('縮んだ3本目はdiverged（長さの大小では判定しない）', { write2, write3 });
  }

  // 16. 🔴 伸びているのに前方一致しない本文は diverged
  // （本番の「1%伸びたのに偽」に相当）。⭐ ここが長さ比較へ退化すると
  // 緑になってしまう歯——write4 は write3 より長いが、先頭が違う。
  await tick();
  const write4 = await archive.archive(continuitySessionId, 'ZZZZ\nBBBB\nCCCC\n');
  if (write4.continuity !== 'diverged') {
    fail('伸びているが前方一致しない本文はdiverged（長さ比較への退化を検出する歯）', {
      write3,
      write4,
    });
  }

  // 17. 別の sessionId は互いに影響しない（それぞれ first から始まり、
  // 元の sessionId の連続性も乱さない）。
  const otherSessionId = 'archive-contract-continuity-other';
  const otherWrite1 = await archive.archive(otherSessionId, 'OTHER-A\n');
  if (otherWrite1.continuity !== 'first') {
    fail('別のsessionIdはfirstから始まる（互いに影響しない）', otherWrite1);
  }
  await tick();
  const continuityAfterOther = await archive.archive(
    continuitySessionId,
    'ZZZZ\nBBBB\nCCCC\nDDDD\n',
  );
  if (
    continuityAfterOther.continuity !== 'continues' ||
    continuityAfterOther.comparedTo !== write4.id
  ) {
    fail('別のsessionIdを挟んでも元のsessionIdの連続性は影響を受けない', {
      write4,
      otherWrite1,
      continuityAfterOther,
    });
  }

  // 18. 'continues' の後にさらに前方一致する本文を積むと、また 'continues'
  // （鎖が続く）。
  await tick();
  const continuityChain = await archive.archive(
    continuitySessionId,
    'ZZZZ\nBBBB\nCCCC\nDDDD\nEEEE\n',
  );
  if (
    continuityChain.continuity !== 'continues' ||
    continuityChain.comparedTo !== continuityAfterOther.id
  ) {
    fail('continuesの後にさらに前方一致する本文を積むとまたcontinues（鎖が続く）', {
      continuityAfterOther,
      continuityChain,
    });
  }

  // 19. 🔴🔴 指紋を持たない行の直後は unknown（continues ではない）。
  // この機能より前に積まれた行（本番の5.4GBの既存行）の再現。
  const fingerprintlessSessionId = 'archive-contract-fingerprintless';
  const fingerprintlessId = await deps.seedFingerprintlessRow(fingerprintlessSessionId, 'LEGACY\n');
  await tick();
  const afterFingerprintless = await archive.archive(fingerprintlessSessionId, 'LEGACY\nNEW\n');
  if (
    afterFingerprintless.continuity !== 'unknown' ||
    afterFingerprintless.comparedTo !== fingerprintlessId
  ) {
    fail('指紋を持たない行の直後はunknown（continuesではない）', {
      fingerprintlessId,
      afterFingerprintless,
    });
  }
}
