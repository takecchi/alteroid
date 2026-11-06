import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  clearRecentTracesForTesting,
  noteDroppedRecord,
  noteInboxEventKeptInMemoryOnly,
  recentDroppedTraces,
  RECENT_TRACE_LIMIT,
  setStderrSinkForTesting,
} from './dropped-record.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `self_dropped` の出力（全文と字数）と、呼んだあとの状態（帳面・日誌が動いていないこと）を、場面ごとにコミットした固定値
// （clone-tools-self-dropped-output-pin.json）と丸ごと比べる。
// `clone-tools-self.ts` の `tool('self_dropped', …)`（limit・offset の検査 → 帳面が空 → offset が件数以上 → `limit` と予算（SELF_DROPPED_BUDGET）で切る
// → 断り書きと次の offset）を小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・帳面の中身）を固定して毎回同じにする。
// この道具は読むだけ。だから出力に加えて、次を場面ごとに確かめる:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - wrote: 呼ぶ前後で帳面（`recentDroppedTraces()`）・日誌の行数が変わったか。場面ごとの宣言（全場面 none）と実際が合うことも確かめる
//   - args: 実際に渡した引数（続きの offset を前の出力から取り出した場面は、取り出した値）
//   - ledgerSize: 呼ぶ前の帳面の件数
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_SELF_DROPPED_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-self-dropped-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-self-dropped-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧。
//
// 帳面はプロセス全体で共有される配列。場面の頭で `clearRecentTracesForTesting()` で空にし、本物の `noteDroppedRecord` 等を呼んで作りものの跡を積み、
// 場面ごとに（と最後に）空へ戻す（ほかの試験へ漏らさない）。stderr は握る（`setStderrSinkForTesting`）。
// 時計は Date だけを固定する（実時間の待ちは使わない）。帳面は基準の 2026-10-01 から 1 秒ずつ進めて積み（`数え始めた時刻` も 2026-10-01）、
// 呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ。同じ帳面へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 予算（SELF_DROPPED_BUDGET = 8,000 字）・既定の limit（50）はこの試験の側に値を持つ（道具の定数を import しない）。保持件数は本物の RECENT_TRACE_LIMIT を import する（200）。
//
// 秘密: 値は作りものだけ。跡の `detail` は `noteDroppedRecord` が伏せずに書く（`reasonOf` を通るのは error だけ）ので、その場面は作りものの値が出力にそのまま出る
// ことをいまの振る舞いとして固定する（json にはその作りものの値が残る。本物ではない）。error 側に入れた作りものの値は `reasonOf` が伏せる。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い文字列は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

interface TraceSpec {
  kind?: 'record' | 'inbox';
  what: string;
  detail: string;
  error: string;
}

interface Step {
  /** 前の呼びの出力の全文（先頭の呼びは空）を受けて引数を作れる（続きの offset の取り出し用） */
  args: Args | ((previous: string) => Args);
}

