import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { UnreadablePracticeError, practiceVersion, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `practice_write` の出力と、呼んだあとの状態（やり方の行・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-practice-write-output-pin.json）と丸ごと比べる。
// `clone-tools-practice.ts` の `tool('practice_write', …)`（約 74 行の式・入れ子 6 段）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - practices: 場面で触れたやり方を、呼んだあとにストアから読んだ形のまま（版 version・履歴の件数 versions・時刻を含む）。
//     読めない行を書き直せなかった場面は `{ unreadable: true }`（行は呼ぶ前のまま残り、読めないままであること）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま）
//   - calls: ストアの呼びの並び（practices.read・practices.write（渡した中身と ifMatch の有無・値）・journal.append）。
//     道具が呼ぶものは practices と journal だけなので、そのほかの口（list・remove など）を呼べばここに出る。
//     口（hooks）が土台を直に書き換える競合は記録に残らない
//   - wrote: やり方か日誌のどれかが呼ぶ前から変わったか。断った・何もしなかった場面は false で、やり方も日誌も呼ぶ前と同じであることを別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PRACTICE_WRITE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-practice-write-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-practice-write-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、やり方・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// やり方は場面の頭に基準時刻で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（updatedAt・日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
//
// 読めない行の作り方: インメモリのストアは行を読めない形で持てないので、`practices.read` が
// `UnreadablePracticeError` を投げる口（hooks.unreadable）で作る（`write` は土台のまま通る）。

type Writes = 'none' | 'some' | 'hook';
// none: 道具も口も何も書かない。some: 道具がやり方か日誌のどちらかを書く。hook: 道具は書かず、口が土台のやり方を書き換えた（競合）

interface SeedPractice {
  slug: string;
  kind: string;
  title: string;
  content: string;
}

interface RaceSpec {
  /** null なら消す。それ以外はその中身へ書き換える */
  to: Omit<SeedPractice, 'slug'> | null;
}

/** 場面の中で呼びごとに差し替える口。対象はその呼びの slug */
interface Hooks {
  /** `practices.read` が `UnreadablePracticeError` を投げる（在ったが読めない行） */
  unreadable: boolean;
  /** `practices.read` が別の例外を投げる */
  readThrows: boolean;
  /** `practices.read` が `UnreadablePracticeError` と名前だけ同じ別の例外を投げる */
  readLookalike: boolean;
  writeThrows: boolean;
  journalFails: boolean;
  /** 最初に読んだ直後に、土台を直に書き換える（読んでから書くまでの間に変わる場面） */
  race: RaceSpec | null;
}

const DEFAULT_HOOKS: Hooks = {
  unreadable: false,
  readThrows: false,
  readLookalike: false,
  writeThrows: false,
  journalFails: false,
  race: null,
};

interface Step {
  slug: string;
  kind: string;
  title: string;
  content: string;
  /**
   * current: 呼ぶ直前（外からの書き換えの後）のやり方の版を渡す。stale: 外からの書き換えの前の版を渡す。none: 渡さない。raw: その文字列を渡す
   */
  base: 'current' | 'stale' | 'none' | { raw: string };
  writes: Writes;
  hooks?: Partial<Hooks>;
  /** 呼ぶ前に外から（人間・別のターンが）やり方を書き換える。呼ぶ前の状態に含める */
  externalEdit?: SeedPractice;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedPractice[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-practice-write-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PRACTICE_WRITE_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

// ---- 入力 ----

const BODY = '# 手順\n1. 読む\n2. 数 42 と `id-7` を確かめる\n';
const SEED: SeedPractice = { slug: 'review', kind: 'レビュー', title: '題', content: BODY };
const NEW_BODY = BODY.replace('読む', '読んで直す');
const LONG = `# 長い\n${'a'.repeat(1500)}\n`;
const NUM_RUN = Array.from({ length: 12 }, (_, index) => String(1001 + index)).join(' ');

const SCENARIOS: Scenario[] = [
  // ---- スラッグの検査 ----
  {
    name: 'slug-invalid',
    covers:
      'スラッグが不正（英大文字と空白・空・先頭が `.`・`/` を含む・129 字）。kind も不正でもスラッグの断りが先。どれも何も呼ばない',
    seed: [SEED],
    steps: [
      { ...SEED, slug: 'Bad Slug', base: 'none', writes: 'none' },
      { ...SEED, slug: '', base: 'none', writes: 'none' },
      { ...SEED, slug: '.hidden', base: 'none', writes: 'none' },
      { ...SEED, slug: 'a/b', base: 'none', writes: 'none' },
      { ...SEED, slug: 'x'.repeat(129), base: 'none', writes: 'none' },
      { ...SEED, slug: 'Bad Slug', kind: '', base: 'none', writes: 'none' },
    ],
  },
  // ---- kind の検査 ----
  {
    name: 'kind-invalid',
    covers:
      'kind が不正（空・129 字・NUL だけ・NUL が複数だけ）。NUL だけは別の文言。既存の slug で版が無くても kind の断りが先。何も呼ばない',
    seed: [SEED],
    steps: [
      { ...SEED, kind: '', base: 'none', writes: 'none' },
      { ...SEED, kind: 'あ'.repeat(129), base: 'current', writes: 'none' },
      { ...SEED, kind: '\u0000', base: 'current', writes: 'none' },
      { ...SEED, kind: '\u0000\u0000\u0000', base: 'none', writes: 'none' },
    ],
  },
  {
    name: 'kind-valid-edges',
    covers:
      'kind が通る端: 1 字・128 字（上限）・NUL が混じる（ストアが NUL を除いて保存する。道具の入口が引数の NUL を先に除くので、日誌の kind も NUL なし）',
    seed: [],
    steps: [
      { slug: 'k-one', kind: 'x', title: '1字', content: BODY, base: 'none', writes: 'some' },
      {
        slug: 'k-max',
        kind: 'あ'.repeat(128),
        title: '上限',
        content: BODY,
        base: 'none',
        writes: 'some',
      },
      {
        slug: 'k-nul',
        kind: 'a\u0000b',
        title: 'NUL 混じり',
        content: BODY,
        base: 'none',
        writes: 'some',
      },
    ],
  },
  // ---- 新規作成 ----
  {
    name: 'create',
    covers:
      '新規作成（無い slug・版なし）: ifMatch は null。応答は「新しく作った」・前の版は読める旨・token 差は出ない・版の行。日誌は「作った」と「新しいやり方を器に置いた」',
    seed: [],
    steps: [{ ...SEED, base: 'none', writes: 'some' }],
  },
  {
    name: 'create-content-forms',
    covers:
      '書いた本文の形: 末尾の改行が無い（ストアが足す・字数は足した後）・NUL を含む（ストアが除く）・空文字・多バイト文字と絵文字（字数はコードポイント）・1,000 字以上・title に NUL・title が空',
    seed: [],
    steps: [
      {
        slug: 'no-newline',
        kind: '調査',
        title: '改行なし',
        content: '# 改行なし\n本文',
        base: 'none',
        writes: 'some',
      },
      {
        slug: 'with-nul',
        kind: '調査',
        title: 'NUL',
        content: '# NUL\n本\u0000文\n',
        base: 'none',
        writes: 'some',
      },
      { slug: 'empty', kind: '調査', title: '空', content: '', base: 'none', writes: 'some' },
      {
        slug: 'multibyte',
        kind: '調査',
        title: '日本語',
        content: '# 日本語\nあいうえお 😀\n',
        base: 'none',
        writes: 'some',
      },
      {
        slug: 'long-ascii',
        kind: '調査',
        title: '長い',
        content: LONG,
        base: 'none',
        writes: 'some',
      },
      {
        slug: 'title-nul',
        kind: '調査',
        title: '題\u0000あ',
        content: BODY,
        base: 'none',
        writes: 'some',
      },
      { slug: 'title-empty', kind: '調査', title: '', content: BODY, base: 'none', writes: 'some' },
    ],
  },
  {
    name: 'create-with-base-version',
    covers:
      '無い slug の新規作成に base_version を渡す: ifMatch は `baseVersion ?? null` で渡り、ストアが断る（いまそのやり方は無い・何も書かない）。そのあと版なしで作ると通る',
    seed: [],
    steps: [
      { ...SEED, base: { raw: practiceVersion(SEED) }, writes: 'none' },
      { ...SEED, base: 'none', writes: 'some' },
    ],
  },
  {
    name: 'create-slug-forms',
    covers:
      'スラッグの通る形（. _ - 数字を含む）。日誌の target と decision に slug がそのまま入る',
    seed: [],
    steps: [
      {
        slug: 'a.b_c-1',
        kind: '日報',
        title: '要約に改行と長い文字列\n2行目 ' + '長'.repeat(300),
        content: BODY,
        base: 'none',
        writes: 'some',
      },
    ],
  },
  // ---- 版の前提 ----
  {
    name: 'update-needs-base',
    covers:
      '既存のやり方に base_version が無い: 何も書かずに断る（write を呼ばない）。空文字の base_version は「無い」ではなく版の食い違いとして断られる。正しい版を渡すと通る',
    seed: [SEED],
    steps: [
      { ...SEED, content: NEW_BODY, base: 'none', writes: 'none' },
      { ...SEED, content: NEW_BODY, base: { raw: '' }, writes: 'none' },
      { ...SEED, content: NEW_BODY, base: 'current', writes: 'some' },
    ],
  },
  // ---- 書き直し ----
  {
    name: 'update',
    covers:
      '書き直し（既存・正しい版）: 応答は「書き直した」・日誌は「書き直した」と履歴の grounds。中身が同じ（token 差なし・版は同じ・履歴は積む）/ 数字と識別子が変わる（token 差）/ 文章だけ / kind と title を変える / 末尾の改行が無い本文（token 差は渡した本文で比べる）/ NUL を含む本文 / token が 11 件以上（ほか N 件）',
    seed: [SEED],
    steps: [
      { ...SEED, base: 'current', writes: 'some' },
      {
        ...SEED,
        content: BODY.replace('42', '43').replace('`id-7`', '`id-8`'),
        base: 'current',
        writes: 'some',
      },
      { ...SEED, content: BODY.replace('読む', '読んで直す'), base: 'current', writes: 'some' },
      { ...SEED, kind: '実装', title: '新しい題', content: BODY, base: 'current', writes: 'some' },
      { ...SEED, content: BODY.trimEnd(), base: 'current', writes: 'some' },
      { ...SEED, content: BODY.replace('読む', '読\u0000む'), base: 'current', writes: 'some' },
      { ...SEED, content: `${BODY}${NUM_RUN}\n`, base: 'current', writes: 'some' },
    ],
  },
  // ---- 版の食い違い ----
  {
    name: 'conflict',
    covers:
      '版の食い違い: 外から書き換えた後の古い版（いまの版と字数を名乗って断る）・でたらめな版・読んだ直後に別の手が書いた（競合）・読んだ直後に別の手が消した（いまそのやり方は無い）。どれも道具は何も書かず、日誌も足さない。write には渡した ifMatch が残る',
    seed: [
      { ...SEED, slug: 'a1' },
      { ...SEED, slug: 'a2' },
      { ...SEED, slug: 'a3' },
      { ...SEED, slug: 'a4' },
    ],
    steps: [
      {
        ...SEED,
        slug: 'a1',
        content: NEW_BODY,
        base: 'stale',
        writes: 'none',
        externalEdit: { ...SEED, slug: 'a1', content: '人間が直した\n' },
      },
      { ...SEED, slug: 'a2', content: NEW_BODY, base: { raw: 'deadbeef' }, writes: 'none' },
      {
        ...SEED,
        slug: 'a3',
        content: NEW_BODY,
        base: 'current',
        writes: 'hook',
        hooks: {
          race: { to: { kind: 'レビュー', title: '題', content: '別のターンが書いた\n' } },
        },
      },
      {
        ...SEED,
        slug: 'a4',
        content: NEW_BODY,
        base: 'current',
        writes: 'hook',
        hooks: { race: { to: null } },
      },
    ],
  },
  // ---- 読めない行 ----
  {
    name: 'unreadable',
    covers:
      '在ったが読めない行（`read` が `UnreadablePracticeError`）の書き直し: 版なしで通る・でたらめな版を渡しても ifMatch は渡らない（省略）・その直後の読める行への書き直しは版が要る・行が無いのに読めない扱いでも通る。応答は「（読めない形で入っていたやり方を）書き直した」で token 差は出ない。日誌は「読めない形で入っていた…」',
    seed: [
      { ...SEED, slug: 'u1' },
      { ...SEED, slug: 'u2' },
    ],
    steps: [
      {
        ...SEED,
        slug: 'u1',
        content: NEW_BODY,
        base: 'none',
        writes: 'some',
        hooks: { unreadable: true },
      },
      {
        ...SEED,
        slug: 'u2',
        content: NEW_BODY,
        base: { raw: 'deadbeef' },
        writes: 'some',
        hooks: { unreadable: true },
      },
      { ...SEED, slug: 'u1', content: BODY, base: 'none', writes: 'none' },
      { ...SEED, slug: 'u1', content: BODY, base: 'current', writes: 'some' },
      {
        ...SEED,
        slug: 'u-gone',
        content: NEW_BODY,
        base: 'none',
        writes: 'some',
        hooks: { unreadable: true },
      },
    ],
  },
  // ---- 失敗 ----
  {
    name: 'failures',
    covers:
      '例外: read が別の例外を投げる（そのまま投げる・書かない）・名前だけ UnreadablePracticeError の別の例外（instanceof で見るので投げる）・write が落ちる（更新・新規・読めない行。やり方も日誌も呼ぶ前のまま）・日誌が書けない（やり方は書けているが日誌は空・「完了済み・未記録・やり直し禁止」の例外。更新・新規・読めない行）',
    seed: [
      { ...SEED, slug: 'f1' },
      { ...SEED, slug: 'f2' },
      { ...SEED, slug: 'f3' },
      { ...SEED, slug: 'f4' },
      { ...SEED, slug: 'f5' },
      { ...SEED, slug: 'f6' },
    ],
    steps: [
      {
        ...SEED,
        slug: 'f1',
        content: NEW_BODY,
        base: 'current',
        writes: 'none',
        hooks: { readThrows: true },
      },
      {
        ...SEED,
        slug: 'f2',
        content: NEW_BODY,
        base: 'current',
        writes: 'none',
        hooks: { readLookalike: true },
      },
      {
        ...SEED,
        slug: 'f3',
        content: NEW_BODY,
        base: 'current',
        writes: 'none',
        hooks: { writeThrows: true },
      },
      { ...SEED, slug: 'f-new', base: 'none', writes: 'none', hooks: { writeThrows: true } },
      {
        ...SEED,
        slug: 'f4',
        content: NEW_BODY,
        base: 'none',
        writes: 'none',
        hooks: { unreadable: true, writeThrows: true },
      },
      {
        ...SEED,
        slug: 'f5',
        content: NEW_BODY,
        base: 'current',
        writes: 'some',
        hooks: { journalFails: true },
      },
      { ...SEED, slug: 'f-new-2', base: 'none', writes: 'some', hooks: { journalFails: true } },
      {
        ...SEED,
        slug: 'f6',
        content: NEW_BODY,
        base: 'none',
        writes: 'some',
        hooks: { unreadable: true, journalFails: true },
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
  /** 例外の名前（例外でなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args: Record<string, unknown>;
  outcome: string;
}

/** ストアから読める形のまま（`practices.read` の中身）に、版（practiceVersion）と履歴の件数を足したもの。読めない行のまま残ったときは `{ unreadable: true }` */
type PinnedPractice = Record<string, unknown>;

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 場面で触れたやり方（呼んだあと）。無ければ null */
  practices: Record<string, PinnedPractice | null>;
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** ストアの呼びの並び（道具の呼びだけ。口が土台を直に書き換えた分は残らない） */
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

async function readPractice(stores: Stores, slug: string): Promise<PinnedPractice | null> {
  const found = await stores.practices.read(slug);
  if (found === null) return null;
  const versions = await stores.practices.listVersions(slug);
  return plain({ ...found, version: practiceVersion(found), versions: versions.length });
}

/** 場面で触れうる slug（不正な slug は読まない） */
function watchedSlugs(scenario: Scenario): string[] {
  const slugs = new Set<string>(scenario.seed.map((entry) => entry.slug));
  for (const step of scenario.steps) {
    for (const slug of [step.slug, step.externalEdit?.slug]) {
      if (slug !== undefined && /^[a-z0-9][a-z0-9._-]*$/.test(slug) && slug.length <= 128) {
        slugs.add(slug);
      }
    }
  }
  return [...slugs].sort();
}

async function snapshot(
  stores: Stores,
  slugs: readonly string[],
): Promise<{ practices: Record<string, PinnedPractice | null>; all: string; journal: unknown[] }> {
  const practices: Record<string, PinnedPractice | null> = {};
  for (const slug of slugs) practices[slug] = await readPractice(stores, slug);
  return {
    practices,
    all: JSON.stringify(practices),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
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

interface StepState {
  raced: boolean;
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で読めない行・失敗・競合を起こす。口の書き換えは土台を直に叩くので記録に残らない */
function withHooks(
  base: Stores,
  hooks: () => Hooks,
  state: () => StepState,
  calls: PinnedCall[],
): Stores {
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
    readVersion: async (slug, version) => {
      calls.push({ op: 'practices.readVersion', args: { slug, version }, outcome: 'called' });
      return base.practices.readVersion(slug, version);
    },
    remove: async (slug, options) => {
      calls.push({ op: 'practices.remove', args: { slug, options }, outcome: 'called' });
      return base.practices.remove(slug, options);
    },
    clear: async () => {
      calls.push({ op: 'practices.clear', args: {}, outcome: 'called' });
      return base.practices.clear();
    },
    read: async (slug) => {
      const now = hooks();
      try {
        if (now.unreadable) {
          throw new UnreadablePracticeError(`やり方の行が読めない: ${slug}`, { slug });
        }
        if (now.readLookalike) throw new LookalikeError('読めない行に似た別の例外');
        if (now.readThrows) throw new Error('ストアが落ちた（read）');
        const found = await base.practices.read(slug);
        calls.push({
          op: 'practices.read',
          args: { slug },
          outcome: found === null ? 'null' : `practice ${practiceVersion(found)}`,
        });
        const race = now.race;
        const current = state();
        if (race !== null && !current.raced) {
          current.raced = true;
          if (race.to === null) await base.practices.remove(slug);
          else await base.practices.write({ slug, ...race.to });
        }
        return found;
      } catch (error) {
        calls.push({ op: 'practices.read', args: { slug }, outcome: failureOf(error) });
        throw error;
      }
    },
    write: async (input, options) => {
      const now = hooks();
      const args = {
        input: plain(input),
        ifMatch: options?.ifMatch === undefined ? '(省略)' : options.ifMatch,
      };
      try {
        if (now.writeThrows) throw new Error('ストアが落ちた（write）');
        const written = await base.practices.write(input, options);
        calls.push({
          op: 'practices.write',
          args,
          outcome: `ok ${practiceVersion(written)} ${String(written.chars)}字`,
        });
        return written;
      } catch (error) {
        calls.push({ op: 'practices.write', args, outcome: failureOf(error) });
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
        const args = plain(entry);
        if (hooks().journalFails) {
          calls.push({ op: 'journal.append', args, outcome: 'threw Error: 日誌が落ちた' });
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(entry);
        calls.push({ op: 'journal.append', args, outcome: `ok ${written.id}` });
        return written;
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const entry of scenario.seed) await base.practices.write(entry);
  let hooks: Hooks = { ...DEFAULT_HOOKS };
  let state: StepState = { raced: false };
  const calls: PinnedCall[] = [];
  const tools = createCloneTools({
    stores: withHooks(
      base,
      () => hooks,
      () => state,
      calls,
    ),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'practice_write');
  if (!found) throw new Error('practice_write が無い');

  const slugs = watchedSlugs(scenario);
  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    let staleBase: string | undefined;
    if (step.base === 'stale') {
      const row = await base.practices.read(step.slug);
      if (row === null) throw new Error(`場面 ${stepKey(scenario, index)}: stale の版が取れない`);
      staleBase = practiceVersion(row);
    }
    if (step.externalEdit !== undefined) {
      vi.setSystemTime(new Date(callTime(index)));
      await base.practices.write(step.externalEdit);
    }
    let baseVersion: string | undefined;
    if (step.base === 'current') {
      const row = await base.practices.read(step.slug);
      if (row === null) throw new Error(`場面 ${stepKey(scenario, index)}: current の版が取れない`);
      baseVersion = practiceVersion(row);
    } else if (step.base === 'stale') {
      baseVersion = staleBase;
    } else if (typeof step.base === 'object') {
      baseVersion = step.base.raw;
    }
    const args = {
      slug: step.slug,
      kind: step.kind,
      title: step.title,
      content: step.content,
      ...(baseVersion === undefined ? {} : { base_version: baseVersion }),
    };
    const before = await snapshot(base, slugs);
    hooks = { ...DEFAULT_HOOKS, ...step.hooks };
    state = { raced: false };
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
    const wasUnreadable = hooks.unreadable;
    hooks = { ...DEFAULT_HOOKS };
    const after = await snapshot(base, slugs);
    const wrote = before.all !== after.all || before.journal.length !== after.journal.length;
    const practices = { ...after.practices };
    // 読めない行を書き直せなかった呼びは、行が呼ぶ前のまま残る＝読めないままである
    const seededRow = before.practices[step.slug];
    if (
      wasUnreadable &&
      seededRow !== null &&
      seededRow !== undefined &&
      JSON.stringify(seededRow) === JSON.stringify(after.practices[step.slug])
    ) {
      practices[step.slug] = { unreadable: true };
    }
    results.push({
      output,
      wrote,
      practices,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、やり方が呼ぶ前と同じで、日誌にも行が足されない
      expect(
        after.all === before.all,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、やり方が呼ぶ前から変わった`,
      ).toBe(true);
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
    if (step.writes === 'hook') {
      // 口が土台を書き換えるだけで、道具は日誌に何も足さない
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は道具が何も書かないはずだが、日誌に行が足された`,
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

describe('practice_write の出力と呼んだあとの状態の固定（場面ごとの出力の全文・やり方の行・日誌の行・ストアの呼び）', () => {
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
          step.writes !== 'none',
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

      it(`${key} の呼んだあとのやり方が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          Object.keys(got?.practices ?? {}),
          `場面 ${key} のやり方: 見ている slug の並びが変わった`,
        ).toEqual(Object.keys(want?.practices ?? {}));
        for (const [slug, wantRow] of Object.entries(want?.practices ?? {})) {
          const gotRow = got?.practices[slug] ?? null;
          expect(gotRow === null, `場面 ${key} のやり方 ${slug}: 行が有る／無いが変わった`).toBe(
            wantRow === null,
          );
          if (wantRow === null || gotRow === null) continue;
          expect(gotRow.content, `場面 ${key} のやり方 ${slug} の本文が固定値からずれた`).toBe(
            wantRow.content,
          );
          expect(
            gotRow,
            `場面 ${key} のやり方 ${slug} の本文以外（版・kind・title・時刻・履歴の件数など）が固定値からずれた`,
          ).toEqual(wantRow);
        }
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
          `場面 ${key} の日誌: 足された行（種類・本文・grounds・target・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
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
          `場面 ${key} のストアの呼び（渡した中身・ifMatch・結果）が固定値からずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・やり方・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const writeCall = (key: string): PinnedCall | undefined =>
      actual[key]?.calls.find((entry) => entry.op === 'practices.write');
    const ifMatch = (key: string): unknown => writeCall(key)?.args.ifMatch;
    const row = (key: string, slug: string): PinnedPractice | null =>
      actual[key]?.practices[slug] ?? null;
    const READ = ['practices.read'];
    const WRITE_ALL = ['practices.read', 'practices.write', 'journal.append'];

    // スラッグの検査・kind の検査: ストアを1つも呼ばない
    for (const key of [
      'slug-invalid#1',
      'slug-invalid#2',
      'slug-invalid#3',
      'slug-invalid#4',
      'slug-invalid#5',
      'slug-invalid#6',
    ]) {
      expect(text(key), key).toContain('やり方のスラッグが不正');
      expect(ops(key), key).toEqual([]);
    }
    expect(text('slug-invalid#6')).not.toContain('kind は使えない');
    for (const key of ['kind-invalid#1', 'kind-invalid#2', 'kind-invalid#3', 'kind-invalid#4']) {
      expect(text(key), key).toContain('kind は使えない');
      expect(ops(key), key).toEqual([]);
    }
    expect(text('kind-invalid#1')).not.toContain('NUL');
    expect(text('kind-invalid#2')).not.toContain('NUL');
    expect(text('kind-invalid#3')).toContain('NUL（\\u0000）だけの値は空と同じ');
    expect(text('kind-invalid#4')).toContain('NUL（\\u0000）だけの値は空と同じ');
    expect(text('kind-invalid#2')).not.toContain('既に在る');

    // kind が通る端
    for (const key of ['kind-valid-edges#1', 'kind-valid-edges#2', 'kind-valid-edges#3']) {
      expect(text(key), key).toContain('新しく作った');
      expect(ops(key), key).toEqual(WRITE_ALL);
    }
    expect(row('kind-valid-edges#3', 'k-nul')?.kind).toBe('ab');
    expect(journal('kind-valid-edges#3')[0]?.decision).toContain('（ab）');

    // 新規作成
    expect(text('create')).toContain('やり方 review を新しく作った（');
    expect(text('create')).not.toContain('本文の数字・識別子の増減');
    expect(text('create')).toContain('base_version=');
    expect(ops('create')).toEqual(WRITE_ALL);
    expect(ifMatch('create')).toBeNull();
    expect(journal('create')[0]).toMatchObject({
      type: 'decision',
      decision: 'やり方 review（レビュー）を作った: 題',
      grounds: '新しいやり方を器に置いた',
      target: { kind: 'practice', slug: 'review' },
    });
    expect(row('create', 'review')?.versions).toBe(1);
    expect(text('create-content-forms#1')).toContain('やり方 no-newline を新しく作った（');
    expect(row('create-content-forms#1', 'no-newline')?.content).toBe('# 改行なし\n本文\n');
    expect(row('create-content-forms#2', 'with-nul')?.content).not.toContain('\u0000');
    expect(row('create-content-forms#3', 'empty')?.content).toBe('\n');
    expect(row('create-content-forms#4', 'multibyte')?.chars).toBe(18);
    expect(text('create-content-forms#5')).toContain('1506 文字');
    expect(row('create-content-forms#6', 'title-nul')?.title).toBe('題あ');
    expect(journal('create-content-forms#6')[0]?.decision).toContain('題あ');
    expect(text('create-slug-forms')).toContain('やり方 a.b_c-1 を新しく作った');

    // 版の前提
    expect(text('create-with-base-version#1')).toContain(
      'いまそのやり方は無い（読んだ後に消された）',
    );
    expect(text('create-with-base-version#1')).toContain('**何も書いていない**');
    expect(ops('create-with-base-version#1')).toEqual(['practices.read', 'practices.write']);
    expect(ifMatch('create-with-base-version#1')).toBe(practiceVersion(SEED));
    expect(actual['create-with-base-version#1']?.calls.at(-1)?.outcome).toMatch(
      /^threw PracticeConflictError/,
    );
    expect(ops('create-with-base-version#2')).toEqual(WRITE_ALL);
    expect(ifMatch('create-with-base-version#2')).toBeNull();
    expect(text('update-needs-base#1')).toContain('は既に在る。全文を書き直すには');
    expect(text('update-needs-base#1')).toContain('**何も書いていない。**');
    expect(ops('update-needs-base#1')).toEqual(READ);
    expect(text('update-needs-base#2')).toContain('その間に変わった');
    expect(ifMatch('update-needs-base#2')).toBe('');
    expect(ifMatch('update-needs-base#3')).toBe(practiceVersion(SEED));
    expect(text('update-needs-base#3')).toContain('やり方 review を書き直した（');

    // 書き直し
    for (const key of [
      'update#1',
      'update#2',
      'update#3',
      'update#4',
      'update#5',
      'update#6',
      'update#7',
    ]) {
      expect(ops(key), key).toEqual(WRITE_ALL);
      expect(journal(key)[0]?.decision, key).toContain('を書き直した: ');
      expect(journal(key)[0]?.grounds, key).toContain('やり方を書き直した（全文置換。');
    }
    expect(text('update#1')).not.toContain('本文の数字・識別子の増減');
    expect(row('update#1', 'review')?.versions).toBe(2);
    expect(row('update#1', 'review')?.version).toBe(practiceVersion(SEED));
    expect(text('update#2')).toContain('消えた: 42 / `id-7`。増えた: 43 / `id-8`。');
    expect(text('update#3')).not.toContain('本文の数字・識別子の増減');
    expect(text('update#4')).toContain('やり方 review を書き直した（');
    expect(row('update#4', 'review')?.kind).toBe('実装');
    expect(text('update#5')).toContain('本文の数字・識別子の増減');
    expect(text('update#7')).toContain('ほか');

    // 版の食い違い
    expect(text('conflict#1')).toContain('いまの版は base_version=');
    expect(text('conflict#1')).toContain('（7 文字）');
    expect(text('conflict#2')).toContain('いまの版は base_version=');
    expect(text('conflict#3')).toContain('（11 文字）');
    expect(text('conflict#4')).toContain('いまそのやり方は無い（読んだ後に消された）');
    for (const key of ['conflict#1', 'conflict#2', 'conflict#3', 'conflict#4']) {
      expect(text(key), key).toContain('**何も書いていない**');
      expect(actual[key]?.calls.at(-1)?.outcome, key).toMatch(/^threw PracticeConflictError/);
      expect(journal(key), key).toEqual([]);
    }
    expect(ifMatch('conflict#2')).toBe('deadbeef');
    expect(row('conflict#3', 'a3')?.content).toBe('別のターンが書いた\n');
    expect(row('conflict#4', 'a4')).toBeNull();

    // 読めない行
    for (const key of ['unreadable#1', 'unreadable#2', 'unreadable#5']) {
      expect(text(key), key).toContain('（読めない形で入っていたやり方を）書き直した');
      expect(text(key), key).not.toContain('本文の数字・識別子の増減');
      expect(ops(key), key).toEqual(WRITE_ALL);
      expect(actual[key]?.calls[0]?.outcome, key).toMatch(/^threw UnreadablePracticeError/);
      expect(writeCall(key)?.args.ifMatch, key).toBe('(省略)');
      expect(journal(key)[0]?.decision, key).toContain('読めない形で入っていたやり方 ');
      expect(journal(key)[0]?.grounds, key).toContain('前の本文は読めなかった');
    }
    expect(row('unreadable#1', 'u1')?.versions).toBe(2);
    expect(row('unreadable#5', 'u-gone')?.versions).toBe(1);
    // 読めない行の書き直しが済んだあとは読める行で、版の前提が要る
    expect(text('unreadable#3')).toContain('は既に在る。全文を書き直すには');
    expect(ifMatch('unreadable#4')).toBe(practiceVersion({ ...SEED, content: NEW_BODY }));
    expect(text('unreadable#4')).toContain('やり方 review を書き直した（');

    // 例外
    expect(actual['failures#1']?.output).toMatchObject({
      thrown: true,
      errorName: 'Error',
      text: 'ストアが落ちた（read）',
    });
    expect(ops('failures#1')).toEqual(READ);
    expect(actual['failures#2']?.output).toMatchObject({
      thrown: true,
      errorName: 'UnreadablePracticeError',
      text: '読めない行に似た別の例外',
    });
    expect(ops('failures#2')).toEqual(READ);
    for (const key of ['failures#3', 'failures#4', 'failures#5']) {
      expect(actual[key]?.output, key).toMatchObject({
        thrown: true,
        errorName: 'Error',
        text: 'ストアが落ちた（write）',
      });
      expect(ops(key), key).toEqual(['practices.read', 'practices.write']);
      expect(journal(key), key).toEqual([]);
    }
    expect(row('failures#3', 'f3')?.content).toBe(BODY);
    expect(row('failures#4', 'f-new')).toBeNull();
    expect(row('failures#5', 'f4')).toEqual({ unreadable: true });
    for (const key of ['failures#6', 'failures#7', 'failures#8']) {
      expect(actual[key]?.output.errorName, key).toBe('JournalNotRecordedError');
      expect(text(key).split('\n')[0], key).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
      expect(journal(key), key).toEqual([]);
      expect(ops(key), key).toEqual(WRITE_ALL);
      expect(actual[key]?.wrote, key).toBe(true);
    }
    expect(row('failures#6', 'f5')?.content).toBe(NEW_BODY);
    expect(row('failures#7', 'f-new-2')?.content).toBe(BODY);
    expect(row('failures#8', 'f6')?.content).toBe(NEW_BODY);
  });
});
