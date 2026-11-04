// 継続中の依頼（schedule_list / schedule_create / schedule_remove）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { CRON_EXPRESSION_MAX, isCronExpression } from './cron.js';
import { collapseErrorCause } from './error-cause.js';
import { encodeScheduleCursor, resolveScheduleCursor } from './schedule-cursor.js';
import { renderStandingRow } from './digest.js';
import { journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import {
  describePage,
  excerpt,
  excerptLine,
  page,
  renderListing,
  renderListingEntry,
} from './excerpt.js';
import { dropUnreadTimersOfKind, removeScheduleJournalFirst } from './schedule-remove.js';
import { stripNul } from './nul-guard.js';
import {
  RESERVED_SCHEDULE_KINDS,
  describeReservedScheduleKindEnvKeys,
  describeScheduleSpec,
  parseTimeOfDay,
} from './schedule.js';
import { scheduleReplaceEntry } from './schedule-replace.js';
import {
  scheduleKindSchema,
  SCHEDULE_EVERY_MINUTES_MAX,
  scheduleSpecSchema,
  type JournalEntryInput,
  type ScheduleSpec,
  type ScheduledRequest,
} from './schema.js';
import {
  UnreadableScheduleError,
  ScheduleConflictError,
  describeUnreadableScheduleEdit,
  describeUnreadableSchedules,
} from './store.js';
import {
  describeBlankViolation,
  describeIntRangeViolation,
  formatIntRangeJa,
} from './tool-arg-checks.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import {
  tool,
  text,
  appendJournalOrThrow,
  appendJournalOrDrop,
  JournalNotRecordedError,
} from './clone-tools-common.js';

const SCHEDULE_LIST_BUDGET = 8_000;

const SCHEDULE_REQUEST_EXCERPT = 200;

// `schedule_create` が、読んだ後に版が変わって書き込みが衝突したとき読み直す回数（上限が無いと、書き換え続ける相手と無限に競る）
const SCHEDULE_CREATE_ATTEMPTS = 3;

const SCHEDULE_PAGE = 8_000;

// 取れないときも黙って行を消さない: scheduler が渡っていない（配線の欠落）と未反映（一時的）を文言で分ける
function scheduleNextAtOf(context: ToolContext, kind: string): string {
  if (context.scheduler === undefined) return '（取れない — scheduler が渡っていない）';
  const status = context.scheduler().find((entry) => entry.kind === kind);
  return status === undefined ? '（まだ計算されていない。少し待って呼び直すこと）' : status.nextAt;
}

type ScheduleCreateStores = CloneToolsShared['stores'];

interface ScheduleCreateInput {
  kind: string;
  request: string;
  dailyAt: string | undefined;
  everyMinutes: number | undefined;
  cron: string | undefined;
}

