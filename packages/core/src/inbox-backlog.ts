import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

/**
 * 受信箱（`InboxStore`）の滞留の内訳（#783 段0「測るだけ」）。
 *
 * ## なぜ在るのか
 *
 * `describeInboxBacklog`（`tools.ts`）はこれまで**件数と最古時刻の2つ**しか
 * 出していなかった。#783 が名指しした欠陥は「内訳を測る口がどの層にも無い」
 * ことで、クローンの受信箱に約6,200件・台帳に約6,700件が積み上がっても、
 * それが「同じ合図が何度も配り直されているだけ」なのか「本当に別件が
 * 6,200件」なのかが1文字も言えなかった。この段は**対策ではなく計器**を足す
 * ——何を積むかは決めず、いま何が積まれているかだけを数える。
 *
 * ## 4つの軸
 *
 * - **種類**（`byType`）: `InboxEvent['type']` ごとの件数
 * - **送信元**（`bySource`）: `external.source` / `manager_message.managerId`
 *   など、型ごとに「誰が積んだか」が言える型だけ数える（上位5件まで）
 * - **同一本文**（`distinct` / {@link inboxBacklogDedupeKey}）: `id` と `at`
 *   （1回の発行ごとに必ず変わる2つ）を除いた中身が同じなら同じ本文とみなし、
 *   畳んだら何件になるかを数える
 * - **配達回数**（`undelivered` / `deliveredOnce` / `redelivered`）と
 *   **齢**（`ageBuckets`）: `claimPending()` の doc が言う「配達回数は器が
 *   入れ替わった回数であって処理が落ちた回数ではない」を踏まえ、まだ一度も
 *   配っていないものと、配り直されているものを分けて見せる
 *
 * ## 純関数である
 *
 * ここは I/O をしない。読むのは呼び出し側（`tools.ts` の `manager_list` /
 * `situation.ts` は触らない——こちらは軽い `pending()` しか使わない）が
 * `InboxStore.peekPending()` で取った行を渡す。判定と副作用を分けておけば、
 * 歯を `InboxStore` の足場を組まずに分岐へ直接当てられる（`situation.ts` の
 * `describeSituation` と同じ作法）。
 */

/** `manager_list` で一覧の内訳を確かめるとき、これを超えたら「詰まり」と読む線。 */
export const INBOX_BACKLOG_LOUD_THRESHOLD = 50;

/**
 * `summarizeInboxBacklog` が出す内訳。
 *
 * ## 0を出す軸と、値を作らない軸
 *
 * ここで数えている4つの軸（種類・送信元・同一本文・配達回数・齢）は、
 * **`peekPending()` が返す行を1件も漏らさず全走査すれば必ず数え切れる**
 * ——`AGENTS.md`の地雷「取れない軸に0の行を作る」が指すのは*取れない*軸に
 * 値を作ることであって、ここは全部**実際に数え切れている**軸である。だから
 * 0件のバケツ・型・送信元を配列から省いても、それは「数えていない」の意味
 * にはならない——省いた分は `total` との算術（他の行を足せば `total` に
 * 一致する）で0だったと読める。この理由は `situation.ts` の `lost`（#688）が
 * 0のとき行を出さない理由と同じである
 * （逐語は `grep -Fn -- '**`lost`（判断待ち）だけは、0 のときに書かない（#688）。**' packages/core/src/situation.ts`）。
 */
export interface InboxBacklogBreakdown {
  readonly total: number;
  /** 1件も無ければ持たせない（0件のときに値を作らない。`InboxStore.pending` と同じ作法）。 */
  readonly oldestAt?: string;
  /** 件数0の型は載せない。 */
  readonly byType: readonly { readonly type: InboxEvent['type']; readonly count: number }[];
  /**
   * `external` の `source` / `manager_message` の `managerId` など、型ごとに
   * 「誰が積んだか」が言える型だけを数える。上位5件まで（同数なら名前順で
   * 安定させる）。件数0のものは載せない。
   */
  readonly bySource: readonly { readonly source: string; readonly count: number }[];
  /** `inboxBacklogDedupeKey` で畳んだ後の件数。 */
  readonly distinct: number;
  /** `deliveries === 0`（まだ一度も配っていない）。 */
  readonly undelivered: number;
  /** `deliveries === 1`。 */
  readonly deliveredOnce: number;
  /** `deliveries >= 2`（配り直されている）。 */
  readonly redelivered: number;
  readonly maxDeliveries: number;
  /** 件数0のバケツは載せない。 */
  readonly ageBuckets: readonly { readonly label: string; readonly count: number }[];
}

/** {@link summarizeInboxBacklog} が並べる齢バケツの境界と順序。 */
const AGE_BUCKET_LABELS = ['1時間未満', '1〜6時間', '6〜24時間', '24時間以上'] as const;

