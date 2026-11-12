// `inbox_remove_many` の道具（受信箱の未読を絞り込んでまとめて畳む）と、その応答・日誌・途中停止の補助。
// `clone-tools-task.ts` の `taskTools` が並びのまま連結する。このファイルから `clone-tools-task.ts` を import しない（一方向）。

import { z } from 'zod';
import {
  describeOffsetRequiredTimeBoundary,
  isOffsetQualifiedTimeBoundary,
} from './journal-time.js';
import { journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { removeInboxChunkJournalFirst } from './removal-journal-first.js';
import { type JournalEntryInput } from './schema.js';
import { describeUnreadableInboxEvents, type Stores } from './store.js';
import {
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
  inboxBacklogSourceFor,
  inboxRemoveManyTypesSchema,
  matchesInboxRemoveManyFilter,
  type InboxRemoveManyFilter,
} from './inbox-backlog.js';
import { chunkIdsByChars } from './chunk-ids.js';
import { CLOSE_MANY_SOURCES_SHOWN } from './task-set-status-many.js';
import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringArrayElementLengthViolation,
  describeStringLengthViolation,
  formatArrayLengthJa,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';
import { tool, text, JournalNotRecordedError } from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

export const REMOVE_MANY_JOURNAL_ID_CHARS = 3_600;

const REMOVE_MANY_IDS_SHOWN = 20;

// `.min(1)` を入力スキーマ側に置かない: SDK の `tool()` がハンドラより前に検証するため、件数の検査はハンドラの先頭の `safeParse` へ渡す
const inboxRemoveManyTypesToolInputSchema = z.array(z.enum(CLONE_REMOVABLE_INBOX_EVENT_TYPES));

type InboxRemoveManyStores = CloneToolsShared['stores'];
type InboxPendingRow = Awaited<
  ReturnType<InboxRemoveManyStores['inbox']['peekPending']>
>['entries'][number];
type InboxDeliveryStop = NonNullable<ToolContext['dropQueuedInboxEvents']>;

interface InboxRemoveManyInput {
  types: InboxRemoveManyFilter['types'];
  sources: string[] | undefined;
  before: string | undefined;
  reason: string;
  limit: number | undefined;
}

// 引数の検査。断る文を返す（通れば null）。順序は元のまま
function describeInboxRemoveManyViolation(input: InboxRemoveManyInput): string | null {
  const { types, sources, before, reason, limit } = input;
  const limitError = describeIntRangeViolation('limit', limit, {
    min: 1,
    max: REMOVE_MANY_LIMIT_MAX,
  });
  if (limitError !== null) return limitError;
  if (!inboxRemoveManyTypesSchema.safeParse(types).success) {
    return `types は使えない（${formatArrayLengthJa({ min: 1 })}）。`;
  }
  const sourcesLengthError = describeArrayLengthViolation('sources', sources, { min: 1 });
  if (sourcesLengthError !== null) return sourcesLengthError;
  const sourcesElementError = describeStringArrayElementLengthViolation('sources', sources);
  if (sourcesElementError !== null) return sourcesElementError;
  const beforeLengthError = describeStringLengthViolation('before', before, { min: 1 });
  if (beforeLengthError !== null) return beforeLengthError;
  const reasonError =
    describeStringLengthViolation('reason', reason, { min: 1 }) ??
    describeBlankViolation('reason', reason);
  if (reasonError !== null) return reasonError;
  // 絞り込みの無い呼びを断る: 「全部」は選べる5種類を指し、その2種は zod の enum が型で塞いでいるため実行時に弾くのは5種類を全部選んだ場合だけ
  if (CLONE_REMOVABLE_INBOX_EVENT_TYPES.every((known) => types.includes(known))) {
    return (
      `types に選べる5種類（${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(', ')}）を全部並べた` +
      '呼びは断る——それは絞り込みが無いのと同じで、1回で（人間起点を除く）受信箱を' +
      '空にできてしまう。消したい種類だけを名指しすること（例 types: ["manager_message"]）。' +
      '**1件も消していない。**'
    );
  }
  // 読めない `before` を「絞り込みが当たらなかった」に混ぜない・時差を必須にする: `until` と同じ理由
  if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
    return (
      describeOffsetRequiredTimeBoundary('before', before, '2026-09-15T00:00:00.000Z') +
      '**1件も消していない。**'
    );
  }
  return null;
}