// 引数の検査。断る文を返す（通れば null）。順序は元のまま
function describeScheduleCreateViolation(input: ScheduleCreateInput): string | null {
  const { kind, request, dailyAt, everyMinutes, cron } = input;
  const parsedKind = scheduleKindSchema.safeParse(kind);
  if (!parsedKind.success) {
    return `kind "${kind}" は使えない（英小文字・数字・. _ - のみ、64文字まで）。`;
  }
  // 「空」は NUL を落とした後で見る: ストアは NUL を落として残すので、落とす前の長さで見ると NUL だけの `request` が日誌より先へ進むため
  if (stripNul(request).length === 0) {
    return 'request が空文字は使えない（依頼の本文を渡すこと）。';
  }
  // 空白だけの本文も空と同じ: 毎回届く依頼に中身が無くなる（既存の置き換えは本文を渡すので、この検査で断られる呼び方は無い）
  const requestBlankError = describeBlankViolation('request', request);
  if (requestBlankError !== null) return requestBlankError;
  if (RESERVED_SCHEDULE_KINDS.includes(parsedKind.data)) {
    return (
      `${parsedKind.data} は既定の定期ジョブの名前なので使えない（別の名前を付けること）。` +
      '既定の刻みそのもの（締め時刻・間隔）を変えたいなら、それはデーモンの設定' +
      `（${describeReservedScheduleKindEnvKeys()}）なので人間に頼むこと。`
    );
  }
  const given = [dailyAt, everyMinutes, cron].filter((value) => value !== undefined);
  if (given.length !== 1) {
    return 'dailyAt / everyMinutes / cron のうち、どれか1つだけ渡すこと。';
  }
  if (dailyAt !== undefined && dailyAt !== dailyAt.trim()) {
    return `dailyAt "${dailyAt}" は前後に空白がある（HH:MM だけを渡すこと）。`;
  }
  if (cron !== undefined && cron !== cron.trim()) {
    return `cron "${cron}" は前後に空白がある（分 時 日 月 曜の5欄だけを渡すこと。例: 毎週月曜 10:00 なら \`0 10 * * 1\`）。`;
  }
  if (dailyAt !== undefined && parseTimeOfDay(dailyAt) === null) {
    return `dailyAt "${dailyAt}" は HH:MM として読めない。`;
  }
  if (cron !== undefined && !isCronExpression(cron)) {
    return `cron "${cron}" は cron 式として読めない（分 時 日 月 曜の5欄だけ。秒つきは使えない。例: 毎週月曜 10:00 なら \`0 10 * * 1\`）。`;
  }
  const everyViolation = describeIntRangeViolation('everyMinutes', everyMinutes, {
    min: 1,
    max: SCHEDULE_EVERY_MINUTES_MAX,
  });
  if (everyViolation !== null) {
    return `${everyViolation}1年（${SCHEDULE_EVERY_MINUTES_MAX}分）より長い周期は everyMinutes ではなく cron 式か単発の予定で書くこと。`;
  }
  return null;
}

function buildScheduleCreateSpec(input: ScheduleCreateInput): ScheduleSpec {
  const { dailyAt, everyMinutes, cron } = input;
  return dailyAt !== undefined
    ? { type: 'daily', at: dailyAt }
    : cron !== undefined
      ? { type: 'cron', expression: cron }
      : { type: 'every', minutes: everyMinutes ?? 60 };
}

// 日誌を先に書く行（試行ごと）。置き換えるときは旧本文・旧周期を逐語で残す（置き換えると行から消える）
function buildScheduleCreateAttemptJournalEntry(args: {
  kind: string;
  request: string;
  spec: ScheduleSpec;
  previous: ScheduledRequest | null;
  unreadable: boolean;
}): JournalEntryInput {
  const { kind, request, spec, previous, unreadable } = args;
  return previous === null
    ? {
        type: 'decision',
        decision: unreadable
          ? `定期の依頼を設定しようとしている（同じ kind の行が読めない形で入っているので、置き換え前の本文は残せない）: ${kind}: ${request}`
          : `定期の依頼を設定しようとしている: ${kind}: ${request}`,
        grounds: '継続する依頼を時間起点として持つ判断',
      }
    : scheduleReplaceEntry({
        kind,
        previous,
        next: { request, spec },
      });
}

function buildScheduleCreateConflictJournalEntry(kind: string): JournalEntryInput {
  return {
    type: 'decision',
    decision: `直前の定期の依頼の設定の行は効いていない（${kind} は書き換えていない）。理由: 読んだ後に同じ kind が別の書き手に変えられていた`,
    grounds: '日誌を先に書いたが、依頼の書き込みが実行されなかったため打ち消して読み直す',
  };
}