const HOUR_MS = 60 * 60 * 1000;

function ageBucketLabel(ageMs: number): (typeof AGE_BUCKET_LABELS)[number] {
  const hours = ageMs / HOUR_MS;
  if (hours < 1) return AGE_BUCKET_LABELS[0];
  if (hours < 6) return AGE_BUCKET_LABELS[1];
  if (hours < 24) return AGE_BUCKET_LABELS[2];
  return AGE_BUCKET_LABELS[3];
}

/**
 * この合図が「誰が積んだか」を言えるなら、その1語を返す。言えない型は
 * `undefined`——`bySource` から除かれる（0件として数えない。取れない軸に
 * 値を作らない側へ倒す）。
 *
 * `external` と `manager_message` の名前空間が衝突しないよう、種類の接頭辞を
 * 付ける（同じ文字列の `source` と `managerId` が同じ行に畳まれないため）。
 */
function inboxBacklogSourceFor(event: InboxEvent): string | undefined {
  switch (event.type) {
    case 'external':
      return `external:${event.source}`;
    case 'manager_message':
      return `manager:${event.managerId}`;
    case 'human_message':
    case 'human_answer':
    case 'distill':
    case 'timer':
    case 'self_initiative':
      return undefined;
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（source）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 「同じ本文か」を畳むための鍵。**このリポジトリで、この判定をするのはここ
 * 1箇所だけである。SQL 側に同じ判定を書かないこと。**
 *
 * ## なぜ1箇所に閉じるか —— #783 が名指しした欠陥の形そのもの
 *
 * `packages/core/src/manager.ts` の `#rateLimits`（鍵は枠の種類・Pool 全体で
 * 1つ）と `#queueSynthesizedNotice`（鍵は `managerId`・マネージャーごと）は、
 * 同じ「畳み込み」という操作を**別々の鍵**で行っている。畳み込みが2つの
 * 別の鍵で割れると、増える側（積む判定）と減る側（消す・数える判定）が
 * 食い違いうる——これがまさに #783 が「内訳を測る口が無い」と言った症状の
 * 裏側にある形である。だからここでは集計（`summarizeInboxBacklog`）を core の
 * 純関数1本に閉じ、ストア（fs / pg）は行を返すだけにする。
 *
 * ## 鍵の作り方
 *
 * `id` と `at`（1回の発行ごとに必ず変わる2つ）を除いた中身から作る。区切りは
 * 半角スペース1文字。**`switch (event.type)` で書き、網羅性を型で強制する**
 * ——新しい合図の型が足されたら、この関数を含むファイルの `typecheck` が
 * 落ちる（`AGENTS.md`「テストを弱めずに直す」の #285 と同じ作法。実行時の
 * 倒れ先は default 節で throw する——この repo の同じ union に対する既存の
 * 倒れ先（`clone.ts` の `#dispatch` の `default`）と同じ形である）。
 *
 * ## 2つの限界
 *
 * - **区切りが半角スペース1文字なので、フィールドの境界がずれて衝突しうる**
 *   （例: `a` と `' b'` の2フィールドと、`'a '` と `b` の2フィールドは同じ
 *   文字列になる）。本文に区切り文字そのものが含まれるケースを厳密に分ける
 *   必要はない——ここは「詰まっているらしさ」を掴む計器であって、台帳の
 *   一意性を保証する鍵ではない
 * - **`external.payload` は `JSON.stringify` で鍵に含めるが、オブジェクトの
 *   キー順に依存する。** 同じコード経路（同じ webhook ハンドラなど）が作った
 *   同形のオブジェクトなら安定するが、一般には保証されない——キー順が違う
 *   同じ中身の2件を、ここでは「別の本文」として数えることがある
 */
export function inboxBacklogDedupeKey(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return [event.type, event.conversationId, event.text].join(' ');
    case 'human_answer':
      return [event.type, event.approvalId, event.answer].join(' ');
    case 'manager_message':
      return [event.type, event.managerId, event.kind, event.text].join(' ');
    case 'external':
      return [event.type, event.source, JSON.stringify(event.payload ?? null)].join(' ');
    case 'timer':
      return [event.type, event.kind, event.target ?? '', event.cause ?? 'schedule'].join(' ');
    case 'self_initiative':
      return [event.type, event.reason, event.cause ?? 'schedule'].join(' ');
    case 'distill':
      return [event.type, event.reason].join(' ');
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（dedupeKey）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 上位N件・同数は名前順で安定させる、共通の並べ替え。 */
function topByCount<T extends { readonly count: number }>(
  entries: readonly T[],
  nameOf: (entry: T) => string,
  limit?: number,
): T[] {
  const sorted = [...entries].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return nameOf(a).localeCompare(nameOf(b));
  });
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** `InboxEvent['type']` の並び順（`schema.ts` の `inboxEventSchema` の判別子の並びと揃える）。 */
const INBOX_EVENT_TYPE_ORDER: readonly InboxEvent['type'][] = [
  'human_message',
  'human_answer',
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
];

/**
 * `peekPending()` が返した行から内訳を作る（純関数。I/O をしない）。
 *
 * @param now 齢バケツの基準時刻（epoch ミリ秒）。呼び出し側が渡す
 *   （`Date.now()` を直接呼ばないことでテストから固定できる）。
 */
export function summarizeInboxBacklog(
  rows: readonly PendingInboxEvent[],
  now: number,
): InboxBacklogBreakdown {
  const total = rows.length;

  const oldestAt = rows.reduce<string | undefined>(
    (min, row) => (min === undefined || row.at < min ? row.at : min),
    undefined,
  );

  const byTypeCounts = new Map<InboxEvent['type'], number>();
  const bySourceCounts = new Map<string, number>();
  const dedupeKeys = new Set<string>();
  const ageBucketCounts = new Map<string, number>();
  let undelivered = 0;
  let deliveredOnce = 0;
  let redelivered = 0;
  let maxDeliveries = 0;

  for (const row of rows) {
    byTypeCounts.set(row.event.type, (byTypeCounts.get(row.event.type) ?? 0) + 1);

    const source = inboxBacklogSourceFor(row.event);
    if (source !== undefined) bySourceCounts.set(source, (bySourceCounts.get(source) ?? 0) + 1);

    dedupeKeys.add(inboxBacklogDedupeKey(row.event));

    if (row.deliveries === 0) undelivered += 1;
    else if (row.deliveries === 1) deliveredOnce += 1;
    else redelivered += 1;
    if (row.deliveries > maxDeliveries) maxDeliveries = row.deliveries;

    const ageMs = now - new Date(row.at).getTime();
    const bucket = ageBucketLabel(ageMs);
    ageBucketCounts.set(bucket, (ageBucketCounts.get(bucket) ?? 0) + 1);
  }

  const byType = INBOX_EVENT_TYPE_ORDER.filter((type) => (byTypeCounts.get(type) ?? 0) > 0).map(
    (type) => ({ type, count: byTypeCounts.get(type) ?? 0 }),
  );

  const bySource = topByCount(
    [...bySourceCounts.entries()].map(([source, count]) => ({ source, count })),
    (entry) => entry.source,
    5,
  );

  const ageBuckets = AGE_BUCKET_LABELS.filter((label) => (ageBucketCounts.get(label) ?? 0) > 0).map(
    (label) => ({ label, count: ageBucketCounts.get(label) ?? 0 }),
  );

  return {
    total,
    ...(oldestAt === undefined ? {} : { oldestAt }),
    byType,
    bySource,
    distinct: dedupeKeys.size,
    undelivered,
    deliveredOnce,
    redelivered,
    maxDeliveries,
    ageBuckets,
  };
}

/**
 * 内訳を文へ描く。**`manager_list` の一覧本文へそのまま足す前提**——本文は
 * 1文字も載せない（合図の `text` / `payload` は集計値の中でしか使わない。
 * `AGENTS.md` の地雷「エージェントへ返す一覧に本文を全文で載せる」に触れない）。
 *
 * **必ず `total` を出す。** `byType` / `bySource` / `ageBuckets` は0件を省く
 * ので、残りを足せば `total` に一致することで「省かれた行は0だった」と算術で
 * 読める形にする（{@link InboxBacklogBreakdown} の doc、`situation.ts` の
 * `lost` と同じ理由）。
 */
export function describeInboxBacklogBreakdown(b: InboxBacklogBreakdown): string {
  const byTypeText =
    b.byType.length === 0 ? '（無し）' : b.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const bySourceText =
    b.bySource.length === 0
      ? '（source/managerId を持つ型は無い）'
      : b.bySource.map((e) => `${e.source} ${e.count}`).join(' / ');
  const ageBucketsText =
    b.ageBuckets.length === 0
      ? '（無し）'
      : b.ageBuckets.map((e) => `${e.label} ${e.count}`).join(' / ');

  return [
    `内訳（計 ${b.total} 件）:`,
    `種類: ${byTypeText}`,
    `送信元（上位5件。source/managerIdを持つ型のみ）: ${bySourceText}`,
    `同一本文（id/at を除いた中身）を畳むと ${b.distinct} 件`,
    `配達回数: 未配達 ${b.undelivered} / 1回 ${b.deliveredOnce} / 2回以上 ${b.redelivered}（最大 ${b.maxDeliveries}）`,
    `齢: ${ageBucketsText}`,
  ].join('\n');
}