// 受信箱の一覧を読んで絞り込む（`peekPending` は1回だけ）
async function selectInboxRemoveManyTargets(
  inbox: InboxRemoveManyStores['inbox'],
  filter: InboxRemoveManyFilter,
): Promise<{
  allPending: readonly InboxPendingRow[];
  matched: readonly InboxPendingRow[];
  // 読めない行は絞り込みの材料が取れず対象にできないので、「未読が1件も無い」とは言わない: 消していないだけで受信箱に在るため
  unreadableNote: string | null;
}> {
  const peek = await inbox.peekPending();
  const allPending = peek.entries;
  const unreadableNote = describeUnreadableInboxEvents(peek.unreadable);
  const matched = allPending.filter((row) => matchesInboxRemoveManyFilter(row, filter));
  return { allPending, matched, unreadableNote };
}

function describeInboxRemoveManyFilterText(filter: InboxRemoveManyFilter): string {
  const { types, sources, before } = filter;
  return [
    `types=[${types.join(', ')}]`,
    ...(sources === undefined ? [] : [`sources=[${sources.join(', ')}]（完全一致）`]),
    ...(before === undefined ? [] : [`before=${before}`]),
  ].join(' / ');
}

function renderInboxRemoveManyFunnel(allPendingCount: number, matchedCount: number): string {
  return `未読 ${allPendingCount} 件 → 絞り込みで ${matchedCount} 件`;
}

// 読めない行は件数を黙って落とさない（`task_set_status_many` の `renderCloseManyUnreadableNote` と同じ）: 「これで全部だ」と読まれるため
function renderInboxRemoveManyUnreadableNote(unreadableNote: string | null): string[] {
  return unreadableNote === null ? [] : [`⚠ ${unreadableNote}この道具では選べず、消していない。`];
}

function describeInboxRemoveManyTypesMiss(allPending: readonly InboxPendingRow[]): string {
  const breakdown = CLONE_REMOVABLE_INBOX_EVENT_TYPES.map(
    (known) => `${known} ${allPending.filter((row) => row.event.type === known).length}`,
  ).join(' / ');
  const humanCount = allPending.filter(
    (row) => row.event.type === 'human_message' || row.event.type === 'human_answer',
  ).length;
  return (
    `未読 ${allPending.length} 件のうち絞り込みに当たる行が0件——**絞り込みが外れている。**` +
    ` いま未読に在る種類の内訳（選べる5種類のみ）: ${breakdown}` +
    `${humanCount > 0 ? `（このほか人間起点の行が ${humanCount} 件あるが、この道具では選べない）` : ''}`
  );
}

function describeInboxRemoveManySourcesMiss(
  sources: readonly string[],
  afterTypes: readonly InboxPendingRow[],
): string {
  const counts = new Map<string, number>();
  for (const row of afterTypes) {
    const source = inboxBacklogSourceFor(row.event);
    if (source === undefined) continue;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CLOSE_MANY_SOURCES_SHOWN)
    .map(([name, count]) => `${name} ${count}`)
    .join(' / ');
  const rest = counts.size - Math.min(counts.size, CLOSE_MANY_SOURCES_SHOWN);
  return (
    `types では ${afterTypes.length} 件当たったが sources=[${sources.join(', ')}] の完全一致で0件——` +
    `**この送信元は未読に無い。** 当たった行に実在する送信元（多い順）: ` +
    `${top === '' ? '（送信元を言える行が無い）' : top}` +
    `${rest > 0 ? ` …ほか ${rest} 種は省略` : ''}`
  );
}

function describeInboxRemoveManyBeforeMiss(
  before: string | undefined,
  prior: readonly InboxPendingRow[],
  priorAxis: 'types' | 'sources',
): string {
  const oldest = prior.reduce(
    (acc, row) => (acc === undefined || Date.parse(row.at) < Date.parse(acc) ? row.at : acc),
    undefined as string | undefined,
  );
  return (
    `${priorAxis} までで ${prior.length} 件当たったが before=${before} 以前の行が0件` +
    `（当たった行のうち最も古いのは ${oldest ?? '不明'}）。`
  );
}