interface Scenario {
  name: string;
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  traces: TraceSpec[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const SEED_ISO = '2026-10-01T00:00:00.000Z';
const SEED_MS = Date.parse(SEED_ISO);
const PIN_URL = new URL('./clone-tools-self-dropped-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_SELF_DROPPED_PIN === '1';

const SELF_DROPPED_BUDGET = 8_000;

/** 作りものの値（本物ではない）。detail へ入れて、伏せられないことをいまのまま固定する */
const FAKE_VALUE = 'FAKE_NOT_A_REAL_VALUE_0123456789';

function callTime(index: number): number {
  return BASE_MS + index * 60_000;
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function t(
  what: string,
  detail: string,
  error: string,
  kind: 'record' | 'inbox' = 'record',
): TraceSpec {
  return { kind, what, detail, error };
}

/** n 件の短い跡（番号入り。古い順に 001, 002, …） */
function gen(n: number, error = '書けない（test）'): TraceSpec[] {
  return Array.from({ length: n }, (_, i) => t('日誌', `n=${pad3(i + 1)}`, error));
}

function s(args: Args = {}): Step {
  return { args };
}

/** 前の出力の「self_dropped offset=N で取れる」から offset を取り出して、同じ limit で続ける */
function follow(limit?: number): (previous: string) => Args {
  return (previous) => {
    const m = /self_dropped offset=(\d+) で取れる/u.exec(previous);
    if (m === null) throw new Error('前の出力に続きの offset が無い');
    return { ...(limit === undefined ? {} : { limit }), offset: Number(m[1]) };
  };
}

const SCENARIOS: Scenario[] = [
  // ---- limit・offset の断り ----
  {
    name: 'limit-invalid',
    group: 'limit・offset の断り',
    covers:
      'limit の範囲外・小数・非数: 帳面を読む前に「limit は …」の断り（isError ではない）。帳面に跡があっても同じ。0・負・上限超え・小数・NaN・Infinity',
    traces: gen(3),
    steps: [
      s({ limit: 0 }),
      s({ limit: -1 }),
      s({ limit: 1.5 }),
      s({ limit: RECENT_TRACE_LIMIT + 1 }),
      s({ limit: Number.NaN }),
      s({ limit: Number.POSITIVE_INFINITY }),
      s({ limit: 1 }),
      s({ limit: RECENT_TRACE_LIMIT }),
    ],
  },
  {
    name: 'offset-invalid',
    group: 'limit・offset の断り',
    covers:
      'offset の範囲外・小数・非数: 「offset は …」の断り。limit の検査が先（limit も不正なら limit の断り）。上限ちょうど（200）は検査を通り、件数以上の断りへ進む',
    traces: gen(3),
    steps: [
      s({ offset: -1 }),
      s({ offset: 1.5 }),
      s({ offset: RECENT_TRACE_LIMIT + 1 }),
      s({ offset: Number.NaN }),
      s({ limit: 0, offset: -1 }),
      s({ offset: RECENT_TRACE_LIMIT }),
    ],
  },

  // ---- 帳面が空 ----
  {
    name: 'ledger-empty',
    group: '帳面が空',
    covers:
      '帳面が空: 「まだ跡が1件も残っていない」の文＋由来＋数え始めた時刻。limit・offset が検査を通る値なら、offset が大きくても空の文が先（件数以上の断りには進まない）',
    traces: [],
    steps: [s(), s({ limit: 1 }), s({ offset: 5 }), s({ limit: 10, offset: RECENT_TRACE_LIMIT })],
  },

  // ---- 1件・数件 ----
  {
    name: 'single',
    group: '1件・数件',
    covers: '1件: 断り書きは付かず、跡の行・由来・保持の説明が並ぶ。既定の limit',
    traces: [t('日誌', 'id=one', '書けない（test）')],
    steps: [s(), s({ limit: 1 }), s({ offset: 0 })],
  },
  {
    name: 'few',
    group: '1件・数件',
    covers:
      '数件（record と inbox の2種類の跡を混ぜる）: 並びは古い側が上・最新が末尾（帳面の並びのまま）。limit が件数以上なら全部。断り書きは付かない',
    traces: [
      t('日誌', 'n=001', '一つ目の失敗'),
      t('添付', 'id=att-1', '二つ目の失敗'),
      t('', '', '詳細が空'),
      t('記憶', 'slug=a', '改行を含む\n二行目は出ない'),
      t('', 'id=ev-1', '合図の失敗', 'inbox'),
    ],
    steps: [s(), s({ limit: 5 }), s({ limit: 100 }), s({ limit: 2 }), s({ limit: 2, offset: 2 })],
  },

  // ---- limit で切れる ----
  {
    name: 'limit-cut',
    group: 'limit で切れる',
    covers:
      'limit で切れる: 新しい側から limit 件だけ載り、先頭に「…ほか古い N 件は省略」と次の offset（skip + 載せた件数）が付く。limit を上げても予算に尽きなければ全部載る。limit = 件数ちょうどなら断り書きは付かない',
    traces: gen(10),
    steps: [
      s({ limit: 3 }),
      s({ limit: 9 }),
      s({ limit: 10 }),
      s({ limit: 1 }),
      s({ limit: 3, offset: 4 }),
    ],
  },

  // ---- 予算で切れる ----
  {
    name: 'budget-cut',
    group: '予算で切れる',
    covers:
      '予算（8,000 字）で切れる: 長い跡が並ぶと limit が件数以上でも、新しい側から入る分だけが載り、「…ほか古い N 件は省略」の次の offset は載せた件数で組まれる。limit を上げても境界は動かない',
    traces: Array.from({ length: 30 }, (_, i) =>
      t('日誌', `n=${pad3(i + 1)} ${spaced(500, 'long')}`, '書けない（test）'),
    ),
    steps: [s(), s({ limit: 200 }), s({ limit: 30 }), s({ limit: 5 })],
  },
  {
    name: 'budget-follow',
    group: '予算で切れる',
    covers:
      '予算で切れた後、断り書きの次の offset をそのまま渡して古い側へ最後まで読み進める。最後の呼びは断り書きが付かない',
    traces: Array.from({ length: 12 }, (_, i) =>
      t('日誌', `n=${pad3(i + 1)} ${spaced(1_500, 'long')}`, '書けない（test）'),
    ),
    steps: [s(), { args: follow() }, { args: follow() }],
  },
  {
    name: 'limit-follow',
    group: 'offset で古い側へ進む',
    covers:
      'limit で切れた後、断り書きの次の offset をそのまま渡して最後まで読む（limit 4 で 10 件: offset 0 → 4 → 8 → 件数ちょうどの手前）。最後は断り書きが付かない',
    traces: gen(10),
    steps: [s({ limit: 4 }), { args: follow(4) }, { args: follow(4) }],
  },
  {
    name: 'offset-skip',
    group: 'offset で古い側へ進む',
    covers:
      'offset で新しい側をスキップして見る: 最新から offset 件を飛ばした窓の中の limit 件。windowed の末尾が窓の最新になる。件数-1（最古の1件だけ）・limit が窓より大きい・limit と offset の組み合わせ',
    traces: gen(10),
    steps: [
      s({ offset: 3 }),
      s({ offset: 9 }),
      s({ offset: 5, limit: 100 }),
      s({ offset: 2, limit: 3 }),
      s({ offset: 8, limit: 1 }),
    ],
  },

  // ---- offset が件数以上 ----
  {
    name: 'offset-ge-count',
    group: 'offset が件数以上',
    covers:
      'offset が件数以上: 「offset（N）が帳面の件数（M）以上なので、これより古い分は無い。offset を M-1 以下にして呼び直すこと」。件数ちょうど・件数超え・上限（200）。件数-1 は通って最古の1件が出る。limit が不正なら limit の断りが先',
    traces: gen(4),
    steps: [
      s({ offset: 4 }),
      s({ offset: 5 }),
      s({ offset: RECENT_TRACE_LIMIT }),
      s({ offset: 3 }),
      s({ limit: 0, offset: 9 }),
    ],
  },
  {
    name: 'offset-ge-count-single',
    group: 'offset が件数以上',
    covers: '1件の帳面で offset=1: 「offset を 0 以下にして呼び直すこと」（件数-1 = 0）',
    traces: gen(1),
    steps: [s({ offset: 1 })],
  },

  // ---- 保持件数ちょうど ----
  {
    name: 'ledger-full',
    group: '帳面が保持件数ちょうど',
    covers:
      '帳面が RECENT_TRACE_LIMIT（200）件ちょうど: 既定 50 件・limit 200・offset 150（最古の 50 件）・199（最古の1件）・200（件数以上の断り）。予算に尽きる呼びは断り書きと次の offset',
    traces: gen(RECENT_TRACE_LIMIT),
    steps: [
      s(),
      s({ limit: RECENT_TRACE_LIMIT }),
      s({ offset: 150 }),
      s({ offset: RECENT_TRACE_LIMIT - 1 }),
      s({ offset: RECENT_TRACE_LIMIT }),
    ],
  },
  {
    name: 'ledger-overflow',
    group: '帳面が保持件数ちょうど',
    covers:
      '保持件数を1件超えて積む（201 件）: 帳面は 200 件のまま、最古の 1 件（n=001）が押し出されて出力に無い。最古は n=002',
    traces: gen(RECENT_TRACE_LIMIT + 1),
    steps: [s({ offset: RECENT_TRACE_LIMIT - 1 }), s({ offset: 150 })],
  },

  // ---- 跡の文に値 ----
  {
    name: 'trace-with-value',
    group: '跡の文に値が入る',
    covers:
      '跡の文に作りものの値が入る（いまの振る舞いのまま固定）: detail（`noteDroppedRecord` の第2引数）は伏せずに帳面へ載り、出力にそのまま出る。error に入れた値と `名前=値` は `reasonOf` が [REDACTED] にする。道具は帳面の文を加工しない',
    traces: [
      t('日誌', `id=${FAKE_VALUE}`, '書けない（test）'),
      t('日誌', 'n=2', `接続できない ${FAKE_VALUE}`),
      t('日誌', 'n=3', `接続できない TOKEN=${FAKE_VALUE}`),
      t('日誌', `export TOKEN=${FAKE_VALUE}`, '書けない（test）'),
    ],
    steps: [s()],
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
  thrown: boolean;
  errorName: string | null;
}

interface PinnedStep {
  output: PinnedOutput;
  /** 呼ぶ前後で帳面・日誌が変わったか（読むだけの道具なので全場面 none） */
  wrote: 'none' | 'ledger' | 'journal';
  /** 実際に渡した引数（NaN・Infinity は文字列で書く） */
  args: Record<string, unknown>;
  /** 呼ぶ前の帳面の件数 */
  ledgerSize: number;
}

interface PinFile {
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function jsonArgs(args: Args): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
    ]),
  );
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function seedLedger(traces: TraceSpec[]): void {
  vi.setSystemTime(new Date(SEED_MS));
  clearRecentTracesForTesting();
  for (const [i, spec] of traces.entries()) {
    vi.setSystemTime(new Date(SEED_MS + (i + 1) * 1_000));
    if (spec.kind === 'inbox') noteInboxEventKeptInMemoryOnly(spec.detail, new Error(spec.error));
    else noteDroppedRecord(spec.what, spec.detail, new Error(spec.error));
  }
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const stores = createMemoryStores();
  const found = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  }).find((entry) => entry.name === 'self_dropped');
  if (!found) throw new Error('self_dropped が無い');
  const results: PinnedStep[] = [];
  try {
    seedLedger(scenario.traces);
    let previous = '';
    for (const [index, step] of scenario.steps.entries()) {
      const args = typeof step.args === 'function' ? step.args(previous) : step.args;
      vi.setSystemTime(new Date(callTime(index)));
      const ledgerBefore = recentDroppedTraces();
      const journalBefore = (await stores.journal.list({ order: 'asc' })).length;
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
          errorName: nameOf(error),
        };
      }
      previous = output.text;
      const ledgerAfter = recentDroppedTraces();
      const journalAfter = (await stores.journal.list({ order: 'asc' })).length;
      const wrote =
        JSON.stringify(ledgerBefore) !== JSON.stringify(ledgerAfter)
          ? 'ledger'
          : journalBefore !== journalAfter
            ? 'journal'
            : 'none';
      const key = stepKey(scenario, index);
      expect(wrote, `場面 ${key}: 読むだけの道具が帳面か日誌を動かした`).toBe('none');
      results.push({ output, wrote, args: jsonArgs(args), ledgerSize: ledgerBefore.length });
    }
  } finally {
    clearRecentTracesForTesting();
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

describe('self_dropped の出力と呼んだあとの状態の固定（場面ごとの出力の全文・帳面と日誌が動かないこと）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    // 跡は stderr へも出る: 握って、ほかの出力へ漏らさない
    setStderrSinkForTesting(() => undefined);
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 120_000);

  afterAll(() => {
    clearRecentTracesForTesting();
    setStderrSinkForTesting(null);
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

  it('全場面で、読むだけの道具が帳面も日誌も動かしていない（固定値の wrote も none）', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 動かした`).toBe('none');
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が none でない`).toBe('none');
    }
  });

  describe.each(SCENARIOS)('場面 $name（$group）', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          {
            isError: got?.output.isError,
            thrown: got?.output.thrown,
            errorName: got?.output.errorName,
          },
          `場面 ${key} の出力の isError／例外で返ったか／例外の名前、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の渡した引数と呼ぶ前の帳面の件数が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.args, `場面 ${key} の引数（続きの offset を含む）が変わった`).toEqual(
          want?.args,
        );
        expect(got?.ledgerSize, `場面 ${key} の帳面の件数が変わった`).toBe(want?.ledgerSize);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・並び・採番が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('帳面は場面ごとに元へ戻っている（ほかの試験へ漏らさない）。json に本物らしい値と絶対パスが無い', () => {
    expect(recentDroppedTraces()).toEqual([]);
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toContain('/tmp/');
    for (const key of ALL_KEYS) {
      if (key === 'trace-with-value') continue;
      expect(
        JSON.stringify(actual[key]).includes(FAKE_VALUE),
        `場面 ${key} の記録に作りものの値が入っている`,
      ).toBe(false);
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const ORIGIN =
      'デーモンのプロセス（クローンを含む）が残した跡だけである。別プロセスの runner が残した跡はここには出ない。';
    const SINCE = `この帳面が数え始めたのは ${SEED_ISO}。`;
    const EMPTY =
      'このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない。0件は「握り潰しが1件も無かった」ことを意味しない —— この帳面はプロセスの生存中だけの記憶で、再起動・デプロイの入れ替えで消える。';
    const RETENTION = `直近 ${String(RECENT_TRACE_LIMIT)} 件までしか持たず、溢れた古い側から押し出される。それより古い分はこの帳面の中には無く、器の外の stderr を見るしかない。`;
    const lines = (key: string): string[] => text(key).split('\n');

    // limit・offset の断り
    for (const key of [
      'limit-invalid#1',
      'limit-invalid#2',
      'limit-invalid#3',
      'limit-invalid#4',
      'limit-invalid#5',
      'limit-invalid#6',
    ]) {
      expect(text(key), key).toMatch(/^limit /u);
      expect(step(key).output.isError, key).toBe(false);
      expect(text(key), key).not.toContain(ORIGIN);
    }
    expect(text('limit-invalid#7')).toContain(ORIGIN);
    expect(text('limit-invalid#8')).toContain(ORIGIN);
    for (const key of [
      'offset-invalid#1',
      'offset-invalid#2',
      'offset-invalid#3',
      'offset-invalid#4',
    ]) {
      expect(text(key), key).toMatch(/^offset /u);
      expect(text(key), key).not.toContain(ORIGIN);
    }
    expect(text('offset-invalid#5')).toMatch(/^limit /u);
    expect(text('offset-invalid#6')).toContain('以上なので');

    // 帳面が空
    for (const key of ['ledger-empty#1', 'ledger-empty#2', 'ledger-empty#3', 'ledger-empty#4']) {
      expect(text(key), key).toBe(`${EMPTY} ${ORIGIN} ${SINCE}`);
      expect(step(key).ledgerSize, key).toBe(0);
    }

    // 1件・数件
    expect(lines('single#1')).toHaveLength(3);
    expect(text('single#1')).not.toContain('省略');
    expect(text('single#1')).toContain(RETENTION);
    expect(text('single#1').endsWith(`（${RETENTION} ${SINCE}）`)).toBe(true);
    const few = lines('few#1');
    expect(few[0]).toContain('日誌を記録できませんでした（n=001）: Error: 一つ目の失敗');
    expect(few[4]).toContain('未読の合図をストアへ書けませんでした（id=ev-1）');
    expect(few[3]).toContain('Error: 改行を含む');
    expect(text('few#1')).not.toContain('二行目は出ない');
    expect(text('few#1')).toBe(text('few#2'));
    expect(text('few#1')).toBe(text('few#3'));
    expect(text('few#4')).toContain(
      '…ほか古い 3 件は省略（帳面には全 5 件あり、直近から 2 件だけ出した）。続きは self_dropped offset=2 で取れる',
    );
    expect(text('few#5')).toContain(
      '…ほか古い 1 件は省略（帳面には全 5 件あり、直近から 2 件だけ出した）。続きは self_dropped offset=4 で取れる',
    );

    // limit で切れる
    expect(text('limit-cut#1')).toContain(
      '…ほか古い 7 件は省略（帳面には全 10 件あり、直近から 3 件だけ出した）。続きは self_dropped offset=3 で取れる（limit を上げても動かない）。',
    );
    expect(text('limit-cut#1')).toContain('n=010');
    expect(text('limit-cut#1')).not.toContain('n=007');
    expect(text('limit-cut#2')).toContain('古い 1 件は省略');
    expect(text('limit-cut#3')).not.toContain('省略');
    expect(text('limit-cut#3')).toContain('n=001');
    expect(text('limit-cut#5')).toContain('self_dropped offset=7 で取れる');

    // 予算で切れる
    expect(text('budget-cut#1')).toContain('省略（帳面には全 30 件あり');
    expect(text('budget-cut#1')).toBe(text('budget-cut#2'));
    expect(text('budget-cut#1')).toBe(text('budget-cut#3'));
    expect(text('budget-cut#1').length).toBeLessThan(SELF_DROPPED_BUDGET + 1_000);
    expect(text('budget-cut#4')).not.toBe(text('budget-cut#1'));
    expect(text('budget-follow#3')).not.toContain('省略');
    expect(text('budget-follow#3')).toContain('n=001');
    expect(step('budget-follow#2').args).not.toEqual(step('budget-follow#3').args);

    // offset で古い側へ進む
    expect(step('limit-follow#2').args).toEqual({ limit: 4, offset: 4 });
    expect(step('limit-follow#3').args).toEqual({ limit: 4, offset: 8 });
    expect(text('limit-follow#3')).not.toContain('省略');
    expect(text('limit-follow#3')).toContain('n=001');
    expect(text('offset-skip#2')).toContain('n=001');
    expect(text('offset-skip#2')).not.toContain('n=002');
    expect(text('offset-skip#1')).toContain('n=007');
    expect(text('offset-skip#1')).not.toContain('n=008');

    // offset が件数以上
    expect(text('offset-ge-count#1')).toBe(
      `offset（4）が帳面の件数（4）以上なので、これより古い分は無い。offset を 3 以下にして呼び直すこと。 ${ORIGIN} ${SINCE}`,
    );
    expect(text('offset-ge-count#2')).toContain('offset（5）が帳面の件数（4）以上');
    expect(text('offset-ge-count#3')).toContain('offset（200）が帳面の件数（4）以上');
    expect(text('offset-ge-count#4')).toContain('n=001');
    expect(text('offset-ge-count#5')).toMatch(/^limit /u);
    expect(text('offset-ge-count-single')).toContain('offset を 0 以下にして呼び直すこと');

    // 保持件数ちょうど
    expect(step('ledger-full#1').ledgerSize).toBe(RECENT_TRACE_LIMIT);
    expect(text('ledger-full#1')).toContain('全 200 件あり');
    expect(text('ledger-full#2')).toContain('全 200 件あり');
    expect(text('ledger-full#3')).toContain('n=001');
    expect(text('ledger-full#4')).toContain('n=001');
    expect(text('ledger-full#5')).toContain('offset（200）が帳面の件数（200）以上');
    expect(step('ledger-overflow#1').ledgerSize).toBe(RECENT_TRACE_LIMIT);
    expect(text('ledger-overflow#1')).toContain('n=002');
    expect(text('ledger-overflow#1')).not.toContain('n=001');

    // 跡の文に値
    expect(text('trace-with-value')).toContain(`id=${FAKE_VALUE}`);
    expect(text('trace-with-value')).toContain(`export TOKEN=${FAKE_VALUE}`);
    expect(text('trace-with-value')).toContain('Error: 接続できない [REDACTED]');
    expect(text('trace-with-value')).toContain('TOKEN=[REDACTED]');
    expect(count(text('trace-with-value'), FAKE_VALUE)).toBe(2);
  });
});
