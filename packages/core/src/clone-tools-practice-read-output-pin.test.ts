import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { UnreadablePracticeError, practiceVersion, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `practice_read` の出力と、ストアの呼びの並びを、場面ごとにコミットした固定値（clone-tools-practice-read-output-pin.json）と
// 丸ごと比べる。`clone-tools-practice.ts` の `tool('practice_read', …)`（約 61 行の式・入れ子 5 段）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・時刻・本文）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - calls: ストアの呼びの並び（practices.read・practices.readVersion。渡した slug と版、結果）。
//     道具が呼ぶのは read と readVersion だけで、list・write・remove・journal.append などを呼べばここに出る（下で別に確かめる）
//   - wrote: やり方（現在の行と版の履歴の全文）か日誌が、呼ぶ前から変わったか。この道具は読むだけなので、どの場面も false
//
// 固定値の作り直し（意図して出力・呼びを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PRACTICE_READ_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-practice-read-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-practice-read-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// やり方の仕込みは 1 手ごとに SEED_ISO から 1 時間ずつ進めて書く（作成・更新・各版の時刻が互いに違う）。
// 呼びは CALL_ISO から 1 分ずつ進めて呼ぶ。日誌は場面の頭に1行入れて、呼ぶ前後で変わらないことを確かめる。
//
// 作り方の注記:
//   - 読めない行: インメモリのストアは行を読めない形で持てないので、`read` / `readVersion` が
//     `UnreadablePracticeError` を投げる口（hooks.readFails / versionFails）で作る
//   - 本文の形: ストアは書くとき NUL を落とし末尾の改行を足す。そのため「末尾の改行なし」「NUL を含む」本文は
//     書き込みでは作れず、口（hooks.content）が返す行の本文を差し替えて作る（道具から見ると、ストアがそう返した場合）。
//     書き込み経由の NUL（落ちる）・空（`\n` になる）も別の場面で固定する
//   - 入力は SDK のスキーマを通さずハンドラを直に呼ぶ。`null`・文字列・NaN の version は、MCP 経由では
//     スキーマが先に弾くので道具へ届かないが、ハンドラに届けばこの文言になる、という固定（version-invalid）
//
// 作れない分岐: 無い。`UnreadablePracticeError` かどうかの判定は instanceof なので、名前だけ同じ別の例外は投げ直される（lookalike）。

type Fail = 'unreadable' | 'lookalike' | 'plain' | null;

interface Hooks {
  /** `practices.read` を失敗させる */
  readFails: Fail;
  /** `practices.readVersion` を失敗させる */
  versionFails: Fail;
  /** 返す行（read・readVersion どちらも）の本文を差し替える */
  content: string | null;
}

const DEFAULT_HOOKS: Hooks = { readFails: null, versionFails: null, content: null };

type SeedOp =
  | { op: 'write'; slug: string; kind: string; title: string; content: string }
  | { op: 'remove'; slug: string };

interface Step {
  slug: string;
  /** SDK のスキーマを通さずそのまま渡す（number 以外はハンドラ直呼びの場合の入力） */
  version?: unknown;
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
const PIN_URL = new URL('./clone-tools-practice-read-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PRACTICE_READ_PIN === '1';

function seedTime(index: number): string {
  return new Date(Date.parse(SEED_ISO) + index * 3_600_000).toISOString();
}

function callTime(index: number): string {
  return new Date(Date.parse(CALL_ISO) + index * 60_000).toISOString();
}

// ---- 入力 ----

const BODY = '# 手順\n1. 読む\n2. 数 42 と `id-7` を確かめる\n';

function write(slug: string, kind: string, title: string, content: string): SeedOp {
  return { op: 'write', slug, kind, title, content };
}

/** 本文・題・kind の形ごとのやり方（書き込みで作れるもの） */
const FORM_SEED: SeedOp[] = [
  write('empty-body', 'x', '空', ''),
  write('multibyte', '日報', '日本語 😀 の題', '日本語😀の本文\n二行目 é\n'),
  write('long', 'x', '長い', `${'長い行。'.repeat(2_000)}\n`),
  write('nul-store', 'x', 'NUL', 'a\u0000b\n'),
  write('blank-lines', 'x', '空行', '\n\n\n'),
  write('crlf', 'x', 'CRLF', 'a\r\nb\r\n'),
  write('empty-title', 'x', '', BODY),
  write('long-title', 'x', '長'.repeat(300), BODY),
  write('newline-title', 'x', '一行目\n二行目', BODY),
  write('kind-multibyte', 'レビュー😀', '題', BODY),
  write('raw-a', 'x', 'raw', 'x\n'),
  write('raw-b', 'x', 'raw', 'x\n'),
];

/** 口で本文を差し替える行（ストアが正規化して返さなかった場合） */
const FORM_RAW_A = 'abc';
const FORM_RAW_B = 'a\u0000b\n';

function formSteps(version: number | undefined): Step[] {
  const v = version === undefined ? {} : { version };
  return [
    ...[
      'empty-body',
      'multibyte',
      'long',
      'nul-store',
      'blank-lines',
      'crlf',
      'empty-title',
      'long-title',
      'newline-title',
      'kind-multibyte',
    ].map((slug): Step => ({ slug, ...v })),
    { slug: 'raw-a', ...v, hooks: { content: FORM_RAW_A } },
    { slug: 'raw-b', ...v, hooks: { content: FORM_RAW_B } },
  ];
}

const REVIEW = write('review', 'レビュー', '題', BODY);
const HISTORY: SeedOp[] = [
  write('h', '調査', '一版目', BODY),
  write('h', '調査', '二版目', BODY.replace('読む', '読んで直す')),
  write('h', '実装', '三版目', `${BODY}追記\n`),
];
const SAME_TWICE: SeedOp[] = [write('same', 'x', '同じ', BODY), write('same', 'x', '同じ', BODY)];

const SCENARIOS: Scenario[] = [
  // ---- スラッグの検査 ----
  {
    name: 'slug-invalid',
    covers:
      'スラッグが不正（英大文字と空白・空・先頭が `.`・`/` を含む・129 字・NUL を含む）。版を渡しても（正しい版・不正な版でも）スラッグの断りが先。ストアは何も呼ばない',
    seed: [REVIEW],
    steps: [
      { slug: 'Bad Slug' },
      { slug: '' },
      { slug: '.hidden' },
      { slug: 'a/b' },
      { slug: 'x'.repeat(129) },
      { slug: 'a\u0000b' },
      { slug: 'Bad Slug', version: 1 },
      { slug: '', version: 0 },
      { slug: 'Bad Slug', version: 1.5 },
    ],
  },
  // ---- version の検査 ----
  {
    name: 'version-invalid',
    covers:
      'version が 1 以上の整数でない（0・-1・-0・0.5・1.5・NaN・±Infinity・null・文字列）: 「version … は使えない」。行が在っても無くても、読めない口があっても、ストアは何も呼ばない',
    seed: [REVIEW],
    steps: [
      { slug: 'review', version: 0 },
      { slug: 'review', version: -1 },
      { slug: 'review', version: 1.5 },
      { slug: 'review', version: Number.NaN },
      { slug: 'review', version: Number.POSITIVE_INFINITY },
      { slug: 'review', version: Number.NEGATIVE_INFINITY },
      { slug: 'review', version: null },
      { slug: 'review', version: '2' },
      { slug: 'nothing', version: 0 },
      {
        slug: 'review',
        version: 0,
        hooks: { readFails: 'unreadable', versionFails: 'plain' },
      },
      { slug: 'review', version: 0.5 },
      { slug: 'review', version: -0 },
    ],
  },
  {
    name: 'version-bounds',
    covers:
      '整数としては通る版の境目: 1（在る）・2（無い）・1e21 と 2^53 と最大の数（整数なので検査は通り readVersion まで進んで「無い」。文言は String(version) の指数表記）',
    seed: [REVIEW],
    steps: [
      { slug: 'review', version: 1 },
      { slug: 'review', version: 2 },
      { slug: 'review', version: 1e21 },
      { slug: 'review', version: 2 ** 53 },
      { slug: 'review', version: Number.MAX_VALUE },
    ],
  },
  // ---- いまの版を読むモード ----
  {
    name: 'current-missing',
    covers:
      'いまの版を読むモードで行が無い（read が null）: 「やり方 … は無い」。readVersion は呼ばない。スラッグの通る形（. _ - 数字・128 字）も同じ文言',
    seed: [REVIEW],
    steps: [{ slug: 'nothing' }, { slug: 'a.b_c-1' }, { slug: '0' }, { slug: 'x'.repeat(128) }],
  },
  {
    name: 'current-read',
    covers:
      'いまの版を読むモードで在る: 頭の行（slug・kind・題）・作成と更新の時刻・字数・本文・版の行。1 回だけ書いた行（作成と更新が同じ）・3 回書き直した行（作成は最初・更新は最後・本文と題は最新）・同じ中身を 2 回書いた行（版の行は同じ）',
    seed: [REVIEW, ...HISTORY, ...SAME_TWICE],
    steps: [{ slug: 'review' }, { slug: 'h' }, { slug: 'same' }],
  },
  {
    name: 'current-forms',
    covers:
      'いまの版を読むモードの本文・題・kind の形: 空（`\\n` になる）・多バイトとサロゲートペア（字数はコードポイント）・長文・書き込みの NUL は落ちる・空行だけ・CRLF・題が空/長い/改行入り・kind が多バイト。口で本文を差し替えて、末尾の改行なし・NUL を含む本文',
    seed: FORM_SEED,
    steps: formSteps(undefined),
  },
  {
    name: 'current-failures',
    covers:
      'いまの版を読むモードで read が失敗: 読めない行（UnreadablePracticeError）→ 理由の分かる文（isError ではない）・名前だけ同じ別の例外と別の例外は投げ直す（例外で返る）。行が無い slug でも読めない扱いなら同じ。そのあと口を外すと普通に読める',
    seed: [REVIEW],
    steps: [
      { slug: 'review', hooks: { readFails: 'unreadable' } },
      { slug: 'review', hooks: { readFails: 'lookalike' } },
      { slug: 'review', hooks: { readFails: 'plain' } },
      { slug: 'u-gone', hooks: { readFails: 'unreadable' } },
      { slug: 'review' },
    ],
  },
  // ---- 版を指定するモード ----
  {
    name: 'version-read',
    covers:
      '版を指定するモードで在る: 頭の行（slug・版・kind・題）・その版が書かれた時刻と字数・本文（版の行は付かない）。3 回書いた行の 1・2・3 版（3 版はいまの版と同じ中身）と、版なしでいまを読んだ場合との並び。同じ中身を 2 回書いた行の 1・2 版',
    seed: [REVIEW, ...HISTORY, ...SAME_TWICE],
    steps: [
      { slug: 'h', version: 1 },
      { slug: 'h', version: 2 },
      { slug: 'h', version: 3 },
      { slug: 'h' },
      { slug: 'same', version: 1 },
      { slug: 'same', version: 2 },
      { slug: 'same' },
      { slug: 'review', version: 1 },
    ],
  },
  {
    name: 'version-missing',
    covers:
      '版を指定するモードで版が無い（readVersion が null）: 「版 N は無い」。行が無い slug・在る行の先の版・スラッグの通る形。read は呼ばない',
    seed: [REVIEW],
    steps: [
      { slug: 'nothing', version: 1 },
      { slug: 'review', version: 2 },
      { slug: 'a.b_c-1', version: 3 },
    ],
  },
  {
    name: 'version-forms',
    covers:
      '版を指定するモードの本文・題・kind の形（current-forms と同じ行の 1 版）。末尾の改行なし・NUL を含む本文は口で差し替える',
    seed: FORM_SEED,
    steps: formSteps(1),
  },
  {
    name: 'version-failures',
    covers:
      '版を指定するモードで readVersion が失敗: 読めない版（UnreadablePracticeError）→ 「読めない形で入っている（消されたのではない）」・名前だけ同じ別の例外と別の例外は投げ直す。行が無い slug でも読めない扱いなら同じ。そのあと口を外すと普通に読める',
    seed: [REVIEW],
    steps: [
      { slug: 'review', version: 1, hooks: { versionFails: 'unreadable' } },
      { slug: 'review', version: 1, hooks: { versionFails: 'lookalike' } },
      { slug: 'review', version: 1, hooks: { versionFails: 'plain' } },
      { slug: 'v-gone', version: 1, hooks: { versionFails: 'unreadable' } },
      { slug: 'review', version: 1 },
    ],
  },
  {
    name: 'mode-split',
    covers:
      '2 つのモードは別の口を呼ぶ: version なしは read だけ（readVersion が壊れていても読める）・version ありは readVersion だけ（read が壊れていても読める）',
    seed: [REVIEW],
    steps: [
      { slug: 'review', hooks: { versionFails: 'plain' } },
      { slug: 'review', version: 1, hooks: { readFails: 'plain' } },
      { slug: 'review', hooks: { versionFails: 'unreadable' } },
      { slug: 'review', version: 1, hooks: { readFails: 'unreadable' } },
    ],
  },
  // ---- 消した後に残る版 ----
  {
    name: 'after-remove',
    covers:
      '消した後: いまの版は「無い」・版（履歴）は残って読める・先の版は無い。消して作り直した行（書く→消す→書く→消す→書く）は版番号が続き、いまの版と最新の版が同じ中身。2 回消された行の途中の版も読める',
    seed: [
      write('gone', '調査', '一版目', BODY),
      write('gone', '調査', '二版目', `${BODY}追記\n`),
      { op: 'remove', slug: 'gone' },
      write('again', 'a', 'A', 'A\n'),
      { op: 'remove', slug: 'again' },
      write('again', 'b', 'B', 'B\n'),
      { op: 'remove', slug: 'again' },
      write('again', 'c', 'C', 'C\n'),
    ],
    steps: [
      { slug: 'gone' },
      { slug: 'gone', version: 1 },
      { slug: 'gone', version: 2 },
      { slug: 'gone', version: 3 },
      { slug: 'again' },
      { slug: 'again', version: 1 },
      { slug: 'again', version: 2 },
      { slug: 'again', version: 3 },
      { slug: 'again', version: 4 },
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
  /** やり方（現在の行・版の履歴）か日誌が呼ぶ前から変わったか。この道具は読むだけなので常に false */
  wrote: boolean;
  /** ストアの呼びの並び（道具の呼びだけ） */
  calls: PinnedCall[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 場面で触れうる slug（不正な slug は読まない） */
function watchedSlugs(scenario: Scenario): string[] {
  const slugs = new Set<string>();
  for (const entry of scenario.seed) slugs.add(entry.slug);
  for (const step of scenario.steps) {
    if (/^[a-z0-9][a-z0-9._-]*$/.test(step.slug) && step.slug.length <= 128) slugs.add(step.slug);
  }
  return [...slugs].sort();
}

/** やり方の現在の行と、版の履歴の全文、日誌の全行を、そのまま JSON にしたもの。呼ぶ前後で比べる */
async function snapshot(stores: Stores, slugs: readonly string[]): Promise<string> {
  const practices: Record<string, unknown> = {};
  for (const slug of slugs) {
    const versions = await stores.practices.listVersions(slug);
    const bodies = [];
    for (const meta of versions) {
      bodies.push(await stores.practices.readVersion(slug, meta.version));
    }
    practices[slug] = { current: await stores.practices.read(slug), versions: bodies };
  }
  return JSON.stringify({ practices, journal: await stores.journal.list({ order: 'asc' }) });
}

function failureOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return `threw ${name}: ${error instanceof Error ? error.message : String(error)}`;
}

/** `UnreadablePracticeError` と名前だけ同じ別の例外 */
class LookalikeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadablePracticeError';
  }
}

function failWith(fail: Fail, op: string, slug: string): void {
  if (fail === 'unreadable') {
    throw new UnreadablePracticeError(`やり方の行が読めない: ${slug}`, { slug });
  }
  if (fail === 'lookalike') throw new LookalikeError(`読めない行に似た別の例外（${op}）`);
  if (fail === 'plain') throw new Error(`ストアが落ちた（${op}）`);
}

/** 道具の呼びを `calls` へ記録し、口（hooks）で読めない行・失敗・本文の差し替えを起こす。read / readVersion 以外の口を呼ぶと、そのまま記録に残る */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  const practices: Stores['practices'] = {
    ...base.practices,
    list: async () => {
      calls.push({ op: 'practices.list', args: {}, outcome: 'called' });
      return base.practices.list();
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
    read: async (slug) => {
      const now = hooks();
      try {
        failWith(now.readFails, 'read', slug);
        const found = await base.practices.read(slug);
        const returned =
          found !== null && now.content !== null ? { ...found, content: now.content } : found;
        calls.push({
          op: 'practices.read',
          args: { slug },
          outcome: returned === null ? 'null' : `practice ${practiceVersion(returned)}`,
        });
        return returned;
      } catch (error) {
        calls.push({ op: 'practices.read', args: { slug }, outcome: failureOf(error) });
        throw error;
      }
    },
    readVersion: async (slug, version) => {
      const now = hooks();
      try {
        failWith(now.versionFails, 'readVersion', slug);
        const found = await base.practices.readVersion(slug, version);
        const returned =
          found !== null && now.content !== null ? { ...found, content: now.content } : found;
        calls.push({
          op: 'practices.readVersion',
          args: { slug, version },
          outcome:
            returned === null
              ? 'null'
              : `version ${String(returned.version)} ${practiceVersion(returned)}`,
        });
        return returned;
      } catch (error) {
        calls.push({
          op: 'practices.readVersion',
          args: { slug, version },
          outcome: failureOf(error),
        });
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
  const found = tools.find((entry) => entry.name === 'practice_read');
  if (!found) throw new Error('practice_read が無い');

  const slugs = watchedSlugs(scenario);
  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const args = {
      slug: step.slug,
      ...(step.version === undefined ? {} : { version: step.version }),
    };
    const before = await snapshot(base, slugs);
    hooks = { ...DEFAULT_HOOKS, ...step.hooks };
    calls.length = 0;
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(args as never, {});
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
    const after = await snapshot(base, slugs);
    results.push({ output, wrote: before !== after, calls: plain(calls) });
    // 読むだけ: やり方（現在の行・版の履歴の全文）も日誌も、呼ぶ前と1文字も変わらない
    expect(
      after === before,
      `場面 ${stepKey(scenario, index)} は読むだけのはずだが、やり方か日誌が呼ぶ前から変わった`,
    ).toBe(true);
    // 道具が呼ぶのは read / readVersion だけ（書き込み口・list・日誌を呼ばない）
    for (const call of calls) {
      expect(
        ['practices.read', 'practices.readVersion'],
        `場面 ${stepKey(scenario, index)} が ${call.op} を呼んだ`,
      ).toContain(call.op);
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

describe('practice_read の出力と呼びの並びの固定（場面ごとの出力の全文・ストアの呼び・読むだけであること）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

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

      it(`${key} のストアの呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} のストアの呼びの並び（op）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び（渡した slug と版・結果）が固定値からずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const READ = ['practices.read'];
    const READ_VERSION = ['practices.readVersion'];
    const range = (name: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => `${name}#${String(i + 1)}`);

    // スラッグの検査: ストアを1つも呼ばない
    for (const key of range('slug-invalid', 9)) {
      expect(text(key), key).toContain('やり方のスラッグが不正');
      expect(ops(key), key).toEqual([]);
    }

    // version の検査: ストアを1つも呼ばない
    for (const key of range('version-invalid', 12)) {
      expect(text(key), key).toMatch(/^version \S* は使えない（1以上の整数のみ）。$/);
      expect(ops(key), key).toEqual([]);
    }
    expect(text('version-invalid#4')).toBe('version NaN は使えない（1以上の整数のみ）。');
    expect(text('version-invalid#12')).toBe('version 0 は使えない（1以上の整数のみ）。');

    // 整数としては通る境目
    expect(text('version-bounds#1')).toContain('review 版1（レビュー） 題');
    expect(ops('version-bounds#1')).toEqual(READ_VERSION);
    for (const key of ['version-bounds#2', 'version-bounds#3', 'version-bounds#4']) {
      expect(text(key), key).toContain('は無い。practice_history slug=<slug>');
      expect(ops(key), key).toEqual(READ_VERSION);
    }
    expect(text('version-bounds#3')).toContain('版 1e+21 は無い');

    // いまの版を読むモード
    for (const key of range('current-missing', 4)) {
      expect(text(key), key).toMatch(/^やり方 \S+ は無い。practice_list で/);
      expect(ops(key), key).toEqual(READ);
    }
    for (const key of ['current-read#1', 'current-read#2', 'current-read#3']) {
      expect(text(key), key).toContain('作成: ');
      expect(text(key), key).toContain('（版 base_version=');
      expect(ops(key), key).toEqual(READ);
    }
    expect(text('current-read#2')).toContain('h（実装） 三版目');
    for (const key of range('current-forms', 12)) {
      expect(text(key), key).toContain('（版 base_version=');
      expect(ops(key), key).toEqual(READ);
    }
    expect(actual['current-failures#1']?.output).toMatchObject({ thrown: false, isError: false });
    expect(text('current-failures#1')).toContain('は読めない形で入っている（消されたのではない）');
    expect(text('current-failures#4')).toContain('やり方 u-gone は読めない形で入っている');
    expect(actual['current-failures#2']?.output).toMatchObject({
      thrown: true,
      errorName: 'UnreadablePracticeError',
    });
    expect(actual['current-failures#3']?.output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: 'ストアが落ちた（read）',
    });
    for (const key of range('current-failures', 5)) expect(ops(key), key).toEqual(READ);
    expect(text('current-failures#5')).toContain('review（レビュー） 題');

    // 版を指定するモード
    for (const key of range('version-read', 8)) {
      if (key === 'version-read#4' || key === 'version-read#7') {
        expect(ops(key), key).toEqual(READ);
        continue;
      }
      expect(text(key), key).toContain('この版が書かれた時刻: ');
      expect(text(key), key).not.toContain('base_version=');
      expect(ops(key), key).toEqual(READ_VERSION);
    }
    expect(text('version-read#1')).toContain('h 版1（調査） 一版目');
    expect(text('version-read#3')).toContain('h 版3（実装） 三版目');
    for (const key of range('version-missing', 3)) {
      expect(text(key), key).toMatch(/^やり方 \S+ の版 \d+ は無い。/);
      expect(ops(key), key).toEqual(READ_VERSION);
    }
    for (const key of range('version-forms', 12)) {
      expect(text(key), key).toContain('この版が書かれた時刻: ');
      expect(ops(key), key).toEqual(READ_VERSION);
    }
    expect(text('version-failures#1')).toContain(
      'の版 1 は読めない形で入っている（消されたのではない）',
    );
    expect(text('version-failures#4')).toContain('やり方 v-gone の版 1 は読めない形で入っている');
    expect(actual['version-failures#2']?.output).toMatchObject({
      thrown: true,
      errorName: 'UnreadablePracticeError',
    });
    expect(actual['version-failures#3']?.output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: 'ストアが落ちた（readVersion）',
    });
    for (const key of range('version-failures', 5)) expect(ops(key), key).toEqual(READ_VERSION);
    expect(text('version-failures#5')).toContain('review 版1（レビュー） 題');

    // 2 つのモードは別の口
    expect(ops('mode-split#1')).toEqual(READ);
    expect(ops('mode-split#2')).toEqual(READ_VERSION);
    expect(ops('mode-split#3')).toEqual(READ);
    expect(ops('mode-split#4')).toEqual(READ_VERSION);
    expect(text('mode-split#1')).toContain('（版 base_version=');
    expect(text('mode-split#2')).toContain('この版が書かれた時刻: ');

    // 消した後に残る版
    expect(text('after-remove#1')).toContain('やり方 gone は無い');
    expect(ops('after-remove#1')).toEqual(READ);
    expect(text('after-remove#2')).toContain('gone 版1（調査） 一版目');
    expect(text('after-remove#3')).toContain('gone 版2（調査） 二版目');
    expect(text('after-remove#4')).toContain('やり方 gone の版 3 は無い');
    expect(text('after-remove#5')).toContain('again（c） C');
    expect(text('after-remove#8')).toContain('again 版3（c） C');
    expect(text('after-remove#7')).toContain('again 版2（b） B');
    expect(text('after-remove#9')).toContain('やり方 again の版 4 は無い');

    // 本文の形（口で差し替えた分・書き込みで正規化された分）
    expect(text('current-forms#4')).toContain('\n\nab\n\n\n（版 base_version=');
    expect(text('current-forms#4')).not.toContain('\u0000');
    expect(text('current-forms#11')).toContain(`\n\n${FORM_RAW_A}\n\n（版 base_version=`);
    expect(text('current-forms#12')).toContain('\u0000');
    expect(text('version-forms#11')).toMatch(/\n\nabc$/);
    expect(text('version-forms#12')).toContain('\u0000');
  });
});
