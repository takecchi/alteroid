import { readConversationWindow } from './conversation.js';
import { compareIsoInstant } from './iso-instant.js';
import { expectNulRejected } from './nul-contract-support.js';
import type { ConversationReadStore, JournalStore } from './store.js';

export interface ConversationReadPosition {
  readThrough: string;
  updatedAt: string;
}

// 「無い」と「読めない」を分ける: unreadable を none へ潰すと、全件が黙って未読へ戻ったことを誰も説明できないため
export type ConversationReadRead =
  | {
      state: 'ok';
      baseline: string | null;
      positions: Record<string, ConversationReadPosition>;
    }
  | { state: 'unreadable'; reason: string };

export interface ConversationOutboundIndex {
  watermark: string | null;
  lastOutbound: Record<string, string>;
}

export type ConversationOutboundIndexRead =
  ({ state: 'ok' } & ConversationOutboundIndex) | { state: 'unreadable'; reason: string };

export type ConversationBaselineResult =
  { state: 'ok'; baseline: string } | { state: 'unreadable'; reason: string };

// unreadable のとき全件を未読として数える: 知らせすぎる側へ倒す。知らせ損ねるほうが取り返しがつかないため
export interface ConversationReadView {
  baseline: string | null;
  positions: Readonly<Record<string, ConversationReadPosition>>;
  unreadable?: string;
}

export const EMPTY_CONVERSATION_READ_VIEW: ConversationReadView = {
  baseline: null,
  positions: {},
};

export async function loadConversationReadView(
  store: ConversationReadStore,
  now: string,
): Promise<ConversationReadView> {
  const ensured = await store.ensureBaseline(now);
  if (ensured.state === 'unreadable') {
    return { baseline: null, positions: {}, unreadable: ensured.reason };
  }
  const read = await store.read();
  if (read.state === 'unreadable') {
    return { baseline: null, positions: {}, unreadable: read.reason };
  }
  return { baseline: read.baseline ?? ensured.baseline, positions: read.positions };
}

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

export interface UnreadConversationCount {
  count: number;
  capped: boolean;
  readStateUnreadable?: string;
}

export const UNREAD_CONVERSATION_COUNT_CAP = 99;
const INDEX_CHUNK = 500;
const INDEX_MAX_CHUNKS = 40;
// 取り込み済みの印を「いま」より手前に置く: 書き込みの完了が at より遅れても取りこぼさないため
const WATERMARK_LAG_MS = 60_000;

function laterIso(a: string, b: string): string {
  return compareIsoInstant(a, b) >= 0 ? a : b;
}

// 日誌を広く遡らない: 索引の続きだけを読んで足し、日誌が育っても1回の費用を新しい分だけにするため
export async function countUnreadConversations(
  deps: { journal: Pick<JournalStore, 'list'>; reads: ConversationReadStore; now: string },
  options: { cap?: number; chunk?: number; maxChunks?: number } = {},
): Promise<UnreadConversationCount> {
  const cap = options.cap ?? UNREAD_CONVERSATION_COUNT_CAP;
  const chunk = options.chunk ?? INDEX_CHUNK;
  const maxChunks = options.maxChunks ?? INDEX_MAX_CHUNKS;
  const { journal, reads, now } = deps;

  const view = await loadConversationReadView(reads, now);
  if (view.unreadable !== undefined || view.baseline === null) {
    return { count: 0, capped: false, readStateUnreadable: view.unreadable ?? '基準時刻が無い' };
  }
  const before = await reads.readOutboundIndex();
  if (before.state === 'unreadable') {
    return { count: 0, capped: false, readStateUnreadable: before.reason };
  }

  const from =
    before.watermark === null ? view.baseline : laterIso(before.watermark, view.baseline);
  const found: Record<string, string> = {};
  // 古い順に印から前へ向かって読む: チャンクごとに確実に前進し、溜まった分が1回の上限の何倍あっても呼び出しを重ねれば追いつくため
  let after: { id: string; at: string } | undefined;
  let lastAt: string | null = null;
  let complete = false;
  for (let i = 0; i < maxChunks; i += 1) {
    const rows = await readConversationWindow(journal, {
      scan: chunk,
      since: from,
      order: 'asc',
      ...(after === undefined ? {} : { after }),
    });
    for (const row of rows) {
      if (row.type !== 'exchange' || row.role !== 'outbound' || row.conversationId === undefined) {
        continue;
      }
      // NUL を含む会話 id を索引へ入れない: ストアが鍵の NUL を断り、1件の不正な id で毎回落ちると全会話の未読数が出なくなるため
      if (row.conversationId.includes('\u0000')) continue;
      const known = found[row.conversationId];
      if (known === undefined || compareIsoInstant(row.at, known) > 0) {
        found[row.conversationId] = row.at;
      }
    }
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      lastAt = last.at;
      after = { id: last.id, at: last.at };
    }
    if (rows.length < chunk) {
      complete = true;
      break;
    }
  }
  const lagged = new Date(Date.parse(now) - WATERMARK_LAG_MS).toISOString();
  await reads.mergeOutboundIndex({
    watermark: complete ? laterIso(from, lagged) : lastAt,
    lastOutbound: found,
  });

  const index = await reads.readOutboundIndex();
  if (index.state === 'unreadable') {
    return { count: 0, capped: false, readStateUnreadable: index.reason };
  }
  let count = 0;
  for (const [conversationId, lastAt] of Object.entries(index.lastOutbound)) {
    const position = view.positions[conversationId]?.readThrough;
    const floor = position === undefined ? view.baseline : laterIso(position, view.baseline);
    if (compareIsoInstant(lastAt, floor) > 0) count += 1;
  }
  const over = count > cap;
  return { count: over ? cap : count, capped: over || !complete };
}
