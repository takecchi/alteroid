import { compareIsoInstant } from './iso-instant.js';
import type { ConversationReadStore } from './store.js';

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
}