// 0件の理由を軸で名指しする（types → sources → before の順で、最初に0件になった軸）: 1つの文言では「当たるものが無かった」と「絞り込みを間違えた」が同じ顔になるため
function describeInboxRemoveManyZeroReason(
  allPending: readonly InboxPendingRow[],
  filter: InboxRemoveManyFilter,
  unreadableNote: string | null,
): string {
  if (allPending.length === 0 && unreadableNote !== null) {
    return `読めた未読が1件も無い。ただし ${unreadableNote}この道具では選べず、1件も消していない。`;
  }
  if (allPending.length === 0) {
    return '受信箱に未読が1件も無い。**絞り込みの問題ではない**（消すべきものがそもそも無い）。';
  }
  const { types, sources, before } = filter;
  const afterTypes = allPending.filter((row) => matchesInboxRemoveManyFilter(row, { types }));
  if (afterTypes.length === 0) return describeInboxRemoveManyTypesMiss(allPending);
  const afterSources = allPending.filter((row) =>
    matchesInboxRemoveManyFilter(row, { types, ...(sources === undefined ? {} : { sources }) }),
  );
  if (sources !== undefined && afterSources.length === 0) {
    return describeInboxRemoveManySourcesMiss(sources, afterTypes);
  }
  return describeInboxRemoveManyBeforeMiss(
    before,
    sources === undefined ? afterTypes : afterSources,
    sources === undefined ? 'types' : 'sources',
  );
}

function renderInboxRemoveManyZeroResult(
  funnel: string,
  why: string,
  unreadableNote: readonly string[],
): string {
  return [
    '絞り込みに当たる未読は0件だった。**1件も消していない。**',
    funnel,
    why,
    ...unreadableNote,
  ].join('\n');
}

function renderInboxRemoveManyRestNote(rest: number, effectiveLimit: number): string[] {
  return rest === 0
    ? []
    : [
        `1回の上限（${effectiveLimit} 件）に当たったので、残り ${rest} 件は対象にしていない。` +
          '**同じ絞り込みでもう一度呼べば続きを消せる。**',
      ];
}

function renderInboxRemoveManyDryRunIds(targets: readonly InboxPendingRow[]): string {
  const shown = targets.slice(0, REMOVE_MANY_IDS_SHOWN).map((row) => row.event.id);
  const hidden = targets.length - shown.length;
  return `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
    hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
  }`;
}

function renderInboxRemoveManyDryRun(args: {
  funnel: string;
  filterText: string;
  targets: readonly InboxPendingRow[];
  matchedCount: number;
  restNote: readonly string[];
  unreadableNote: readonly string[];
}): string {
  const { funnel, filterText, targets, matchedCount } = args;
  return [
    `**試算（dryRun）。1件も消していない。** 実際に消すには dryRun: false を渡すこと。`,
    funnel,
    `絞り込み: ${filterText}`,
    `この呼びで消すのは ${targets.length} 件（当たったのは ${matchedCount} 件）。` +
      `いちばん古いのは ${targets[0]?.at ?? '不明'}、いちばん新しいのは ${
        targets[targets.length - 1]?.at ?? '不明'
      }。`,
    renderInboxRemoveManyDryRunIds(targets),
    ...args.restNote,
    ...args.unreadableNote,
  ].join('\n');
}

function renderInboxRemoveManyNoDeliveryRefusal(): string {
  return [
    '**1件も消していない。** 配達の待ち行列から落とす口が渡されていないので、' +
      'この道具は消し込みを拒んだ。',
    '消しても、既にクローンのメモリ上の待ち行列へ載った合図は配られ続ける' +
      '。「消した」と名乗って配達が続く状態を作らないために、' +
      'ここで止めている。',
    '⚠️ これは配線の不備である（本番の `ToolContext` は2箇所とも' +
      '`dropQueuedInboxEvents` を渡している）。人間へ上げること。',
  ].join('\n');
}

// 塊ごとの先の日誌の行
function buildInboxRemoveManyJournalEntry(args: {
  index: number;
  chunkCount: number;
  chunk: readonly string[];
  reason: string;
  filterText: string;
}): JournalEntryInput {
  const { index, chunkCount, chunk, reason, filterText } = args;
  return {
    type: 'decision',
    decision:
      `受信箱の未読を絞り込みで一括して畳む（消す）` +
      `（${index + 1}/${chunkCount} 塊目、この塊は ${chunk.length} 件）: ${reason}\n` +
      `絞り込み: ${filterText}\n` +
      `消す id: ${chunk.join(' ')}`,
    grounds:
      'クローン自身が inbox_remove_many で絞り込んで消す（人間はこれを読んで後から否定する）',
  };
}

