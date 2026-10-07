import { z } from 'zod';

import { isDaemonSelfNotice } from './daemon-self-notice.js';
import { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
import type { InboxEvent, UnreadableInboxEvent } from './schema.js';
import { describeUnreadableInboxEvents } from './store.js';
import type { PendingInboxEvent } from './store.js';

export const INBOX_BACKLOG_LOUD_THRESHOLD = 50;

// `bySource` の欠落を省かない: 省くと、読み手が「他の送信元は無かった」と誤読するため
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
  // `未配達` と名乗らない: `post()` は受理した瞬間に `put()` するため、いまの器で積まれた行は処理中のものも含めて必ず 0 になるため
  readonly undelivered: number;
  readonly deliveredOnce: number;
  // `配達回数` と名乗らない: `claimPending()` は未読の全行を一緒に進めるため、処理されていない合図も同じだけ増えるため
  readonly redelivered: number;
  readonly maxDeliveries: number;
  readonly undeliveredByType: readonly {
    readonly type: InboxEvent['type'];
    readonly count: number;
  }[];
  readonly ageBuckets: readonly { readonly label: string; readonly count: number }[];
  // 基準時刻を持たせる: 齢は相対値で、内訳を別の場所へ写した瞬間に基準点が消えるため
  readonly observedAt: string;
  // `deliveries === 0` に絞らない: 配達済みでまだ消えていない人間の発言を、計器から静かに落とすことになるため
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

// 種類の接頭辞を付ける: 同じ文字列の `source` と `managerId` が同じ行に畳まれないため
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
// 計器の鍵と制御の鍵を同じ関数に載せない: 計器側の偏りが、そのまま制御側の挙動の揺れになるため
export function inboxCollapseKey(event: InboxEvent): string | undefined {
  if (event.type === 'manager_message') return inboxBacklogDedupeKey(event);

  if (event.type === 'external' && isDaemonSelfNotice(event)) {
    // `identity` が在れば `payload` を鍵に含めない: 畳んだ件数などで揺れうるため
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
// `manager_message` 以外は `inboxBacklogDedupeKey` へ委譲する: 実装を複製すると、片方だけ直されて食い違うため
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

// 3 は実測で決めた値ではない: 1件の標本だけで決めたもので、見直す人は根拠の薄さごと引き継ぐこと
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
// 実行時の if で弾かず、候補の集合を狭めて「そもそも渡せない」形にする: 在っても使わずに撃たれることが実際に起きているため
export const CLONE_REMOVABLE_INBOX_EVENT_TYPES = [
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const satisfies readonly Exclude<InboxEvent['type'], 'human_message' | 'human_answer'>[];

// 呼び出し側ごとにスキーマを組み立てない: 道具が使うスキーマとテストが検査するスキーマが別々の値になり、片方だけ書き換えられても気づけないため
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

// SQL 側に同じ判定を複製しない: 一覧で見た件数と実際に消える件数が食い違うため
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

// `CloneHost` 型そのものを受けない: 面全体を要求すると、このファイルが `host.ts` に依存し始めるため
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

/**
 * 内訳を文へ描く。**`manager_list` の一覧本文へそのまま足す前提**——本文は
 * 1文字も載せない（合図の `text` / `payload` は集計値の中でしか使わない。
 * `AGENTS.md` の地雷「エージェントへ返す一覧に本文を全文で載せる」に触れない）。
 *
 * **必ず `total` を出す。** `byType` / `ageBuckets` は0件を省くが、残りを
 * 足せば `total` に一致するので「省かれた行は0だった」と算術で読める
 * （{@link InboxBacklogBreakdown} の doc、`situation.ts` の `lost` と同じ理由）。
 *
 * **`bySource` はそれだけでは `total` に届かない**——だから溢れた種類数・
 * 件数（`bySourceOverflowKinds` / `bySourceOverflowCount`）と、`source` を
 * 言えない型の行数（`bySourceUnknownCount`）を**0件でも必ず**送信元の行に
 * 添える。0のときに省くと「省いた＝0だった」という他の軸と同じ形に見えて
 * しまい、実際には打ち切られている可能性（測っていない）と区別できなくなる
 * ため（{@link InboxBacklogBreakdown} の doc の「⚠️ #818 の欠陥と直し方」）。
 *
 * **0回の桶は種類別の内訳も出す**（`undeliveredByType`）——「いまの器になって
 * から積まれた分に人間の依頼（`human_message`）が混ざっているか」を、種類と
 * 器の入れ替え回数の2つの一覧を突き合わせずに直接言えるようにするため
 * （#783 段0 追補）。**この行が、実際にいちばん行動へ効く**——クローンは
 * `manager_message 25`（受け取っていない報告が25本）をここから読む
 * （実測 2026-09-12）。
 *
 * ## ⚠️ #910: 出力の軸名は「配達回数」ではない。**改名であって、断り書きではない**
 *
 * この関数の doc は #818 の時点で既に「`claimPending()` の doc が言う『配達回数は
 * 器が入れ替わった回数であって処理が落ちた回数ではない』を踏まえ」と書いていたが、
 * **出力には1文字も刷っていなかった。読み手が違う** —— この doc を読むのは
 * このコードを触る実装者で、`配達回数: 2回以上 4249` を読むのはクローンである。
 * クローンは `manager_list` の戻り値しか見えないので、doc へ置いた断り書きは届かない
 * （実測 2026-09-12: クローンがこの2行から「4253 件は実質 30 種類の増殖」「配達しても
 * 消えず、また配達されている」という2つの誤った結論を立て、その筋で委譲を1本出した。
 * #910。同じ誤読は #700 でも起きており、そのときは断り書きを `store.ts` 側へ足した
 * ——**実装者が読む場所へ置いて、4日後に破られた**）。
 *
 * **⟹ ここで採ったのは改名である。** `AGENTS.md`（逐語:
 * `grep -Fn -- '添えるのではなく分ける' AGENTS.md`）が「**列の分かれ目は読む順に
 * 関係なく効くが、断り書きは読み手がそこを通ったときにしか効かない**」と書いている
 * とおりで、断り書きは読み飛ばされうるが、名前は数字を読む前に必ず通る。
 *
 * **2つの数で扱いが違う。その違いには理由がある:**
 *
 * - **`undelivered` / `deliveredOnce` / `redelivered` / `maxDeliveries` は改名した**
 *   （`配達回数` → `器の入れ替え回数`）。**この計器では、この数は例外なく
 *   「器が入れ替わった回数」だからである。** `claimPending()` は残っている未読の
 *   全行を一緒に進め（`InboxStore.claimPending` の doc）、`peekPending()` が返すのは
 *   その全行である ⟹ ここに「この合図の処理が落ちた回数」と読んでよい行は1つも無い。
 *   **名前が無条件に間違っているなら、直すのは名前である。**
 * - **`distinct` は改名せず、断り書きを足した。** 名前（`同一本文…を畳むと N 件`）は
 *   計算しているものを正確に言っている ⟹ 誤読は名前ではなく**そこから引く推論**
 *   （「同じ本文＝同じ出来事の増殖」「畳めば減る」）の側で起きる。**名前の直しは
 *   間違った名前を直せるだけで、正しい名前が招く推論は止められない。**
 *
 * **`clone.ts` の `#redeliveryNoticeFor` を改名しないのは、この線の裏側である。**
 * あちらは1件ごとの断り書きで、`#restoredCohort <= 1`（同じ起動で一緒に拾い直した
 * のがその1件だけ）のときは回数がその合図について語れる ⟹ 名前が**条件付きで
 * 正しい**ので、#700 / #708 が採った「名前は保って修飾を足す」が正しい。ここは
 * その条件が起きえない側である。
 *
 * ## ⚠️ #910 追補: **`未配達` も同じ理由で名前が間違っていた**（実測 2026-09-12、3回目）
 *
 * 上の改名を最初に入れたとき、0の桶だけは `0回（＝未配達）` と旧い語を残した
 * ——「`deliveries === 0` なら一度も配っていないのは本当だろう」と考えたからである。
 * **現物を読むと違った。**
 *
 * - `post()` は受理した瞬間に `put()` する（`clone.ts` の `#remember`）ので、
 *   **いまの器で積まれた行の `deliveries` は必ず 0 である。** 同時に
 *   `#inbox.push` で待ち行列にも載っている ⟹ **0 は「届いていない」ではなく
 *   「いまの器になってから積まれ、まだ片付いていない（＝いま流れている最中）」**
 *   である。処理中のその1件も 0 で数えられる
 * - 逆に **`2回以上` は「配られた」を意味しない。** `#restoreUnread` の門
 *   （`CloneOptions.redeliveryGate`。#843 / #883）が畳んだ行は
 *   **`#inbox.push` されない＝ターンが1度も起きない**まま、受信箱にも残り、
 *   起動のたびに回数だけ増える（逐語は
 *   `grep -Fn -- '**`#inbox.push` をしない ＝ ターンを起こさない。**' packages/core/src/clone.ts`）
 *
 * **実測 2026-09-12（クローン自身の観測）**: 未読 4283 件の内訳を読んだクローンが
 * 「`2回以上 4249` ＝ 既に配達済み＝自分が読んだ上で処理していないだけ」「`未配達 30`
 * ＝ 届いていない＝異常」と読み、**両方とも逆だった。** そしてこのとき
 * `齢: 1時間未満 21 / 1〜6時間 9` の和がちょうど 30 で、**0 の桶は「いまの器の
 * 起動より後に積まれた行」と完全に一致していた。**
 *
 * ⟹ **`未配達` を出力から外し、0 の桶は「いまの器になってから積まれた」と名乗る。**
 * `2回以上` の側は名前では塞げない（`器の入れ替え回数` は正しく数えている——
 * 誤りは「⟹ だから配られたはずだ」という*推論*の側にある）ので、`distinct` と
 * 同じ扱い、すなわち**断り書き**にした。
 *
 * **欄の名前（`undelivered` / `undeliveredByType`）はそのままにしてある。**
 * 直すのは出力の語であって、内部の識別子ではない——実装者はこの doc を読む経路を
 * 持っており（#910 が言う「読み手が違う」の裏側）、識別子まで一緒に変えると
 * 差分が本題から離れる。**この doc がその対応表である。**
 *
 * ## ⚠️ #910 追補2: `齢` は但し書きではなく**基準点**が欠けていた
 *
 * `齢: 1時間未満 21 / …` は `now` からの**相対値**なのに、その `now` を1文字も
 * 刷っていなかった。**読んだその場では困らない**（「いま」が基準だと分かる）が、
 * **この内訳を別の場所へ写した瞬間に基準点が消える。**
 *
 * **実測 2026-09-12（クローン自身の誤り）**: クローンが `resets 6:40am
 * (Asia/Tokyo)` という**時間帯つきの正しい表示**を持っていながら、別の場所から
 * 取った時間帯なしの数字（vitest の `Start at 03:52:01`）を基準にして
 * 「窓はもう明けた」と結論した。実際には9時間ずれていた。⟹ **但し書きの無い数字の
 * 害は、その数字自身が誤読されることだけではない——他の正しい計器を誤読させる
 * 基準にもなる。**
 *
 * **⟹ ここで足したのは断り書きではない。** {@link InboxBacklogBreakdown.observedAt}
 * は齢を数えるために既に受け取っている `now` そのもので、**新しい観測は1つも
 * していない。** 落としていた演算子を落とさなくしただけである。
 *
 * **他の軸には足していない。** `総数` / `種類` / `齢の桶の名前` / `最も古いものは
 * <ISO8601 Z> から` は、どれも基準点を要しない（絶対値か、名前が境界を字面で
 * 言っているか、全行が必ずどれかへ入って足すと `total` になるか）。**全部に足すのが
 * 正解ではない**——足すべきなのは「それ無しでは読めない数」だけである。
 *
 * **`distinct` の断り書きは1行に畳んである。** 偏りの向きは2つあり
 * （区切りの衝突で小さく出る／本文へ畳んだ件数を焼き込む合図で大きく出る。
 * {@link inboxBacklogDedupeKey} の doc の「限界」）、**片方だけ書くと新しい誤読を
 * 作る。** 2つの機構を出力へ書き下すと120字を超えて数字が埋まるので、出力には
 * 向きに中立な事実（「上下どちらへもぶれる」）と**機構が書いてある場所の名前**を
 * 載せ、機構そのものは doc に置く —— クローンが doc へ辿る経路を、出力の側から
 * 作るためである。
 *
 * ## `distinctAcrossManagers`（#783 段0 追補 / issue #954）は差が無ければ1文字も足さない
 *
 * `distinct` と `distinctAcrossManagers`（{@link InboxBacklogBreakdown} の doc）
 * が同じ値なら、`manager_message` に複数の `managerId` がそもそも混ざって
 * いないか、混ざっていても本文が揃っていないかのどちらかで、読み手に新しく
 * 言えることが無い——「0を出す軸と、値を作らない軸」（`InboxBacklogBreakdown`
 * の doc）と同じ作法で、**同値のときは行を増やさない。**
 *
 * **差が出たときだけ**、`同一本文` の行へ添えて足す——独立の行を新設すると、
 * 2つの数がどちらも「同一本文を畳んだら何件か」を数えたものであることが
 * 読み手に伝わりにくくなるため、同じ行に並べて置く。**「畳める」「捨てられる」
 * とは名乗らない。** `distinctAcrossManagers` を数えること自体は `managerId`
 * を無視して数え直しただけで、実際に畳んでよいかは別の判断だからである
 * （{@link InboxBacklogBreakdown.distinctAcrossManagers} の doc「これが
 * 言えないこと」）。
 */
/**
 * 人間起点（`human_message` / `human_answer`）の滞留だけを、**単独の行**として
 * 描く（Issue #917 (B)）。
 *
 * ## なぜ在るのか —— #917 が名指しした症状
 *
 * オーナーがクローンへ出した指示が47分間まるごと配達されなかった。クローンが
 * それに気づいたのは、`manager_list` の内訳の**7行目**に出ていた
 * `human_message 1`（`undeliveredByType` の1行）を自分で拾ったからだった。
 * 同じ日の午後、クローンは同じ計器を読んで**この行を読み飛ばした**——そのとき
 * 目に入ったのは `⚠ クローンの受信箱に未処理の合図が 4301 件ある` だった。
 *
 * > 大きい数字と、行動を要する数字が、同じ字の大きさで並んでいる。大きい
 * > ほうが先に来て、目立つ。
 *
 * **この関数は対策（配達の挙動）を1ミリも変えない。行動を要る数字（人間起点の
 * 滞留）だけを、大きい数字より先・単独の行として取り出す計器である。**
 *
 * ## 呼び出し側の並び（必ず守ること）
 *
 * `tools.ts` の `describeInboxBacklog` は、この行を**内訳より前**——
 * `⚠ クローンの受信箱に未処理の合図が N 件ある` の行より**前**に出す。この
 * 関数自身は並び順を強制しない（「前に置く」のは呼び出し側1行の責務）ので、
 * 並びは `tools.ts` 側の歯（`manager_list` を呼ぶテスト）で固定する。
 *
 * ## 名乗ってよいことの線（このファイルの既存 doc と同じ規律）
 *
 * - **`oldestAt` は `Clone#post()` が受理した時刻であって、人間が実際に書いた
 *   時刻ではない**（`store.ts` の `PendingInboxEvent.at` の doc「`post` が
 *   受理した時刻」）。⟹ 「書かれてから N 分」のような経過時間は計算しない
 *   ——絶対時刻（ISO 8601）と、それが何の時刻かだけを言う
 * - **「配達されていない」とは断定しない。** ここが見ているのは**ストアに
 *   残っている行**であって、メモリ上の待ち行列ではない（#1049 / PR #1052 の
 *   `inbox_flow` の doc）。言えるのは「片付いていない」（受信箱にまだ残って
 *   いる）までである
 *
 * ## 0件なら1文字も返さない
 *
 * `InboxBacklogBreakdown` の「0を出す軸と、値を作らない軸」と同じ作法——
 * ただしこちらは**行そのもの**を作らない（空文字列を返す）。呼び出し側
 * （`tools.ts`）は空文字列を出力へ混ぜない。
 */
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

/**
 * 受信箱の**メモリの配達待ち行列**の1行（issue #1084 / #1133）。
 *
 * ## 2つの呼び出し口が、同じ計算・同じ文言を通る（issue #1133）
 *
 * **かつてこの関数は `situation.ts` の中に private な
 * `describeSituationInboxQueued` として在り、`tools.ts` の
 * `describeInboxBacklog`（`manager_list` の末尾に必ず出る、受信箱の滞留を
 * 読むもう1つの口）はメモリの待ち行列を1文字も知らなかった。** ⟹ 同じ
 * クローンが、同じターンの中で、「受信箱の滞留」という同じ言葉に対して
 * 2つの違う定義を読むことになっていた——器の行が0件なら `manager_list` は
 * 「クローンの受信箱に未処理の合図は無い。」と言い切るが、メモリの待ち
 * 行列に数千件残っていてもそれは1文字も反映しない（issue #1133 本文）。
 *
 * **⟹ この関数をここ1箇所へ寄せ、`situation.ts` の `describeSituation` と
 * `tools.ts` の `describeInboxBacklog` の両方がこれを呼ぶ。** 計算・文言の
 * 生成元が1つになったので、2つの呼び出し口が食い違えようがない
 * （どちらかだけを直して忘れる、という形そのものが構造的に作れない）。
 *
 * `situation.ts` の `describeSituationInboxBacklog`、`tools.ts` の
 * `describeInboxBacklog` の**どちらも器の行数の1行とは別の軸**として、この
 * 関数が返す行を隣に置く——{@link describeSituationInboxBacklog}
 * （`situation.ts`）の doc「メモリの配達待ち行列は別の軸である」を先に
 * 読むこと。
 *
 * ## 何を数えるか
 *
 * 呼び出し側（`clone.ts` の `#queuedInMemoryCount`。`#situationNoticeFor` と
 * `#toolContext()` の両方がこれ経由で渡す——issue #1133 が「件数の出どころは
 * 1つにする」と求めた形）が渡す値は、**`Clone#inbox`（配達を待つ FIFO。
 * `inbox.ts` の `Inbox#size`）と `#deferred`（枠＝利用上限で保持している分）
 * を足したもの**である。**両方が「配達待ち」に数える理由**: `#deferred` に
 * 居る合図は枠が開けば `Clone#inbox` の先頭へ戻され（`clone.ts` の `#pump` の
 * 解除ブロック、`Inbox#unshift`）、その時点でまた配達される——まだ処理し
 * 終えていない、という点で `Clone#inbox` の中身と変わらない（`clone.ts` の
 * `dropQueuedInboxEvents` が消すときにこの2つを両方とも落としているのと
 * 同じ理由——`grep -Fn -- '枠（利用上限）で保持している分' packages/core/src/clone.ts`）。
 *
 * ## 何を数えていないか（⚠️ ここが要点——数えていないと、この行を読む側が
 * 「これで全部」と誤読する）
 *
 * 1. **いま処理中のこの1件（このターンの `batch` そのもの）。** `Clone#inbox`
 *    からは `#pump` が `next()` / `drainWhile()` で既に取り出した後なので、
 *    構造上ここには入らない——DB 側の軸のように `events.length` を引く補正は
 *    要らない（引く前の値が既に「これを除いた残り」になっている）。
 * 2. **`Clone#inbox` が待ち手へ直接渡した分。** `Inbox#push` は待ち手（`next()`
 *    で待っている `#pump`）が居ればその場で渡し、`#queue` を素通りする
 *    （`inbox.ts` の `push` の doc「待ち手が居るときは順序の話にならない」）。
 *    この経路を通った合図は1度も `#queue` に載らないので、`size` はそれを
 *    最初から知らない——ただしこれは「これから処理される1件」であって
 *    「取り残された合図」ではない（上の1と同じ理由で、そもそも数える対象では
 *    ない）。
 * 3. **もう配り終えて `#handle` の中を実行中の合図が、その実行の途中で新しい
 *    合図（サブ依頼・ツール呼び出し）を作ることがあっても、それは
 *    `InboxEvent` として `Clone#inbox` を経由しない**（別の経路——委譲・
 *    ツール呼び出し——であって受信箱の合図ではない）ので、この軸の対象にすら
 *    ならない。
 * 4. **`tools.ts` から呼ばれた回に限り、`context.queuedInMemory` を渡さない
 *    呼び出し側（テスト等）が居れば `undefined` になる。** 本番の配線
 *    （`clone.ts` の `#toolContext()`）は必ず渡す——`runtime` / `scheduler`
 *    と同じ「省略はテストのためだけ」という作法（`ToolContext` の doc）。
 *
 * **⟹ 言えるのは「配達を待って、いまメモリに載っている分」までである。**
 * 「クローンにこれから起きる仕事の総量」ではない——走っているターン自身の分
 * （1・2）は、走っている以上どのみち仕事として数える必要が無い。
 *
 * ## `undefined` は「省略」——0 と見分けが付く必要は無い
 *
 * DB の軸と違って、この値は非同期の読み取りを経ない（`Inbox#size` /
 * `#deferred.length` はどちらも同期の getter / 配列長で、失敗しうる操作を
 * 経由しない）。⟹ 「読もうとして読めなかった」という状態がそもそも無い
 * ——`'unreadable'` に対応する型を持たないのはこのためであり、**手抜きでは
 * ない**。`undefined` が意味するのは「呼び出し側が渡さないと決めた」（既存の
 * 呼び出しを壊さないための省略。`tokens` / `backlog` と同じ作法）だけである。
 *
 * ## 0 のときは行を出さない
 *
 * 上の理由（読めない状態が無い）により、`0` は常に「数え切れて0件だった」を
 * 意味する——DB の軸で問題になった「0 が『数えられなかった』を覆い隠す」は
 * ここでは構造的に起きない。⟹ 0 を隠しても情報は失われないので、DB の軸と
 * 同じ「0 なら行を出さない」を採ってよい。
 *
 * ## ⚠️ 2つの軸は**重なる**——「別の軸」を「互いに素」と読ませないこと
 *
 * **通常は、同じ合図が両方に数えられている。** `clone.ts` の `#remember`
 * （`post()` の中）は型を問わず全部の合図を配達より前に器へ書き、消す
 * `#forget` はターンが終わってからしか呼ばれない —— 出典は
 * `grep -Fn -- '消す `#forget()` はこの後' packages/core/src/clone.ts` が当たる
 * `#situationNoticeFor` の doc である。⟹ **メモリの待ち行列に居る合図は、
 * ふつう器にも行を持っている。**
 *
 * **⛔ だから足しても引いても意味が無い。** この行が「別の実体」とだけ名乗る
 * と、読む側は互いに素な2つの箱だと読み、**合計を取って負荷を倍に見積もる**
 * （あるいは差を取って「どちらかが漏れている」と読む）。**2つは同じものを
 * 別の数え方で見た値で、意味を持つのは食い違ったときだけである**——器が空で
 * メモリに残っていれば、それが issue #1049 の形そのものである。
 *
 * **⟹ 行の文言に「足し引きしないこと」と「食い違いが何を意味するか」を
 * 書く。** 添えるのではなく行の中に置く（`AGENTS.md`「報告の形」——断り書き
 * は読み手がそこを通ったときにしか効かない）。
 */
export function describeInboxBacklogQueuedInMemory(queued: number | undefined): string | null {
  if (queued === undefined || queued === 0) return null;
  // **器の行数と合算しない、足し算もしない。** 独立した1行として並べる——
  // 上の doc「2つの軸は重なる」。
  return (
    `メモリの配達待ち行列 ${queued} 件` +
    '（配達を待ってプロセスのメモリに載っている分。器の行数（上）とは' +
    '**同じ合図を別の数え方で見た値**で、ふつう両方に数えられている——' +
    '**足しても引いても意味が無い。**食い違ったときだけ、器と配達がずれて' +
    'いる印である。内訳を割る口は無い）。'
  );
}

/**
 * 読めた合図が0件で、読めない行だけが在るときの文（issue #2344。読めない行が無ければ `null`）。
 *
 * **「未処理の合図は無い」とは言わない。** その文言は、読めた行も読めない行も0件のときにしか
 * 出さない。`manager_list`（`tools.ts`）と CLI（`alteroid inbox show`）が同じ文面を使う。
 */
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
  // `distinct` と同じ値のときは1文字も足さない（describeInboxBacklogBreakdown
  // の doc「distinctAcrossManagers は差が無ければ1文字も足さない」）。
  const crossManagerText =
    b.distinctAcrossManagers === b.distinct
      ? ''
      : ` ／ 同じ本文がマネージャーを跨いで ${b.distinctAcrossManagers} 件（managerId を無視して数え直した参考値。inboxBacklogCrossManagerDedupeKey の doc）`;

  // 読めない行は計に入っていない別の軸（issue #2344）。0件なら1文字も足さない。
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
