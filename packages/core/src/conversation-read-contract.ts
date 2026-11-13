import { compareIsoInstant } from './iso-instant.js';
import { expectNulRejected } from './nul-contract-support.js';
import type { ConversationReadStore } from './store.js';

// vitest に依存しない素の非同期関数にする。器は空の状態で渡す: この関数は位置を進めるため
export async function verifyConversationReadStoreContract(
  store: ConversationReadStore,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`会話の既読の器の契約違反: ${message}`);
  }

  const initial = await store.read();
  if (initial.state !== 'ok') fail(`空の器の read() が ok でない: ${initial.state}`);
  if (initial.baseline !== null) fail(`空の器に基準時刻が在る: ${initial.baseline}`);
  if (Object.keys(initial.positions).length !== 0) fail('空の器に位置が在る');

  const b1 = '2026-10-01T00:00:10.000Z';
  const first = await store.ensureBaseline(b1);
  if (first.state !== 'ok' || compareIsoInstant(first.baseline, b1) !== 0) {
    fail(`ensureBaseline() が渡した時刻で決まらない: ${JSON.stringify(first)}`);
  }
  const second = await store.ensureBaseline('2026-10-01T00:00:20.000Z');
  if (second.state !== 'ok' || compareIsoInstant(second.baseline, b1) !== 0) {
    fail(`基準時刻が2度目の ensureBaseline() で変わった: ${JSON.stringify(second)}`);
  }
  const afterBaseline = await store.read();
  if (
    afterBaseline.state !== 'ok' ||
    afterBaseline.baseline === null ||
    compareIsoInstant(afterBaseline.baseline, b1) !== 0
  ) {
    fail(`基準時刻を読み戻せない: ${JSON.stringify(afterBaseline)}`);
  }
  const racing = await Promise.all([
    store.ensureBaseline('2026-10-01T00:00:30.000Z'),
    store.ensureBaseline('2026-10-01T00:00:40.000Z'),
  ]);
  for (const result of racing) {
    if (result.state !== 'ok' || compareIsoInstant(result.baseline, b1) !== 0) {
      fail(`並行の ensureBaseline() が決まった基準時刻を変えた: ${JSON.stringify(result)}`);
    }
  }

  const t1 = '2026-10-01T00:00:01.000Z';
  const advanced = await store.advance('c-a', t1);
  if (compareIsoInstant(advanced.readThrough, t1) !== 0) {
    fail(`advance() の返り値が渡した位置と違う: ${advanced.readThrough}`);
  }
  if (Number.isNaN(Date.parse(advanced.updatedAt))) fail('updatedAt が時刻として読めない');
  const reread = await store.read();
  const readA = reread.state === 'ok' ? reread.positions['c-a'] : undefined;
  if (readA === undefined || compareIsoInstant(readA.readThrough, t1) !== 0) {
    fail(`進めた位置を読み戻せない: ${JSON.stringify(reread)}`);
  }
  if (reread.state === 'ok' && reread.positions['c-b'] !== undefined) {
    fail('進めていない会話に位置が在る');
  }

  const older = await store.advance('c-a', '2026-10-01T00:00:00.000Z');
  if (compareIsoInstant(older.readThrough, t1) !== 0) {
    fail(`古い位置で巻き戻った（返り値）: ${older.readThrough}`);
  }
  const same = await store.advance('c-a', t1);
  if (compareIsoInstant(same.readThrough, t1) !== 0) fail('同じ位置で値が変わった');
  const afterOlder = await store.read();
  const olderA = afterOlder.state === 'ok' ? afterOlder.positions['c-a'] : undefined;
  if (olderA === undefined || compareIsoInstant(olderA.readThrough, t1) !== 0) {
    fail(`古い位置で巻き戻った（読み戻し）: ${JSON.stringify(afterOlder)}`);
  }

  const t2 = '2026-10-01T00:00:02.000Z';
  await store.advance('c-b', '2026-10-01T00:00:05.000Z');
  await store.advance('c-a', t2);
  const afterNewer = await store.read();
  if (afterNewer.state !== 'ok') fail(`読めない: ${afterNewer.reason}`);
  const newerA = afterNewer.positions['c-a'];
  const newerB = afterNewer.positions['c-b'];
  if (newerA === undefined || compareIsoInstant(newerA.readThrough, t2) !== 0) {
    fail(`新しい位置へ進まない: ${JSON.stringify(afterNewer)}`);
  }
  if (
    newerB === undefined ||
    compareIsoInstant(newerB.readThrough, '2026-10-01T00:00:05.000Z') !== 0
  ) {
    fail(`別の会話を進めたら、この会話の位置が動いた: ${JSON.stringify(afterNewer)}`);
  }

  await Promise.all([
    store.advance('c-c', '2026-10-01T00:00:03.000Z'),
    store.advance('c-c', '2026-10-01T00:00:01.000Z'),
    store.advance('c-c', '2026-10-01T00:00:02.000Z'),
  ]);
  const afterRace = await store.read();
  const raceC = afterRace.state === 'ok' ? afterRace.positions['c-c'] : undefined;
  if (
    raceC === undefined ||
    compareIsoInstant(raceC.readThrough, '2026-10-01T00:00:03.000Z') !== 0
  ) {
    fail(`並行の advance() で巻き戻った: ${JSON.stringify(afterRace)}`);
  }

  if (
    afterRace.state !== 'ok' ||
    afterRace.baseline === null ||
    compareIsoInstant(afterRace.baseline, b1) !== 0
  ) {
    fail(`位置を進めたら基準時刻が変わった: ${JSON.stringify(afterRace)}`);
  }

  const emptyIndex = await store.readOutboundIndex();
  if (
    emptyIndex.state !== 'ok' ||
    emptyIndex.watermark !== null ||
    Object.keys(emptyIndex.lastOutbound).length !== 0
  ) {
    fail(`空の器の索引が空でない: ${JSON.stringify(emptyIndex)}`);
  }
  await store.mergeOutboundIndex({
    watermark: '2026-10-01T00:01:00.000Z',
    lastOutbound: { 'c-a': '2026-10-01T00:00:50.000Z' },
  });
  await store.mergeOutboundIndex({
    watermark: '2026-10-01T00:00:30.000Z',
    lastOutbound: { 'c-a': '2026-10-01T00:00:40.000Z', 'c-b': '2026-10-01T00:00:45.000Z' },
  });
  await store.mergeOutboundIndex({ watermark: null, lastOutbound: {} });
  const merged = await store.readOutboundIndex();
  if (
    merged.state !== 'ok' ||
    merged.watermark === null ||
    compareIsoInstant(merged.watermark, '2026-10-01T00:01:00.000Z') !== 0 ||
    compareIsoInstant(
      merged.lastOutbound['c-a'] ?? '1970-01-01T00:00:00.000Z',
      '2026-10-01T00:00:50.000Z',
    ) !== 0 ||
    compareIsoInstant(
      merged.lastOutbound['c-b'] ?? '1970-01-01T00:00:00.000Z',
      '2026-10-01T00:00:45.000Z',
    ) !== 0
  ) {
    fail(`索引が単調に足されない（古い値で戻った・足した分が消えた）: ${JSON.stringify(merged)}`);
  }
  const afterIndex = await store.read();
  if (
    afterIndex.state !== 'ok' ||
    afterIndex.baseline === null ||
    compareIsoInstant(afterIndex.baseline, b1) !== 0 ||
    afterIndex.positions['c-a'] === undefined
  ) {
    fail('索引を足したら位置か基準時刻が変わった');
  }
  await store.clearOutboundIndex();
  const cleared = await store.readOutboundIndex();
  if (
    cleared.state !== 'ok' ||
    cleared.watermark !== null ||
    Object.keys(cleared.lastOutbound).length !== 0
  ) {
    fail(`clearOutboundIndex() の後に索引が残る: ${JSON.stringify(cleared)}`);
  }

  const beforeNul = await store.read();
  await expectNulRejected(
    fail,
    'advanceの会話idのNUL',
    () => store.advance('c-\u0000-nul', '2026-10-01T00:05:00.000Z'),
    'c-',
  );
  await expectNulRejected(
    fail,
    'mergeOutboundIndexの会話idのNUL',
    () =>
      store.mergeOutboundIndex({
        watermark: null,
        lastOutbound: {
          'c-ok': '2026-10-01T00:05:00.000Z',
          'c-\u0000-nul': '2026-10-01T00:05:00.000Z',
        },
      }),
    'c-',
  );
  const afterNul = await store.read();
  const indexAfterNul = await store.readOutboundIndex();
  if (
    JSON.stringify(afterNul) !== JSON.stringify(beforeNul) ||
    indexAfterNul.state !== 'ok' ||
    Object.keys(indexAfterNul.lastOutbound).length !== 0
  ) {
    fail('NULで断ったのに何かを書いた');
  }
}
