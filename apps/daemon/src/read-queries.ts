import type { JournalEntryType } from '@alteroid/core';
import {
  JournalAnchorNotFoundError,
  JOURNAL_ENTRY_TYPES,
  describeUnreadableJournalTimeBoundary,
  findUnrecordedManagers,
  journalWindowCrossesHorizon,
  ledgerTimeZone,
  normalizeJournalTimeBoundary,
  summarizeUsage,
  usageDate,
  usageLayerSchema,
  usageSiteSchema,
} from '@alteroid/core';
import type { z } from 'zod';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';

// `GET /journal`・`GET /usage` の中身を、HTTP の口と MCP の読み取りの道具の両方から呼ぶ関数へ切り出したもの。
// ロジックを道具の側へ書き写さない: 片方だけ直して意味がずれるのを避けるため。HTTP の応答（状態番号・本文・エラー文）は切り出す前と1バイトも変えない。

export interface JournalReadParams {
  limit: number;
  since?: string | undefined;
  until?: string | undefined;
  type?: string | undefined;
  q?: string | undefined;
  order: 'asc' | 'desc';
  afterId?: string | undefined;
  afterAt?: string | undefined;
  horizon?: 'true' | 'false' | undefined;
  // `exchange` の `with` の絞り。`GET /journal` には無い（渡さない呼びの応答は変わらない）。MCP の `exchanges` が使う
  with?: ('human' | 'manager' | 'self')[] | undefined;
  conversationId?: string | undefined;
}

type JournalPage = Awaited<ReturnType<AppContext['stores']['journal']['listPage']>>;

export type JournalReadResult =
  | {
      ok: true;
      body: JournalPage & { oldestAt?: string | null; crossesHorizon?: boolean };
    }
  | { ok: false; error: string };

export async function readJournalPage(
  stores: AppContext['stores'],
  params: JournalReadParams,
): Promise<JournalReadResult> {
  const { limit, since, until, type, q, order, afterId, afterAt, horizon } = params;
  const requestedTypes = type?.split(',').filter((value) => value.length > 0);
  const unknownTypes = (requestedTypes ?? []).filter(
    (value) => !(JOURNAL_ENTRY_TYPES as readonly string[]).includes(value),
  );
  if (unknownTypes.length > 0) {
    return {
      ok: false,
      error:
        `type に知らない値が入っている: ${unknownTypes.join(', ')}` +
        `（使えるのは ${JOURNAL_ENTRY_TYPES.join(' / ')}。カンマ区切りで複数）`,
    };
  }
  const types = requestedTypes as JournalEntryType[] | undefined;

  // 片方だけでは境界が決まらない。
  if (afterId === undefined && afterAt !== undefined) {
    return { ok: false, error: 'afterId と afterAt は両方一緒に渡す' };
  }
  if (afterId !== undefined && afterAt === undefined) {
    return { ok: false, error: 'afterId と afterAt は両方一緒に渡す' };
  }
  if (afterId !== undefined && afterAt !== undefined && Number.isNaN(Date.parse(afterAt))) {
    return { ok: false, error: 'afterAt は ISO 8601 で指定する' };
  }

  // `toISOString()` へ正規化してからストアへ渡す: pg は時刻で比べるが fs・インメモリは文字列比較なので、秒の省略やオフセットで3実装の答えが割れる。
  if (since !== undefined && normalizeJournalTimeBoundary(since) === null) {
    return { ok: false, error: describeUnreadableJournalTimeBoundary('since', since) };
  }
  if (until !== undefined && normalizeJournalTimeBoundary(until) === null) {
    return { ok: false, error: describeUnreadableJournalTimeBoundary('until', until) };
  }
  const normalizedSince = since === undefined ? undefined : normalizeJournalTimeBoundary(since)!;
  const normalizedUntil = until === undefined ? undefined : normalizeJournalTimeBoundary(until)!;

  try {
    const { entries, next } = await stores.journal.listPage({
      limit,
      order,
      ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
      ...(normalizedUntil === undefined ? {} : { until: normalizedUntil }),
      ...(types === undefined || types.length === 0 ? {} : { types }),
      ...(q === undefined ? {} : { q }),
      ...(params.with === undefined ? {} : { with: params.with }),
      ...(params.conversationId === undefined ? {} : { conversationId: params.conversationId }),
      ...(afterId === undefined || afterAt === undefined
        ? {}
        : { after: { id: afterId, at: afterAt } }),
    });

    // 0件かどうかでは決めない: 窓がまるごと地平より後ろなら、0件でも「本当に無かった」と言い切れる。
    const oldestAt =
      normalizedSince !== undefined || normalizedUntil !== undefined || horizon === 'true'
        ? await stores.journal.oldestAt()
        : undefined;
    // `journal_read` と同じ関数（`journalWindowCrossesHorizon`）を呼ぶ: 2箇所に書き写さない。
    const crossesHorizon =
      oldestAt === undefined ? undefined : journalWindowCrossesHorizon(oldestAt, normalizedSince);

    return {
      ok: true,
      body: {
        entries,
        // `entries` が `limit` 未満・空でも、`null` でない限り先に行が在る: ストアは読めない行を `limit` の後で捨てる。
        next,
        ...(oldestAt === undefined ? {} : { oldestAt }),
        ...(crossesHorizon === undefined ? {} : { crossesHorizon }),
      },
    };
  } catch (error) {
    // 指す行が見当たらないのは判定できないという第3の状態: 黙って先頭から返さず断る。
    if (error instanceof JournalAnchorNotFoundError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export interface UsageReadParams {
  from?: string | undefined;
  to?: string | undefined;
  managerId?: string | undefined;
  layer?: z.infer<typeof usageLayerSchema> | undefined;
  site?: z.infer<typeof usageSiteSchema> | undefined;
  tokenId?: string | undefined;
}

export async function readUsage(
  ctx: Pick<AppContext, 'clone' | 'stores' | 'clock' | 'resolveTimeZone'>,
  deps: Pick<AppDeps, 'accountUsage'>,
  params: UsageReadParams,
) {
  const { clone, stores, clock, resolveTimeZone } = ctx;
  const { from, to, managerId, layer, site, tokenId } = params;
  const aggregate = await stores.usage.aggregate({
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(managerId === undefined ? {} : { managerId }),
    ...(layer === undefined ? {} : { layer }),
    ...(site === undefined ? {} : { site }),
    ...(tokenId === undefined ? {} : { tokenId }),
  });
  // 全期間・絞り込み無しの2つを突き合わせる: クエリで狭めた `aggregate.rows` から作ると、照会範囲の外で記録された委譲が「記録が無い」に化ける。
  const allManagers = await clone.managers.list();
  const recordedManagerIds = await stores.usage.recordedManagerIds();
  const unrecordedManagers = findUnrecordedManagers(
    allManagers,
    recordedManagerIds,
    aggregate.since,
  );
  return {
    ...aggregate,
    // 内訳は core の1つの実装で作る（口ごとに足し直すと食い違う）。
    breakdown: summarizeUsage(aggregate.rows, aggregate.turnRows),
    // 配線されていなければ「まだ分からない」を返す: 0 や null にすると「枠を使っていない」と読める。
    account: deps.accountUsage?.() ?? { state: 'unknown' as const },
    unrecordedManagers,
    // 台帳の `date` を書くのと同じ関数・同じ TZ で評価する: ブラウザの TZ で「今日」を決めると台帳の日とずれる。
    today: usageDate(clock()),
    // `today` と同じ時計・同じ TZ の名前。取れなければ null（既定値を埋めない）
    ledgerTimeZone: ledgerTimeZone(clock(), resolveTimeZone),
  };
}