function describeInboxRemoveManyStopped(args: {
  index: number;
  chunkCount: number;
  chunkSize: number;
  error: unknown;
}): string {
  const { index, chunkCount, chunkSize, error } = args;
  return (
    `⚠⚠ ${index + 1}/${chunkCount} 塊目の先の日誌が書けなかったので、この塊（${chunkSize} 件）と` +
    `それ以降は消さずに止めた（${collapseErrorCause(error)}）。` +
    `止める前の ${index} 塊は消えていて日誌にも残っている。残りは同じ絞り込みでもう一度呼べば続きから消せる。`
  );
}

// 「日誌に N 件」は実際に書いた件数で数える: 先の行が書けて止めた回に、書いていない行を名乗らないため
interface InboxRemoveManyRunState {
  removedIds: string[];
  droppedFromDelivery: number;
  raced: number;
  journaledChunks: number;
  stoppedNote: string | undefined;
}

// 塊ごとに「その塊の id を日誌へ書く → 消す」を交互に回す（`removeInboxChunkJournalFirst`）: 消すと配達も止まって戻らないので、消してから書くと日誌が落ちた回に何を畳んだかが残らないため
// `stores.inbox.removeMany` を直に呼ばない: 器から消すのと配達を止めるのを1つの呼びで行う関数を通す（helper の中）
async function removeInboxTargetsJournaling(args: {
  stores: InboxRemoveManyStores;
  stopDelivery: InboxDeliveryStop;
  targets: readonly InboxPendingRow[];
  reason: string;
  filterText: string;
}): Promise<InboxRemoveManyRunState> {
  const { stores, stopDelivery, targets, reason, filterText } = args;
  const chunks = chunkIdsByChars(
    targets.map((row) => row.event.id),
    REMOVE_MANY_JOURNAL_ID_CHARS,
  );
  const state: InboxRemoveManyRunState = {
    removedIds: [],
    droppedFromDelivery: 0,
    raced: 0,
    journaledChunks: 0,
    stoppedNote: undefined,
  };
  for (const [index, chunk] of chunks.entries()) {
    const outcome = await removeInboxChunkJournalFirst(
      stores,
      { dropQueuedInboxEvents: stopDelivery },
      chunk,
      () =>
        buildInboxRemoveManyJournalEntry({
          index,
          chunkCount: chunks.length,
          chunk,
          reason,
          filterText,
        }),
    );
    if (outcome.kind === 'journal-failed') {
      // 先の行が書けなかった塊は消していない。1つも消していなければ行為は起きていない（`act-not-performed`）。
      noteDroppedRecord('日誌', journalEntryShape(outcome.entry), outcome.error);
      if (state.journaledChunks === 0) {
        throw new JournalNotRecordedError(
          'inbox_remove_many',
          outcome.entry,
          'act-not-performed',
          outcome.error,
        );
      }
      // 前の塊は消えていて日誌にも在るので投げず、どこまで消したかを返す（投げると「やり直してよい」が前の塊について嘘になる）
      state.stoppedNote = describeInboxRemoveManyStopped({
        index,
        chunkCount: chunks.length,
        chunkSize: chunk.length,
        error: outcome.error,
      });
      break;
    }
    state.journaledChunks += 1;
    state.droppedFromDelivery += outcome.droppedFromDelivery;
    state.removedIds.push(...outcome.removedIds);
    state.raced += outcome.racedIds.length;
  }
  return state;
}

