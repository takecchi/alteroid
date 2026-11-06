import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderListingEntry } from './excerpt.js';
import { UnreadablePracticeError, type Stores } from './store.js';
import type { UnreadablePractice } from './schema.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `practice_list` の出力（全文と字数）と、ストアの呼びの並び（`practices.list` と返した件数）を、場面ごとにコミットした固定値
// （clone-tools-practice-list-output-pin.json）と丸ごと比べる。
// `clone-tools-practice.ts` の `tool('practice_list', …)`（`practices.list()` → 読めない行の注記 → 空の文（読めない行の有無で2通り）→ 一覧（予算で切れたら
// 「ほか N 件は省略」）→ 読めない行の注記を末尾へ足す）を小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。
// 固定値の側で値を伏せず、入力（時計・やり方・読めない行）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - calls: ストアの呼びの並び（`practices.list` と、返した件数・読めない行の数。投げたら投げた文言）。道具が呼ぶのは list だけで、
//     read・listVersions・write・remove・clear・日誌の書き込みを呼べば記録に出る（下で別に確かめる）
//   - wrote: やり方（一覧と版の履歴の全文）か日誌が、呼ぶ前から変わったか。この道具は読むだけなので、どの場面も false
//
// 固定値の作り直し（意図して出力・呼びを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PRACTICE_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-practice-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-practice-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。やり方の仕込みは 1 手ごとに SEED_ISO から 1 時間ずつ進めて書く（作成・更新の時刻が互いに違う）。
// 呼びは CALL_ISO から 1 分ずつ進めて呼ぶ。日誌は場面の頭に1行入れて、呼ぶ前後で変わらないことを確かめる。
//
// 作り方の注記:
//   - 読めない行: インメモリのストアは `unreadable` が常に空なので、`list` の口（hooks.unreadable）が返す列に足して作る（道具から見ると、ストアがそう返した場合）
//   - 予算の境目: 予算（PRACTICE_LIST_BUDGET = 8,000 字）は一覧の行の字数の合計で測る。行の字数をそろえた行（`sized`。1行 250 字）を 32 件並べると
//     合計がちょうど 8,000 字になる（ちょうど）。33 件目から省略が出る。行の長さは本物の `renderListingEntry` で測って題の長さを合わせる
//   - 予算の値はこの試験の側に持つ（道具の定数を import しない）
//
// 秘密: 値は作りものだけ。題は道具がそのまま出す（伏せない）ので、題に作りものの値が入る場面は出力にそのまま出ることをいまの振る舞いとして固定する
// （json にはその作りものの値が残る。本物ではない）。読めない行の `reason` は道具が出さない（slug だけ）ことも同じ場面で固定する。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い文字列は 10 字ごとに空白を挟む（`spaced`）。
//
// 作れない分岐: 無い（`practices.list()` が返す `entries` が空でないのに読めない行の注記が付く場面も、`unreadable` の口で作った）。

const PRACTICE_LIST_BUDGET = 8_000;
const SIZED_ITEM_CHARS = 250;
/** 作りものの値（本物ではない）。題へ入れて、伏せられないことをいまのまま固定する */
const FAKE_VALUE = 'FAKE_NOT_A_REAL_VALUE_0123456789';

type Fail = 'plain' | 'unreadable' | null;

interface Hooks {
  /** `practices.list` が返す `unreadable` に足す行 */
  unreadable: UnreadablePractice[];
  /** `practices.list` を失敗させる */
  listFails: Fail;
}

const DEFAULT_HOOKS: Hooks = { unreadable: [], listFails: null };

type SeedOp =
  | { op: 'write'; slug: string; kind: string; title: string; content: string }
  | { op: 'remove'; slug: string };

interface Step {
  hooks?: Partial<Hooks>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedOp[];
  steps: Step[];
}

const SEED_ISO = '2026-10-01T00:00:00.000Z';
const CALL_ISO = '2026-10-29T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-practice-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PRACTICE_LIST_PIN === '1';

function seedTime(index: number): string {
  return new Date(Date.parse(SEED_ISO) + index * 3_600_000).toISOString();
}

function callTime(index: number): string {
  return new Date(Date.parse(CALL_ISO) + index * 60_000).toISOString();
}

// ---- 入力 ----

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

function write(slug: string, kind: string, title: string, content = 'abc'): SeedOp {
  return { op: 'write', slug, kind, title, content };
}

