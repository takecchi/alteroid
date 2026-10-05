import { readConversationWindow } from './conversation.js';
import { compareIsoInstant } from './iso-instant.js';
import { expectNulRejected } from './nul-contract-support.js';
import type { ConversationReadStore, JournalStore } from './store.js';

/**
 * 会話の既読の位置（保存の型と、器の契約テスト）。
 *
 * ## 何を持つか
 *
 * 会話そのものは日誌の `exchange`（`with: 'human'`）の射影で、ここが持つのは
 * 「どこまで読んだか」だけである（`NotificationStore` と同じ流儀）。
 *
 * - **会話ごとの位置**: `conversationId` → `readThrough`（最後に読んだ発言の `at`）。
 *   **戻らない**。
 * - **基準時刻 `baseline`（全体で1つ）**: 位置の記録が無い会話は「`baseline` 以前の発言は
 *   既読、以後は未読」とする。導入した瞬間に過去の会話が未読だらけにならず、かつ導入後に
 *   クローンが新しく始めた会話は（位置が無くても）未読になる。**一度決まったら変えない**
 *   （`ensureBaseline` は無ければ入れ、在れば何もしない）。
 *
 * 既読は**全員で1組**（アカウントごとに分けない。PRD「非ゴール」の「利用者ごとにデータを
 * 分けない」の線）。
 */

/** 1つの会話の既読の位置。`readThrough` 以前（同時刻を含む）の発言は既読である。 */
export interface ConversationReadPosition {
  readThrough: string;
  /** 位置が最後に動いた時刻。 */
  updatedAt: string;
}

/**
 * 既読の記録の読み出し結果。
 *
 * **「無い」と「読めない」を分ける**（AGENTS.md「取れない軸に 0 の行を作る」）。
 * - `ok` かつ `baseline: null` かつ `positions` が空 — 何も記録していない（「無い」）
 * - `unreadable` — 記録は在るが読めない。`none` へ潰すと、全件が黙って未読へ戻ったことを
 *   誰も説明できない
 */
export type ConversationReadRead =
  | {
      state: 'ok';
      /** 基準時刻（まだ決まっていなければ `null`）。 */
      baseline: string | null;
      positions: Record<string, ConversationReadPosition>;
    }
  | { state: 'unreadable'; reason: string };

/**
 * 「会話ごとの、最後のクローン側発言の時刻」の索引（未読のある会話の数を、日誌を広く
 * 遡らずに数えるためのもの）。
 *
 * **日誌の写しであって真実ではない**（日誌から作り直せる）。`watermark` は「これ以前
 * （の少し手前まで）の日誌は索引へ取り込み済み」の印で、数えるたびに前回の続きから
 * 新しく積まれた分だけを日誌から読んで足す。基準時刻より前は取り込まない。
 */
export interface ConversationOutboundIndex {
  watermark: string | null;
  /** conversationId → その会話の最後のクローン側発言（`role: 'outbound'`）の `at`。 */
  lastOutbound: Record<string, string>;
}

export type ConversationOutboundIndexRead =
  ({ state: 'ok' } & ConversationOutboundIndex) | { state: 'unreadable'; reason: string };

/** `ensureBaseline` の結果。記録が読めないときは書き換えず、そう返す。 */
export type ConversationBaselineResult =
  { state: 'ok'; baseline: string } | { state: 'unreadable'; reason: string };

/**
 * 呼び出し側が数えるときに使う、既読の記録の写し（`ConversationReadRead` から作る）。
 *
 * `unreadable` が載っているとき、位置は全て無いものとして扱う（**全件を未読として
 * 数える**。知らせすぎる側へ倒す——知らせ損ねるほうが取り返しがつかない）。
 */
export interface ConversationReadView {
  baseline: string | null;
  positions: Readonly<Record<string, ConversationReadPosition>>;
  /** 記録が読めなかったときだけ載る理由。 */
  unreadable?: string;
}

/** 何も記録が無い写し。 */
export const EMPTY_CONVERSATION_READ_VIEW: ConversationReadView = {
  baseline: null,
  positions: {},
};

/**
 * 器から既読の記録を読む。**基準時刻が無ければ `now` で決めてから返す**
 * （どの経路でも基準時刻が決まる）。読めないときは書き換えず、`unreadable` を載せて返す。
 */
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

/**
 * `ConversationReadStore` の契約を、**実装1つに対して**測る（インメモリ・fs・pg の
 * 3実装が同じ関数を呼ぶ。`verifyNotificationStoreContract` と同じ理由）。
 *
 * **vitest に依存しない素の非同期関数にしてある。**
 *
 * ⚠️ 器は空（基準時刻も位置も無い）の状態で渡すこと。この関数は位置を進める。
 */
