import { selectArchiveRemovalTargets } from './archive-prune.js';
import { InvalidArchiveSessionIdError } from './archive-session-id.js';
import type { TranscriptArchive } from './store.js';

// vi.useFakeTimers() を使わず Date だけ差し替える: vitest を持ち込まないため、また setTimeout まで止めると PGlite の内部が止まるため
// class extends Date にしない: 可変長引数を super へ渡す形が tsup の dts ビルドの TS2556 で拒まれるため
async function withFrozenNow<T>(frozenMs: number, run: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const FrozenDate = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) return new target(frozenMs);
      return Reflect.construct(target, args);
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => frozenMs;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

  globalThis.Date = FrozenDate;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

export async function verifyTranscriptArchiveContract(
  archive: TranscriptArchive,
  deps: { seedFingerprintlessRow(sessionId: string, body: string): Promise<string> },
): Promise<void> {
  function fail(label: string, detail: unknown): never {
    throw new Error(`TranscriptArchive contract violated: ${label} — ${JSON.stringify(detail)}`);
  }

  const missingId = 'archive-contract-never-archived-id';

  const removeMissing = await archive.remove(missingId);
  if (removeMissing.kind !== 'missing') fail('remove(存在しないid)', removeMissing);

  const readMissing = await archive.read(missingId);
  if (readMissing.kind !== 'missing') fail('read(存在しないid)', readMissing);

  {
    const countBefore = (await archive.list()).length;
    let thrown: unknown;
    try {
      await archive.archive('archive-contract-session-\u0000-nul', 'BODY-NUL\n');
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof InvalidArchiveSessionIdError)) {
      fail('NULを含むsessionIdはInvalidArchiveSessionIdErrorで断る', {
        thrown: thrown === undefined ? '(投げなかった)' : String(thrown),
      });
    }
    if (thrown.message !== new InvalidArchiveSessionIdError().message) {
      fail('NULを含むsessionIdの例外の文言が3実装で同じ', thrown.message);
    }
    const countAfter = (await archive.list()).length;
    if (countAfter !== countBefore) {
      fail('NULを含むsessionIdでは何も積まない', { countBefore, countAfter });
    }
  }

  const idA = (await archive.archive('archive-contract-session-a', 'BODY-A\n')).id;
  const idB = (await archive.archive('archive-contract-session-b', 'BODY-B\n')).id;
  const bodyA = await archive.read(idA);
  if (bodyA.kind !== 'body' || bodyA.body !== 'BODY-A\n') fail('積んで読める(A)', bodyA);
  const bodyB = await archive.read(idB);
  if (bodyB.kind !== 'body' || bodyB.body !== 'BODY-B\n') fail('積んで読める(B)', bodyB);

  {
    const underB = `${idB}/x`;
    const readUnder = await archive.read(underB);
    if (readUnder.kind !== 'missing') fail('read(在るidの下)はmissing', readUnder);
    const tailUnder = await archive.readTail(underB, 10);
    if (tailUnder.kind !== 'missing') fail('readTail(在るidの下)はmissing', tailUnder);
    const removeUnder = await archive.remove(underB);
    if (removeUnder.kind !== 'missing') fail('remove(在るidの下)はmissing', removeUnder);
    const bodyBAfter = await archive.read(idB);
    if (bodyBAfter.kind !== 'body' || bodyBAfter.body !== 'BODY-B\n') {
      fail('remove(在るidの下)はBを巻き添えにしない', bodyBAfter);
    }
  }

  const idEmpty = (await archive.archive('archive-contract-session-empty', '')).id;
  const bodyEmpty = await archive.read(idEmpty);
  if (bodyEmpty.kind !== 'body' || bodyEmpty.body !== '')
    fail('空の生ログはremovedにならない', bodyEmpty);

  const listBefore = await archive.list();
  if (![idA, idB, idEmpty].every((id) => listBefore.some((entry) => entry.id === id))) {
    fail('list()に3件とも出る', listBefore);
  }

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
  if ('removedAt' in entryA || 'removedBytes' in entryA) {
    fail('消す前のlist()行はremovedAt/removedBytesを持たない', entryA);
  }

  const expectedBytesA = Buffer.byteLength('BODY-A\n', 'utf8');
  const removedA = await archive.remove(idA);
  if (removedA.kind !== 'removed') fail('remove(A)', removedA);
  if (removedA.bytes !== expectedBytesA) fail('remove(A)のバイト数', removedA);

  const listAfterRemove = await archive.list();
  const entryAAfterRemove = listAfterRemove.find((entry) => entry.id === idA);
  if (entryAAfterRemove === undefined) fail('remove後も行は残る', listAfterRemove);

  if (
    entryAAfterRemove.removedAt === undefined ||
    Number.isNaN(Date.parse(entryAAfterRemove.removedAt)) ||
    entryAAfterRemove.removedBytes !== expectedBytesA
  ) {
    fail('remove後のlist()行はremovedAt/removedBytesを伴う', entryAAfterRemove);
  }
  const entryBAfterRemove = listAfterRemove.find((entry) => entry.id === idB);
  if (
    entryBAfterRemove === undefined ||
    'removedAt' in entryBAfterRemove ||
    'removedBytes' in entryBAfterRemove
  ) {
    fail('消していない行(B)はremovedAt/removedBytesを持たない', entryBAfterRemove);
  }

  const readA = await archive.read(idA);
  if (readA.kind !== 'removed') fail('read(消したid)はremoved', readA);
  if (readA.bytes !== expectedBytesA) fail('removedのバイト数', readA);
  if (typeof readA.removedAt !== 'string' || Number.isNaN(Date.parse(readA.removedAt))) {
    fail('removedAtがISO8601文字列', readA);
  }

  const readBAfter = await archive.read(idB);
  if (readBAfter.kind !== 'body' || readBAfter.body !== 'BODY-B\n') {
    fail('巻き添えなし(Bはbodyのまま)', readBAfter);
  }

  const readEmptyAfter = await archive.read(idEmpty);
  if (readEmptyAfter.kind !== 'body' || readEmptyAfter.body !== '') {
    fail('空の生ログは他のidのremoveに巻き込まれてremovedにならない', readEmptyAfter);
  }

  const removedAgain = await archive.remove(idA);
  if (removedAgain.kind !== 'already') fail('二重remove()はalready', removedAgain);
  if (removedAgain.bytes !== expectedBytesA) fail('二重removeのバイト数', removedAgain);
  if (removedAgain.removedAt !== readA.removedAt) {
    fail('二重removeのremovedAtは最初のままである', {
      first: readA.removedAt,
      second: removedAgain.removedAt,
    });
  }

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
  await archive.remove(idM2);

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

  const ordered = await archive.sessions();
  const expectedOrder = [...ordered].sort(
    (a, b) =>
      b.storedBytes - a.storedBytes ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  if (ordered.some((summary, index) => summary.sessionId !== expectedOrder[index]?.sessionId)) {
    fail('sessions()はstoredBytesの降順・同値ならsessionIdの昇順で返る', ordered);
  }

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

  const continuitySessionId = 'archive-contract-continuity';
  const write1 = await archive.archive(continuitySessionId, 'AAAA\n');
  if (write1.continuity !== 'first' || write1.comparedTo !== undefined) {
    fail('同一sessionIdの1本目はfirst（comparedTo無し）', write1);
  }

  await tick();
  const write2 = await archive.archive(continuitySessionId, 'AAAA\nBBBB\n');
  if (write2.continuity !== 'continues' || write2.comparedTo !== write1.id) {
    fail('前方一致する2本目はcontinues（comparedToは1本目のid）', { write1, write2 });
  }

  await tick();
  const write3 = await archive.archive(continuitySessionId, 'AAAA\n');
  if (write3.continuity !== 'diverged' || write3.comparedTo !== write2.id) {
    fail('縮んだ3本目はdiverged（長さの大小では判定しない）', { write2, write3 });
  }

  await tick();
  const write4 = await archive.archive(continuitySessionId, 'ZZZZ\nBBBB\nCCCC\n');
  if (write4.continuity !== 'diverged') {
    fail('伸びているが前方一致しない本文はdiverged（長さ比較への退化を検出する歯）', {
      write3,
      write4,
    });
  }

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

  const sameMsSessionId = 'archive-contract-same-millisecond';
  const frozenMs = Date.now();
  const frozenIso = new Date(frozenMs).toISOString();
  const [sameMs1, sameMs2] = await withFrozenNow(frozenMs, async () => {
    const first = await archive.archive(sameMsSessionId, 'SAME-MS-1\n');
    const second = await archive.archive(sameMsSessionId, 'SAME-MS-2\n');
    return [first, second] as const;
  });

  if (sameMs1.id === sameMs2.id) {
    fail('同じミリ秒に2回積むと別々のidになる（#905。同じなら片方が上書きされる）', {
      first: sameMs1,
      second: sameMs2,
    });
  }

  const sameMsEntries = (await archive.list()).filter(
    (entry) => entry.sessionId === sameMsSessionId,
  );
  if (
    sameMsEntries.length !== 2 ||
    ![sameMs1.id, sameMs2.id].every((id) => sameMsEntries.some((entry) => entry.id === id))
  ) {
    fail('同じミリ秒に積んだ2本がlist()に2行とも出る（#905）', {
      first: sameMs1,
      second: sameMs2,
      sameMsEntries,
    });
  }

  const readSameMs1 = await archive.read(sameMs1.id);
  if (readSameMs1.kind !== 'body' || readSameMs1.body !== 'SAME-MS-1\n') {
    fail('同じミリ秒に積んだ1本目の本文が残っている（#905。⭐ 上書きされていない）', {
      id: sameMs1.id,
      readSameMs1,
    });
  }
  const readSameMs2 = await archive.read(sameMs2.id);
  if (readSameMs2.kind !== 'body' || readSameMs2.body !== 'SAME-MS-2\n') {
    fail('同じミリ秒に積んだ2本目の本文が残っている（#905）', { id: sameMs2.id, readSameMs2 });
  }

  const sameMsSummary = (await archive.sessions()).find((s) => s.sessionId === sameMsSessionId);
  if (sameMsSummary === undefined || sameMsSummary.rows !== 2) {
    fail('同じミリ秒に2回積むとsessions().rowsが2になる（#905。退避の回数を過少に数えない）', {
      sameMsSummary,
    });
  }

  if (sameMsEntries.some((entry) => entry.at !== frozenIso)) {
    fail('同じミリ秒に積んだ2行のatは固定した瞬間と一致する（#905）', {
      frozenIso,
      ats: sameMsEntries.map((entry) => entry.at),
    });
  }

  const diffMsSessionId = 'archive-contract-different-millisecond';
  const diffBaseMs = Date.now();
  const diffMs1 = await withFrozenNow(diffBaseMs, () =>
    archive.archive(diffMsSessionId, 'DIFF-MS-1\n'),
  );
  const diffMs2 = await withFrozenNow(diffBaseMs + 7, () =>
    archive.archive(diffMsSessionId, 'DIFF-MS-2\n'),
  );

  if (diffMs1.id === diffMs2.id) {
    fail('違うミリ秒に積んだ2本は別々のidになる（#905の陰性対照）', {
      first: diffMs1,
      second: diffMs2,
    });
  }

  const diffMsEntries = (await archive.list()).filter(
    (entry) => entry.sessionId === diffMsSessionId,
  );
  if (
    diffMsEntries.length !== 2 ||
    ![diffMs1.id, diffMs2.id].every((id) => diffMsEntries.some((entry) => entry.id === id))
  ) {
    fail('違うミリ秒に積んだ2本がlist()に2行とも出る（#905の陰性対照）', {
      first: diffMs1,
      second: diffMs2,
      diffMsEntries,
    });
  }

  const readDiffMs1 = await archive.read(diffMs1.id);
  if (readDiffMs1.kind !== 'body' || readDiffMs1.body !== 'DIFF-MS-1\n') {
    fail('違うミリ秒に積んだ1本目の本文が残っている（#905の陰性対照）', {
      id: diffMs1.id,
      readDiffMs1,
    });
  }
  const readDiffMs2 = await archive.read(diffMs2.id);
  if (readDiffMs2.kind !== 'body' || readDiffMs2.body !== 'DIFF-MS-2\n') {
    fail('違うミリ秒に積んだ2本目の本文が残っている（#905の陰性対照）', {
      id: diffMs2.id,
      readDiffMs2,
    });
  }

  const diffMsSummary = (await archive.sessions()).find((s) => s.sessionId === diffMsSessionId);
  if (diffMsSummary === undefined || diffMsSummary.rows !== 2) {
    fail('違うミリ秒に2回積むとsessions().rowsが2になる（#905の陰性対照）', { diffMsSummary });
  }

  const diffMsAts = new Set(diffMsEntries.map((entry) => entry.at));
  if (diffMsAts.size !== 2) {
    fail('陰性対照の2行は別々のatを持つ（同じミリ秒を測ってしまっていない）', {
      ats: [...diffMsAts],
    });
  }

  const prefixPairs: ReadonlyArray<readonly [string, string]> = [
    [sameMsSessionId, sameMs1.id],
    [sameMsSessionId, sameMs2.id],
    [diffMsSessionId, diffMs1.id],
    [diffMsSessionId, diffMs2.id],
  ];
  for (const [prefixSessionId, id] of prefixPairs) {
    if (!id.startsWith(prefixSessionId)) {
      fail('idはsessionIdで始まる（前方一致LIKEが効く性質。#698 §6-5 / #905）', {
        sessionId: prefixSessionId,
        id,
      });
    }
  }

  const allSessionSummaries = await archive.sessions();

  for (const summary of allSessionSummaries) {
    const total =
      summary.continuity.first +
      summary.continuity.continues +
      summary.continuity.diverged +
      summary.continuity.unknown +
      summary.continuity.absent;
    if (total !== summary.rows) {
      fail('sessions().continuityの5値の和はrowsと一致する（不変条件）', summary);
    }
  }

  const continuityWrites = [write1, write2, write3, write4, continuityAfterOther, continuityChain];
  const expectedContinuityTally = { first: 0, continues: 0, diverged: 0, unknown: 0, absent: 0 };
  for (const write of continuityWrites) {
    expectedContinuityTally[write.continuity] += 1;
  }
  const continuitySummary = allSessionSummaries.find((s) => s.sessionId === continuitySessionId);
  if (continuitySummary === undefined) {
    fail('sessions()にcontinuitySessionIdの行がある', allSessionSummaries);
  }
  if (
    continuitySummary.continuity.first !== expectedContinuityTally.first ||
    continuitySummary.continuity.continues !== expectedContinuityTally.continues ||
    continuitySummary.continuity.diverged !== expectedContinuityTally.diverged ||
    continuitySummary.continuity.unknown !== expectedContinuityTally.unknown ||
    continuitySummary.continuity.absent !== expectedContinuityTally.absent
  ) {
    fail('sessions().continuityはarchive()が返したcontinuityの積み上げと一致する', {
      expected: expectedContinuityTally,
      actual: continuitySummary.continuity,
    });
  }

  const fingerprintlessSummary = allSessionSummaries.find(
    (s) => s.sessionId === fingerprintlessSessionId,
  );
  if (fingerprintlessSummary === undefined) {
    fail('sessions()にfingerprintlessSessionIdの行がある', allSessionSummaries);
  }
  if (
    fingerprintlessSummary.continuity.absent !== 1 ||
    fingerprintlessSummary.continuity.unknown !== 1 ||
    fingerprintlessSummary.rows !== 2
  ) {
    fail('absentとunknownは別カウンタに割れる（seedした行はabsent、その直後はunknown）', {
      summary: fingerprintlessSummary,
    });
  }

  const tailSessionId = 'archive-contract-read-tail';
  const tailFullBody = `PREFIX-${'A'.repeat(4000)}-TAIL-MARKER-END`;
  const tailId = (await archive.archive(tailSessionId, tailFullBody)).id;
  const tailMaxChars = 100;
  const tailResult = await archive.readTail(tailId, tailMaxChars);
  if (tailResult.kind !== 'body') fail('readTail(本文が長い)はbody', tailResult);
  if (tailResult.body.length <= tailMaxChars) {
    fail('readTailは本文がmaxCharsより長いとき、maxCharsを厳密に上回る量を返す', {
      returnedChars: tailResult.body.length,
      tailMaxChars,
    });
  }
  if (!tailFullBody.endsWith(tailResult.body)) {
    fail('readTailが返すのは本文の末尾である（頭ではない）', { tailResult, tailFullBody });
  }
  if (tailResult.body.slice(-tailMaxChars) !== tailFullBody.slice(-tailMaxChars)) {
    fail('readTailの末尾maxChars文字ぶんは本文の末尾maxChars文字ぶんと一致する', {
      tail: tailResult.body.slice(-tailMaxChars),
      expected: tailFullBody.slice(-tailMaxChars),
    });
  }

  const shortBody = 'SHORT-BODY-1234567890\n';
  const shortId = (await archive.archive('archive-contract-read-tail-short', shortBody)).id;
  const shortResult = await archive.readTail(shortId, shortBody.length + 1000);
  if (shortResult.kind !== 'body' || shortResult.body !== shortBody) {
    fail('readTailは本文がmaxChars以下なら全文を返す', shortResult);
  }

  const tailMissing = await archive.readTail(missingId, 10);
  if (tailMissing.kind !== 'missing')
    fail('readTail(存在しないid)はmissing（read()と一致）', tailMissing);

  const tailRemovedId = (
    await archive.archive('archive-contract-read-tail-removed', 'REMOVE-ME-BEFORE-TAIL\n')
  ).id;
  await archive.remove(tailRemovedId);
  const tailRemoved = await archive.readTail(tailRemovedId, 5);
  const plainRemoved = await archive.read(tailRemovedId);
  if (tailRemoved.kind !== 'removed' || plainRemoved.kind !== 'removed') {
    fail('readTail(消したid)はread()と同じくremoved', { tailRemoved, plainRemoved });
  }
  if (
    tailRemoved.removedAt !== plainRemoved.removedAt ||
    tailRemoved.bytes !== plainRemoved.bytes
  ) {
    fail('readTailのremoved詳細（removedAt/bytes）はread()と一致する', {
      tailRemoved,
      plainRemoved,
    });
  }

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    let threw = false;
    try {
      await archive.readTail(tailId, bad);
    } catch {
      threw = true;
    }
    if (!threw) fail('readTail(不正なmaxChars)はfail-closedで拒む（例外を投げる）', { bad });
  }

  const branchTieSessionId = 'archive-contract-same-ms-branch-tiebreak';
  const branchTieMs = Date.now() + 1;
  const [branchWrite1, branchWrite2, branchWrite3, branchWrite4] = await withFrozenNow(
    branchTieMs,
    async () => {
      const w1 = await archive.archive(branchTieSessionId, 'BRANCH-TIE-1\n');
      const w2 = await archive.archive(branchTieSessionId, 'BRANCH-TIE-2\n');
      const w3 = await archive.archive(branchTieSessionId, 'BRANCH-TIE-3\n');
      const w4 = await archive.archive(branchTieSessionId, 'BRANCH-TIE-4\n');
      return [w1, w2, w3, w4] as const;
    },
  );
  if (new Set([branchWrite1.id, branchWrite2.id, branchWrite3.id, branchWrite4.id]).size !== 4) {
    fail('#908: 同じミリ秒に4回積んでも4本とも別々のidになる', {
      branchWrite1,
      branchWrite2,
      branchWrite3,
      branchWrite4,
    });
  }
  if (branchWrite2.comparedTo !== branchWrite1.id) {
    fail('#908: 2本目のcomparedToは1本目のid', { branchWrite1, branchWrite2 });
  }
  if (branchWrite3.comparedTo !== branchWrite2.id) {
    fail('#908: 3本目のcomparedToは2本目のid（1本目ではない。idの字面順tie-breakの再発検出）', {
      branchWrite1,
      branchWrite2,
      branchWrite3,
    });
  }
  if (branchWrite4.comparedTo !== branchWrite3.id) {
    fail('#908: 4本目のcomparedToは3本目のid', { branchWrite3, branchWrite4 });
  }

  const branchTieEntries = (await archive.list()).filter(
    (entry) => entry.sessionId === branchTieSessionId,
  );
  const branchTieOrder = branchTieEntries.map((entry) => entry.id);
  const expectedBranchTieOrder = [
    branchWrite4.id,
    branchWrite3.id,
    branchWrite2.id,
    branchWrite1.id,
  ];
  if (
    branchTieOrder.length !== 4 ||
    branchTieOrder.some((id, index) => id !== expectedBranchTieOrder[index])
  ) {
    fail('#908: list()の同着(同じat)の並びは積んだ逆順（新しいものが先）', {
      order: branchTieOrder,
      expected: expectedBranchTieOrder,
    });
  }

  const chainedDiffMsSessionId = 'archive-contract-different-millisecond-chain';
  const chainedBaseMs = branchTieMs + 1000;
  const chained1 = await withFrozenNow(chainedBaseMs, () =>
    archive.archive(chainedDiffMsSessionId, 'CHAIN-1\n'),
  );
  const chained2 = await withFrozenNow(chainedBaseMs + 5, () =>
    archive.archive(chainedDiffMsSessionId, 'CHAIN-2\n'),
  );
  const chained3 = await withFrozenNow(chainedBaseMs + 11, () =>
    archive.archive(chainedDiffMsSessionId, 'CHAIN-3\n'),
  );
  if (chained2.comparedTo !== chained1.id || chained3.comparedTo !== chained2.id) {
    fail('#908の陰性対照A: 違うミリ秒に3本積むとcomparedToは常に直前の1本を指す', {
      chained1,
      chained2,
      chained3,
    });
  }

  const afterTieMs = branchTieMs + 50;
  const afterTie1 = await withFrozenNow(afterTieMs, () =>
    archive.archive(branchTieSessionId, 'AFTER-TIE-1\n'),
  );
  const afterTie2 = await withFrozenNow(afterTieMs, () =>
    archive.archive(branchTieSessionId, 'AFTER-TIE-2\n'),
  );
  if (afterTie1.comparedTo !== branchWrite4.id) {
    fail(
      '#908の陰性対照B: 同着グループの直後、違うミリ秒の1本目は同着グループの最新行を直前とする',
      {
        branchWrite4,
        afterTie1,
      },
    );
  }
  if (afterTie2.comparedTo !== afterTie1.id) {
    fail(
      '#908の陰性対照B: 同着グループの直後の2本目は、枝番の大小(4 > 1)ではなくatの新しさで' +
        '直前(afterTie1。枝番1)を選ぶ——atを見ない変異はここで赤くなる',
      { branchWrite4, afterTie1, afterTie2 },
    );
  }

  const concurrentSessionId = 'archive-contract-concurrent-lock-window';
  const concurrentBase = 'CONCURRENT-CHAIN-LINE\n';
  const concurrentBodies = Array.from({ length: 8 }, (_, i) => concurrentBase.repeat((i + 1) * 20));
  const concurrentWrites = await Promise.all(
    concurrentBodies.map((b) => archive.archive(concurrentSessionId, b)),
  );
  const concurrentOldestFirst = (await archive.list())
    .filter((entry) => entry.sessionId === concurrentSessionId)
    .slice()
    .reverse();
  if (concurrentOldestFirst.length !== 8) {
    fail('#1732: 並行に積んだ8本が全部list()に出る（重複・欠落が無い）', concurrentOldestFirst);
  }
  for (let i = 0; i < concurrentOldestFirst.length; i += 1) {
    const entry = concurrentOldestFirst[i];
    if (entry === undefined) continue;
    const write = concurrentWrites.find((w) => w.id === entry.id);
    if (write === undefined) fail('#1732: list()の行がarchive()の戻り値のどれかと一致する', entry);
    const expectedComparedTo = i === 0 ? undefined : concurrentOldestFirst[i - 1]?.id;
    if ((write?.comparedTo ?? undefined) !== expectedComparedTo) {
      fail(
        '#1732: 並行に積んでも、comparedToはat昇順の直前の行のidと一致する' +
          '（一致しなければ、同じ「直前」を複数の呼び出しが同時に読む窓が塞がっていない）',
        { index: i, entry, write, expectedComparedTo },
      );
    }
  }

  const pruneDangerSessionId = 'archive-contract-concurrent-prune-danger';
  const pruneRow1 = await archive.archive(pruneDangerSessionId, 'AAAA\n');
  if (pruneRow1.continuity !== 'first') {
    fail('#1732: prune-danger シナリオの1本目はfirstで確定させる', pruneRow1);
  }
  const [pruneRow2, pruneRow3] = await Promise.all([
    archive.archive(pruneDangerSessionId, 'AAAA\nUNIQUE-CONTENT-B\n'),
    archive.archive(pruneDangerSessionId, 'AAAA\nDIFFERENT-BRANCH-C\n'),
  ]);
  const pruneDangerEntries = (await archive.list()).filter(
    (entry) => entry.sessionId === pruneDangerSessionId,
  );
  const pruneSelection = selectArchiveRemovalTargets(
    pruneDangerEntries,
    { sessionIds: [pruneDangerSessionId] },
    { requireContainment: true },
  );
  const pruneTargetIds = new Set(pruneSelection.targets.map((t) => t.id));
  if (pruneTargetIds.has(pruneRow2.id) || pruneTargetIds.has(pruneRow3.id)) {
    fail(
      '#1732: 互いに無関係な分岐を並行に積んでも、selectArchiveRemovalTargets' +
        '（requireContainment: true）はどちらも削除対象に選ばない' +
        '（選んだら、他のどこにも残っていない本文を持つ行を消してよいと言っていることになる）',
      { pruneRow2, pruneRow3, pruneSelection },
    );
  }

  const astralShortSessionId = 'archive-contract-astral-short-body';
  const astralShortBody = `${'\u{1F600}'.repeat(5)}\nKEEP`;
  const astralShortCodePoints = [...astralShortBody].length;
  if (astralShortCodePoints !== 10) {
    fail('#1829: 検査36の前提（本文のコードポイント数は10）が崩れている', {
      astralShortBody,
      astralShortCodePoints,
    });
  }
  const astralShortId = (await archive.archive(astralShortSessionId, astralShortBody)).id;
  const astralShortTail = await archive.readTail(astralShortId, astralShortCodePoints);
  if (astralShortTail.kind !== 'body') {
    fail('#1829: 検査36はbodyが返ることを前提にする', astralShortTail);
  }
  if (astralShortTail.body !== astralShortBody) {
    fail(
      '#1829: maxChars をコードポイント数で数えていれば、本文（コードポイント数' +
        '10）は maxChars(10) 以下なので全文が返るはず。UTF-16 コード単位（長さ15）' +
        'で数える実装は、ここで本文の先頭（絵文字）を静かに失う',
      { expected: astralShortBody, actual: astralShortTail.body },
    );
  }

  const astralTruncateSessionId = 'archive-contract-astral-truncate';
  const astralTruncateBody = '\u{1F600}'.repeat(10);
  const astralTruncateId = (await archive.archive(astralTruncateSessionId, astralTruncateBody)).id;
  const astralTruncateMaxChars = 6;
  const astralTruncateTail = await archive.readTail(astralTruncateId, astralTruncateMaxChars);
  if (astralTruncateTail.kind !== 'body') {
    fail('#1829: 検査37はbodyが返ることを前提にする', astralTruncateTail);
  }
  const expectedAstralTruncateTail = '\u{1F600}'.repeat(astralTruncateMaxChars + 1);
  if (astralTruncateTail.body !== expectedAstralTruncateTail) {
    fail(
      '#1829: 真に長い本文の切り詰めは、末尾から maxChars+1 個ぶんの完全な' +
        'コードポイント（サロゲートペアを割らない）と厳密に一致するはず。' +
        '孤立サロゲートを残す実装・単位を取り違えた実装はここで割れる',
      { expected: expectedAstralTruncateTail, actual: astralTruncateTail.body },
    );
  }
  const loneSurrogatePattern =
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
  if (loneSurrogatePattern.test(astralTruncateTail.body)) {
    fail('#1829: 切り詰めた本文に孤立サロゲート（不正なUTF-16）が残っている', {
      body: astralTruncateTail.body,
    });
  }

  {
    const nulId = 'archive-contract-n\u0000ul-id.jsonl';
    const outcomes: Array<[string, () => Promise<{ kind: string }>]> = [
      ['read(NULを含むid)', () => archive.read(nulId)],
      ['readTail(NULを含むid)', () => archive.readTail(nulId, 10)],
      ['remove(NULを含むid)', () => archive.remove(nulId)],
    ];
    for (const [label, call] of outcomes) {
      let outcome: { kind: string };
      try {
        outcome = await call();
      } catch (error) {
        fail(`${label}はmissingで投げない`, {
          投げた: error instanceof Error ? error.name : typeof error,
        });
      }
      if (outcome.kind !== 'missing') fail(`${label}はmissing`, outcome);
    }

    const written = await archive.archive('archive-contract-session-nulbody', 'A\u0000B\n');
    const readNul = await archive.read(written.id);
    if (readNul.kind !== 'body' || readNul.body !== 'AB\n')
      fail('本文のNULは落として残す(read)', readNul);
    const tailNul = await archive.readTail(written.id, 100);
    if (tailNul.kind !== 'body' || tailNul.body !== 'AB\n')
      fail('本文のNULは落として残す(readTail)', tailNul);
    const removedNul = await archive.remove(written.id);
    if (removedNul.kind !== 'removed' || removedNul.bytes !== 3)
      fail('本文のNULを落とした後のバイト数で消える', removedNul);
  }
}