function buildScheduleCreateFailedJournalEntry(args: {
  kind: string;
  request: string;
  cause: 'unreadable' | 'conflict-limit' | 'other';
}): JournalEntryInput {
  const { kind, request, cause } = args;
  if (cause === 'conflict-limit') {
    // 最後の回の先の行を打ち消す（上限の手前の回と同じ形で、上限に達したことも言う）
    return {
      type: 'decision',
      decision: `直前の定期の依頼の設定の行は効いていない（${kind} は書き換えていない）。理由: 読んだ後に同じ kind が別の書き手に変えられ続け、${SCHEDULE_CREATE_ATTEMPTS} 回試して諦めた`,
      grounds:
        '日誌を先に書いたが、依頼の書き込みが別の書き手との競合で最後まで実行されなかったため打ち消す',
    };
  }
  const unreadable = cause === 'unreadable';
  return {
    type: 'decision',
    decision: unreadable
      ? `定期の依頼を設定できなかった（読めない形で入っている）: ${kind}: ${request}`
      : `定期の依頼を設定できなかった: ${kind}: ${request}`,
    grounds: unreadable
      ? '継続する依頼を時間起点として持とうとしたが、その kind の行が読めないので書いていない'
      : '継続する依頼を時間起点として持とうとしたが、状態の変更が失敗した',
  };
}

function buildScheduleCreateDoneJournalEntry(args: {
  replaced: boolean;
  plan: ScheduledRequest;
  request: string;
}): JournalEntryInput {
  const { replaced, plan, request } = args;
  return {
    type: 'decision',
    decision:
      `${replaced ? '定期の依頼を直した' : '定期の依頼を仕込んだ'}: ` +
      `${plan.kind}（${describeScheduleSpec(plan.spec)}）: ${request}`,
    grounds: '継続する依頼を時間起点として持つ判断',
  };
}

function renderScheduleCreateConflictRefusal(kind: string): string {
  return (
    `${kind} は書き込みの直前に別の書き手に変えられ続けたので、設定していない。` +
    'schedule_list で確かめてから、もう一度 schedule_create を試すこと。'
  );
}

// 読めない行は `null` のまま進める: `editRequest` が `UnreadableScheduleError` を投げ、呼び元が理由の分かる文にする
async function readScheduleCreatePrevious(
  stores: ScheduleCreateStores,
  kind: string,
): Promise<{ previous: ScheduledRequest | null; unreadable: boolean }> {
  try {
    return { previous: await stores.schedules.get(kind), unreadable: false };
  } catch (error) {
    if (!(error instanceof UnreadableScheduleError)) throw error;
    return { previous: null, unreadable: true };
  }
}

// 編集は `editRequest`、新規作成だけ `put`: 読んでから書く間に定期発火の `claimRun` が割り込むと、その印を消す lost update になるため
async function writeScheduleCreateRow(args: {
  stores: ScheduleCreateStores;
  kind: string;
  request: string;
  spec: ScheduleSpec;
  changes: { request: string; spec: ScheduleSpec };
  previous: ScheduledRequest | null;
  now: string;
}): Promise<ScheduledRequest> {
  const { stores, kind, request, spec, changes, previous, now } = args;
  const edited = await stores.schedules.editRequest(kind, changes, now, {
    ifMatch: previous?.updatedAt ?? null,
  });
  if (edited !== null) return edited;
  const created: ScheduledRequest = {
    kind,
    spec,
    request,
    createdAt: now,
    updatedAt: now,
  };
  await stores.schedules.put(created, { ifMatch: null });
  return created;
}

type ScheduleCreateRun =
  | {
      kind: 'written';
      plan: ScheduledRequest;
      previous: ScheduledRequest | null;
      replaceEntryId: string | undefined;
    }
  | { kind: 'refused'; message: string };

