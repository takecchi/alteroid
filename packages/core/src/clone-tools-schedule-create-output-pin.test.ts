import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RESERVED_SCHEDULE_KINDS } from './schedule.js';
import type { ScheduledRequest } from './schema.js';
import { ScheduleConflictError, UnreadableScheduleError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `schedule_create` の出力（全文と字数）と、呼んだあとの状態（定期の依頼の行・日誌へ足された行・`forgetStandingRow` へ渡した kind・
// スケジュールのストアの書き込み口の呼び）を、場面ごとにコミットした固定値（clone-tools-schedule-create-output-pin.json）と丸ごと比べる。
// `clone-tools-schedule.ts` の `tool('schedule_create', …)`（約 164 行・入れ子 6 段の式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・本文・時刻）を固定して毎回同じにする。
// この道具は定期の依頼を書き換える（新規・置き換え）ので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外の名前）
//   - schedules: 呼んだあとの定期の依頼の行（`stores.schedules.list()` の entries 全行）と、読めない行の一覧（unreadable）。
//     メモリのストアは壊れた行を持てないので、読めない行の場面は `unreadableRow` の口で get / editRequest / put(版つき) を
//     `UnreadableScheduleError` で落とし、list の unreadable にその kind を載せて再現する
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・id・at をそのまま）。id は日誌のインメモリの採番（id-1, id-2, …）で場面ごとに作り直す
//   - forgotten: `context.forgetStandingRow` に渡した kind の並び（口が無い配線の場面は常に空）
//   - storeCalls: スケジュールのストアの書き込み口（`editRequest`・`put`）の呼びの並び（引数・`ifMatch`・結果）。読み（get）は数えない
//   - wrote: 定期の依頼か日誌のどちらかが呼ぶ前から変わったか。断った場面は false で、定期の依頼と日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_SCHEDULE_CREATE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-schedule-create-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-schedule-create-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、定期の依頼・日誌のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ（日誌の at・新しい行の updatedAt が呼び順に増える）。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 「読んだ後に別の書き手が変えた」は、書き込み口の呼びの直前に別の経路（素のストア）で行を直す・作る・消す口（beforeEdit / beforePut）で作る。
// 衝突そのものを出す口（editThrows / putThrows の 'conflict'）は、ストアに行を作らず `ScheduleConflictError` だけを投げる。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（定期の依頼か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

/** 書き込み口の直前に、別の経路が行へ手を入れる */
type Interference = 'bump' | 'bump-long' | 'create' | 'delete';

/** 書き込み口が投げる例外 */
type Failure = 'unreadable' | 'plain' | 'conflict';
/** 場面の中で呼びごとに差し替える口（ストアの振る舞い。番号は呼びの中での 1 から数えた回） */
interface Hooks {
  /** `get` の n 回目を投げさせる */
  getFails: Record<number, 'unreadable' | 'plain'>;
  /** この kind の行が「在るが読めない」: get・editRequest・版つき put が UnreadableScheduleError、list の unreadable に載る */
  unreadableRow: boolean;
  beforeEdit: Record<number, Interference>;
  beforePut: Record<number, Interference>;
  editThrows: Record<number, Failure>;
  putThrows: Record<number, Failure>;
  /** `journal.append` の n 回目（呼びの中・1 から。打ち消しの行も数える）を投げさせる */
  journalFailsAt: number[];
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Hooks>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: ScheduledRequest[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const SEED_AT = '2026-10-01T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-schedule-create-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_SCHEDULE_CREATE_PIN === '1';

const K = 'weekly-review';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function old(
  kind: string,
  request: string,
  spec: ScheduledRequest['spec'] = { type: 'every', minutes: 60 },
  extra: Partial<ScheduledRequest> = {},
): ScheduledRequest {
  return { kind, spec, request, createdAt: SEED_AT, updatedAt: SEED_AT, ...extra };
}

function call(args: Args): Args {
  return { kind: K, request: '週次の見直しをする', ...args };
}

const LONG_OLD = (size: number): string => `先頭。${'あ'.repeat(size - 3)}`;

const none = (args: Args): Step => ({ args, writes: 'none' });

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-kind',
    covers:
      'kind の検査（空・大文字・先頭の記号・空白・スラッシュ・NUL・65 文字）。request や周期より先に見るので、request が空でも kind の文言だけを返す。どれも定期の依頼と日誌に触らない',
    seed: [old(K, '旧い本文')],
    steps: [
      none(call({ kind: '', dailyAt: '09:00' })),
      none(call({ kind: 'Bad Kind', dailyAt: '09:00' })),
      none(call({ kind: 'UPPER', dailyAt: '09:00' })),
      none(call({ kind: '-lead', dailyAt: '09:00' })),
      none(call({ kind: '.dot', dailyAt: '09:00' })),
      none(call({ kind: 'has/slash', dailyAt: '09:00' })),
      none(call({ kind: 'a\u0000b', dailyAt: '09:00' })),
      none(call({ kind: 'a'.repeat(65), dailyAt: '09:00' })),
      none(call({ kind: 'Bad Kind', request: '', dailyAt: '09:00' })),
      none(call({ kind: 'Bad Kind', request: '', everyMinutes: 0 })),
    ],
  },
  {
    name: 'arg-request',
    covers:
      'request の検査: 空・NUL だけ（NUL を落とした後で見る）・空白だけ・NUL と空白だけは別の文言（空 / 空白）。予約名・周期の検査より先に見る',
    seed: [old(K, '旧い本文')],
    steps: [
      none(call({ request: '', dailyAt: '09:00' })),
      none(call({ request: '\u0000', dailyAt: '09:00' })),
      none(call({ request: '\u0000\u0000\u0000', dailyAt: '09:00' })),
      none(call({ request: ' ', dailyAt: '09:00' })),
      none(call({ request: '\n\t　', dailyAt: '09:00' })),
      none(call({ request: ' \u0000 ', dailyAt: '09:00' })),
      none(call({ request: '', kind: 'daily-report', dailyAt: '09:00' })),
      none(call({ request: '   ', kind: 'daily-report', dailyAt: '09:00' })),
      none(call({ request: '', dailyAt: '09:00', everyMinutes: 30 })),
      none(call({ request: '', dailyAt: 'zz' })),
    ],
  },
  {
    name: 'arg-reserved',
    covers:
      '予約名（既定の定期ジョブの名前）は使えない。周期の検査より先に見る（周期が無くても・2つ渡しても予約名の文言）。どれも定期の依頼と日誌に触らない',
    seed: [old(K, '旧い本文')],
    steps: [
      ...RESERVED_SCHEDULE_KINDS.map((kind) => none(call({ kind, dailyAt: '09:00' }))),
      none(call({ kind: RESERVED_SCHEDULE_KINDS[0], dailyAt: 'zz' })),
      none(call({ kind: RESERVED_SCHEDULE_KINDS[0] })),
      none(call({ kind: RESERVED_SCHEDULE_KINDS[1], dailyAt: '09:00', everyMinutes: 30 })),
    ],
  },
  {
    name: 'arg-period',
    covers:
      '周期の検査の順: 個数（0・2・3 個。空文字や 0 も「渡した」に数える）→ dailyAt（HH:MM として読めない）→ cron（5欄でない・秒つき・二度と来ない式）→ everyMinutes（0・負・小数・NaN・Infinity・上限超え）。2つ渡すと個数の文言が先',
    seed: [old(K, '旧い本文')],
    steps: [
      none(call({})),
      none(call({ dailyAt: '09:00', everyMinutes: 30 })),
      none(call({ dailyAt: '09:00', cron: '0 10 * * 1' })),
      none(call({ everyMinutes: 30, cron: '0 10 * * 1' })),
      none(call({ dailyAt: '09:00', everyMinutes: 30, cron: '0 10 * * 1' })),
      none(call({ dailyAt: 'zz', everyMinutes: 0 })),
      none(call({ dailyAt: '' })),
      none(call({ dailyAt: '25:00' })),
      none(call({ dailyAt: '24:00' })),
      none(call({ dailyAt: '9:60' })),
      none(call({ dailyAt: 'abc' })),
      none(call({ dailyAt: '09:00:00' })),
      none(call({ dailyAt: '0900' })),
      none(call({ cron: '' })),
      none(call({ cron: '   ' })),
      none(call({ cron: '* * * * * *' })),
      none(call({ cron: '* * * *' })),
      none(call({ cron: 'abc' })),
      none(call({ cron: '60 * * * *' })),
      none(call({ cron: '0 0 30 2 *' })),
      none(call({ everyMinutes: 0 })),
      none(call({ everyMinutes: -1 })),
      none(call({ everyMinutes: 1.5 })),
      none(call({ everyMinutes: Number.NaN })),
      none(call({ everyMinutes: Number.POSITIVE_INFINITY })),
      none(call({ everyMinutes: 525_601 })),
      none(call({ dailyAt: ' 09:00 ' })),
      none(call({ dailyAt: '09:00\n' })),
      none(call({ cron: ' 0 10 * * 1' })),
      none(call({ cron: '0 10 * * 1 ' })),
      none(call({ dailyAt: ' 09:00', everyMinutes: 30 })),
    ],
  },
  {
    name: 'arg-spec-schema',
    covers:
      'dailyAt の前後の空白・cron の前後の空白で 120 字を超える式: かつては検査を通って `scheduleSpecSchema` が断り zod の JSON が応答になった。いまは検査が自前の文（前後に空白がある）で断る。定期の依頼と日誌に触らない',
    seed: [old(K, '旧い本文')],
    steps: [
      none(call({ dailyAt: ' 09:00' })),
      none(call({ dailyAt: '09:00 ' })),
      none(call({ dailyAt: ' 9:00 ' })),
      none(call({ cron: `0 10 * * 1${' '.repeat(120)}` })),
    ],
  },
  // ---- 新規 ----
  {
    name: 'new-daily',
    covers:
      '新規（daily）: 日誌に「設定しようとしている」→ editRequest（ifMatch null）が null → put（ifMatch null）→ 最後の日誌「仕込んだ」。`forgetStandingRow` が1回。応答は新規の文言。「9:00」は表示が 09:00 に揃う',
    seed: [],
    steps: [
      { args: call({ dailyAt: '09:00' }), writes: 'some' },
      { args: call({ kind: 'k-short', dailyAt: '9:00' }), writes: 'some' },
      { args: call({ kind: 'k-midnight', dailyAt: '00:00' }), writes: 'some' },
      { args: call({ kind: 'k-last', dailyAt: '23:59' }), writes: 'some' },
    ],
  },
  {
    name: 'new-every',
    covers:
      '新規（every）: 1 分・30 分・上限ちょうど（525600 分）・既定の 60 分は渡さない限り出ない',
    seed: [],
    steps: [
      { args: call({ everyMinutes: 30 }), writes: 'some' },
      { args: call({ kind: 'k-min', everyMinutes: 1 }), writes: 'some' },
      { args: call({ kind: 'k-max', everyMinutes: 525_600 }), writes: 'some' },
      { args: call({ kind: 'k-hour', everyMinutes: 60 }), writes: 'some' },
    ],
  },
  {
    name: 'new-cron',
    covers:
      '新規（cron）: 週次・5 分ごと・前後に空白のある式（検査で断る。書き込まない）・年に一度の式',
    seed: [],
    steps: [
      { args: call({ cron: '0 10 * * 1' }), writes: 'some' },
      { args: call({ kind: 'k-five', cron: '*/5 * * * *' }), writes: 'some' },
      // 前後に空白のある式は検査で断る（かつてはそのまま保存された）
      none(call({ kind: 'k-spaced', cron: ' 0 10 * * 1 ' })),
      { args: call({ kind: 'k-yearly', cron: '0 0 1 1 *' }), writes: 'some' },
    ],
  },
  {
    name: 'new-forms',
    covers:
      '新規の入力の形: kind の形（64 文字ちょうど・. _ - ・数字始まり）・request の形（NUL 混じりは日誌・行から NUL が落ちる・前後の空白は残る・改行・長い本文）',
    seed: [],
    steps: [
      { args: call({ kind: 'a'.repeat(64), everyMinutes: 30 }), writes: 'some' },
      { args: call({ kind: 'a.b_c-d', everyMinutes: 30 }), writes: 'some' },
      { args: call({ kind: '1abc', everyMinutes: 30 }), writes: 'some' },
      {
        args: call({ kind: 'nul-body', request: '本文\u0000です', everyMinutes: 30 }),
        writes: 'some',
      },
      {
        args: call({ kind: 'spaced-body', request: '  前後に空白  ', everyMinutes: 30 }),
        writes: 'some',
      },
      {
        args: call({ kind: 'multi-body', request: '一行目\n二行目\n三行目', everyMinutes: 30 }),
        writes: 'some',
      },
      {
        args: call({ kind: 'long-body', request: `長い。${'あ'.repeat(5_000)}`, everyMinutes: 30 }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'new-then-replace',
    covers:
      '道具だけで 作る → 直す → 同じ内容で直す: 2 回目から「置き換えた」。置き換え前の本文と周期は直前の呼びの値。日誌の id の採番が呼びをまたいで続く',
    seed: [],
    steps: [
      { args: call({ request: '最初の本文', dailyAt: '09:00' }), writes: 'some' },
      { args: call({ request: '二番目の本文', everyMinutes: 15 }), writes: 'some' },
      { args: call({ request: '二番目の本文', everyMinutes: 15 }), writes: 'some' },
    ],
  },
  // ---- 置き換え ----
  {
    name: 'replace-forms',
    covers:
      '置き換え: 周期だけ・本文だけ・両方・同一内容・周期の種類を替える（daily→cron・cron→every）。日誌は「置き換えようとしている」（旧本文・旧周期を逐語）→「直した」。editRequest の ifMatch は旧行の updatedAt。createdAt は引き継がれ updatedAt だけ進む',
    seed: [
      old('r-period', '同じ本文', { type: 'every', minutes: 60 }),
      old('r-request', '旧い本文', { type: 'every', minutes: 60 }),
      old('r-both', '旧い本文', { type: 'every', minutes: 60 }),
      old('r-same', '同じ本文', { type: 'every', minutes: 60 }),
      old('r-daily', '同じ本文', { type: 'daily', at: '09:00' }),
      old('r-cron', '同じ本文', { type: 'cron', expression: '0 10 * * 1' }),
    ],
    steps: [
      {
        args: call({ kind: 'r-period', request: '同じ本文', everyMinutes: 30 }),
        writes: 'some',
      },
      {
        args: call({ kind: 'r-request', request: '新しい本文', everyMinutes: 60 }),
        writes: 'some',
      },
      { args: call({ kind: 'r-both', request: '新しい本文', dailyAt: '07:30' }), writes: 'some' },
      {
        args: call({ kind: 'r-same', request: '同じ本文', everyMinutes: 60 }),
        writes: 'some',
      },
      {
        args: call({ kind: 'r-daily', request: '同じ本文', cron: '0 10 * * 1' }),
        writes: 'some',
      },
      {
        args: call({ kind: 'r-cron', request: '同じ本文', everyMinutes: 45 }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'replace-keeps-run-marks',
    covers:
      '置き換えは発火の印を引き継ぐ: lastRunAt・lastScheduledRunAt・pendingRun は残り、request・spec・updatedAt だけが変わる（行の全体が json に出る）',
    seed: [
      old(
        K,
        '旧い本文',
        { type: 'every', minutes: 60 },
        {
          lastRunAt: '2026-10-20T00:00:00.000Z',
          lastScheduledRunAt: '2026-10-19T00:00:00.000Z',
          pendingRun: { at: '2026-10-20T00:00:00.000Z', cause: 'schedule' },
        },
      ),
    ],
    steps: [{ args: call({ request: '新しい本文', dailyAt: '09:00' }), writes: 'some' }],
  },
  {
    name: 'replace-nul-request',
    covers:
      '置き換えの新しい本文の NUL: 日誌の置き換えの行・行の本文から NUL が落ちる（応答には新しい本文が出ない）',
    seed: [old(K, '旧い本文')],
    steps: [{ args: call({ request: '新\u0000しい', everyMinutes: 30 }), writes: 'some' }],
  },
  {
    name: 'replace-excerpt',
    covers:
      '旧本文の抜粋（200 字）の境目: 199・200 字は全文で「置き換え前の本文は日誌にも残してある」、201 字以上は抜粋して「journal_read id=<置き換えの行の id>」。改行を含む旧本文・多バイト文字',
    seed: [
      old('x-199', LONG_OLD(199)),
      old('x-200', LONG_OLD(200)),
      old('x-201', LONG_OLD(201)),
      old('x-500', LONG_OLD(500)),
      old('x-multi', `一行目\n${'二行目'.repeat(100)}`),
    ],
    steps: ['x-199', 'x-200', 'x-201', 'x-500', 'x-multi'].map((kind): Step => ({
      args: call({ kind, request: '短い新しい本文', everyMinutes: 30 }),
      writes: 'some',
    })),
  },
  // ---- 読めない行 ----
  {
    name: 'unreadable-row',
    covers:
      '読めない行（get が UnreadableScheduleError）: 旧本文が取れないので previous は null のまま「設定しようとしている」を書く → editRequest が Unreadable → 「設定できなかった（読めない形で入っている）」の日誌 → 断りの文（書き換えていない）。forgetStandingRow は呼ばない。list の unreadable に kind が載る',
    seed: [],
    steps: [
      {
        args: call({ dailyAt: '09:00' }),
        writes: 'some',
        hooks: { unreadableRow: true },
      },
      {
        args: call({ everyMinutes: 30 }),
        writes: 'some',
        hooks: { unreadableRow: true },
      },
    ],
  },
  {
    name: 'unreadable-on-write',
    covers:
      '読みは通り（旧行が見える）、書きの時に読めなくなる: 置き換えの日誌を書いてから editRequest が Unreadable → 失敗の日誌（読めない形）・断りの文。新規の put（ifMatch null）が Unreadable でも同じ断り',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'unreadable' } },
      },
      {
        args: call({ kind: 'fresh', everyMinutes: 30 }),
        writes: 'some',
        hooks: { putThrows: { 1: 'unreadable' } },
      },
    ],
  },
  {
    name: 'unreadable-after-conflict',
    covers:
      '1 回目は競合で打ち消して読み直し、2 回目の書きで読めない: 日誌は 設定/置き換え → 打ち消し → 設定/置き換え → 失敗（読めない形）の順。断りの文',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'conflict', 2: 'unreadable' } },
      },
    ],
  },
  {
    name: 'get-unreadable-transient',
    covers:
      '1 回目の get だけが読めない（実際には行が在る）: previous null で「設定しようとしている」を書き、editRequest は ifMatch null で在る行に当たって競合 → 打ち消して読み直し、2 回目は置き換えとして通る（editRequest の ifMatch が null → 旧行の updatedAt に変わる）',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { getFails: { 1: 'unreadable' } },
      },
    ],
  },
  {
    name: 'get-plain-error',
    covers:
      'get が Unreadable 以外で投げる: そのまま投げる（日誌は先に書かない・定期の依頼も動かない）。競合のあと 2 回目の get で投げる場合は、先の行と打ち消しの行が日誌に残り失敗の日誌は書かれない',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'none',
        hooks: { getFails: { 1: 'plain' } },
      },
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump' }, getFails: { 2: 'plain' } },
      },
    ],
  },
  // ---- 競合 ----
  {
    name: 'conflict-replace-once',
    covers:
      '置き換えで 1 回目の editRequest だけ競合（読んだ後に別の書き手が本文を直した）: 打ち消しの日誌 → 読み直して別の書き手の本文を旧本文として置き換えの行へ逐語で残す → 2 回目で通る。応答の旧本文は別の書き手の本文',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump' } },
      },
    ],
  },
  {
    name: 'conflict-replace-twice',
    covers:
      '競合が 2 回続き、上限の 3 回目で通る（attempt < SCHEDULE_CREATE_ATTEMPTS の境目の内側）: 打ち消しの日誌が 2 本・置き換えの行が 3 本',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump', 2: 'bump' } },
      },
    ],
  },
  {
    name: 'conflict-replace-limit',
    covers:
      '競合が上限（3 回）まで続く: 3 回目の競合は打ち消さず、失敗の日誌（読めない形ではない方）→ 「書き込みの直前に別の書き手に変えられ続けたので、設定していない」。forgetStandingRow は呼ばない。定期の依頼は別の書き手の最後の版のまま',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump', 2: 'bump', 3: 'bump' } },
      },
    ],
  },
  {
    name: 'conflict-new-put-race',
    covers:
      '新規作成の直前に同名が作られた: editRequest は null（無い）→ 別の書き手が作る → put（ifMatch null）が競合 → 打ち消して読み直し、2 回目は置き換えとして通る（作られた行の本文が旧本文）',
    seed: [],
    steps: [
      {
        args: call({ everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforePut: { 1: 'create' } },
      },
    ],
  },
  {
    name: 'conflict-new-limit-forced',
    covers:
      '新規で editRequest の競合が上限まで続く（行は作られないまま）: 毎回「設定しようとしている」を書き、打ち消しは 2 本、3 回目は失敗の日誌 → 断りの文。put は一度も呼ばれない',
    seed: [],
    steps: [
      {
        args: call({ everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'conflict', 2: 'conflict', 3: 'conflict' } },
      },
    ],
  },
  {
    name: 'conflict-new-limit-put',
    covers:
      '新規で 1・2 回目は editRequest の競合、3 回目は put（ifMatch null）の競合: 上限の 3 回目の put の競合も打ち消さず失敗の日誌と断りの文。作られた行は別の書き手のまま',
    seed: [],
    steps: [
      {
        args: call({ everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'conflict', 2: 'conflict' }, beforePut: { 1: 'create' } },
      },
    ],
  },
  {
    name: 'conflict-deleted',
    covers:
      '置き換えのつもりが、読んだ後に行を消された: 版つきの editRequest が競合（current null）→ 打ち消して読み直し、2 回目は無いので新規として作る（「仕込んだ」・設定の行）',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'delete' } },
      },
    ],
  },
  {
    name: 'conflict-long-excerpt',
    covers:
      '競合で読み直した旧本文が長い（抜粋になる）: 応答の journal_read id は通った回（2 回目）の置き換えの行の id で、打ち消しの行や 1 回目の行の id ではない',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump-long' } },
      },
    ],
  },
  // ---- ストアの書き込みが競合以外で投げる ----
  {
    name: 'store-write-fails',
    covers:
      '書き込みが競合・読めない以外で投げる: 失敗の日誌（「状態の変更が失敗した」）を書いて例外をそのまま投げ直す。置き換えの editRequest・新規の put。forgetStandingRow は呼ばない',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'plain' } },
      },
      {
        args: call({ kind: 'fresh', everyMinutes: 30 }),
        writes: 'some',
        hooks: { putThrows: { 1: 'plain' } },
      },
      {
        args: call({ kind: 'fresh', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'plain' } },
      },
    ],
  },
  {
    name: 'conflict-then-store-fails',
    covers:
      '1 回目は競合で打ち消し、2 回目の書き込みが競合以外で投げる: 日誌は 設定/置き換え → 打ち消し → 設定/置き換え → 失敗の順で、例外はそのまま',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'conflict', 2: 'plain' } },
      },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails-first',
    covers:
      '最初の日誌（行為の前）が書けない: 新規・置き換えとも、書き込み口を一度も呼ばずに投げる（JournalNotRecordedError・act-not-performed）。定期の依頼も日誌も呼ぶ前と同じ',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ kind: 'fresh', everyMinutes: 30 }),
        writes: 'none',
        hooks: { journalFailsAt: [1] },
      },
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'none',
        hooks: { journalFailsAt: [1] },
      },
    ],
  },
  {
    name: 'journal-fails-first-after-retry',
    covers:
      '競合のあとの 2 回目の最初の日誌が書けない（日誌の 3 回目）: 投げる。先の設定の行と打ち消しの行は日誌に残り、定期の依頼は別の書き手の版のまま',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump' }, journalFailsAt: [3] },
      },
    ],
  },
  {
    name: 'journal-fails-retraction',
    covers:
      '打ち消しの日誌（2 回目）が書けない: 黙って諦めて読み直しを続け、通る。日誌には打ち消しの行が無い',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { beforeEdit: { 1: 'bump' }, journalFailsAt: [2] },
      },
    ],
  },
  {
    name: 'journal-fails-failure-entry',
    covers:
      '失敗の日誌が書けない: 黙って諦め、元の分岐の結果（競合以外はその例外・読めない行は断りの文・競合の上限は断りの文）は変わらない',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ kind: 'fresh', everyMinutes: 30 }),
        writes: 'some',
        hooks: { putThrows: { 1: 'plain' }, journalFailsAt: [2] },
      },
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'plain' }, journalFailsAt: [2] },
      },
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { editThrows: { 1: 'unreadable' }, journalFailsAt: [2] },
      },
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: {
          editThrows: { 1: 'conflict', 2: 'conflict', 3: 'conflict' },
          journalFailsAt: [6],
        },
      },
    ],
  },
  {
    name: 'journal-fails-final',
    covers:
      '最後の日誌が書けない: 書き込みも forgetStandingRow も済んでいるので、応答は普段どおり（新規・置き換え）。日誌には最初の 1 行だけが残り「直した／仕込んだ」の行が無い',
    seed: [old(K, '旧い本文')],
    steps: [
      {
        args: call({ kind: 'fresh', everyMinutes: 30 }),
        writes: 'some',
        hooks: { journalFailsAt: [2] },
      },
      {
        args: call({ request: '新しい本文', everyMinutes: 30 }),
        writes: 'some',
        hooks: { journalFailsAt: [2] },
      },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

// ---- 記録の形 ----

interface PinnedOutput {
  length: number;
  text: string;
  isError: boolean;
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
  /** 例外で返ったときの例外の名前（返らなければ null） */
  errorName: string | null;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの定期の依頼の行（全行）と読めない行の一覧 */
  schedules: { entries: Record<string, unknown>[]; unreadable: Record<string, unknown>[] };
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** スケジュールのストアの書き込み口の呼びの並び */
  storeCalls: Record<string, unknown>[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Snapshot {
  schedules: PinnedStep['schedules'];
  journal: Record<string, unknown>[];
}

interface Runtime {
  hooks: Hooks;
  counts: { get: number; edit: number; put: number; journal: number };
  /** この呼びが指す kind（読めない行の一覧に載せる名前） */
  kind: string;
  storeCalls: Record<string, unknown>[];
}

function freshHooks(): Hooks {
  return {
    getFails: {},
    unreadableRow: false,
    beforeEdit: {},
    beforePut: {},
    editThrows: {},
    putThrows: {},
    journalFailsAt: [],
  };
}

function freshRuntime(): Runtime {
  return {
    hooks: freshHooks(),
    counts: { get: 0, edit: 0, put: 0, journal: 0 },
    kind: K,
    storeCalls: [],
  };
}

async function snapshot(base: Stores, runtime: Runtime): Promise<Snapshot> {
  const list = await base.schedules.list();
  return {
    schedules: {
      entries: plain(list.entries) as unknown as Record<string, unknown>[],
      unreadable: runtime.hooks.unreadableRow
        ? [{ kind: runtime.kind, reason: '行が読めない形' }]
        : [],
    },
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
  };
}

function failureOf(failure: Failure, kind: string): Error {
  switch (failure) {
    case 'unreadable':
      return new UnreadableScheduleError('行が読めない形', { kind });
    case 'plain':
      return new Error('スケジュールのストアが落ちた');
    case 'conflict':
      return new ScheduleConflictError(kind, null);
  }
}

async function interfere(base: Stores, how: Interference, kind: string, n: number): Promise<void> {
  const at = `2026-10-15T00:00:0${String(n)}.000Z`;
  if (how === 'create') {
    await base.schedules.put({
      kind,
      spec: { type: 'daily', at: '07:00' },
      request: `先に作られた本文#${String(n)}`,
      createdAt: at,
      updatedAt: at,
    });
    return;
  }
  if (how === 'delete') {
    await base.schedules.removeIfPresent(kind);
    return;
  }
  const current = await base.schedules.get(kind);
  if (current === null) return;
  await base.schedules.editRequest(
    kind,
    {
      request:
        how === 'bump-long'
          ? `別の書き手の長い本文#${String(n)}。${'い'.repeat(400)}`
          : `別の書き手の本文#${String(n)}`,
      spec: current.spec,
    },
    at,
  );
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function withHooks(base: Stores, runtime: Runtime): Stores {
  return {
    ...base,
    schedules: {
      ...base.schedules,
      async list() {
        const list = await base.schedules.list();
        return {
          entries: list.entries,
          unreadable: runtime.hooks.unreadableRow
            ? [{ kind: runtime.kind, reason: '行が読めない形' }]
            : [],
        };
      },
      async get(target) {
        runtime.counts.get += 1;
        const failure = runtime.hooks.getFails[runtime.counts.get];
        if (failure !== undefined) throw failureOf(failure, target);
        if (runtime.hooks.unreadableRow) throw failureOf('unreadable', target);
        return base.schedules.get(target);
      },
      async editRequest(target, changes, updatedAt, options) {
        runtime.counts.edit += 1;
        const n = runtime.counts.edit;
        const how = runtime.hooks.beforeEdit[n];
        if (how !== undefined) await interfere(base, how, target, n);
        const record = {
          op: 'editRequest',
          kind: target,
          ifMatch: options?.ifMatch ?? null,
          updatedAt,
          changes: plain(changes),
        };
        let outcome = 'unknown';
        try {
          const failure = runtime.hooks.editThrows[n];
          if (failure !== undefined) throw failureOf(failure, target);
          if (runtime.hooks.unreadableRow) throw failureOf('unreadable', target);
          const result = await base.schedules.editRequest(target, changes, updatedAt, options);
          outcome = result === null ? 'null' : 'edited';
          return result;
        } catch (error) {
          outcome = `threw ${errorNameOf(error)}`;
          throw error;
        } finally {
          runtime.storeCalls.push({ ...record, outcome });
        }
      },
      async put(entry, options) {
        runtime.counts.put += 1;
        const n = runtime.counts.put;
        const how = runtime.hooks.beforePut[n];
        if (how !== undefined) await interfere(base, how, entry.kind, n);
        const record = {
          op: 'put',
          kind: entry.kind,
          ifMatch: options?.ifMatch ?? null,
          entry: plain(entry),
        };
        let outcome = 'unknown';
        try {
          const failure = runtime.hooks.putThrows[n];
          if (failure !== undefined) throw failureOf(failure, entry.kind);
          if (runtime.hooks.unreadableRow && options?.ifMatch !== undefined) {
            throw failureOf('unreadable', entry.kind);
          }
          await base.schedules.put(entry, options);
          outcome = 'put';
        } catch (error) {
          outcome = `threw ${errorNameOf(error)}`;
          throw error;
        } finally {
          runtime.storeCalls.push({ ...record, outcome });
        }
      },
    },
    journal: {
      ...base.journal,
      append: (entry) => {
        runtime.counts.journal += 1;
        if (runtime.hooks.journalFailsAt.includes(runtime.counts.journal)) {
          return Promise.reject(new Error('日誌が落ちた'));
        }
        return base.journal.append(entry);
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const seed of scenario.seed) await base.schedules.put(seed);
  const runtime = freshRuntime();
  const stores = withHooks(base, runtime);
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  };
  const found = createCloneTools(context).find((entry) => entry.name === 'schedule_create');
  if (!found) throw new Error('schedule_create が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    runtime.hooks = { ...freshHooks(), ...(step.hooks ?? {}) };
    runtime.counts = { get: 0, edit: 0, put: 0, journal: 0 };
    runtime.storeCalls = [];
    runtime.kind = typeof step.args.kind === 'string' ? step.args.kind : K;
    const before = await snapshot(base, runtime);
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(step.args as never, {} as never);
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = {
        length: text.length,
        text,
        isError: result.isError === true,
        thrown: false,
        errorName: null,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = {
        length: text.length,
        text,
        isError: true,
        thrown: true,
        errorName: error instanceof Error ? error.name : 'unknown',
      };
    }
    const after = await snapshot(base, runtime);
    const wrote =
      JSON.stringify(before.schedules.entries) !== JSON.stringify(after.schedules.entries) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      schedules: after.schedules,
      journal: after.journal.slice(before.journal.length),
      storeCalls: plain(runtime.storeCalls),
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、定期の依頼と日誌が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
      expect(
        after.schedules.entries,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、定期の依頼が呼ぶ前から変わった`,
      ).toEqual(before.schedules.entries);
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
  }
  return results;
}

async function runAll(): Promise<Record<string, PinnedStep>> {
  const out: Record<string, PinnedStep> = {};
  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    for (const [index, result] of results.entries()) out[stepKey(scenario, index)] = result;
  }
  return out;
}

describe('schedule_create の出力と呼んだあとの状態の固定（場面ごとの出力の全文・定期の依頼の行・日誌の行・書き込み口の呼び）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  }, 120_000);

  afterAll(() => {
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.output.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの出力の字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.output.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.output.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.output.length);
    }
  });

  it('書き込みが起きなかったと宣言した場面は、実際にも書き込みが起きていない（その逆も）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes === 'some',
        );
      }
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          { isError: got?.output.isError, thrown: got?.output.thrown, name: got?.output.errorName },
          `場面 ${key} の出力の isError／例外で返ったか／例外の名前、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          name: want?.output.errorName,
        });
      });

      it(`${key} の呼んだあとの定期の依頼の行と書き込み口の呼びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.schedules.entries.map((entry) => entry.kind),
          `場面 ${key} の定期の依頼: 行の並び（kind）が変わった`,
        ).toEqual(want?.schedules.entries.map((entry) => entry.kind));
        for (const [rowIndex, wantRow] of (want?.schedules.entries ?? []).entries()) {
          expect(
            got?.schedules.entries[rowIndex],
            `場面 ${key} の定期の依頼 ${String(wantRow.kind)}（${String(rowIndex)} 行目）が固定値からずれた（request・spec・createdAt・updatedAt・発火の印など）`,
          ).toEqual(wantRow);
        }
        expect(got?.schedules.unreadable, `場面 ${key} の読めない行の一覧が変わった`).toEqual(
          want?.schedules.unreadable,
        );
        expect(
          got?.storeCalls.length,
          `場面 ${key} の書き込み口の呼び: 回数が変わった: 固定値 ${String(want?.storeCalls.length)} 回 → いま ${String(got?.storeCalls.length)} 回`,
        ).toBe(want?.storeCalls.length);
        expect(
          got?.storeCalls,
          `場面 ${key} の書き込み口の呼び（editRequest・put の引数・ifMatch・結果）が固定値からずれた`,
        ).toEqual(want?.storeCalls);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} の呼んだあとに日誌へ足された行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・本文・grounds・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・定期の依頼・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep | undefined => actual[key];
    const text = (key: string): string => step(key)?.output.text ?? '';
    const decisions = (key: string): string[] =>
      (step(key)?.journal ?? []).map((entry) =>
        typeof entry.decision === 'string' ? entry.decision : '',
      );
    const calls = (key: string): string[] =>
      (step(key)?.storeCalls ?? []).map(
        (entry) =>
          `${String(entry.op)} ifMatch=${JSON.stringify(entry.ifMatch)} ${String(entry.outcome)}`,
      );
    const rowOf = (key: string, kind: string): Record<string, unknown> | undefined =>
      step(key)?.schedules.entries.find((entry) => entry.kind === kind);
    const SETTING = '定期の依頼を設定しようとしている';
    const REPLACING = '定期の依頼を置き換えようとしている';
    const RETRACT = '直前の定期の依頼の設定の行は効いていない';
    const EDITED = '定期の依頼を直した';
    const CREATED = '定期の依頼を仕込んだ';
    const FAILED = '定期の依頼を設定できなかった';
    const CONFLICT_TEXT = '別の書き手に変えられ続けたので、設定していない';
    const UNREADABLE_TEXT = '読めない形で入っているので編集できない（書き換えていない）';
    const startsWith = (key: string, head: string): number =>
      decisions(key).filter((line) => line.startsWith(head)).length;

    // 引数の検査（書き込み口を一度も呼ばない）
    expect(text('arg-kind#2')).toContain('kind "Bad Kind" は使えない');
    expect(text('arg-kind#9')).toContain('kind "Bad Kind" は使えない');
    expect(text('arg-request#1')).toBe('request が空文字は使えない（依頼の本文を渡すこと）。');
    expect(text('arg-request#6')).toContain('空白だけの値は空と同じ');
    expect(text('arg-request#7')).toContain('request が空文字は使えない');
    expect(text('arg-reserved#1')).toContain('daily_report は既定の定期ジョブの名前なので使えない');
    expect(text('arg-reserved#6')).toContain(
      'self_initiative は既定の定期ジョブの名前なので使えない',
    );
    expect(text('arg-period#1')).toBe(
      'dailyAt / everyMinutes / cron のうち、どれか1つだけ渡すこと。',
    );
    expect(text('arg-period#6')).toContain('どれか1つだけ渡すこと');
    expect(text('arg-period#7')).toBe('dailyAt "" は HH:MM として読めない。');
    expect(text('arg-period#14')).toContain('cron "" は cron 式として読めない');
    expect(text('arg-period#21')).toContain('everyMinutes 0 は使えない');
    expect(text('arg-period#26')).toContain('1年（525600分）より長い周期');
    expect(text('arg-period#27')).toBe(
      'dailyAt " 09:00 " は前後に空白がある（HH:MM だけを渡すこと）。',
    );
    expect(text('arg-period#29')).toContain('cron " 0 10 * * 1" は前後に空白がある');
    expect(text('arg-period#31')).toBe(
      'dailyAt / everyMinutes / cron のうち、どれか1つだけ渡すこと。',
    );
    expect(text('arg-spec-schema#1')).toBe(
      'dailyAt " 09:00" は前後に空白がある（HH:MM だけを渡すこと）。',
    );
    expect(text('arg-spec-schema#4')).toContain(
      'は前後に空白がある（分 時 日 月 曜の5欄だけを渡すこと',
    );
    expect(text('arg-spec-schema#4')).not.toContain('"too_big"');
    for (const key of ALL_KEYS.filter((name) => name.startsWith('arg-'))) {
      expect(step(key)?.storeCalls, `${key}: 検査で断る場面が書き込み口を呼んだ`).toEqual([]);
      expect(step(key)?.journal, `${key}: 検査で断る場面が日誌を書いた`).toEqual([]);
    }
    // 新規
    expect(text('new-daily#1')).toBe(
      'weekly-review を 毎日 09:00（ローカル時刻）で仕込んだ。時刻が来たら依頼の本文とともに届く。',
    );
    expect(text('new-daily#2')).toContain('k-short を 毎日 09:00（ローカル時刻）');
    expect(calls('new-daily#1')).toEqual(['editRequest ifMatch=null null', 'put ifMatch=null put']);
    expect(startsWith('new-daily#1', SETTING)).toBe(1);
    expect(startsWith('new-daily#1', CREATED)).toBe(1);
    expect(text('new-every#3')).toContain('525600 分ごと');
    expect(text('new-cron#3')).toContain('cron " 0 10 * * 1 " は前後に空白がある');
    expect(rowOf('new-forms#4', 'nul-body')?.request).toBe('本文です');
    expect(decisions('new-forms#4')[0]).toBe(`${SETTING}: nul-body: 本文です`);
    // 置き換え
    expect(text('new-then-replace#2')).toContain(
      'は既に在ったので置き換えた（15 分ごとで仕込み直した）',
    );
    expect(text('new-then-replace#2')).toContain(
      '置き換え前は 毎日 09:00（ローカル時刻）、依頼本文は「最初の本文」だった（置き換え前の本文は日誌にも残してある）。時刻が来たら',
    );
    expect(calls('new-then-replace#2')).toEqual([
      'editRequest ifMatch="2026-10-29T00:01:00.000Z" edited',
    ]);
    expect(startsWith('new-then-replace#2', REPLACING)).toBe(1);
    expect(startsWith('new-then-replace#2', EDITED)).toBe(1);
    expect(rowOf('replace-forms#1', 'r-period')?.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(rowOf('replace-forms#1', 'r-period')?.updatedAt).toBe('2026-10-29T00:01:00.000Z');
    expect(rowOf('replace-keeps-run-marks', K)).toMatchObject({
      lastRunAt: '2026-10-20T00:00:00.000Z',
      lastScheduledRunAt: '2026-10-19T00:00:00.000Z',
      pendingRun: { at: '2026-10-20T00:00:00.000Z', cause: 'schedule' },
    });
    expect(rowOf('replace-nul-request', K)?.request).toBe('新しい');
    expect(text('replace-excerpt#1')).toContain('（置き換え前の本文は日誌にも残してある）');
    expect(text('replace-excerpt#2')).toContain('（置き換え前の本文は日誌にも残してある）');
    expect(text('replace-excerpt#2')).not.toContain('文字省略');
    expect(text('replace-excerpt#3')).toContain('…（1 文字省略。全 201 文字）');
    expect(text('replace-excerpt#3')).toContain('journal_read id=id-5）。時刻が来たら');
    expect(text('replace-excerpt#4')).toContain('…（300 文字省略。全 500 文字）');
    // 読めない行
    expect(text('unreadable-row#1')).toContain(UNREADABLE_TEXT);
    expect(calls('unreadable-row#1')).toEqual([
      'editRequest ifMatch=null threw UnreadableScheduleError',
    ]);
    expect(decisions('unreadable-row#1')[0]).toContain(SETTING);
    expect(decisions('unreadable-row#1')[0]).toContain(
      '（同じ kind の行が読めない形で入っているので、置き換え前の本文は残せない）',
    );
    expect(decisions('unreadable-row#1')[1]).toContain(`${FAILED}（読めない形で入っている）`);
    expect(step('unreadable-row#1')?.schedules.unreadable).toEqual([
      { kind: K, reason: '行が読めない形' },
    ]);
    expect(decisions('unreadable-on-write#1')[0]).toContain(REPLACING);
    expect(decisions('unreadable-on-write#1')[1]).toContain(`${FAILED}（読めない形で入っている）`);
    expect(calls('unreadable-on-write#2')).toEqual([
      'editRequest ifMatch=null null',
      'put ifMatch=null threw UnreadableScheduleError',
    ]);
    expect(startsWith('unreadable-after-conflict', RETRACT)).toBe(1);
    expect(startsWith('unreadable-after-conflict', REPLACING)).toBe(2);
    expect(text('unreadable-after-conflict')).toContain(UNREADABLE_TEXT);
    expect(calls('get-unreadable-transient')).toEqual([
      'editRequest ifMatch=null threw ScheduleConflictError',
      'editRequest ifMatch="2026-10-01T00:00:00.000Z" edited',
    ]);
    expect(step('get-plain-error#1')?.output.thrown).toBe(true);
    expect(step('get-plain-error#1')?.journal).toEqual([]);
    expect(step('get-plain-error#2')?.journal).toHaveLength(2);
    expect(startsWith('get-plain-error#2', FAILED)).toBe(0);
    // 競合
    expect(calls('conflict-replace-once')).toEqual([
      'editRequest ifMatch="2026-10-01T00:00:00.000Z" threw ScheduleConflictError',
      'editRequest ifMatch="2026-10-15T00:00:01.000Z" edited',
    ]);
    expect(text('conflict-replace-once')).toContain('依頼本文は「別の書き手の本文#1」だった');
    expect(startsWith('conflict-replace-once', RETRACT)).toBe(1);
    expect(startsWith('conflict-replace-twice', RETRACT)).toBe(2);
    expect(startsWith('conflict-replace-twice', REPLACING)).toBe(3);
    expect(startsWith('conflict-replace-twice', EDITED)).toBe(1);
    expect(calls('conflict-replace-limit')).toHaveLength(3);
    expect(text('conflict-replace-limit')).toContain(CONFLICT_TEXT);
    // 上限に達した回も打ち消す（「別の書き手に変えられ続け、3 回試して諦めた」と言い分ける）。ストアの障害の行は出ない
    expect(startsWith('conflict-replace-limit', RETRACT)).toBe(3);
    expect(decisions('conflict-replace-limit').at(-1)).toContain('3 回試して諦めた');
    expect(startsWith('conflict-replace-limit', FAILED)).toBe(0);
    expect(calls('conflict-new-put-race')).toEqual([
      'editRequest ifMatch=null null',
      'put ifMatch=null threw ScheduleConflictError',
      'editRequest ifMatch="2026-10-15T00:00:01.000Z" edited',
    ]);
    expect(text('conflict-new-put-race')).toContain('依頼本文は「先に作られた本文#1」だった');
    expect(calls('conflict-new-limit-forced')).toHaveLength(3);
    expect(calls('conflict-new-limit-forced').every((line) => !line.startsWith('put'))).toBe(true);
    expect(text('conflict-new-limit-forced')).toContain(CONFLICT_TEXT);
    expect(calls('conflict-new-limit-put').at(-1)).toBe(
      'put ifMatch=null threw ScheduleConflictError',
    );
    expect(startsWith('conflict-new-limit-put', RETRACT)).toBe(3);
    expect(decisions('conflict-new-limit-put').at(-1)).toContain('3 回試して諦めた');
    expect(startsWith('conflict-new-limit-put', FAILED)).toBe(0);
    expect(calls('conflict-deleted')).toEqual([
      'editRequest ifMatch="2026-10-01T00:00:00.000Z" threw ScheduleConflictError',
      'editRequest ifMatch=null null',
      'put ifMatch=null put',
    ]);
    expect(text('conflict-deleted')).toContain('を 30 分ごとで仕込んだ。');
    expect(startsWith('conflict-deleted', CREATED)).toBe(1);
    expect(text('conflict-long-excerpt')).toContain('journal_read id=id-3');
    expect(text('conflict-long-excerpt')).toContain('…（213 文字省略。全 413 文字）');
    // ストアの書き込みが競合以外で投げる
    expect(text('store-write-fails#1')).toBe('スケジュールのストアが落ちた');
    expect(step('store-write-fails#1')?.output.thrown).toBe(true);
    expect(decisions('store-write-fails#1')[1]).toBe(`${FAILED}: ${K}: 新しい本文`);
    expect(calls('store-write-fails#2')).toEqual([
      'editRequest ifMatch=null null',
      'put ifMatch=null threw Error',
    ]);
    expect(step('store-write-fails#3')?.storeCalls).toHaveLength(1);
    expect(startsWith('conflict-then-store-fails', RETRACT)).toBe(1);
    expect(startsWith('conflict-then-store-fails', FAILED)).toBe(1);
    // 日誌が書けない
    expect(step('journal-fails-first#1')?.output.errorName).toBe('JournalNotRecordedError');
    expect(text('journal-fails-first#1')).toContain(
      '⚠⚠ 未記録・行為は起きていない・やり直してよい',
    );
    expect(step('journal-fails-first#1')?.storeCalls).toEqual([]);
    expect(step('journal-fails-first#2')?.storeCalls).toEqual([]);
    expect(step('journal-fails-first-after-retry')?.output.errorName).toBe(
      'JournalNotRecordedError',
    );
    expect(step('journal-fails-first-after-retry')?.journal).toHaveLength(2);
    expect(startsWith('journal-fails-retraction', RETRACT)).toBe(0);
    expect(startsWith('journal-fails-retraction', REPLACING)).toBe(2);
    expect(text('journal-fails-retraction')).toContain('は既に在ったので置き換えた');
    expect(text('journal-fails-failure-entry#1')).toBe('スケジュールのストアが落ちた');
    expect(startsWith('journal-fails-failure-entry#1', FAILED)).toBe(0);
    expect(text('journal-fails-failure-entry#2')).toBe('スケジュールのストアが落ちた');
    expect(text('journal-fails-failure-entry#3')).toContain(UNREADABLE_TEXT);
    expect(text('journal-fails-failure-entry#4')).toContain(CONFLICT_TEXT);
    expect(startsWith('journal-fails-failure-entry#4', FAILED)).toBe(0);
    expect(step('journal-fails-final#1')?.journal).toHaveLength(1);
    expect(text('journal-fails-final#2')).toContain('は既に在ったので置き換えた');
    expect(startsWith('journal-fails-final#2', EDITED)).toBe(0);
  });
});
