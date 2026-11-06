import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderListingEntry } from './excerpt.js';
import { UnreadablePracticeError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `practice_history` の出力（全文と字数）と、ストアの呼びの並び（`practices.listVersions` に渡した slug と返した版の数）を、場面ごとにコミットした固定値
// （clone-tools-practice-history-output-pin.json）と丸ごと比べる。
// `clone-tools-practice.ts` の `tool('practice_history', …)`（slug の形の検査 → `practices.listVersions(slug)` → 版が 0 なら「無い」→ 版の一覧
// （予算で切れたら「ほか N 件は省略」））を小さな関数へ分けるとき、振る舞いが1文字も変わらないことを機械で確かめる歯。
// 固定値の側で値を伏せず、入力（時計・やり方・版）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - calls: ストアの呼びの並び（`practices.listVersions` の引数 slug と、返した版の数。投げたら投げた文言）。道具が呼ぶのは listVersions だけで、
//     list・read・readVersion・write・remove・clear・日誌の書き込みを呼べば記録に出る（下で別に確かめる）。slug の形で断った呼びは何も呼ばない（空）
//   - wrote: やり方（一覧・各版の全文）か日誌が、呼ぶ前から変わったか。この道具は読むだけなので、どの場面も false
//
// 固定値の作り直し（意図して出力・呼びを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PRACTICE_HISTORY_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-practice-history-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-practice-history-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。やり方の仕込みは 1 手ごとに SEED_ISO から 1 時間ずつ進めて書く（版の `at` が互いに違う）。
// 呼びは CALL_ISO から 1 分ずつ進めて呼ぶ。日誌は場面の頭に1行入れて、呼ぶ前後で変わらないことを確かめる。
//
// 作り方の注記:
//   - 版: 1 回の `practices.write` が 1 版（書き直すたびに増える）。`remove` しても版は消えず、同じ slug を作り直すと版番号は続きから振られる
//   - 予算の境目: 予算（PRACTICE_LIST_BUDGET = 8,000 字）は一覧の行の字数の合計で測る。行の字数をそろえた版（`sized`。1行 250 字）を 32 版並べると
//     合計がちょうど 8,000 字になる（ちょうど）。33 版目から省略が出る。行は `版<番号>` から始まり、番号の桁（1〜9 と 10〜）で行頭が 1 字違うので、
//     題の長さは版ごとに本物の `renderListingEntry` で測って合わせる。予算の値はこの試験の側に持つ（道具の定数を import しない）
//   - 長い文字列を作る `spaced(len)` は、語（既定は 9 字の `abcdefghi`）と空白の繰り返しで、空白は語の長さ＋1 字ごと（この試験は既定の語だけを使うので 10 字ごと）
//
// 秘密: 値は作りものだけ（題は `題 <slug>` ほかの作りもの）。固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない
// （`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。長い題は `spaced` で空白を挟む。slug の上限（128 字）の場面だけは slug 自体が連続になる（上限の確かめに必要）。

const PRACTICE_LIST_BUDGET = 8_000;
const SIZED_ITEM_CHARS = 250;
const SLUG_MAX = 128;

type Fail = 'plain' | 'unreadable' | null;

interface Hooks {
  /** `practices.listVersions` を失敗させる */
  listVersionsFails: Fail;
}

const DEFAULT_HOOKS: Hooks = { listVersionsFails: null };

type SeedOp =
  | { op: 'write'; slug: string; kind: string; title: string; content: string }
  | { op: 'remove'; slug: string };

interface Step {
  /** 呼ぶ slug */
  slug: string;
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
const PIN_URL = new URL('./clone-tools-practice-history-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PRACTICE_HISTORY_PIN === '1';

function seedTime(index: number): string {
  return new Date(Date.parse(SEED_ISO) + index * 3_600_000).toISOString();
}

function callTime(index: number): string {
  return new Date(Date.parse(CALL_ISO) + index * 60_000).toISOString();
}

// ---- 入力 ----

/** 長さ len の、語（既定は 9 字の `abcdefghi`）と空白の繰り返し。空白は語の長さ＋1 字ごと（既定で 10 字ごと）。末尾は空白にしない */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function write(slug: string, kind: string, title: string, content = 'abc'): SeedOp {
  return { op: 'write', slug, kind, title, content };
}

function s(slug: string, hooks?: Partial<Hooks>): Step {
  return { slug, ...(hooks === undefined ? {} : { hooks }) };
}

/** 版 v（1 から）の題なしの1行（種類 `x`・本文 `abc` = 4 文字）の字数。題の長さの引き算の元。`at` は仕込みの n 手目の時刻 */
function baseItemChars(version: number): number {
  return renderListingEntry({
    id: `版${String(version)}`,
    title: '[x] ',
    summary: '4 文字',
    createdAt: seedTime(version - 1),
  }).length;
}

/** 1行がちょうど 250 字になる n 版（同じ slug に n 回書く） */
function sized(n: number, slug = 'hist'): SeedOp[] {
  return Array.from({ length: n }, (_, i) =>
    write(slug, 'x', spaced(SIZED_ITEM_CHARS - baseItemChars(i + 1))),
  );
}

const LONG_SLUG = `a${'b'.repeat(SLUG_MAX - 1)}`;

const SCENARIOS: Scenario[] = [
  {
    name: 'slug-refused',
    covers:
      'slug の形の断り（practiceSlugSchema）: 空・大文字・空白入り・日本語・全角・絵文字・`/` 入り・先頭が - . _・末尾の空白・改行・129 字。「やり方のスラッグが不正: <slug>（英小文字・数字・. _ - のみ）。」で、slug はそのまま出る。ストアは呼ばない（calls が空）。isError ではない',
    seed: [write('real', 'x', '題')],
    steps: [
      s(''),
      s('Upper'),
      s('a b'),
      s('日本語'),
      s('ａｂｃ'),
      s('a😀'),
      s('a/b'),
      s('-lead'),
      s('.lead'),
      s('_lead'),
      s('trail '),
      s('a\n'),
      s(`${LONG_SLUG}b`),
    ],
  },
  {
    name: 'slug-accepted-forms',
    covers:
      'slug の形が通る境目: 1 字・数字始まり・. _ - を含む・128 字ちょうど。どれも版が在れば出る（1 版）。slug は一覧の行ではなく省略の文にだけ出る（版の行は `版1`）',
    seed: [
      write('a', 'x', '題 a'),
      write('0lead', 'x', '題 0lead'),
      write('a.b_c-d', 'x', '題 a.b_c-d'),
      write(LONG_SLUG, 'x', '題 long'),
    ],
    steps: [s('a'), s('0lead'), s('a.b_c-d'), s(LONG_SLUG)],
  },
  {
    name: 'no-versions',
    covers:
      '版が無い（一度も書かれていない）: 「やり方 X の版は無い。practice_write で一度も書かれていない（または slug を打ち間違えている）可能性がある。」。ほかの slug に版が在っても、大文字小文字ではなく別の slug は無い扱い。やり方が1件も無い場面でも同じ',
    seed: [write('other', 'x', '別のやり方')],
    steps: [s('never'), s('othe'), s('other-2'), s('a.b')],
  },
  {
    name: 'no-versions-empty-store',
    covers: 'やり方が1件も無い（版も無い）ストアでも、形の合う slug は「版は無い」',
    seed: [],
    steps: [s('anything')],
  },
  {
    name: 'single',
    covers:
      '1 版: `- 版1 [種類] 題` / 作成（版の書かれた時刻）/ 字数 の3行だけ。更新の欄は出ない（版は追記専用）。省略の文は付かない',
    seed: [write('only', '調査', 'ひとつだけ', '# 手順\n1. 読む\n')],
    steps: [s('only')],
  },
  {
    name: 'few',
    covers:
      '数版: 書き直すたびに版が増え、版番号の昇順に並ぶ。書き直しで種類・題が変わる（実装→レビュー→日報）。多バイト文字・絵文字の題と種類・字数はコードポイント。空の本文は 1 文字（改行）。ほかの slug の版は混ざらない。作成の時刻は版ごとに違う',
    seed: [
      write('alpha', '実装', '最初の題', 'abc'),
      write('other', '調査', '別のやり方', 'zzz'),
      write('alpha', '実装', '最初の題（書き直し）', 'abcdef'),
      write('alpha', 'レビュー', '日本語 😀 の題', '日本語😀の本文\n'),
      write('alpha', '日報😀', '', ''),
      write('alpha', 'x', spaced(300)),
      write('alpha', 'x', '一行目\n二行目'),
    ],
    steps: [s('alpha'), s('other')],
  },
  {
    name: 'versions-ten-plus',
    covers:
      '版番号が 10 を超える（`版10`・`版11` と桁が増えても昇順。1 桁と 2 桁が混ざる並びは番号順で、文字列順ではない）',
    seed: Array.from({ length: 12 }, (_, i) => write('many', 'x', `題 ${String(i + 1)}`)),
    steps: [s('many')],
  },
  {
    name: 'after-remove',
    covers:
      'remove の後: 版は消えない（消した slug の履歴も読める）。消した後に同じ slug で作り直すと、版番号は消える前の続きから振られる（版3 が作り直し）。作り直す前の版（版1・版2）も一覧に残る。remove だけして作り直さない slug も履歴が出る。別の slug の remove は影響しない',
    seed: [
      write('again', 'x', '一回目'),
      write('again', 'x', '二回目'),
      { op: 'remove', slug: 'again' },
      write('again', 'y', '作り直し'),
      write('gone', 'x', '消える'),
      write('gone', 'x', '消える（書き直し）'),
      { op: 'remove', slug: 'gone' },
    ],
    steps: [s('again'), s('gone')],
  },
  {
    name: 'after-remove-twice',
    covers: '2 回消して 2 回作り直す: 版番号は 1 → 2 → 3 → 4 と続く（消えるたびに戻らない）',
    seed: [
      write('cycle', 'x', '一回目'),
      { op: 'remove', slug: 'cycle' },
      write('cycle', 'x', '二回目'),
      { op: 'remove', slug: 'cycle' },
      write('cycle', 'x', '三回目'),
      write('cycle', 'x', '四回目'),
    ],
    steps: [s('cycle')],
  },
  // ---- 予算 ----
  {
    name: 'budget-exact',
    covers: '予算ちょうど: 1行 250 字を 32 版（合計 8,000 字）。省略の文は付かない',
    seed: sized(32),
    steps: [s('hist')],
  },
  {
    name: 'budget-under',
    covers: '予算より 1 行少ない 31 版（7,750 字）: 省略は付かない',
    seed: sized(31),
    steps: [s('hist')],
  },
  {
    name: 'budget-over-by-one',
    covers:
      '予算を 1 版超える（33 版）: 版番号の昇順で 32 版だけ出し、「…ほか 1 件は省略（全 33 件のうち版番号の昇順に 32 件だけ出した）。個別に読むには practice_read slug=hist version=<版番号> を使うこと。」が末尾に付く。落ちるのは版番号の大きい側（版33）',
    seed: sized(33),
    steps: [s('hist')],
  },
  {
    name: 'budget-many',
    covers:
      '予算を大きく超える（50 版）: 32 版だけ出し、「ほか 18 件は省略（全 50 件…）」。slug は案内の文へそのまま入る',
    seed: sized(50),
    steps: [s('hist')],
  },
  {
    name: 'budget-slug-in-omitted',
    covers:
      '予算で切れる slug が長い（128 字）: 省略の文の案内に slug がそのまま入る（切り詰めない）',
    seed: sized(33, LONG_SLUG),
    steps: [s(LONG_SLUG)],
  },
  {
    name: 'budget-first-too-long',
    covers:
      '1 版目だけで予算を超える（題が 9,000 字）: 1 版目は予算を超えても出る（excerpt で切る）。2 版目以降は省略され「ほか N 件は省略」',
    seed: [write('big', 'x', spaced(9_000)), write('big', 'x', '次'), write('big', 'x', '最後')],
    steps: [s('big')],
  },
  // ---- 失敗 ----
  {
    name: 'list-versions-fails',
    covers:
      '`practices.listVersions()` が投げる（いまの振る舞いのまま）: 道具は握らず投げ直す（例外で返る。isError ではなく thrown）。普通の Error も UnreadablePracticeError も同じ。slug の形で断る呼びは listVersions まで届かず、断りの文を返す（例外にならない）。そのあと口を外すと普通に読める',
    seed: [write('review', 'レビュー', '題')],
    steps: [
      s('review', { listVersionsFails: 'plain' }),
      s('review', { listVersionsFails: 'unreadable' }),
      s('Bad Slug', { listVersionsFails: 'plain' }),
      s('review'),
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

/** やり方の一覧・各版の全文・日誌の全行を、そのまま JSON にしたもの。呼ぶ前後で比べる */
async function snapshot(stores: Stores, slugs: readonly string[]): Promise<string> {
  const { entries } = await stores.practices.list();
  const practices: Record<string, unknown> = {};
  for (const slug of new Set([...entries.map((entry) => entry.slug), ...slugs])) {
    const versions = await stores.practices.listVersions(slug);
    const bodies = [];
    for (const meta of versions) {
      bodies.push(await stores.practices.readVersion(slug, meta.version));
    }
    practices[slug] = { current: await stores.practices.read(slug), versions: bodies };
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

/** 道具の呼びを `calls` へ記録し、口（hooks）で失敗を起こす。listVersions 以外の口を呼ぶと、そのまま記録に残る */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  const practices: Stores['practices'] = {
    ...base.practices,
    list: async () => {
      calls.push({ op: 'practices.list', args: {}, outcome: 'called' });
      return base.practices.list();
    },
    read: async (slug) => {
      calls.push({ op: 'practices.read', args: { slug }, outcome: 'called' });
      return base.practices.read(slug);
    },
    readVersion: async (slug, version) => {
      calls.push({ op: 'practices.readVersion', args: { slug, version }, outcome: 'called' });
      return base.practices.readVersion(slug, version);
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
    listVersions: async (slug) => {
      const now = hooks();
      try {
        if (now.listVersionsFails === 'unreadable') {
          throw new UnreadablePracticeError('版の一覧が読めない（テスト用）', { slug });
        }
        if (now.listVersionsFails === 'plain') throw new Error('ストアが落ちた（listVersions）');
        const found = await base.practices.listVersions(slug);
        calls.push({
          op: 'practices.listVersions',
          args: { slug },
          outcome: `${String(found.length)} versions`,
        });
        return found;
      } catch (error) {
        calls.push({ op: 'practices.listVersions', args: { slug }, outcome: failureOf(error) });
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
  const found = tools.find((entry) => entry.name === 'practice_history');
  if (!found) throw new Error('practice_history が無い');
  // 形の合わない slug は ストアの読みに渡さず、仕込みで触れた slug と呼ぶ slug だけを前後で比べる
  const watched = [
    ...new Set([
      ...scenario.seed.map((entry) => entry.slug),
      ...scenario.steps
        .map((step) => step.slug)
        .filter((slug) => /^[a-z0-9][a-z0-9._-]*$/.test(slug)),
    ]),
  ];

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base, watched);
    hooks = { ...DEFAULT_HOOKS, ...step.hooks };
    calls.length = 0;
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler({ slug: step.slug } as never, {});
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
    const toolCalls = plain(calls);
    const after = await snapshot(base, watched);
    results.push({ output, wrote: before !== after, calls: toolCalls });
    // 読むだけ: やり方も版も日誌も、呼ぶ前と1文字も変わらない
    expect(
      after === before,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、やり方・版か日誌が呼ぶ前から変わった`,
    ).toBe(true);
    // 道具が呼ぶのは listVersions だけ（list・read・readVersion・書き込み口・日誌を呼ばない）。呼ぶなら 1 回
    for (const call of toolCalls) {
      expect(
        ['practices.listVersions'],
        `場面 ${stepKey(scenario, index)} が ${call.op} を呼んだ`,
      ).toContain(call.op);
    }
    expect(
      toolCalls.filter((call) => call.op === 'practices.listVersions').length,
      `場面 ${stepKey(scenario, index)}: listVersions は 0 回（形の断り）か 1 回`,
    ).toBeLessThanOrEqual(1);
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

describe('practice_history の出力と呼びの並びの固定（場面ごとの出力の全文・ストアの呼び・読むだけであること）', () => {
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

      it(`${key} の呼びの並び（listVersions の引数と返した版の数）が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び（引数・結果・失敗）が固定値からずれた`).toEqual(
          want?.calls,
        );
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値だけ（json に鍵らしい形と絶対パスが無い）', () => {
    expect(pinnedRaw).not.toMatch(/(^|[^A-Za-z])sk-|ghp_|github_pat_|AKIA|xox[abp]-/);
    expect(pinnedRaw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|Bearer /);
    expect(pinnedRaw).not.toContain('/tmp/');
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const outcomes = (key: string): string[] => step(key).calls.map((entry) => entry.outcome);
    const itemIds = (key: string): string[] =>
      text(key)
        .split('\n')
        .filter((line) => line.startsWith('- 版'))
        .map((line) => line.slice(2).split(' ')[0] ?? '');
    const INVALID = (slug: string): string =>
      `やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`;
    const NONE = (slug: string): string =>
      `やり方 ${slug} の版は無い。practice_write で一度も書かれていない（または slug を打ち間違えている）可能性がある。`;
    const OMITTED = (rest: number, total: number, shown: number, slug: string): string =>
      `…ほか ${String(rest)} 件は省略（全 ${String(total)} 件のうち版番号の昇順に ${String(shown)} 件だけ出した）。個別に読むには practice_read slug=${slug} version=<版番号> を使うこと。`;

    // slug の断り
    const refused = [
      '',
      'Upper',
      'a b',
      '日本語',
      'ａｂｃ',
      'a😀',
      'a/b',
      '-lead',
      '.lead',
      '_lead',
      'trail ',
      'a\n',
      `${LONG_SLUG}b`,
    ];
    for (const [index, slug] of refused.entries()) {
      const key = `slug-refused#${String(index + 1)}`;
      expect(text(key), key).toBe(INVALID(slug));
      expect(ops(key), key).toEqual([]);
      expect(step(key).output.isError, key).toBe(false);
    }
    expect(`${LONG_SLUG}b`).toHaveLength(SLUG_MAX + 1);

    // 通る形
    for (const [index, slug] of ['a', '0lead', 'a.b_c-d', LONG_SLUG].entries()) {
      const key = `slug-accepted-forms#${String(index + 1)}`;
      expect(itemIds(key), key).toEqual(['版1']);
      expect(step(key).calls, key).toEqual([
        { op: 'practices.listVersions', args: { slug }, outcome: '1 versions' },
      ]);
    }
    expect(LONG_SLUG).toHaveLength(SLUG_MAX);

    // 版が無い
    expect(text('no-versions#1')).toBe(NONE('never'));
    expect(text('no-versions#2')).toBe(NONE('othe'));
    expect(text('no-versions#3')).toBe(NONE('other-2'));
    expect(text('no-versions#4')).toBe(NONE('a.b'));
    for (let n = 1; n <= 4; n += 1)
      expect(outcomes(`no-versions#${String(n)}`)).toEqual(['0 versions']);
    expect(text('no-versions-empty-store')).toBe(NONE('anything'));

    // 1 版・数版
    expect(text('single').startsWith('- 版1 [調査] ひとつだけ\n  作成: ')).toBe(true);
    expect(text('single')).not.toContain('更新');
    expect(text('single')).not.toContain('省略');
    expect(itemIds('single')).toEqual(['版1']);
    expect(itemIds('few#1')).toEqual(['版1', '版2', '版3', '版4', '版5', '版6']);
    expect(text('few#1')).toContain('[実装] 最初の題\n');
    expect(text('few#1')).toContain('[実装] 最初の題（書き直し）');
    expect(text('few#1')).toContain('[レビュー] 日本語 😀 の題');
    expect(text('few#1')).toContain('[日報😀] ');
    expect(text('few#1')).toContain('  1 文字');
    expect(text('few#1')).not.toContain('省略');
    expect(itemIds('few#2')).toEqual(['版1']);
    expect(text('few#2')).not.toContain('最初の題');
    expect(itemIds('versions-ten-plus')).toEqual(
      Array.from({ length: 12 }, (_, i) => `版${String(i + 1)}`),
    );

    // remove の後
    expect(itemIds('after-remove#1')).toEqual(['版1', '版2', '版3']);
    expect(text('after-remove#1')).toContain('- 版3 [y] 作り直し');
    expect(itemIds('after-remove#2')).toEqual(['版1', '版2']);
    expect(text('after-remove#2')).toContain('消える（書き直し）');
    expect(itemIds('after-remove-twice')).toEqual(['版1', '版2', '版3', '版4']);

    // 予算
    expect(itemIds('budget-exact')).toHaveLength(32);
    expect(text('budget-exact')).not.toContain('省略');
    expect(text('budget-exact').length).toBe(PRACTICE_LIST_BUDGET + 31);
    expect(itemIds('budget-under')).toHaveLength(31);
    expect(text('budget-under')).not.toContain('省略');
    expect(itemIds('budget-over-by-one')).toHaveLength(32);
    expect(itemIds('budget-over-by-one')[31]).toBe('版32');
    expect(text('budget-over-by-one')).toContain(OMITTED(1, 33, 32, 'hist'));
    expect(text('budget-over-by-one').endsWith(OMITTED(1, 33, 32, 'hist'))).toBe(true);
    expect(text('budget-over-by-one')).not.toContain('- 版33 ');
    expect(text('budget-many')).toContain(OMITTED(18, 50, 32, 'hist'));
    expect(text('budget-slug-in-omitted')).toContain(OMITTED(1, 33, 32, LONG_SLUG));
    expect(text('budget-first-too-long')).toContain(OMITTED(2, 3, 1, 'big'));
    expect(itemIds('budget-first-too-long')).toEqual(['版1']);

    // 失敗
    expect(step('list-versions-fails#1').output).toMatchObject({
      thrown: true,
      isError: true,
      errorName: 'Error',
      text: 'ストアが落ちた（listVersions）',
    });
    expect(step('list-versions-fails#2').output).toMatchObject({
      thrown: true,
      errorName: 'UnreadablePracticeError',
    });
    expect(step('list-versions-fails#3').output.thrown).toBe(false);
    expect(text('list-versions-fails#3')).toBe(INVALID('Bad Slug'));
    expect(ops('list-versions-fails#3')).toEqual([]);
    expect(step('list-versions-fails#4').output.thrown).toBe(false);
    expect(step('list-versions-fails#1').calls).toEqual([
      {
        op: 'practices.listVersions',
        args: { slug: 'review' },
        outcome: 'threw Error: ストアが落ちた（listVersions）',
      },
    ]);
  });
});