function renderInboxRemoveManyRemovedIds(
  removedIds: readonly string[],
  journaledChunks: number,
): string {
  const shownRemoved = removedIds.slice(0, REMOVE_MANY_IDS_SHOWN);
  const hiddenRemoved = removedIds.length - shownRemoved.length;
  return `消した id（先頭 ${shownRemoved.length} 件）: ${shownRemoved.join(', ')}${
    hiddenRemoved > 0
      ? ` …ほか ${hiddenRemoved} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
      : ''
  }`;
}

// 配達の側にも届いたことを名乗る: 消えた件数だけを出すと器の行しか消さずに「消した」と名乗る形に戻るため
function renderInboxRemoveManyDeliveryNote(droppedFromDelivery: number): string {
  return (
    `配達の待ち行列からも外したのは ${droppedFromDelivery} 件` +
    `（残りは器に在っただけで、まだ配達待ちには載っていなかった分である。` +
    `**既に取り出して処理中のものは取り消せない。**）`
  );
}

function renderInboxRemoveManyRacedNote(targetCount: number, raced: number): string[] {
  return raced === 0
    ? []
    : [
        `⚠ 対象 ${targetCount} 件のうち ${raced} 件は消せなかった` +
          '（この呼びの最中に他の経路が先に消した）。',
      ];
}

function renderInboxRemoveManyDone(args: {
  reason: string;
  funnel: string;
  filterText: string;
  targetCount: number;
  state: InboxRemoveManyRunState;
  restNote: readonly string[];
  unreadableNote: readonly string[];
}): string {
  const { reason, funnel, filterText, targetCount, state } = args;
  const stopped = state.stoppedNote === undefined ? [] : [state.stoppedNote];
  // 全件が競合したときは「0 件を畳んだ」と空の「消した id」で終えず、消せなかったと言う（`renderCloseManyRacedNote` に倣い、競合の注意を本体にする）
  if (state.removedIds.length === 0 && state.raced > 0) {
    return [
      ...stopped,
      `**1 件も消せなかった**（理由: ${reason}）。`,
      funnel,
      `絞り込み: ${filterText}`,
      ...renderInboxRemoveManyRacedNote(targetCount, state.raced),
      ...args.restNote,
      ...args.unreadableNote,
    ].join('\n');
  }
  return [
    ...stopped,
    `**${state.removedIds.length} 件を畳んだ（消した）**（理由: ${reason}）。`,
    funnel,
    `絞り込み: ${filterText}`,
    renderInboxRemoveManyRemovedIds(state.removedIds, state.journaledChunks),
    renderInboxRemoveManyDeliveryNote(state.droppedFromDelivery),
    ...renderInboxRemoveManyRacedNote(targetCount, state.raced),
    ...args.restNote,
    ...args.unreadableNote,
  ].join('\n');
}

// 人間起点の合図（`human_message` / `human_answer`）を選べない形にする: クローンは自分の側の都合で溜まった合図だけを畳める
// 絞り込みの判定をストアへ複製しない: SQL 側へ同じ判定を書くと「一覧に見えている件数」と「実際に消える件数」が別の実装を持つことになるため
export function inboxRemoveManyTool(context: ToolContext, stores: Stores) {
  return tool(
    'inbox_remove_many',
    [
      '受信箱（`InboxStore`）の未読を、**絞り込みを渡してまとめて畳む（消す）**。',
      '1件ずつ消す道具（内部の `remove()`）はこの器から呼べない——同じ失敗の写しが',
      '数千件積もると、1ターン1件のペースでの排出それ自体が文脈窓を食い潰す。',
      '**既定は試算（dryRun）で、1件も消さない。** 実際に消すには `dryRun: false` を明示すること——',
      '消した合図を戻す道具はこの器に無いので、撃ち間違えは道具では戻せない。',
      `**\`types\` は必須で、選べる5種類（${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(' / ')}）を` +
        '全部並べた呼びは断る**' +
        '（「全部消す」を1回で撃てる形は作らない——それは `POST /reset` の役目である）。',
      '**人間起点の合図（`human_message` / `human_answer`）はそもそも選べない。**' +
        'あなたは自分の側の都合で溜まった合図だけを畳める——人間から届いた合図を' +
        '自分の判断で畳む口は、この道具には無い（オーナー判断）。',
      '**行は消える。** `task_set_status_many` の「閉じる（closedAt を付けるだけで行は残る）」とは違い、',
      '受信箱は「まだ処理し終えていない」という事実だけを持つ器で、片付いた後の記録を残す場所ではない',
      '（`InboxStore` の doc）。**消した id は全部日誌に残る。**',
    ].join(''),
    {
      types: inboxRemoveManyTypesToolInputSchema.describe(
        `例 {"types":["manager_message"]}。配列で渡し、値は引用符で囲む。` +
          `消す対象の種類（必須。${formatArrayLengthJa({ min: 1 })}）。選べる5種類 ` +
          `(${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(' / ')}) を全部並べると断られる。` +
          '人間起点の human_message / human_answer はここに無い——選べない' +
          '（自分の受信箱から人間の発言・回答を自分の判断で畳むことはできない）。' +
          '例: 委譲先の429の写しを畳むなら manager_message だけを狙う',
      ),
      sources: z
        .array(z.string())
        .optional()
        .describe(
          `例 {"sources":["external:token-pool"]}。配列で渡し、値は引用符で囲む。` +
            `送信元の**完全一致**（配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。\`manager_list\` の内訳（送信元）に出る表記` +
            '（例 "external:token-pool" / "manager:mgr-xxx"）をそのまま渡す。' +
            '送信元を言えない種類（distill / timer / self_initiative）の行は、' +
            'これを渡すと必ず対象から外れる',
        ),
      before: z
        .string()
        .optional()
        .describe(
          `この時刻**以前**（ISO8601、その瞬間ちょうども含む。${formatStringLengthJa({ min: 1 })}）に積まれた行だけを対象にする。` +
            '元に戻せない操作なので時差が必須（Z か +09:00。例 2026-09-15T00:00:00Z。時差の無い形は断る）。' +
            '消している最中に届いた新しい行を巻き込まないために使う',
        ),
      reason: z
        .string()
        .describe(
          `何をもってこの絞り込みに当たる行を畳んでよいとしたか（${formatStringLengthJa({ min: 1 })}）。人間はこれを読んで後から否定する`,
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          '省略すると true（何件当たるかを数えるだけで1件も消さない）。実際に消すときだけ false を明示する',
        ),
      limit: z
        .number()
        .optional()
        .describe(
          `1回の呼びで消す上限（${formatIntRangeJa({ min: 1, max: REMOVE_MANY_LIMIT_MAX })}。省略すると 500）。**古い側から**消す。` +
            '残りは同じ絞り込みでもう一度呼べば続けられる',
        ),
    },
    async ({ types, sources, before, reason, dryRun, limit }) => {
      const violation = describeInboxRemoveManyViolation({
        types,
        sources,
        before,
        reason,
        limit,
      });
      if (violation !== null) return text(violation);

      const filter: InboxRemoveManyFilter = {
        types,
        ...(sources === undefined ? {} : { sources }),
        ...(before === undefined ? {} : { before }),
      };
      const { allPending, matched, unreadableNote } = await selectInboxRemoveManyTargets(
        stores.inbox,
        filter,
      );

      const filterText = describeInboxRemoveManyFilterText(filter);
      const funnel = renderInboxRemoveManyFunnel(allPending.length, matched.length);

      const unreadableLines = renderInboxRemoveManyUnreadableNote(unreadableNote);

      if (matched.length === 0) {
        const why = describeInboxRemoveManyZeroReason(allPending, filter, unreadableNote);
        // 読めた未読が0件のときは理由の文が読めない行を言っているので、注意を重ねない
        return text(
          renderInboxRemoveManyZeroResult(
            funnel,
            why,
            allPending.length === 0 ? [] : unreadableLines,
          ),
        );
      }

      const effectiveLimit = limit ?? REMOVE_MANY_LIMIT_DEFAULT;
      const targets = matched.slice(0, effectiveLimit);
      const restNote = renderInboxRemoveManyRestNote(
        matched.length - targets.length,
        effectiveLimit,
      );

      // 省略された `dryRun` は試算にする: 消した合図を戻す道具が無いため
      if (dryRun !== false) {
        return text(
          renderInboxRemoveManyDryRun({
            funnel,
            filterText,
            targets,
            matchedCount: matched.length,
            restNote,
            unreadableNote: unreadableLines,
          }),
        );
      }

      // 配達を止める口が無ければ1件も消さない: 行を消した状態で配達だけが続くほうが、1件も消さないより悪い（掃除できたと誤解するのにターンは起き続ける）ため
      const stopDelivery = context.dropQueuedInboxEvents;
      if (stopDelivery === undefined) return text(renderInboxRemoveManyNoDeliveryRefusal());

      const state = await removeInboxTargetsJournaling({
        stores,
        stopDelivery,
        targets,
        reason,
        filterText,
      });
      return text(
        renderInboxRemoveManyDone({
          reason,
          funnel,
          filterText,
          targetCount: targets.length,
          state,
          restNote,
          unreadableNote: unreadableLines,
        }),
      );
    },
  );
}
