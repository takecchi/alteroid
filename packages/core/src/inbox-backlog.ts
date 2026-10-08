import { z } from 'zod';

import { isDaemonSelfNotice } from './daemon-self-notice.js';
import { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
import type { InboxEvent, UnreadableInboxEvent } from './schema.js';
import { describeUnreadableInboxEvents } from './store.js';
import type { PendingInboxEvent } from './store.js';

export const INBOX_BACKLOG_LOUD_THRESHOLD = 50;

export interface InboxBacklogBreakdown {
  readonly total: number;
  readonly oldestAt?: string;
  readonly byType: readonly { readonly type: InboxEvent['type']; readonly count: number }[];
  readonly bySource: readonly { readonly source: string; readonly count: number }[];
  readonly bySourceOverflowKinds: number;
  readonly bySourceOverflowCount: number;
  readonly bySourceUnknownCount: number;
  readonly distinct: number;
  // `inboxBacklogDedupeKey` 自体を変えない: `distinct` の意味を動かすと、前提にしている呼び出し側・doc・テストが黙って意味を変えるため
  readonly distinctAcrossManagers: number;
  readonly undelivered: number;
  readonly deliveredOnce: number;
  readonly redelivered: number;
  readonly maxDeliveries: number;
  readonly undeliveredByType: readonly {
    readonly type: InboxEvent['type'];
    readonly count: number;
  }[];
  readonly ageBuckets: readonly { readonly label: string; readonly count: number }[];
  readonly observedAt: string;
  readonly humanOriginated: {
    readonly total: number;
    readonly byType: readonly {
      readonly type: 'human_message' | 'human_answer';
      readonly count: number;
    }[];
    readonly oldestAt?: string;
    readonly undelivered: number;
  };
  readonly unreadable?: readonly UnreadableInboxEvent[];
}

// `external` や `timer` を足さない: 割り込みの量が機械の速さで決まるようになり、人間以外が餓死しない根拠（人間の速さでしか来ない）が消えるため
// `clone.ts` に置かない: `clone.ts` が既にこのファイルを import しており、逆向きの import は循環になるため
export function isHumanOriginated(event: InboxEvent): boolean {
  return event.type === 'human_message' || event.type === 'human_answer';
}

const AGE_BUCKET_LABELS = ['1時間未満', '1〜6時間', '6〜24時間', '24時間以上'] as const;

const HOUR_MS = 60 * 60 * 1000;

function ageBucketLabel(ageMs: number): (typeof AGE_BUCKET_LABELS)[number] {
  const hours = ageMs / HOUR_MS;
  if (hours < 1) return AGE_BUCKET_LABELS[0];
  if (hours < 6) return AGE_BUCKET_LABELS[1];
  if (hours < 24) return AGE_BUCKET_LABELS[2];
  return AGE_BUCKET_LABELS[3];
}

export function inboxBacklogSourceFor(event: InboxEvent): string | undefined {
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

// 区切りは半角スペースにしない: ほぼ全ての本文に含まれて境界がずれ、別の本文が同じ鍵へ潰れて `distinct` が小さく出る偏りが大きくなるため
const DEDUPE_SEPARATOR = '\u0000';

// SQL 側に同じ判定を書かない: 畳み込みが別々の鍵で割れると、増える側と減る側が食い違うため
export function inboxBacklogDedupeKey(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return [event.type, event.conversationId, event.text].join(DEDUPE_SEPARATOR);
    case 'human_answer':
      return [event.type, event.approvalId, event.answer].join(DEDUPE_SEPARATOR);
    case 'manager_message':
      return [event.type, event.managerId, event.kind, event.text].join(DEDUPE_SEPARATOR);
    case 'external':
      // `identity` が在れば `payload` を鍵に含めない: `payload` の中身は畳んだ件数などで揺れうるため
      return [
        event.type,
        event.source,
        event.identity ?? JSON.stringify(event.payload ?? null),
        // 添付の id を鍵に含める: 本文が同じでも添付が違う合図を同じ中身と見なすと、束ね読みが片方の添付を黙って落とすため
        ...(event.attachments === undefined || event.attachments.length === 0
          ? []
          : [event.attachments.map((ref) => ref.id).join(',')]),
      ].join(DEDUPE_SEPARATOR);
    case 'timer':
      return [event.type, event.kind, event.target ?? '', event.cause ?? 'schedule'].join(
        DEDUPE_SEPARATOR,
      );
    case 'self_initiative':
      return [event.type, event.reason, event.cause ?? 'schedule'].join(DEDUPE_SEPARATOR);
    case 'distill':
      return [event.type, event.reason].join(DEDUPE_SEPARATOR);
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（dedupeKey）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// 外から来た `external` や人間の発言は畳まない: 同文の2件が「1つの出来事が2回届いた」のか「2回起きた」のか、受け手に区別する手段が無いため
// 鍵を `inboxBacklogDedupeKey` へ委譲し、2本目の `switch` を書かない: 判定が2箇所に分かれると、増える側と減る側が食い違うため
export function inboxCollapseKey(event: InboxEvent): string | undefined {
  if (event.type === 'manager_message') return inboxBacklogDedupeKey(event);

  if (event.type === 'external' && isDaemonSelfNotice(event)) {
    if (event.identity !== undefined) {
      return [event.type, event.source, event.identity].join(DEDUPE_SEPARATOR);
    }
    let serializedPayload: string;
    try {
      serializedPayload = JSON.stringify(event.payload ?? null);
    } catch {
      // 直列化できない payload は畳まない側へ倒す: `post()` が落ちるより、受信箱の行が増えるほうが安全なため
      return undefined;
    }
    return [event.type, event.source, serializedPayload].join(DEDUPE_SEPARATOR);
  }

  return undefined;
}

// 跨いだ鍵を制御に使わず計器のままにする: 受信箱と台帳で鍵の粗さが違うと畳み方が食い違い、跨ぐと「どの委譲が落ちたか」の名指しが消えるため
export function inboxBacklogCrossManagerDedupeKey(event: InboxEvent): string {
  if (event.type !== 'manager_message') return inboxBacklogDedupeKey(event);
  return [event.type, event.kind, event.text].join(DEDUPE_SEPARATOR);
}

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

export const INBOX_BACKLOG_LOUD_TYPE_FOLD_AT = 3;

export function foldInboxBacklogByType(
  byType: readonly { readonly type: InboxEvent['type']; readonly count: number }[],
  foldAt: number = INBOX_BACKLOG_LOUD_TYPE_FOLD_AT,
): string {
  if (byType.length === 0) return '（無し）';
  const sorted = topByCount(byType, (entry) => entry.type);
  const top = sorted.slice(0, foldAt);
  const rest = sorted.slice(foldAt);
  const topText = top.map((entry) => `${entry.type} ${entry.count}`).join(' / ');
  if (rest.length === 0) return topText;
  const restTotal = rest.reduce((sum, entry) => sum + entry.count, 0);
  return `${topText} / 他 ${rest.length} 種 ${restTotal} 件`;
}

export const INBOX_EVENT_TYPE_ORDER = [
  'human_message',
  'human_answer',
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const satisfies readonly InboxEvent['type'][];

// 人間起点の合図を除く: 「人間が私に届けたものを、私が黙って捨てる」経路を構造的に消すため
export const CLONE_REMOVABLE_INBOX_EVENT_TYPES = [
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const satisfies readonly Exclude<InboxEvent['type'], 'human_message' | 'human_answer'>[];

export function buildInboxEventTypesSchema(allowed: readonly InboxEvent['type'][]) {
  return z.array(z.enum(allowed)).min(1);
}

export const inboxRemoveManyTypesSchema = buildInboxEventTypesSchema(
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
);

export interface InboxRemoveManyFilter {
  readonly types: readonly InboxEvent['type'][];
  // 送信元を言えない型は `sources` を渡すと必ず対象から外す: 「送信元不明」を一致側へ含めると、一括削除が申告より広い範囲を消すため
  readonly sources?: readonly string[];
  readonly before?: string;
}

export function matchesInboxRemoveManyFilter(
  row: PendingInboxEvent,
  filter: InboxRemoveManyFilter,
): boolean {
  if (!filter.types.includes(row.event.type)) return false;
  if (filter.sources !== undefined) {
    const source = inboxBacklogSourceFor(row.event);
    if (source === undefined || !filter.sources.includes(source)) return false;
  }
  if (filter.before !== undefined && Date.parse(row.at) > Date.parse(filter.before)) return false;
  return true;
}

export interface InboxDeliveryStopper {
  dropQueuedInboxEvents(ids: readonly string[]): Promise<number>;
}

// 消す口を関数1本に寄せる: 配達を止める呼びを作法として足すと、直し忘れた箇所に同じ穴が戻っても赤くならないため
// 「器から消す」→「配達を止める」の順を逆にしない: 配達を止めた直後に器の削除が失敗すると、その合図が配られもせず器にも残らず静かに失われるため
// 配達停止を掛けるのは実際に消えた id だけ: 器に行が残るものの配達を止めると、誰も処理しない仕事になるため
export async function removeInboxEventsAndStopDelivery(
  inbox: { removeMany(ids: readonly string[]): Promise<string[]> },
  delivery: InboxDeliveryStopper,
  ids: readonly string[],
): Promise<{ removedIds: string[]; droppedFromDelivery: number }> {
  const removedIds = await inbox.removeMany(ids);
  if (removedIds.length === 0) return { removedIds, droppedFromDelivery: 0 };
  const droppedFromDelivery = await delivery.dropQueuedInboxEvents(removedIds);
  return { removedIds, droppedFromDelivery };
}

export function summarizeInboxBacklog(
  rows: readonly PendingInboxEvent[],
  now: number,
  unreadable: readonly UnreadableInboxEvent[] = [],
): InboxBacklogBreakdown {
  const total = rows.length;

  // 文字列の `<` で比べない: `+09:00` と `Z` の行が同居すると取り違えるため
  const oldestAt = earliestIsoInstant(rows.map((row) => row.at));

  const byTypeCounts = new Map<InboxEvent['type'], number>();
  const bySourceCounts = new Map<string, number>();
  const dedupeKeys = new Set<string>();
  const crossManagerDedupeKeys = new Set<string>();
  const ageBucketCounts = new Map<string, number>();
  const undeliveredByTypeCounts = new Map<InboxEvent['type'], number>();
  let undelivered = 0;
  let deliveredOnce = 0;
  let redelivered = 0;
  let maxDeliveries = 0;
  let bySourceUnknownCount = 0;
  const humanOriginatedByTypeCounts = new Map<'human_message' | 'human_answer', number>();
  let humanOriginatedTotal = 0;
  let humanOriginatedUndelivered = 0;
  let humanOriginatedOldestAt: string | undefined;

  for (const row of rows) {
    byTypeCounts.set(row.event.type, (byTypeCounts.get(row.event.type) ?? 0) + 1);

    const source = inboxBacklogSourceFor(row.event);
    if (source !== undefined) bySourceCounts.set(source, (bySourceCounts.get(source) ?? 0) + 1);
    else bySourceUnknownCount += 1;

    dedupeKeys.add(inboxBacklogDedupeKey(row.event));
    crossManagerDedupeKeys.add(inboxBacklogCrossManagerDedupeKey(row.event));

    if (row.deliveries === 0) {
      undelivered += 1;
      undeliveredByTypeCounts.set(
        row.event.type,
        (undeliveredByTypeCounts.get(row.event.type) ?? 0) + 1,
      );
    } else if (row.deliveries === 1) deliveredOnce += 1;
    else redelivered += 1;
    if (row.deliveries > maxDeliveries) maxDeliveries = row.deliveries;

    const ageMs = now - new Date(row.at).getTime();
    const bucket = ageBucketLabel(ageMs);
    ageBucketCounts.set(bucket, (ageBucketCounts.get(bucket) ?? 0) + 1);

    if (isHumanOriginated(row.event)) {
      humanOriginatedTotal += 1;
      const humanType = row.event.type as 'human_message' | 'human_answer';
      humanOriginatedByTypeCounts.set(
        humanType,
        (humanOriginatedByTypeCounts.get(humanType) ?? 0) + 1,
      );
      if (
        humanOriginatedOldestAt === undefined ||
        compareIsoInstant(row.at, humanOriginatedOldestAt) < 0
      ) {
        humanOriginatedOldestAt = row.at;
      }
      if (row.deliveries === 0) humanOriginatedUndelivered += 1;
    }
  }

  const byType = INBOX_EVENT_TYPE_ORDER.filter((type) => (byTypeCounts.get(type) ?? 0) > 0).map(
    (type) => ({ type, count: byTypeCounts.get(type) ?? 0 }),
  );

  const bySourceSorted = topByCount(
    [...bySourceCounts.entries()].map(([source, count]) => ({ source, count })),
    (entry) => entry.source,
  );
  const bySource = bySourceSorted.slice(0, 5);
  const bySourceOverflow = bySourceSorted.slice(5);
  const bySourceOverflowKinds = bySourceOverflow.length;
  const bySourceOverflowCount = bySourceOverflow.reduce((sum, entry) => sum + entry.count, 0);

  const undeliveredByType = INBOX_EVENT_TYPE_ORDER.filter(
    (type) => (undeliveredByTypeCounts.get(type) ?? 0) > 0,
  ).map((type) => ({ type, count: undeliveredByTypeCounts.get(type) ?? 0 }));

  const ageBuckets = AGE_BUCKET_LABELS.filter((label) => (ageBucketCounts.get(label) ?? 0) > 0).map(
    (label) => ({ label, count: ageBucketCounts.get(label) ?? 0 }),
  );

  const humanOriginatedByType = INBOX_EVENT_TYPE_ORDER.filter(
    (type): type is 'human_message' | 'human_answer' =>
      type === 'human_message' || type === 'human_answer',
  )
    .filter((type) => (humanOriginatedByTypeCounts.get(type) ?? 0) > 0)
    .map((type) => ({ type, count: humanOriginatedByTypeCounts.get(type) ?? 0 }));

  return {
    total,
    ...(oldestAt === undefined ? {} : { oldestAt }),
    byType,
    bySource,
    bySourceOverflowKinds,
    bySourceOverflowCount,
    bySourceUnknownCount,
    distinct: dedupeKeys.size,
    distinctAcrossManagers: crossManagerDedupeKeys.size,
    undelivered,
    deliveredOnce,
    redelivered,
    maxDeliveries,
    undeliveredByType,
    ageBuckets,
    observedAt: new Date(now).toISOString(),
    humanOriginated: {
      total: humanOriginatedTotal,
      byType: humanOriginatedByType,
      ...(humanOriginatedOldestAt === undefined ? {} : { oldestAt: humanOriginatedOldestAt }),
      undelivered: humanOriginatedUndelivered,
    },
    ...(unreadable.length === 0 ? {} : { unreadable }),
  };
}

// 軸名を `配達回数` と名乗らず `器の入れ替え回数` にする: 断り書きは読み手がそこを通ったときにしか効かず、名前は数字を読む前に必ず通るため
// `distinct` は改名せず断り書きを足す: 名前は計算しているものを正確に言っており、誤読は名前から引く推論の側で起きるため
// 人間起点の行で「配達されていない」と断定しない: 見ているのはストアに残っている行で、メモリ上の待ち行列ではないため
export function describeHumanOriginatedInboxAlert(b: InboxBacklogBreakdown): string {
  const h = b.humanOriginated;
  if (h.total === 0) return '';

  const byTypeText = h.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const oldestText =
    h.oldestAt === undefined
      ? ''
      : `最も古いものは ${h.oldestAt} に受理された` +
        '（Clone#post が受理した時刻——人間が書いた時刻ではない。PendingInboxEvent.at の doc）。';

  return (
    `⚠ 人間起点（human_message / human_answer）の滞留が ${h.total} 件ある（${byTypeText}）。` +
    `${oldestText}` +
    `そのうち、いまの器になってから積まれ、まだ片付いていない分が ${h.undelivered} 件` +
    '（ストアに残っている行を見ているだけで、配達されていないとは言えない）。'
  );
}

// 器の行数と合算しない: 同じ合図が両方に数えられ、読む側が互いに素な2つの箱と読んで合計や差を取ってしまうため
export function describeInboxBacklogQueuedInMemory(queued: number | undefined): string | null {
  if (queued === undefined || queued === 0) return null;
  return (
    `メモリの配達待ち行列 ${queued} 件` +
    '（配達を待ってプロセスのメモリに載っている分。器の行数（上）とは' +
    '**同じ合図を別の数え方で見た値**で、ふつう両方に数えられている——' +
    '**足しても引いても意味が無い。**食い違ったときだけ、器と配達がずれて' +
    'いる印である。内訳を割る口は無い）。'
  );
}

// 「未処理の合図は無い」と言わない: その文言は、読めた行も読めない行も0件のときにしか出さないため
export function describeNoReadableInboxEvents(
  unreadable: readonly UnreadableInboxEvent[],
): string | null {
  const note = describeUnreadableInboxEvents(unreadable);
  if (note === null) return null;
  return `読めた未処理の合図は無い（ただし、読めない行が在る——下）。\n${note}`;
}

export function describeInboxBacklogBreakdown(b: InboxBacklogBreakdown): string {
  const byTypeText =
    b.byType.length === 0 ? '（無し）' : b.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const bySourceText =
    b.bySource.length === 0
      ? '（source/managerId を持つ型は無い）'
      : b.bySource.map((e) => `${e.source} ${e.count}`).join(' / ');
  const undeliveredByTypeText =
    b.undeliveredByType.length === 0
      ? '（無し）'
      : b.undeliveredByType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const ageBucketsText =
    b.ageBuckets.length === 0
      ? '（無し）'
      : b.ageBuckets.map((e) => `${e.label} ${e.count}`).join(' / ');
  const crossManagerText =
    b.distinctAcrossManagers === b.distinct
      ? ''
      : ` ／ 同じ本文がマネージャーを跨いで ${b.distinctAcrossManagers} 件（managerId を無視して数え直した参考値。inboxBacklogCrossManagerDedupeKey の doc）`;

  const unreadableNote = describeUnreadableInboxEvents(b.unreadable ?? []);

  return [
    `内訳（計 ${b.total} 件）:`,
    `種類: ${byTypeText}`,
    `送信元（上位5件。source/managerIdを持つ型のみ。溢れ ${b.bySourceOverflowKinds} 種 ${b.bySourceOverflowCount} 件 / source を言えない型 ${b.bySourceUnknownCount} 件）: ${bySourceText}`,
    `同一本文（id/at を除いた中身）を畳むと ${b.distinct} 件 ⚠ 本文が同じでも別々に起きた出来事である。この数は上下どちらへもぶれる（向きと理由は inboxBacklogDedupeKey の doc）${crossManagerText}`,
    `器の入れ替え回数: 0回＝いまの器になってから積まれた ${b.undelivered} / 1回 ${b.deliveredOnce} / 2回以上 ${b.redelivered}（最大 ${b.maxDeliveries}）⚠ 配られた回数ではない — 門が畳んだ行はターンが1度も起きないまま数だけ増える`,
    `いまの器になってから積まれた分（0回）の内訳（種類別）: ${undeliveredByTypeText}`,
    `齢（観測 ${b.observedAt} 時点。齢は相対値なので、この行を写すときは基準点も一緒に写すこと）: ${ageBucketsText}`,
    ...(unreadableNote === null ? [] : [`⚠ ${unreadableNote}（上の計には入っていない）`]),
  ].join('\n');
}