/** 題なしの1行（slug `p-001`・kind `x`・本文 `abc` = 4 文字）の字数。題の長さの引き算の元 */
const BASE_ITEM_CHARS = renderListingEntry({
  id: 'p-001',
  title: '[x] ',
  summary: '4 文字',
  createdAt: SEED_ISO,
  updatedAt: SEED_ISO,
}).length;

/** 1行がちょうど 250 字になる n 件（slug は p-001 から昇順） */
function sized(n: number, from = 1): SeedOp[] {
  return Array.from({ length: n }, (_, i) =>
    write(`p-${pad3(from + i)}`, 'x', spaced(SIZED_ITEM_CHARS - BASE_ITEM_CHARS)),
  );
}

const UNREADABLE_KNOWN: UnreadablePractice = { slug: 'broken-a', reason: '形が合わない' };
const UNREADABLE_KNOWN_B: UnreadablePractice = { slug: 'broken-b', reason: '別の壊れ方' };
const UNREADABLE_UNKNOWN: UnreadablePractice = { reason: 'slug も取れない' };

const FEW: SeedOp[] = [
  write('zeta', '調査', '最後の題'),
  write('alpha', '実装', '最初の題'),
  write('mid', 'レビュー', '日本語 😀 の題', '日本語😀の本文\n'),
  write('alpha', '実装', '最初の題（書き直し）', 'abcdef'),
  write('beta', '日報', '二番目', ''),
];