// 置き換えの旧値は、書く直前に読んだ行の版（`ifMatch`）で書き込みへ結びつける: 日誌に残した本文と実際に上書きされる本文を同じものにするため。
// 読んだ後に版が変わっていたら先の行を打ち消して読み直す（`removeScheduleJournalFirst` と同じ考え方）。
// 新規作成は「無いときだけ」（`ifMatch: null`）で書く: `editRequest` が「無い」と答えてから書くまでに同じ名前が作られていたら、
// 無条件の `put` はその依頼を丸ごと置き換え、引き受け中の発火の印（`pendingRun`）まで消すため。作られていたら同じ kind として置き換える
async function createScheduleRowJournaling(args: {
  stores: ScheduleCreateStores;
  kind: string;
  request: string;
  spec: ScheduleSpec;
  now: string;
}): Promise<ScheduleCreateRun> {
  const { stores, kind, request, spec, now } = args;
  const changes = { request, spec };
  let plan: ScheduledRequest | undefined;
  let previous: ScheduledRequest | null = null;
  let replaceEntryId: string | undefined;
  for (let attempt = 1; plan === undefined; attempt += 1) {
    const read = await readScheduleCreatePrevious(stores, kind);
    previous = read.previous;

    // 日誌を先に書く: 書けなければ仕込まずに道具のエラーで返すため
    const attemptEntry = await appendJournalOrThrow(
      'schedule_create',
      stores.journal,
      buildScheduleCreateAttemptJournalEntry({
        kind,
        request,
        spec,
        previous,
        unreadable: read.unreadable,
      }),
      'act-not-performed',
    );
    replaceEntryId = previous === null ? undefined : attemptEntry.id;

    try {
      plan = await writeScheduleCreateRow({
        stores,
        kind,
        request,
        spec,
        changes,
        previous,
        now,
      });
    } catch (error) {
      const unreadable = error instanceof UnreadableScheduleError;
      const conflict = error instanceof ScheduleConflictError;
      if (conflict && attempt < SCHEDULE_CREATE_ATTEMPTS) {
        await appendJournalOrDrop(
          'schedule_create',
          stores.journal,
          buildScheduleCreateConflictJournalEntry(kind),
        );
        continue;
      }
      // 読めない行は例外のまま落とさず、理由の分かる文で返す
      await appendJournalOrDrop(
        'schedule_create',
        stores.journal,
        buildScheduleCreateFailedJournalEntry({
          kind,
          request,
          cause: unreadable ? 'unreadable' : conflict ? 'conflict-limit' : 'other',
        }),
      );
      if (unreadable) return { kind: 'refused', message: describeUnreadableScheduleEdit(error) };
      if (conflict) return { kind: 'refused', message: renderScheduleCreateConflictRefusal(kind) };
      throw error;
    }
  }
  return { kind: 'written', plan, previous, replaceEntryId };
}

// 新規作成の応答は変えない
function renderScheduleCreateCreated(plan: ScheduledRequest): string {
  return `${plan.kind} を ${describeScheduleSpec(plan.spec)}で仕込んだ。時刻が来たら依頼の本文とともに届く。`;
}

function renderScheduleCreateReplaced(args: {
  plan: ScheduledRequest;
  previous: ScheduledRequest;
  replaceEntryId: string | undefined;
}): string {
  const { plan, previous, replaceEntryId } = args;
  const oldRequest = excerpt(previous.request, SCHEDULE_REQUEST_EXCERPT);
  const truncated = oldRequest !== previous.request;
  return (
    `${plan.kind} は既に在ったので置き換えた（${describeScheduleSpec(plan.spec)}で仕込み直した）。` +
    `置き換え前は ${describeScheduleSpec(previous.spec)}、依頼本文は「${oldRequest}」だった` +
    (truncated
      ? `（本文は抜粋。置き換え前の全文は日誌に逐語で残してある: journal_read id=${replaceEntryId ?? ''}）`
      : '（置き換え前の本文は日誌にも残してある）') +
    '。時刻が来たら新しい依頼の本文とともに届く。'
  );
}