export async function verifyConversationReadStoreContract(
  store: ConversationReadStore,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`会話の既読の器の契約違反: ${message}`);
  }

  // --- 1. 空の器: 無い（ok・基準時刻 null・位置 0 件）。読めないではない ---
  const initial = await store.read();
  if (initial.state !== 'ok') fail(`空の器の read() が ok でない: ${initial.state}`);
  if (initial.baseline !== null) fail(`空の器に基準時刻が在る: ${initial.baseline}`);
  if (Object.keys(initial.positions).length !== 0) fail('空の器に位置が在る');

  // --- 2. 基準時刻は無ければ入れ、一度決まったら変わらない ---
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
  // 並行して入れても1つに決まる（器が別々の時刻で2度書かない）。
  const racing = await Promise.all([
    store.ensureBaseline('2026-10-01T00:00:30.000Z'),
    store.ensureBaseline('2026-10-01T00:00:40.000Z'),
  ]);
  for (const result of racing) {
    if (result.state !== 'ok' || compareIsoInstant(result.baseline, b1) !== 0) {
      fail(`並行の ensureBaseline() が決まった基準時刻を変えた: ${JSON.stringify(result)}`);
    }
  }

  // --- 3. 進めたら読み戻せる。会話ごとに独立 ---
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

  // --- 4. 戻らない（古い位置を渡しても、いまの位置のまま） ---
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

  // --- 5. 新しい位置へは進む。別の会話は動かない ---
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

  // --- 6. 並行に進めても単調（遅い側の古い位置で巻き戻らない） ---
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

  // --- 7. 位置を進めても基準時刻は変わらない ---
  if (
    afterRace.state !== 'ok' ||
    afterRace.baseline === null ||
    compareIsoInstant(afterRace.baseline, b1) !== 0
  ) {
    fail(`位置を進めたら基準時刻が変わった: ${JSON.stringify(afterRace)}`);
  }

  // --- 8. 索引（会話ごとの最後のクローン側発言の時刻）: 空 → 足す → 単調 → 消す ---
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
  // 索引は位置・基準時刻に触れない
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

  // --- 9. NUL（issue #2927。teto の判断、2026-10-05）: 会話 id は鍵なので断り、何も書かない ---
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

/** 未読のある会話の数の応答。 */
export interface UnreadConversationCount {
  count: number;
  /** 数え切れていない（`count` は下限）。 */
  capped: boolean;
  readStateUnreadable?: string;
}

/** 数えて返す会話数の上限。これを超えたら `capped`（UI は「N+」と出す）。 */
export const UNREAD_CONVERSATION_COUNT_CAP = 99;
/** 索引へ取り込むとき、日誌を1回に読む件数と、1回の呼び出しで読む回数の上限。 */
const INDEX_CHUNK = 500;
const INDEX_MAX_CHUNKS = 40;
/** 取り込み済みの印を「いま」より手前に置く幅（書き込みの完了が `at` より遅れても取りこぼさない）。 */
const WATERMARK_LAG_MS = 60_000;

function laterIso(a: string, b: string): string {
  return compareIsoInstant(a, b) >= 0 ? a : b;
}

/**
 * 未読のある会話の数（全会話で数える。左ナビの札用で、全ページから呼ばれる）。
 *
 * **日誌を広く遡らない。** 費用は「前回から新しく積まれた発言」の件数で決まる:
 * 1. 索引（会話ごとの最後のクローン側発言の時刻）の続きだけを日誌から読んで足す
 *    （`since` = 取り込み済みの印）。日誌が育っても、1回の費用は新しい分だけである
 * 2. 索引と既読の記録（位置と基準時刻の遅いほう）だけで数える
 *
 * 一覧の `unreadCount`（窓の中で見える発言を数える）との差が出うる条件: 編集で既定ビュー
 * から畳まれた返答が会話の最後のクローン側発言のとき（索引は畳みを知らない）。その会話を
 * 開いて既読にすれば揃う。
 *
 * `capped` になるのは、未読の会話が上限（`UNREAD_CONVERSATION_COUNT_CAP`）を超えるとき、または
 * 長い不在のあとの取り込みが1回の上限に収まらなかったとき（続きは次の呼び出しで読む）。
 */
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

  // 前回の続きから。基準時刻より前は取り込まない。
  const from =
    before.watermark === null ? view.baseline : laterIso(before.watermark, view.baseline);
  const found: Record<string, string> = {};
  // **古い順に、印から前へ向かって読む。** チャンクごとに確実に前進するので、不在の間に
  // 溜まった分が1回の上限の何倍あっても、呼び出しを重ねれば追いつく。印の時刻ちょうどの
  // 発言は再び読む（`since` は含む。索引への足し込みは冪等）。
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
      // **NUL を含む会話 id は索引へ入れない**（issue #2927。ストアは鍵の NUL を断る）。日誌から導く
      // 索引が1件の不正な id で毎回落ちると、全会話の未読数が出なくなる——その会話だけ数えない。
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
    // 読み切ったら「いま」の少し手前まで、読み切れなかったら読めた最後の発言の時刻まで進める
    // （次の呼び出しはそこから続ける）。
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
