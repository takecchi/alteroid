import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { encodeCursor } from './cursor-codec.js';
import { excerptLine, renderListingEntry } from './excerpt.js';
import { encodeScheduleCursor } from './schedule-cursor.js';
import { describeScheduleSpec, type ScheduleStatus } from './schedule.js';
import type { ScheduledRequest, UnreadableSchedule } from './schema.js';
import { UnreadableScheduleError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `schedule_list` の出力（全文と字数）と、呼びの並び（`schedules.get`・`schedules.list`・次に動く時刻を読む `context.scheduler`・
// `context.keepStandingRowIfSame`・定期の依頼の書き込み口）を、場面ごとにコミットした固定値
// （clone-tools-schedule-list-output-pin.json）と丸ごと比べる。
// `clone-tools-schedule.ts` の `tool('schedule_list', …)`（約 85 行・入れ子 7 段の式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・本文・時刻）を固定して毎回同じにする。
// この道具は読むだけ: 出力と呼びの並びに加えて、呼ぶ前と後で定期の依頼の行・日誌が変わらないこと、書き込み口を呼ばないことも固定する。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外の名前）
//   - calls: 呼びの並び（呼んだ順）。`schedules.get("kind") -> 結果`・`schedules.list() -> 行数と読めない行数`・
//     `context.scheduler() -> 件数`（次に動く時刻を読む呼び。投げたら threw）・`context.keepStandingRowIfSame(引数の JSON)` は下の注意を見る
//   - wrote / writeCalls: 定期の依頼か日誌が呼ぶ前から変わったか・書き込み口（get / list 以外の `schedules.*`）の呼び。どの場面も false / 空
//
// 注意（`keepStandingRowIfSame`）: この固定値を作った時点の origin/main（3d53e4b1）には `context.keepStandingRowIfSame` が
// どこにも無く、`schedule_list` はそれを呼ばない。そこで ToolContext の口として `keepStandingRowIfSame` の呼びを記録する差し込み
// （引数は JSON で全文）を context に足し（`keep: false` の場面は口が無い器）、いまは「どの場面でも呼ばれない」ことを固定している。
// 今後その呼びが入ったら、その場面の `calls` が変わって落ちる（意図した変更なら固定値を作り直す）。
//
// 固定値の作り直し（意図して出力・呼びを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_SCHEDULE_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-schedule-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-schedule-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// メモリのストアは壊れた行を持てないので、読めない行は `unreadable`（list の unreadable に載せる）と `getFails`（get が
// UnreadableScheduleError を投げる）で再現する。次に動く時刻は kind の綴りから決めた固定の時刻で、場面ごとに scheduler の形を替える。

type Args = Record<string, unknown>;
type ArgsOf = Args | ((previousTexts: string[]) => Args);

/** `context.scheduler` の形。entries: 仕込みの kind ごとに時刻を返す（別の kind の行も混ぜる）／absent: 口が無い／empty: 空／decoy: 別の kind だけ／throws: 投げる */
type SchedulerMode = 'entries' | 'absent' | 'empty' | 'decoy' | 'throws';

interface Step {
  args: ArgsOf;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: ScheduledRequest[];
  steps: Step[];
  scheduler?: SchedulerMode;
  /** scheduler が知らない kind（「まだ計算されていない」になる） */
  unplanned?: string[];
  /** list の unreadable に載せる読めない行 */
  unreadable?: UnreadableSchedule[];
  /** kind ごとに get を投げさせる */
  getFails?: Record<string, 'unreadable' | 'plain'>;
  /** list を投げさせる */
  listFails?: boolean;
  /** false: context が `keepStandingRowIfSame` を持たない器 */
  keep?: boolean;
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const SEED_AT = '2026-10-01T00:00:00.000Z';
const UPDATED_AT = '2026-10-02T03:04:05.000Z';
const RAN_AT = '2026-10-20T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-schedule-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_SCHEDULE_LIST_PIN === '1';

const BUDGET = 8_000;
const PAGE = 8_000;
const EXCERPT = 200;
const FOOTER = '（依頼本文は抜粋。全文は schedule_list kind=<kind> で取れる）';

function row(
  kind: string,
  request: string,
  spec: ScheduledRequest['spec'] = { type: 'every', minutes: 60 },
  extra: Partial<ScheduledRequest> = {},
): ScheduledRequest {
  return { kind, spec, request, createdAt: SEED_AT, updatedAt: UPDATED_AT, ...extra };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** kind の綴りから決める固定の「次に動く時刻」（幅は常に同じ） */
function nextAtOf(kind: string): string {
  let sum = 0;
  for (const char of kind) sum += char.charCodeAt(0);
  return `2026-10-30T09:${pad2(sum % 60)}:00.000Z`;
}

function ran(minute: number): Partial<ScheduledRequest> {
  return { lastRunAt: `2026-10-20T00:${pad2(minute)}:00.000Z` };
}

/** 本文だけが `size` 字の行（予算の組み立てで、一覧の1件の長さをそろえる） */
function sized(kind: string, size: number): ScheduledRequest {
  return row(kind, 'x'.repeat(size));
}

/** 一覧の1件（`renderListingEntry`）の字数。予算の境目を作るための計算で、出力そのものは固定値と比べる */
function itemLength(plan: ScheduledRequest): number {
  return renderListingEntry({
    id: plan.kind,
    title: describeScheduleSpec(plan.spec),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    summary: `依頼: ${excerptLine(plan.request, EXCERPT)}`,
    extra: [
      `  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
      `  次に動く時刻: ${nextAtOf(plan.kind)}`,
    ],
  }).length;
}

/**
 * 件の長さの合計が `target` 字ちょうどになる行の並び（kind は bk-01 から。最後の1件だけ本文の長さを替えて合わせる）。
 * 合わせられる組が無ければ投げる（組み立てが毎回同じなので、固定値の作り直しで気づく）
 */
function budgetRows(target: number): ScheduledRequest[] {
  for (let base = 100; base <= EXCERPT; base += 1) {
    const unit = itemLength(sized('bk-01', base));
    for (let count = Math.floor(target / unit) + 1; count >= 2; count -= 1) {
      const last = sized(`bk-${pad2(count)}`, 1);
      const lastLength = target - (count - 1) * unit - (itemLength(last) - 1);
      if (lastLength >= 1 && lastLength <= EXCERPT) {
        const rows = Array.from({ length: count - 1 }, (_, index) =>
          sized(`bk-${pad2(index + 1)}`, base),
        );
        rows.push(sized(`bk-${pad2(count)}`, lastLength));
        const total = rows.reduce((sum, plan) => sum + itemLength(plan), 0);
        if (total === target) return rows;
      }
    }
  }
  throw new Error(`予算 ${String(target)} 字ちょうどの行の並びが作れない`);
}

/** 前の呼びの出力が案内した cursor（`schedule_list cursor=… で取れる`）を取る */
function cursorFrom(previousTexts: string[]): string {
  const text = previousTexts.at(-1) ?? '';
  const found = /schedule_list cursor=([A-Za-z0-9_-]+) で取れる/.exec(text);
  if (found === null) throw new Error('前の呼びの出力に cursor の案内が無い');
  return found[1]!;
}

const cursorAfter = (kind: string): string => encodeScheduleCursor({ kind });

const EXACT_ROWS = budgetRows(BUDGET);
const OVER_ROWS = budgetRows(BUDGET + 1);
const MULTI_ROWS: ScheduledRequest[] = Array.from({ length: 60 }, (_, index) =>
  sized(`mp-${pad2(index + 1)}`, 150),
);

const small = (kind: string): ScheduledRequest => row(kind, `${kind} の本文`);
const FIVE = ['k-01', 'k-02', 'k-03', 'k-04', 'k-05'].map(small);

const LONG = (size: number): string =>
  Array.from({ length: size }, (_, index) => String(index % 10)).join('');

const list = (args: Args = {}): Step => ({ args });
const full = (kind: string, extra: Args = {}): Step => ({ args: { kind, ...extra } });

const SCENARIOS: Scenario[] = [
  // ---- offset の検査 ----
  {
    name: 'arg-offset',
    covers:
      'offset の検査（負・小数・NaN・Infinity）。kind の有無に関わらず最初に見て、ストアを呼ばない。一覧モードでは offset 0 以上なら無視される',
    seed: [small('a-one')],
    steps: [
      list({ offset: -1 }),
      list({ offset: 1.5 }),
      list({ offset: Number.NaN }),
      list({ offset: Number.POSITIVE_INFINITY }),
      full('a-one', { offset: -1 }),
      full('a-one', { offset: 0.5 }),
      full('no-such', { offset: -3 }),
      list({ offset: 5 }),
      list({ offset: 0 }),
    ],
  },
  // ---- 全文モード ----
  {
    name: 'full-heads',
    covers:
      '全文モードの頭の行: 周期（every・daily・cron）・前回動いた時刻（有る・まだ一度も動いていない）・次に動く時刻（scheduler の時刻）。頁が1つで収まり「全 N 文字」。get が1回・scheduler が1回・list は呼ばない',
    seed: [
      row('f-every', '一時間ごとの見回り', { type: 'every', minutes: 60 }),
      row('f-daily', '毎朝の確認\n二行目も残る', { type: 'daily', at: '09:00' }, ran(5)),
      row(
        'f-cron',
        '  前後の空白は全文では残る  ',
        { type: 'cron', expression: '0 10 * * 1' },
        ran(7),
      ),
    ],
    steps: [full('f-every'), full('f-daily'), full('f-cron')],
  },
  {
    name: 'full-boundary',
    covers:
      '本文の長さが頁（8,000 字）の境目: 7,999・8,000 字は1頁で「全 N 文字」、8,001 字は切れて「続きは … offset=8000」。続きの案内は頭の行の「依頼本文: 1〜8,000 文字目 / 全 8,001 文字」',
    seed: [row('b-7999', LONG(7_999)), row('b-8000', LONG(8_000)), row('b-8001', LONG(8_001))],
    steps: [full('b-7999'), full('b-8000'), full('b-8001'), full('b-8001', { offset: 8_000 })],
  },
  {
    name: 'full-paging',
    covers:
      '17,000 字の本文を offset で読む: 先頭（続きあり）・8000（続きあり）・16000（最後の頁・続きなし）・17000（ちょうど末尾）・99999（末尾を越える）・16999（最後の1字）・5000（途中から続きあり）。「末尾を越えている」の文は offset が全体の長さ以上のとき',
    seed: [row('p-long', LONG(17_000))],
    steps: [
      full('p-long'),
      full('p-long', { offset: 8_000 }),
      full('p-long', { offset: 16_000 }),
      full('p-long', { offset: 17_000 }),
      full('p-long', { offset: 99_999 }),
      full('p-long', { offset: 16_999 }),
      full('p-long', { offset: 5_000 }),
    ],
  },
  {
    name: 'full-offset-short',
    covers:
      '短い本文（10 字）に offset: 途中から（1〜10 文字目ではなく from>0 で続きなし）・長さと同じ・越える。from が 0 でないとき「N〜M 文字目 / 全 10 文字」',
    seed: [row('s-ten', '0123456789')],
    steps: [
      full('s-ten', { offset: 3 }),
      full('s-ten', { offset: 9 }),
      full('s-ten', { offset: 10 }),
      full('s-ten', { offset: 11 }),
      full('s-ten', { offset: 2.0 }),
    ],
  },
  {
    name: 'full-surrogate',
    covers:
      '頁の切れ目が補助面の文字（サロゲートペア）の途中に当たる: 8,001 字（先頭 a + 絵文字 4,000 個）の先頭の頁は 7,999 字で切れ（ペアを割らない）、続きの offset もそこ。offset 7999 はペアの先頭から',
    seed: [row('u-emoji', `a${'😀'.repeat(4_000)}`)],
    steps: [full('u-emoji'), full('u-emoji', { offset: 7_999 })],
  },
  {
    name: 'full-store',
    covers:
      'get の結果: 読めない行（UnreadableScheduleError → 案内する文。例外にしない）・ほかの例外（そのまま投げる）・無い（空の kind・予約名・大文字を含む）。list は呼ばない。scheduler も呼ばない',
    seed: [small('present')],
    steps: [
      full('broken'),
      full('boom'),
      full('no-such'),
      full(''),
      full('daily_report'),
      full('Present'),
      full('present'),
    ],
    getFails: { broken: 'unreadable', boom: 'plain' },
  },
  {
    name: 'full-ignores-list-args',
    covers:
      'kind を渡すと cursor は無視される（壊れた cursor でも全文モードの出力。list を呼ばない）。unreadable な行が list に在っても全文モードの出力には出ない',
    seed: [small('present')],
    steps: [
      full('present', { cursor: 'garbage' }),
      full('present', { cursor: cursorAfter('present') }),
    ],
    unreadable: [{ kind: 'broken', reason: '行が読めない形' }],
  },
  {
    name: 'full-scheduler-absent',
    covers: '全文モード: context.scheduler が無い器 →「（取れない — scheduler が渡っていない）」',
    seed: [small('present')],
    steps: [full('present')],
    scheduler: 'absent',
  },
  {
    name: 'full-scheduler-empty',
    covers:
      '全文モード: scheduler は在るが空 →「（まだ計算されていない。少し待って呼び直すこと）」',
    seed: [small('present')],
    steps: [full('present')],
    scheduler: 'empty',
  },
  {
    name: 'full-scheduler-decoy',
    covers:
      '全文モード: scheduler に別の kind（daily_report）だけ在る → kind で探すので「まだ計算されていない」',
    seed: [small('present')],
    steps: [full('present')],
    scheduler: 'decoy',
  },
  {
    name: 'full-scheduler-throws',
    covers: '全文モード: scheduler が投げる → そのまま例外で返る（出力は例外の文言）',
    seed: [small('present')],
    steps: [full('present')],
    scheduler: 'throws',
  },
  {
    name: 'full-keep-absent',
    covers:
      '全文モード: context が keepStandingRowIfSame を持たない器でも同じ出力（口が有る場面 full-heads と出力の形は同じ）',
    seed: [row('f-daily', '毎朝の確認', { type: 'daily', at: '09:00' }, ran(5))],
    steps: [full('f-daily')],
    keep: false,
  },
  // ---- 一覧モード: 空・読めない行 ----
  {
    name: 'list-empty',
    covers:
      '一覧が空（読めない行なし）→「（継続中の依頼は無い）」。cursor が壊れていても空が先（malformed の判定まで進まない）。scheduler は呼ばない',
    seed: [],
    steps: [list(), list({ cursor: 'garbage' }), list({ cursor: cursorAfter('x') })],
  },
  {
    name: 'list-empty-unreadable-one',
    covers:
      '一覧が空で、読めない行が kind つきで1件 →「（読めた継続中の依頼は無い）」+ 読めない行の案内（schedule_remove kind=<kind> で外せる）。cursor が壊れていても同じ',
    seed: [],
    steps: [list(), list({ cursor: 'garbage' })],
    unreadable: [{ kind: 'broken', reason: '行が読めない形' }],
  },
  {
    name: 'list-empty-unreadable-kindless',
    covers:
      '一覧が空で、読めない行が kind の取れない1件 →「（kind も取れない）」で、schedule_remove の案内は付かない',
    seed: [],
    steps: [list()],
    unreadable: [{ reason: '行が読めない形' }],
  },
  {
    name: 'list-empty-unreadable-mixed',
    covers:
      '一覧が空で、読めない行が kind つき2件 + kind なし1件 →「kind: a, b。kind が取れない行が 1 件」。schedule_remove の案内は付く',
    seed: [],
    steps: [list()],
    unreadable: [
      { kind: 'bad-a', reason: '行が読めない形' },
      { reason: '行が読めない形' },
      { kind: 'bad-b', reason: '行が読めない形' },
    ],
  },
  {
    name: 'list-empty-unreadable-many',
    covers: '一覧が空で、読めない行が 12 件（kind つき）→ 10 件まで書いて「ほか 2 件」',
    seed: [],
    steps: [list()],
    unreadable: Array.from({ length: 12 }, (_, index) => ({
      kind: `bad-${pad2(index + 1)}`,
      reason: '行が読めない形',
    })),
  },
  {
    name: 'list-unreadable-with-rows',
    covers:
      '読めた行が在り、読めない行も在る: 行のあとに「依頼本文は抜粋…」の行、最後に読めない行の案内（読めた行は消えない）。kind なし・kind つきの混在',
    seed: [small('k-01'), small('k-02')],
    steps: [list(), list({ cursor: cursorAfter('k-01') }), list({ cursor: cursorAfter('k-02') })],
    unreadable: [{ kind: 'broken', reason: '行が読めない形' }, { reason: '行が読めない形' }],
  },
  {
    name: 'list-unreadable-malformed-cursor',
    covers: '読めない行が在っても、cursor が壊れていれば断りの文だけ（読めない行の案内は付かない）',
    seed: [small('k-01')],
    steps: [list({ cursor: 'garbage' })],
    unreadable: [{ kind: 'broken', reason: '行が読めない形' }],
  },
  {
    name: 'list-fails',
    covers: 'list が投げる → そのまま例外で返る（読めない行の扱いまで進まない）',
    seed: [small('k-01')],
    steps: [list(), full('k-01')],
    listFails: true,
  },
  // ---- 一覧モード: 行の形 ----
  {
    name: 'list-one-never-run',
    covers:
      '1件・まだ一度も動いていない: 見出し（kind・周期）・作成/更新・依頼の抜粋・「前回動いた時刻: （まだ一度も動いていない）」・次に動く時刻。末尾に抜粋の案内。scheduler は1回。get は呼ばない',
    seed: [row('one-every', '見回りをする')],
    steps: [list()],
  },
  {
    name: 'list-one-ran',
    covers: '1件・前回動いた時刻が在る（daily）',
    seed: [row('one-daily', '毎朝の確認', { type: 'daily', at: '09:00' }, ran(3))],
    steps: [list()],
  },
  {
    name: 'list-rows-forms',
    covers:
      '行の形: every・daily・cron、前回あり・なし、複数行・空白の多い本文（1行に畳む）、199・200・201 字（200 字までは全文、超えると「…（全 N 字）ではなく excerpt の注記」）、補助面の文字での切れ目、64 字の kind。kind の昇順',
    seed: [
      row('a-every', '一時間ごとの見回り', { type: 'every', minutes: 60 }),
      row('b-daily', '毎朝の確認', { type: 'daily', at: '09:00' }, ran(5)),
      row('c-cron', '週次の見直し', { type: 'cron', expression: '0 10 * * 1' }, ran(7)),
      row('d-multiline', '  一行目\n\n二行目\t三行目   ', { type: 'every', minutes: 5 }),
      row('e-199', LONG(199)),
      row('f-200', LONG(200)),
      row('g-201', LONG(201)),
      row('h-emoji', `${'a'.repeat(199)}😀😀😀`),
      row(`i-${'z'.repeat(62)}`, '最長の kind'),
      row('j-max', '周期の上限', { type: 'every', minutes: 525_600 }),
    ],
    steps: [list()],
  },
  // ---- 一覧モード: scheduler ----
  {
    name: 'list-scheduler-entries',
    covers:
      '3件・scheduler が全 kind の時刻を（別の kind の行も混ぜて）返す: 各行に自分の kind の時刻。scheduler は行ごとに1回（3回）',
    seed: [small('k-01'), small('k-02'), small('k-03')],
    steps: [list()],
  },
  {
    name: 'list-scheduler-partial',
    covers:
      '3件のうち k-02 だけ scheduler が知らない →「（まだ計算されていない。少し待って呼び直すこと）」は k-02 の行だけ',
    seed: [small('k-01'), small('k-02'), small('k-03')],
    steps: [list()],
    unplanned: ['k-02'],
  },
  {
    name: 'list-scheduler-absent',
    covers:
      '一覧モード: context.scheduler が無い器 → 全行「（取れない — scheduler が渡っていない）」',
    seed: [small('k-01'), small('k-02')],
    steps: [list()],
    scheduler: 'absent',
  },
  {
    name: 'list-scheduler-empty',
    covers: '一覧モード: scheduler は在るが空 → 全行「まだ計算されていない」。呼びは行ごとに1回',
    seed: [small('k-01'), small('k-02')],
    steps: [list()],
    scheduler: 'empty',
  },
  {
    name: 'list-scheduler-decoy',
    covers: '一覧モード: scheduler に別の kind だけ在る → 全行「まだ計算されていない」',
    seed: [small('k-01'), small('k-02')],
    steps: [list()],
    scheduler: 'decoy',
  },
  {
    name: 'list-scheduler-throws',
    covers: '一覧モード: scheduler が投げる → 1行目の組み立てで例外のまま返る（出力は例外の文言）',
    seed: [small('k-01'), small('k-02')],
    steps: [list()],
    scheduler: 'throws',
  },
  {
    name: 'list-scheduler-not-read-when-empty-or-malformed',
    covers:
      'scheduler を読むのは cursor を当てたあとの見せる行だけ: cursor が壊れている・cursor より後ろが無いときは scheduler を呼ばない（throws の器でも断りの文・最後の頁の文が返る）',
    seed: [small('k-01'), small('k-02')],
    steps: [list({ cursor: 'garbage' }), list({ cursor: cursorAfter('k-02') })],
    scheduler: 'throws',
  },
  {
    name: 'list-keep-absent',
    covers:
      '一覧モード: context が keepStandingRowIfSame を持たない器でも、出力は口が有る器（list-scheduler-entries）と同じ形',
    seed: [small('k-01'), small('k-02'), small('k-03')],
    steps: [list()],
    keep: false,
  },
  {
    name: 'list-keep-present',
    covers:
      '一覧モード: keepStandingRowIfSame の口が有る器で、見せた行ごとの呼びが（いまは）無い。呼びが入ったら calls が変わって落ちる',
    seed: [small('k-01'), small('k-02'), small('k-03')],
    steps: [list(), list({ cursor: cursorAfter('k-01') })],
    keep: true,
  },
  // ---- 一覧モード: cursor ----
  {
    name: 'cursor-forms',
    covers:
      'cursor の当たり方（5 件 k-01〜k-05）: 先頭・k-02 の後ろ（3 件）・k-04 の後ろ（最後の 1 件）・k-05 の後ろ（無い → 最後の頁の文）・存在しない錨 k-025（それより大きい kind から）・k-00（全件）・zzz（無い）',
    seed: FIVE,
    steps: [
      list(),
      list({ cursor: cursorAfter('k-02') }),
      list({ cursor: cursorAfter('k-04') }),
      list({ cursor: cursorAfter('k-05') }),
      list({ cursor: cursorAfter('k-025') }),
      list({ cursor: cursorAfter('k-00') }),
      list({ cursor: cursorAfter('zzz') }),
    ],
  },
  {
    name: 'cursor-malformed',
    covers:
      'cursor が壊れている → 断りの文だけ（先頭へ倒さない）: base64url でない・空文字・空白・JSON だが形が違う（kind が空・数・欠け・配列）。scheduler は呼ばない。空の文字列も cursor を渡したことになる',
    seed: FIVE,
    steps: [
      list({ cursor: 'not-a-cursor' }),
      list({ cursor: '' }),
      list({ cursor: ' ' }),
      list({ cursor: encodeCursor({ kind: '' }) }),
      list({ cursor: encodeCursor({ kind: 5 }) }),
      list({ cursor: encodeCursor({ other: 'k-01' }) }),
      list({ cursor: encodeCursor([]) }),
      list({ cursor: encodeCursor(null) }),
    ],
  },
  // ---- 一覧モード: 予算 ----
  {
    name: 'budget-exact',
    covers:
      '件の字数の合計がちょうど 8,000 字（SCHEDULE_LIST_BUDGET）: 全件が収まり「…ほか N 件は省略」は付かない。末尾の「依頼本文は抜粋…」の行だけ。cursor を渡すと、その後ろ（1 件・最後の頁）',
    seed: EXACT_ROWS,
    steps: [
      list(),
      list({ cursor: cursorAfter(`bk-${pad2(EXACT_ROWS.length - 1)}`) }),
      list({ cursor: cursorAfter(`bk-${pad2(EXACT_ROWS.length)}`) }),
    ],
  },
  {
    name: 'budget-over',
    covers:
      '件の字数の合計が 8,001 字: 最後の 1 件が落ち「…ほか 1 件は省略（継続中の依頼は N 件あり、N-1 件だけ出した。…続きは schedule_list cursor=…）」。その cursor で 2 頁目（残りの 1 件・省略なし）→ 最後の頁（cursor より後ろが無い）',
    seed: OVER_ROWS,
    steps: [
      list(),
      { args: (previous) => ({ cursor: cursorFrom(previous) }) },
      list({ cursor: cursorAfter(`bk-${pad2(OVER_ROWS.length)}`) }),
    ],
  },
  {
    name: 'budget-over-unreadable',
    covers:
      '予算で切れ、読めない行も在る: 省略の文（cursor つき）→「依頼本文は抜粋…」→ 読めない行の案内の順。読めない行の案内は予算に数えない',
    seed: OVER_ROWS,
    steps: [list()],
    unreadable: [{ kind: 'broken', reason: '行が読めない形' }],
  },
  {
    name: 'budget-multi-page',
    covers:
      '60 件（kind mp-01〜mp-60）を cursor でたどる: 各頁の省略の文の母数は cursor を当てる前の 60 件（頁が進んでも「60 件あり」）、出した件数は頁ごと。最後の頁は省略なし。最後の cursor（mp-60 の後ろ）は最後の頁の文',
    seed: MULTI_ROWS,
    steps: [
      list(),
      { args: (previous) => ({ cursor: cursorFrom(previous) }) },
      { args: (previous) => ({ cursor: cursorFrom(previous) }) },
      list({ cursor: cursorAfter('mp-60') }),
    ],
  },
  {
    name: 'budget-cursor-missing-anchor',
    covers:
      '錨の kind が消えたあとの cursor（行は mp-01〜mp-60 のうち mp-10 を除いた 59 件）: mp-10 より大きい kind から続ける。省略の母数は 59',
    seed: MULTI_ROWS.filter((plan) => plan.kind !== 'mp-10'),
    steps: [list({ cursor: cursorAfter('mp-10') })],
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
  /** 呼びの並び（呼んだ順） */
  calls: string[];
  /** 定期の依頼か日誌が呼ぶ前から変わったか（読むだけの道具なので常に false） */
  wrote: boolean;
  /** get / list 以外の `schedules.*` の呼び（常に空） */
  writeCalls: string[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function schedulerStatuses(scenario: Scenario): ScheduleStatus[] {
  const decoy: ScheduleStatus = {
    kind: 'daily_report',
    description: '毎日の日報',
    nextAt: '2026-10-31T00:00:00.000Z',
  };
  const planned = scenario.seed
    .map((plan) => plan.kind)
    .filter((kind) => !(scenario.unplanned ?? []).includes(kind))
    .map((kind): ScheduleStatus => ({ kind, description: kind, nextAt: nextAtOf(kind) }));
  // 別の kind を先頭に混ぜ、仕込みの並びを逆にして、kind で探していることを確かめる
  return [decoy, ...planned.reverse()];
}

async function snapshot(base: Stores): Promise<{ rows: string; journal: string }> {
  return {
    rows: JSON.stringify((await base.schedules.list()).entries),
    journal: JSON.stringify(await base.journal.list({ order: 'asc' })),
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const seed of scenario.seed) await base.schedules.put(seed);

  let calls: string[] = [];
  const get = async (target: string): ReturnType<Stores['schedules']['get']> => {
    const failure = scenario.getFails?.[target];
    if (failure === 'unreadable') {
      calls.push(`schedules.get(${JSON.stringify(target)}) -> threw UnreadableScheduleError`);
      throw new UnreadableScheduleError('行が読めない形', { kind: target });
    }
    if (failure === 'plain') {
      calls.push(`schedules.get(${JSON.stringify(target)}) -> threw Error`);
      throw new Error('スケジュールのストアが落ちた');
    }
    const found = await base.schedules.get(target);
    calls.push(`schedules.get(${JSON.stringify(target)}) -> ${found === null ? 'null' : 'row'}`);
    return found;
  };
  const listRows = async (): ReturnType<Stores['schedules']['list']> => {
    if (scenario.listFails === true) {
      calls.push('schedules.list() -> threw Error');
      throw new Error('スケジュールの一覧が落ちた');
    }
    const result = await base.schedules.list();
    const unreadable = scenario.unreadable ?? [];
    calls.push(
      `schedules.list() -> entries=${String(result.entries.length)} unreadable=${String(unreadable.length)}`,
    );
    return { entries: result.entries, unreadable };
  };
  const schedules = Object.fromEntries(
    Object.entries(base.schedules).map(([name, member]) => [
      name,
      typeof member === 'function'
        ? (...args: unknown[]): unknown => {
            calls.push(`schedules.${name}(${JSON.stringify(args)})`);
            return (member as (...inner: unknown[]) => unknown)(...args);
          }
        : member,
    ]),
  ) as Stores['schedules'];
  const stores: Stores = { ...base, schedules: { ...schedules, get, list: listRows } };

  const mode = scenario.scheduler ?? 'entries';
  const scheduler = (): ScheduleStatus[] => {
    if (mode === 'throws') {
      calls.push('context.scheduler() -> threw Error');
      throw new Error('scheduler が落ちた');
    }
    const statuses =
      mode === 'empty'
        ? []
        : mode === 'decoy'
          ? schedulerStatuses({ ...scenario, seed: [] })
          : schedulerStatuses(scenario);
    calls.push(`context.scheduler() -> ${String(statuses.length)} statuses`);
    return statuses;
  };
  const keepStandingRowIfSame = (...args: unknown[]): undefined => {
    calls.push(`context.keepStandingRowIfSame(${JSON.stringify(args)})`);
    return undefined;
  };
  const context = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(mode === 'absent' ? {} : { scheduler }),
    ...(scenario.keep === false ? {} : { keepStandingRowIfSame }),
  } as ToolContext;
  const found = createCloneTools(context).find((entry) => entry.name === 'schedule_list');
  if (!found) throw new Error('schedule_list が無い');

  const results: PinnedStep[] = [];
  const previousTexts: string[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    calls = [];
    const before = await snapshot(base);
    const args = typeof step.args === 'function' ? step.args(previousTexts) : step.args;
    let output: PinnedOutput;
    try {
      const result = await found.handler(args as never, {} as never);
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
        errorName: errorNameOf(error),
      };
    }
    previousTexts.push(output.text);
    const after = await snapshot(base);
    const recorded = plain(calls);
    const wrote = before.rows !== after.rows || before.journal !== after.journal;
    results.push({
      output,
      calls: recorded,
      wrote,
      writeCalls: recorded.filter(
        (line) =>
          line.startsWith('schedules.') &&
          !line.startsWith('schedules.get(') &&
          !line.startsWith('schedules.list('),
      ),
    });
    expect(wrote, `場面 ${stepKey(scenario, index)}: 読むだけの道具が行か日誌を変えた`).toBe(false);
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

describe('schedule_list の出力と呼びの並びの固定（場面ごとの出力の全文・get / list / scheduler / keepStandingRowIfSame の呼び）', () => {
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

  it('読むだけである（どの場面も、行も日誌も変わらず、get / list 以外の書き込み口を呼ばない。固定値の側も同じ）', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 書き込みが起きた`).toBe(false);
      expect(actual[key]?.writeCalls, `${key}: 書き込み口が呼ばれた`).toEqual([]);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote`).toBe(false);
      expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
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

      it(`${key} の呼びの並び（get・list・scheduler・keepStandingRowIfSame）が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.length,
          `場面 ${key} の呼びの数が変わった: 固定値 ${String(want?.calls.length)} 回 → いま ${String(got?.calls.length)} 回`,
        ).toBe(want?.calls.length);
        expect(
          got?.calls,
          `場面 ${key} の呼びの並び（呼んだ順・引数・結果）が固定値からずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びの並びになる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep | undefined => actual[key];
    const text = (key: string): string => step(key)?.output.text ?? '';
    const calls = (key: string): string[] => step(key)?.calls ?? [];
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const callsOf = (key: string, head: string): number =>
      calls(key).filter((line) => line.startsWith(head)).length;
    const NO_NEXT = '（まだ計算されていない。少し待って呼び直すこと）';
    const NO_SCHEDULER = '（取れない — scheduler が渡っていない）';
    const NEVER = '（まだ一度も動いていない）';
    const LAST_PAGE = '（cursor より後ろの継続中の依頼は無い。これが最後の頁）';
    const MALFORMED = 'cursor が壊れている（この道具が返したものではないか、書き換えられている）';
    const OMITTED = '…ほか ';

    // offset の検査
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(text(`arg-offset#${String(n)}`)).toContain('は使えない（0以上の整数のみ）。');
      expect(calls(`arg-offset#${String(n)}`), `arg-offset#${String(n)}`).toEqual([]);
    }
    expect(text('arg-offset#8')).toContain('- a-one');
    expect(text('arg-offset#9')).toContain('- a-one');
    // 全文モード
    for (const key of ['full-heads#1', 'full-heads#2', 'full-heads#3']) {
      expect(callsOf(key, 'schedules.get('), key).toBe(1);
      expect(callsOf(key, 'schedules.list('), key).toBe(0);
      expect(callsOf(key, 'context.scheduler('), key).toBe(1);
      expect(text(key)).toContain('（依頼本文: 全 ');
    }
    expect(text('full-heads#1')).toContain(`前回動いた時刻: ${NEVER}`);
    expect(text('full-heads#2')).toContain('前回動いた時刻: 2026-10-20T00:05:00.000Z');
    expect(text('full-heads#3')).toContain('0 10 * * 1');
    expect(text('full-heads#3')).toContain('\n\n  前後の空白は全文では残る  ');
    expect(text('full-boundary#1')).toContain('全 7,999 文字');
    expect(text('full-boundary#2')).toContain('全 8,000 文字');
    expect(text('full-boundary#2')).not.toContain('続きは');
    expect(text('full-boundary#3')).toContain('1〜8,000 文字目 / 全 8,001 文字');
    expect(text('full-boundary#3')).toContain('続きは schedule_list kind=b-8001 offset=8000）');
    expect(text('full-boundary#4')).toContain('8,001〜8,001 文字目 / 全 8,001 文字');
    expect(text('full-boundary#4')).not.toContain('続きは');
    expect(text('full-paging#1')).toContain('1〜8,000 文字目 / 全 17,000 文字');
    expect(text('full-paging#2')).toContain('8,001〜16,000 文字目');
    expect(text('full-paging#2')).toContain('offset=16000）');
    expect(text('full-paging#3')).toContain('16,001〜17,000 文字目');
    expect(text('full-paging#3')).not.toContain('続きは');
    expect(text('full-paging#4')).toContain('全 17,000 文字の末尾を越えている');
    expect(text('full-paging#5')).toContain('全 17,000 文字の末尾を越えている');
    expect(text('full-paging#6')).toContain('17,000〜17,000 文字目');
    expect(text('full-paging#7')).toContain('5,001〜13,000 文字目');
    expect(text('full-offset-short#1')).toContain('4〜10 文字目 / 全 10 文字');
    expect(text('full-offset-short#3')).toContain('末尾を越えている');
    expect(text('full-offset-short#5')).toContain('3〜10 文字目');
    expect(text('full-surrogate#1')).toContain('1〜7,999 文字目 / 全 8,001 文字');
    expect(text('full-surrogate#1')).toContain('offset=7999）');
    expect(text('full-surrogate#2')).toContain('8,000〜8,001 文字目');
    expect(text('full-store#1')).toContain(
      '継続中の依頼 broken は読めない形で入っている（消されたのではない）',
    );
    expect(text('full-store#1')).toContain('schedule_remove kind=broken で外せる');
    expect(step('full-store#1')?.output.thrown).toBe(false);
    expect(step('full-store#2')?.output.thrown).toBe(true);
    expect(text('full-store#2')).toBe('スケジュールのストアが落ちた');
    for (const n of [3, 4, 5, 6]) {
      expect(text(`full-store#${String(n)}`)).toContain('は無い（kind が違うか、もう外してある）');
    }
    expect(text('full-store#7')).toContain('present（');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(
        callsOf(`full-store#${String(n)}`, 'context.scheduler('),
        `full-store#${String(n)}`,
      ).toBe(0);
    }
    expect(callsOf('full-ignores-list-args#1', 'schedules.list('), 'full-ignores-list-args#1').toBe(
      0,
    );
    expect(text('full-ignores-list-args#1')).not.toContain(MALFORMED);
    expect(text('full-ignores-list-args#1')).not.toContain('読めない継続中の依頼');
    expect(text('full-scheduler-absent')).toContain(NO_SCHEDULER);
    expect(text('full-scheduler-empty')).toContain(NO_NEXT);
    expect(text('full-scheduler-decoy')).toContain(NO_NEXT);
    expect(step('full-scheduler-throws')?.output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: 'scheduler が落ちた',
    });
    expect(text('full-keep-absent')).toContain('次に動く時刻: 2026-10-30T');
    // 一覧モード: 空・読めない行
    expect(text('list-empty#1')).toBe('（継続中の依頼は無い）');
    expect(text('list-empty#2')).toBe('（継続中の依頼は無い）');
    expect(text('list-empty#3')).toBe('（継続中の依頼は無い）');
    for (const n of [1, 2, 3])
      expect(callsOf(`list-empty#${String(n)}`, 'context.scheduler(')).toBe(0);
    expect(text('list-empty-unreadable-one#1')).toBe(
      '（読めた継続中の依頼は無い）\n読めない継続中の依頼が 1 件ある（kind: broken）。壊れた行であって、消された依頼ではない。この一覧には載っていない。kind が分かるものは schedule_remove kind=<kind> で外せる。',
    );
    expect(text('list-empty-unreadable-one#2')).toBe(text('list-empty-unreadable-one#1'));
    expect(text('list-empty-unreadable-kindless')).toContain('（kind も取れない）');
    expect(text('list-empty-unreadable-kindless')).not.toContain('schedule_remove');
    expect(text('list-empty-unreadable-mixed')).toContain('kind: bad-a, bad-b');
    expect(text('list-empty-unreadable-mixed')).toContain('kind が取れない行が 1 件');
    expect(text('list-empty-unreadable-many')).toContain('ほか 2 件');
    expect(text('list-unreadable-with-rows#1')).toContain('- k-02');
    expect(
      text('list-unreadable-with-rows#1').endsWith('schedule_remove kind=<kind> で外せる。'),
    ).toBe(true);
    expect(text('list-unreadable-with-rows#1')).toContain(
      `${FOOTER}\n読めない継続中の依頼が 2 件ある`,
    );
    expect(text('list-unreadable-with-rows#3')).toContain(`${LAST_PAGE}\n読めない継続中の依頼`);
    expect(text('list-unreadable-with-rows#3')).not.toContain(FOOTER);
    expect(text('list-unreadable-malformed-cursor')).toBe(
      `${MALFORMED}。一覧を先頭から読み直すには cursor を付けずに schedule_list を呼ぶこと。`,
    );
    expect(step('list-fails#1')?.output).toMatchObject({
      thrown: true,
      text: 'スケジュールの一覧が落ちた',
    });
    expect(step('list-fails#2')?.output.thrown).toBe(false);
    expect(callsOf('list-fails#2', 'schedules.list(')).toBe(0);
    // 行の形
    expect(text('list-one-never-run')).toContain(
      `  前回動いた時刻: ${NEVER}\n  次に動く時刻: 2026-10-30T09:`,
    );
    expect(text('list-one-never-run')).toContain('  依頼: 見回りをする');
    expect(text('list-one-never-run').endsWith(FOOTER)).toBe(true);
    expect(callsOf('list-one-never-run', 'context.scheduler(')).toBe(1);
    expect(callsOf('list-one-never-run', 'schedules.get(')).toBe(0);
    expect(text('list-one-ran')).toContain('前回動いた時刻: 2026-10-20T00:03:00.000Z');
    expect(text('list-rows-forms')).toContain('  依頼: 一行目 二行目 三行目\n');
    expect(text('list-rows-forms')).toContain(`  依頼: ${LONG(199)}\n`);
    expect(text('list-rows-forms')).toContain(`  依頼: ${LONG(200)}\n`);
    expect(text('list-rows-forms')).toContain(`${LONG(200)}…（1 文字省略。全 201 文字）`);
    expect(count(text('list-rows-forms'), NEVER)).toBe(8);
    expect(callsOf('list-rows-forms', 'context.scheduler(')).toBe(10);
    // scheduler
    expect(callsOf('list-scheduler-entries', 'context.scheduler(')).toBe(3);
    expect(count(text('list-scheduler-entries'), '次に動く時刻: 2026-10-30T09:')).toBe(3);
    expect(count(text('list-scheduler-partial'), NO_NEXT)).toBe(1);
    expect(text('list-scheduler-partial')).toContain(`- k-02`);
    expect(count(text('list-scheduler-absent'), NO_SCHEDULER)).toBe(2);
    expect(callsOf('list-scheduler-absent', 'context.scheduler(')).toBe(0);
    expect(count(text('list-scheduler-empty'), NO_NEXT)).toBe(2);
    expect(count(text('list-scheduler-decoy'), NO_NEXT)).toBe(2);
    expect(step('list-scheduler-throws')?.output.thrown).toBe(true);
    expect(callsOf('list-scheduler-throws', 'context.scheduler(')).toBe(1);
    expect(text('list-scheduler-not-read-when-empty-or-malformed#1')).toContain(MALFORMED);
    expect(text('list-scheduler-not-read-when-empty-or-malformed#2')).toContain(LAST_PAGE);
    for (const n of [1, 2]) {
      expect(
        callsOf(
          `list-scheduler-not-read-when-empty-or-malformed#${String(n)}`,
          'context.scheduler(',
        ),
      ).toBe(0);
    }
    expect(text('list-keep-absent')).toBe(text('list-scheduler-entries'));
    // keepStandingRowIfSame（いまは呼ばれない）
    for (const key of ALL_KEYS) {
      expect(
        callsOf(key, 'context.keepStandingRowIfSame('),
        `${key}: keepStandingRowIfSame が呼ばれた`,
      ).toBe(0);
    }
    // cursor
    expect(count(text('cursor-forms#1'), '\n- k-'), 'cursor-forms#1').toBe(4);
    expect(text('cursor-forms#2')).not.toContain('- k-02');
    expect(text('cursor-forms#2')).toContain('- k-03');
    expect(text('cursor-forms#3')).toContain('- k-05');
    expect(text('cursor-forms#3')).not.toContain('- k-04');
    expect(text('cursor-forms#4')).toBe(LAST_PAGE);
    expect(text('cursor-forms#5')).toContain('- k-03');
    expect(text('cursor-forms#5')).not.toContain('- k-02');
    expect(text('cursor-forms#6')).toContain('- k-01');
    expect(text('cursor-forms#7')).toBe(LAST_PAGE);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(text(`cursor-malformed#${String(n)}`), `cursor-malformed#${String(n)}`).toContain(
        MALFORMED,
      );
      expect(callsOf(`cursor-malformed#${String(n)}`, 'context.scheduler(')).toBe(0);
    }
    // 予算
    expect(text('budget-exact#1')).not.toContain(OMITTED);
    expect(text('budget-exact#1').endsWith(FOOTER)).toBe(true);
    expect(callsOf('budget-exact#1', 'context.scheduler(')).toBe(EXACT_ROWS.length);
    expect(text('budget-exact#2')).toContain(`- bk-${pad2(EXACT_ROWS.length)}`);
    expect(text('budget-exact#3')).toBe(LAST_PAGE);
    expect(text('budget-over#1')).toContain(
      `${OMITTED}1 件は省略（継続中の依頼は ${String(OVER_ROWS.length)} 件あり、${String(OVER_ROWS.length - 1)} 件だけ出した。`,
    );
    expect(text('budget-over#1')).not.toContain(`- bk-${pad2(OVER_ROWS.length)}`);
    expect(callsOf('budget-over#1', 'context.scheduler(')).toBe(OVER_ROWS.length);
    expect(text('budget-over#2')).toContain(`- bk-${pad2(OVER_ROWS.length)}`);
    expect(text('budget-over#2')).not.toContain(OMITTED);
    expect(text('budget-over#3')).toBe(LAST_PAGE);
    expect(text('budget-over-unreadable')).toContain(
      `取れる）。\n${FOOTER}\n読めない継続中の依頼が 1 件ある`,
    );
    for (const n of [1, 2]) {
      expect(text(`budget-multi-page#${String(n)}`)).toContain('継続中の依頼は 60 件あり、');
    }
    expect(text('budget-multi-page#3')).not.toContain(OMITTED);
    expect(text('budget-multi-page#3')).toContain('- mp-60');
    expect(text('budget-multi-page#4')).toBe(LAST_PAGE);
    expect(text('budget-cursor-missing-anchor')).toContain('継続中の依頼は 59 件あり、');
    expect(text('budget-cursor-missing-anchor')).toContain('- mp-11');
    expect(text('budget-cursor-missing-anchor')).not.toContain('- mp-10');
  });
});