const SCENARIOS: Scenario[] = [
  {
    name: 'empty',
    covers:
      '空（読めない行も無い）: 「やり方はまだ1件も無い。これは正常な状態である」。何度呼んでも同じ。書き方の案内（practice_write）付き',
    seed: [],
    steps: [{}, {}],
  },
  {
    name: 'empty-unreadable',
    covers:
      '空で読めない行だけ在る: 「（読めたやり方は無い）」＋読めない行の注記（slug が分かる行は slug を並べ、分からない行は取れない旨）＋「やり方が無いとも、正常だとも言えない」。slug の分かる1件・2件・分からない1件・混ざり・多数',
    seed: [],
    steps: [
      { hooks: { unreadable: [UNREADABLE_KNOWN] } },
      { hooks: { unreadable: [UNREADABLE_KNOWN, UNREADABLE_KNOWN_B] } },
      { hooks: { unreadable: [UNREADABLE_UNKNOWN] } },
      { hooks: { unreadable: [UNREADABLE_KNOWN, UNREADABLE_UNKNOWN, UNREADABLE_KNOWN_B] } },
      {
        hooks: {
          unreadable: Array.from({ length: 12 }, (_, i) => ({
            slug: `broken-${pad3(i + 1)}`,
            reason: '壊れ',
          })),
        },
      },
    ],
  },
  {
    name: 'single',
    covers:
      '1件: 1行（`- slug [種類] 題` / 作成と更新 / 字数）だけ。省略も読めない行の注記も付かない。書き直していなければ作成と更新が同じ時刻',
    seed: [write('only', '調査', 'ひとつだけ', '# 手順\n1. 読む\n')],
    steps: [{}],
  },
  {
    name: 'few',
    covers:
      '数件: 書いた順（zeta・alpha・mid・alpha の書き直し・beta）にかかわらず slug の昇順（alpha・beta・mid・zeta）。種類は 調査・実装・レビュー・日報。alpha は書き直したので作成と更新が違う。多バイト文字と絵文字の題・字数はコードポイント。空の本文は 1 文字（改行）',
    seed: FEW,
    steps: [{}],
  },
  {
    name: 'forms',
    covers:
      '題・種類・本文の形: 空の題（`[x] ` のあとが空）・300 字の題・改行入りの題（一覧の行が割れる）・多バイトの種類・長い本文（字数）・NUL を含む本文（ストアが落とす）・同じ slug を何度も書き直す',
    seed: [
      write('empty-title', 'x', ''),
      write('long-title', 'x', spaced(300)),
      write('newline-title', 'x', '一行目\n二行目'),
      write('kind-multibyte', 'レビュー😀', '題'),
      write('long-body', 'x', '長い', `${'長い行。'.repeat(2_500)}\n`),
      write('nul', 'x', 'NUL', 'a\u0000b'),
      write('rewrite', 'x', '一回目'),
      write('rewrite', 'x', '二回目'),
      write('rewrite', 'y', '三回目'),
    ],
    steps: [{}],
  },
  {
    name: 'after-remove',
    covers: '消したやり方は一覧に出ない。消して書き直した slug は出る。全部消すと空の文',
    seed: [
      write('keep', 'x', '残る'),
      write('gone', 'x', '消える'),
      { op: 'remove', slug: 'gone' },
      write('again', 'x', '一回目'),
      { op: 'remove', slug: 'again' },
      write('again', 'y', '作り直し'),
    ],
    steps: [{}],
  },
  {
    name: 'after-remove-all',
    covers: '全部消した後は空の文（読めない行も無い）',
    seed: [
      write('a', 'x', 'A'),
      write('b', 'x', 'B'),
      { op: 'remove', slug: 'a' },
      { op: 'remove', slug: 'b' },
    ],
    steps: [{}],
  },
  // ---- 予算 ----
  {
    name: 'budget-exact',
    covers:
      '予算ちょうど: 1行 250 字を 32 件（合計 8,000 字）。省略の文は付かない。1行ぶん少ない 31 件も同じく全部',
    seed: sized(32),
    steps: [{}],
  },
  {
    name: 'budget-under',
    covers: '予算より 1 行少ない 31 件（7,750 字）: 省略は付かない',
    seed: sized(31),
    steps: [{}],
  },
  {
    name: 'budget-over-by-one',
    covers:
      '予算を 1 件超える（33 件）: slug の昇順で 32 件だけ出し、「…ほか 1 件は省略（全 33 件のうち slug の昇順に 32 件だけ出した）。この一覧に続きを取る口はまだ無い」が一覧の末尾に付く。落ちるのは slug の大きい側（p-033）',
    seed: sized(33),
    steps: [{}],
  },
  {
    name: 'budget-many',
    covers: '予算を大きく超える（50 件）: 32 件だけ出し、「ほか 18 件は省略（全 50 件…）」',
    seed: sized(50),
    steps: [{}],
  },
  {
    name: 'budget-first-too-long',
    covers:
      '1件目だけで予算を超える（題が 9,000 字）: 1件目は予算を超えても出る（excerpt で切る）。2件目以降は省略され「ほか N 件は省略」',
    seed: [
      write('a-long', 'x', spaced(9_000)),
      write('b-next', 'x', '次'),
      write('c-last', 'x', '最後'),
    ],
    steps: [{}],
  },
  // ---- 読めない行 ----
  {
    name: 'with-unreadable',
    covers:
      '一覧と読めない行が両方在る: 一覧のあとに空行を1つ挟んで読めない行の注記（slug が分かる行・分からない行）。一覧は読めない行を含まない',
    seed: FEW,
    steps: [
      { hooks: { unreadable: [UNREADABLE_KNOWN] } },
      { hooks: { unreadable: [UNREADABLE_UNKNOWN] } },
      { hooks: { unreadable: [UNREADABLE_KNOWN, UNREADABLE_UNKNOWN, UNREADABLE_KNOWN_B] } },
    ],
  },
  {
    name: 'budget-with-unreadable',
    covers:
      '予算で切れて、かつ読めない行が在る: 一覧の末尾の「ほか 1 件は省略」のあとに、空行を挟んで読めない行の注記。注記は予算の外に必ず出る（一覧が 8,000 字ちょうどでも注記は付く）',
    seed: sized(33),
    steps: [
      { hooks: { unreadable: [UNREADABLE_KNOWN, UNREADABLE_UNKNOWN] } },
      {
        hooks: {
          unreadable: Array.from({ length: 30 }, (_, i) => ({
            slug: `broken-${pad3(i + 1)}`,
            reason: '壊れ',
          })),
        },
      },
    ],
  },
  {
    name: 'budget-exact-with-unreadable',
    covers: '予算ちょうど（32 件）で読めない行が在る: 省略は付かず、注記だけが空行のあとに付く',
    seed: sized(32),
    steps: [{ hooks: { unreadable: [UNREADABLE_KNOWN] } }],
  },
  // ---- 失敗 ----
  {
    name: 'list-fails',
    covers:
      '`practices.list()` が投げる（いまの振る舞いのまま）: 道具は握らず投げ直す（例外で返る。isError ではなく thrown）。普通の Error も UnreadablePracticeError も同じ。そのあと口を外すと普通に読める',
    seed: [write('review', 'レビュー', '題')],
    steps: [{ hooks: { listFails: 'plain' } }, { hooks: { listFails: 'unreadable' } }, {}],
  },
  // ---- 秘密 ----
  {
    name: 'title-with-value',
    covers:
      '題に作りものの値が入る（いまの振る舞いのまま固定）: 道具は題を伏せずにそのまま出す。読めない行の reason に作りものの値が入っても、出すのは slug だけで reason は出ない',
    seed: [
      write('with-value', 'x', `export TOKEN=${FAKE_VALUE}`),
      write('with-id', 'x', `id=${FAKE_VALUE}`),
    ],
    steps: [
      {},
      { hooks: { unreadable: [{ slug: 'broken-a', reason: `形が合わない ${FAKE_VALUE}` }] } },
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
  /** 例外の名前（例外でなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args: Record<string, unknown>;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  /** やり方か日誌が呼ぶ前から変わったか。この道具は読むだけなので常に false */
  wrote: boolean;
  /** ストアの呼びの並び（道具の呼びだけ） */
  calls: PinnedCall[];
}

interface PinFile {
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** やり方の一覧・版の履歴の全文・日誌の全行を、そのまま JSON にしたもの。呼ぶ前後で比べる */
async function snapshot(stores: Stores): Promise<string> {
  const { entries } = await stores.practices.list();
  const practices: Record<string, unknown> = {};
  for (const entry of entries) {
    const versions = await stores.practices.listVersions(entry.slug);
    const bodies = [];
    for (const meta of versions) {
      bodies.push(await stores.practices.readVersion(entry.slug, meta.version));
    }
    practices[entry.slug] = { current: await stores.practices.read(entry.slug), versions: bodies };
  }
  return JSON.stringify({
    entries,
    practices,
    journal: await stores.journal.list({ order: 'asc' }),
  });
}

function failureOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return `threw ${name}: ${error instanceof Error ? error.message : String(error)}`;
}

/** 道具の呼びを `calls` へ記録し、口（hooks）で読めない行・失敗を起こす。list 以外の口を呼ぶと、そのまま記録に残る */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  const practices: Stores['practices'] = {
    ...base.practices,
    read: async (slug) => {
      calls.push({ op: 'practices.read', args: { slug }, outcome: 'called' });
      return base.practices.read(slug);
    },
    readVersion: async (slug, version) => {
      calls.push({ op: 'practices.readVersion', args: { slug, version }, outcome: 'called' });
      return base.practices.readVersion(slug, version);
    },
    listVersions: async (slug) => {
      calls.push({ op: 'practices.listVersions', args: { slug }, outcome: 'called' });
      return base.practices.listVersions(slug);
    },
    write: async (input, options) => {
      calls.push({
        op: 'practices.write',
        args: { input: plain(input), options: options === undefined ? '(なし)' : plain(options) },
        outcome: 'called',
      });
      return base.practices.write(input, options);
    },
    remove: async (slug, options) => {
      calls.push({
        op: 'practices.remove',
        args: { slug, options: options === undefined ? '(なし)' : plain(options) },
        outcome: 'called',
      });
      return base.practices.remove(slug, options);
    },
    clear: async () => {
      calls.push({ op: 'practices.clear', args: {}, outcome: 'called' });
      return base.practices.clear();
    },
    list: async () => {
      const now = hooks();
      try {
        if (now.listFails === 'unreadable') {
          throw new UnreadablePracticeError('やり方の一覧が読めない（テスト用）', { slug: 'x' });
        }
        if (now.listFails === 'plain') throw new Error('ストアが落ちた（list）');
        const found = await base.practices.list();
        const returned = { ...found, unreadable: [...found.unreadable, ...now.unreadable] };
        calls.push({
          op: 'practices.list',
          args: {},
          outcome: `${String(returned.entries.length)} entries / ${String(returned.unreadable.length)} unreadable`,
        });
        return returned;
      } catch (error) {
        calls.push({ op: 'practices.list', args: {}, outcome: failureOf(error) });
        throw error;
      }
    },
  };
  return {
    ...base,
    practices,
    journal: {
      ...base.journal,
      append: async (entry) => {
        calls.push({ op: 'journal.append', args: plain(entry), outcome: 'called' });
        return base.journal.append(entry);
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  for (const [index, entry] of scenario.seed.entries()) {
    vi.setSystemTime(new Date(seedTime(index)));
    if (entry.op === 'write') {
      await base.practices.write({
        slug: entry.slug,
        kind: entry.kind,
        title: entry.title,
        content: entry.content,
      });
    } else {
      await base.practices.remove(entry.slug);
    }
  }
  vi.setSystemTime(new Date(SEED_ISO));
  await base.journal.append({ type: 'decision', decision: '仕込みの日誌', grounds: '仕込み' });
  let hooks: Hooks = { ...DEFAULT_HOOKS };
  const calls: PinnedCall[] = [];
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'practice_list');
  if (!found) throw new Error('practice_list が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base);
    hooks = { ...DEFAULT_HOOKS, ...step.hooks };
    calls.length = 0;
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler({} as never, {});
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
        errorName: error instanceof Error ? error.name : typeof error,
      };
    }
    hooks = { ...DEFAULT_HOOKS };
    const after = await snapshot(base);
    results.push({ output, wrote: before !== after, calls: plain(calls) });
    // 読むだけ: やり方も日誌も、呼ぶ前と1文字も変わらない
    expect(
      after === before,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、やり方か日誌が呼ぶ前から変わった`,
    ).toBe(true);
    // 道具が呼ぶのは list だけ（read・listVersions・書き込み口・日誌を呼ばない）
    for (const call of calls) {
      expect(
        ['practices.list'],
        `場面 ${stepKey(scenario, index)} が ${call.op} を呼んだ`,
      ).toContain(call.op);
    }
    expect(
      calls.filter((call) => call.op === 'practices.list').length,
      `場面 ${stepKey(scenario, index)}: list は 1 回だけ呼ぶ`,
    ).toBe(1);
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

describe('practice_list の出力と呼びの並びの固定（場面ごとの出力の全文・ストアの呼び・読むだけであること）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(CALL_ISO));
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

  it('どの場面も読むだけ（やり方・版の履歴・日誌が呼ぶ前と同じ）で、固定値もそう記録している', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 読むだけの道具が書き込みを起こした`).toBe(false);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が false でない`).toBe(false);
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

      it(`${key} の呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び（結果・失敗）が固定値からずれた`).toEqual(
          want?.calls,
        );
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に本物らしい値と絶対パスが無い。作りものの値は、伏せない振る舞いのとおり題の場面にだけ在る', () => {
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toContain('/tmp/');
    for (const key of ALL_KEYS) {
      if (key.startsWith('title-with-value')) continue;
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
    const itemCount = (key: string): number =>
      text(key).split('\n- ').length - (text(key).startsWith('- ') ? 0 : 1);
    const EMPTY =
      'やり方はまだ1件も無い。**これは正常な状態である**——やり方が書かれていない仕事も普通に進む。書くなら practice_write slug=<slug> kind=<種類> title=<題> content=<本文>。';
    const UNREADABLE_TAIL = '壊れた行であって、消されたやり方ではない。この一覧には載っていない。';

    // 空
    expect(text('empty#1')).toBe(EMPTY);
    expect(text('empty#2')).toBe(EMPTY);
    for (let i = 1; i <= 5; i += 1) {
      const key = `empty-unreadable#${String(i)}`;
      expect(text(key), key).toMatch(/^（読めたやり方は無い）読めないやり方が \d+ 件ある/u);
      expect(text(key), key).toContain(UNREADABLE_TAIL);
      expect(text(key), key).toContain('**やり方が無いとも、正常だとも言えない。**');
      expect(text(key), key).not.toContain('これは正常な状態である');
    }
    expect(text('empty-unreadable#1')).toContain('読めないやり方が 1 件ある（slug: broken-a）');
    expect(text('empty-unreadable#3')).not.toContain('slug: ');
    expect(text('after-remove-all')).toBe(EMPTY);

    // 1件・数件
    expect(text('single').startsWith('- only [調査] ひとつだけ\n')).toBe(true);
    expect(itemCount('single')).toBe(1);
    expect(text('single')).not.toContain('省略');
    const few = text('few');
    expect(itemCount('few')).toBe(4);
    expect(few.indexOf('- alpha ')).toBeLessThan(few.indexOf('- beta '));
    expect(few.indexOf('- beta ')).toBeLessThan(few.indexOf('- mid '));
    expect(few.indexOf('- mid ')).toBeLessThan(few.indexOf('- zeta '));
    expect(few).toContain('[実装] 最初の題（書き直し）');
    expect(few).toContain('[レビュー] 日本語 😀 の題');
    expect(few).toContain('1 文字');
    expect(few).not.toContain('省略');
    expect(text('after-remove')).toContain('- again [y] 作り直し');
    expect(text('after-remove')).not.toContain('gone');

    // 予算
    expect(itemCount('budget-exact')).toBe(32);
    expect(text('budget-exact')).not.toContain('省略');
    expect(text('budget-exact').length).toBe(PRACTICE_LIST_BUDGET + 31);
    expect(itemCount('budget-under')).toBe(31);
    expect(text('budget-under')).not.toContain('省略');
    expect(itemCount('budget-over-by-one')).toBe(32);
    expect(text('budget-over-by-one')).toContain(
      '…ほか 1 件は省略（全 33 件のうち slug の昇順に 32 件だけ出した）。この一覧に続きを取る口はまだ無い——個別に読むには practice_read slug=<slug> を使うこと。',
    );
    expect(text('budget-over-by-one')).not.toContain('- p-033 ');
    expect(text('budget-over-by-one').endsWith('slug=<slug> を使うこと。')).toBe(true);
    expect(text('budget-many')).toContain(
      '…ほか 18 件は省略（全 50 件のうち slug の昇順に 32 件だけ出した）',
    );
    expect(text('budget-first-too-long')).toContain(
      '…ほか 2 件は省略（全 3 件のうち slug の昇順に 1 件だけ出した）',
    );
    expect(text('budget-first-too-long')).toContain('- a-long ');

    // 読めない行
    for (const key of ['with-unreadable#1', 'with-unreadable#2', 'with-unreadable#3']) {
      expect(text(key), key).toContain(`\n\n読めないやり方が `);
      expect(text(key), key).toContain(UNREADABLE_TAIL);
      expect(text(key).endsWith(UNREADABLE_TAIL), key).toBe(true);
      expect(itemCount(key), key).toBe(4);
    }
    expect(text('with-unreadable#1')).toContain('（slug: broken-a）');
    expect(text('with-unreadable#2')).not.toContain('slug: ');
    // 予算で切れて読めない行が在る: 注記は省略の文のあと・予算の外
    for (const key of ['budget-with-unreadable#1', 'budget-with-unreadable#2']) {
      expect(text(key), key).toContain(
        '…ほか 1 件は省略（全 33 件のうち slug の昇順に 32 件だけ出した）',
      );
      expect(text(key), key).toContain('\n\n読めないやり方が ');
      expect(text(key).endsWith(UNREADABLE_TAIL), key).toBe(true);
      expect(text(key).indexOf('…ほか 1 件は省略'), key).toBeLessThan(
        text(key).indexOf('読めないやり方が'),
      );
    }
    expect(text('budget-with-unreadable#1').length).toBeGreaterThan(PRACTICE_LIST_BUDGET);
    expect(text('budget-exact-with-unreadable')).not.toContain('省略');
    expect(text('budget-exact-with-unreadable')).toContain('\n\n読めないやり方が 1 件ある');
    expect(itemCount('budget-exact-with-unreadable')).toBe(32);

    // 失敗
    expect(step('list-fails#1').output).toMatchObject({
      thrown: true,
      isError: true,
      errorName: 'Error',
      text: 'ストアが落ちた（list）',
    });
    expect(step('list-fails#2').output).toMatchObject({
      thrown: true,
      errorName: 'UnreadablePracticeError',
    });
    expect(step('list-fails#3').output.thrown).toBe(false);
    expect(step('list-fails#1').calls).toEqual([
      { op: 'practices.list', args: {}, outcome: 'threw Error: ストアが落ちた（list）' },
    ]);

    // 秘密らしい値: 題はそのまま出る・reason は出ない
    expect(text('title-with-value#1')).toContain(`export TOKEN=${FAKE_VALUE}`);
    expect(text('title-with-value#1')).toContain(`id=${FAKE_VALUE}`);
    expect(text('title-with-value#2')).toContain('（slug: broken-a）');
    expect(text('title-with-value#2')).not.toContain('形が合わない');
    expect(
      text('title-with-value#2').split(FAKE_VALUE).length - 1,
      '作りものの値は題の 2 件ぶんだけ（reason の分は出ない）',
    ).toBe(2);
  });
});