export function scheduleTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;
  return [
    tool(
      'schedule_list',
      [
        '仕込んである継続中の依頼の一覧。周期と、前回それで動いた時刻・次に動く時刻が分かる。',
        // 一覧を数え直さず `RESERVED_SCHEDULE_KINDS` から導出する: 足されたとき取り残されるため
        `既定の定期ジョブ（${RESERVED_SCHEDULE_KINDS.join(' / ')}）はここには出ない（あれは設定で回っているもの）。`,
        '一覧の依頼本文は抜粋で、全文が要る1件は kind を渡して取る。',
        '一覧が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
      ].join(' '),
      {
        kind: z
          .string()
          .optional()
          .describe('この1件の依頼本文を全文で読む（一覧に出ている kind）'),
        offset: z
          .number()
          .optional()
          .describe(`kind で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧モードの続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。' +
              'kind を渡す全文モードでは他の条件と同じく無視される。',
          ),
      },
      async ({ kind, offset = 0, cursor }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (kind !== undefined) {
          // 読めない行は案内する文で返す: 書き直しの手段が無く、`schedule_remove` で外す以外に回復手段が無いため
          let plan: Awaited<ReturnType<typeof stores.schedules.get>>;
          try {
            plan = await stores.schedules.get(kind);
          } catch (error) {
            if (!(error instanceof UnreadableScheduleError)) throw error;
            return text(
              `継続中の依頼 ${kind} は読めない形で入っている（消されたのではない）。` +
                `schedule_remove kind=${kind} で外せる。`,
            );
          }
          if (!plan) return text(`継続中の依頼 ${kind} は無い（kind が違うか、もう外してある）。`);
          // 行をこの応答で見せた: 定期の tick が会話の上の別の版を「最後に全文で出した版」と畳まないよう、控えがこの版と違えば捨てる（同じなら残す）
          context.keepStandingRowIfSame?.(plan.kind, renderStandingRow(plan));
          const head =
            `${plan.kind}（${describeScheduleSpec(plan.spec)}）` +
            ` 前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}` +
            ` 次に動く時刻: ${scheduleNextAtOf(context, plan.kind)}`;
          const part = page(plan.request, offset, SCHEDULE_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは schedule_list kind=${plan.kind} offset=${part.to}）`
            : '';
          return text(`${head}（依頼本文: ${describePage(part)}）\n\n${part.body}${tail}`);
        }

        const scheduleList = await stores.schedules.list();
        const plans = scheduleList.entries;
        // 読めない行は一覧から消さず、件数と kind で言う
        const unreadableNote = describeUnreadableSchedules(scheduleList.unreadable);
        if (plans.length === 0) {
          return text(
            unreadableNote === null
              ? '（継続中の依頼は無い）'
              : `（読めた継続中の依頼は無い）\n${unreadableNote}`,
          );
        }

        const cursorOutcome = resolveScheduleCursor(plans, cursor);
        if (cursorOutcome.kind === 'malformed') {
          return text(
            'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
              '一覧を先頭から読み直すには cursor を付けずに schedule_list を呼ぶこと。',
          );
        }
        const view = cursorOutcome.view;
        // 一覧で見せた行の kind も、上と同じ理由で控えを捨てる（予算で切れて載らなかった行まで捨てるのは安全側）。控えと同じ版なら残す
        for (const plan of view)
          context.keepStandingRowIfSame?.(plan.kind, renderStandingRow(plan));
        const items = view.map((plan) =>
          renderListingEntry({
            id: plan.kind,
            title: describeScheduleSpec(plan.spec),
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            summary: `依頼: ${excerptLine(plan.request, SCHEDULE_REQUEST_EXCERPT)}`,
            extra: [
              `  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
              `  次に動く時刻: ${scheduleNextAtOf(context, plan.kind)}`,
            ],
          }),
        );
        const lines = [
          view.length === 0
            ? '（cursor より後ろの継続中の依頼は無い。これが最後の頁）'
            : renderListing(items, {
                budget: SCHEDULE_LIST_BUDGET,
                // 母数は cursor を当てる前の `plans.length`: `renderListing` が渡す `total` は cursor 以降の残りで、頁が進むと変わるため
                omitted: ({ rest, shown }) => {
                  const total = plans.length;
                  const lastShown = view[shown - 1]!;
                  const nextCursor = encodeScheduleCursor({ kind: lastShown.kind });
                  return (
                    `…ほか ${rest} 件は省略（継続中の依頼は ${total} 件あり、${shown} 件だけ出した。` +
                    'kind の昇順で並んでいるので、省いたのはこれより後ろ（kind の綴りが後）の依頼である。' +
                    `続きは schedule_list cursor=${nextCursor} で取れる）。`
                  );
                },
              }),
        ];
        // 今回の応答に実際に載った件数（`view.length`）で見る: 最後の頁で1件も出していないのにこの行だけが付くのを避けるため
        if (view.length > 0) {
          lines.push('（依頼本文は抜粋。全文は schedule_list kind=<kind> で取れる）');
        }
        if (unreadableNote !== null) lines.push(unreadableNote);
        return text(lines.join('\n'));
      },
    ),

    tool(
      'schedule_create',
      [
        'その場で終わらない依頼を、時間起点として仕込む。',
        '時刻が来れば必ずあなたの受信箱へ届き、そのとき依頼の本文と前回動いた時刻が一緒に渡る。',
        '記憶に書くのは判断の根拠であって、記憶は時計を持たない。継続する依頼はここにも置くこと。',
        '同じ kind で呼べば置き換わる（周期や本文の直しはこれで行う）。',
        '置き換えたときは、応答が置き換え前の本文と周期を言い、置き換え前の本文は日誌にも逐語で残る。',
        // 予約名は `RESERVED_SCHEDULE_KINDS` から導出する: 手で書き写すと既定の刻みが増えたときここだけ古くなるため
        `既定の定期ジョブの名前（${RESERVED_SCHEDULE_KINDS.join(' / ')}）は使えない——別の名前を付けること。`,
        `既定の刻みそのもの（締め時刻・間隔）はデーモンの設定で決まる（${describeReservedScheduleKindEnvKeys()}）ので、変えたいなら人間に頼むこと。`,
      ].join(' '),
      {
        kind: z
          .string()
          .describe('この依頼の名前（英小文字・数字・. _ -）。後から直す・消すときの識別子'),
        request: z
          .string()
          .describe(
            '依頼の本文。時刻が来たときのあなたが読んで、そのまま動ける粒度で書く' +
              '（対象・狙い・どこまでやるか。人間から頼まれた言葉そのものも残すとよい）',
          ),
        dailyAt: z
          .string()
          .optional()
          .describe('毎日この時刻に起こす（ローカル時刻の HH:MM）。周期はどれか1つだけ渡す'),
        everyMinutes: z
          .number()
          .optional()
          .describe(
            `この分数ごとに起こす（${formatIntRangeJa({ min: 1, max: SCHEDULE_EVERY_MINUTES_MAX })}。1年より長い周期は cron か単発で書く）。周期はどれか1つだけ渡す`,
          ),
        cron: z
          .string()
          .optional()
          .describe(
            'cron 式で起こす（ローカル時刻。分 時 日 月 曜の5欄だけ。例: 毎週月曜 10:00 なら `0 10 * * 1`）。' +
              '曜日や月の指定が要るときはこれを使う。周期はどれか1つだけ渡す',
          ),
      },
      async ({ kind, request, dailyAt, everyMinutes, cron }) => {
        const input: ScheduleCreateInput = { kind, request, dailyAt, everyMinutes, cron };
        const violation = describeScheduleCreateViolation(input);
        if (violation !== null) return text(violation);
        const parsedKind = scheduleKindSchema.parse(kind);

        const parsedSpec = scheduleSpecSchema.safeParse(buildScheduleCreateSpec(input));
        if (!parsedSpec.success) {
          return text(
            `周期を読めなかった（dailyAt は HH:MM、everyMinutes は ${formatIntRangeJa({ min: 1, max: SCHEDULE_EVERY_MINUTES_MAX })} の整数、` +
              `cron は分 時 日 月 曜の5欄で ${CRON_EXPRESSION_MAX} 字まで）。`,
          );
        }

        const now = new Date().toISOString();

        const run = await createScheduleRowJournaling({
          stores,
          kind: parsedKind,
          request,
          spec: parsedSpec.data,
          now,
        });
        if (run.kind === 'refused') return text(run.message);
        const { plan, previous, replaceEntryId } = run;
        // 書き換えた版は応答（置き換えなら旧版も）で会話に載る: 定期の tick の控えが古い版のまま「最後に全文で出した版と同じ」と畳まないよう、その kind の控えを捨てる
        // 投げても書けた事実は残す: 最後の日誌は普段どおり書き、応答の末尾に注を足す
        let forgetNote = '';
        try {
          context.forgetStandingRow?.(parsedKind);
        } catch (error) {
          forgetNote =
            `（定期の tick の控えを捨てられなかった: ${collapseErrorCause(error)}。` +
            '次の tick で、以前の版と同じとして畳まれることがある）';
        }
        await appendJournalOrDrop(
          'schedule_create',
          stores.journal,
          buildScheduleCreateDoneJournalEntry({ replaced: previous !== null, plan, request }),
        );
        if (previous === null) return text(renderScheduleCreateCreated(plan) + forgetNote);
        return text(renderScheduleCreateReplaced({ plan, previous, replaceEntryId }) + forgetNote);
      },
    ),

    tool(
      'schedule_remove',
      '継続中の依頼を片付ける。済んだ依頼・もう要らない依頼はここで外す。',
      { kind: z.string().describe('schedule_list に出ている kind') },
      async ({ kind }) => {
        // 外した行の本文は行から消えるので、日誌へ残してから外す（`removeScheduleJournalFirst`）。壊れた行は `get` が投げるので、読めない形で入っていた依頼として扱い、外す目的まで届かせる。
        const result = await removeScheduleJournalFirst(stores, kind, {
          buildEntry: (before) => ({
            type: 'decision',
            decision:
              before === 'unreadable'
                ? // 読めなかった行なので本文（`request`）は取り出せない
                  `読めない形で入っていた依頼を外す: ${kind}`
                : `定期の依頼を外す: ${kind}: ${before.request}`,
            grounds: 'この依頼はもう要らないという判断',
          }),
        });
        if (result.kind === 'journal-failed') {
          // 外す前に落ちたので何も起きていない（`act-not-performed`）
          noteDroppedRecord('日誌', journalEntryShape(result.entry), result.error);
          throw new JournalNotRecordedError(
            'schedule_remove',
            result.entry,
            'act-not-performed',
            result.error,
          );
        }
        // 外せなかった（先に読んだ後で消えていた）: 打ち消しの行は helper が足してある
        if (result.kind !== 'removed') return text(`継続中の依頼 ${kind} は無い。`);
        // 口が渡されない器は消さない: 配達だけが続く半端な状態を作らない（本番の `ToolContext` は2箇所とも渡している）
        if (context.dropQueuedInboxEvents !== undefined) {
          await dropUnreadTimersOfKind(
            stores,
            { dropQueuedInboxEvents: context.dropQueuedInboxEvents },
            kind,
          );
        }
        // 外した行の控えも捨てる: 同じ kind が後で別の本文で作り直されても、古い版を「前回と同じ」と畳まないため
        try {
          context.forgetStandingRow?.(kind);
        } catch (error) {
          // 行は外れて日誌にも残っている: 例外で返すとクローンが「外せなかった」と受け取るので、事実と注を返す
          return text(
            `${kind} を外した。（定期の tick の控えを捨てられなかった: ${collapseErrorCause(error)}。` +
              '次の tick で、外す前の版と同じとして畳まれることがある）',
          );
        }
        return text(`${kind} を外した。`);
      },
    ),
  ];
}
