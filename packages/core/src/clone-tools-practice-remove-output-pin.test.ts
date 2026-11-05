import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { UnreadablePracticeError, practiceVersion, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `practice_remove` の出力と、呼んだあとの状態（やり方の行・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-practice-remove-output-pin.json）と丸ごと比べる。
// `clone-tools-practice.ts` の `tool('practice_remove', …)`（約 66 行の式・入れ子 5 段）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - practices: 場面で触れたやり方を、呼んだあとにストアから読んだ形のまま（版 version・履歴の件数 versions・時刻を含む）。
//     消えた行は `{ absent: true, versions: 履歴の件数 }`（履歴は消えずに残る）。履歴も無ければ null。
//     読めない行を消せなかった場面は `{ unreadable: true }`（行は呼ぶ前のまま残り、読めないままであること）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・target・id・at をそのまま）
//   - calls: ストアの呼びの並び（practices.read・practices.remove（slug と options。ifMatch の有無・値）・journal.append）。
//     道具が呼ぶものは practices と journal だけなので、そのほかの口（list・write など）を呼べばここに出る。
//     口（hooks）が土台を直に書き換える競合は記録に残らない
//   - wrote: やり方か日誌のどれかが呼ぶ前から変わったか。断った・何もしなかった場面は false で、やり方も日誌も呼ぶ前と同じであることを別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PRACTICE_REMOVE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-practice-remove-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-practice-remove-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、やり方・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// やり方は場面の頭に基準時刻で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
//
// 読めない行の作り方: インメモリのストアは行を読めない形で持てないので、`practices.read` が
// `UnreadablePracticeError` を投げる口（hooks.unreadable）で作る（土台には行が在るまま。`remove` は土台のまま通る）。
//
// 作れない分岐: 読めない行（ifMatch なし）の `remove` が `PracticeConflictError` を投げる経路。
// 条件なしの削除は版を比べないのでストアは競合を返せず、実ストアでも起きない（口で無理に投げさせると別の物を固定してしまう）。

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
  removeThrows: boolean;
  journalFails: boolean;
  /** 最初に読んだ直後に、土台を直に書き換える（読んでから消すまでの間に変わる場面） */
  race: RaceSpec | null;
}

const DEFAULT_HOOKS: Hooks = {
  unreadable: false,
  readThrows: false,
  readLookalike: false,
  removeThrows: false,
  journalFails: false,
  race: null,
};

interface Step {
  slug: string;
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
const PIN_URL = new URL('./clone-tools-practice-remove-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PRACTICE_REMOVE_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

// ---- 入力 ----

const BODY = '# 手順\n1. 読む\n2. 数 42 と `id-7` を確かめる\n';
const SEED: SeedPractice = { slug: 'review', kind: 'レビュー', title: '題', content: BODY };
const NEW_BODY = BODY.replace('読む', '読んで直す');

const SCENARIOS: Scenario[] = [
  // ---- スラッグの検査 ----
  {
    name: 'slug-invalid',
    covers:
      'スラッグが不正（英大文字と空白・空・先頭が `.`・`/` を含む・129 字）。版を渡しても渡さなくても断りが先。どれも何も呼ばない',
    seed: [SEED],
    steps: [
      { slug: 'Bad Slug', base: 'none', writes: 'none' },
      { slug: '', base: 'none', writes: 'none' },
      { slug: '.hidden', base: 'none', writes: 'none' },
      { slug: 'a/b', base: 'none', writes: 'none' },
      { slug: 'x'.repeat(129), base: 'none', writes: 'none' },
      { slug: 'Bad Slug', base: { raw: practiceVersion(SEED) }, writes: 'none' },
    ],
  },
  // ---- もともと無い ----
  {
    name: 'not-found',
    covers:
      '無い slug（読んで null）: 「もともと無かった」・日誌を書かない・remove を呼ばない。版を渡しても（でたらめ・空文字）同じ。スラッグの通る形（. _ - 数字）も同じ文言',
    seed: [SEED],
    steps: [
      { slug: 'nothing', base: 'none', writes: 'none' },
      { slug: 'nothing', base: { raw: practiceVersion(SEED) }, writes: 'none' },
      { slug: 'nothing', base: { raw: 'deadbeef' }, writes: 'none' },
      { slug: 'nothing', base: { raw: '' }, writes: 'none' },
      { slug: 'a.b_c-1', base: 'none', writes: 'none' },
    ],
  },
  // ---- 版の前提 ----
  {
    name: 'needs-base',
    covers:
      '在る行に base_version が無い: 何も消さずに断る（remove を呼ばない）。空文字は「無い」ではなく版の食い違いとして remove まで進んで断られる。正しい版を渡すと消える',
    seed: [SEED],
    steps: [
      { slug: 'review', base: 'none', writes: 'none' },
      { slug: 'review', base: { raw: '' }, writes: 'none' },
      { slug: 'review', base: 'current', writes: 'some' },
    ],
  },
  // ---- 消す ----
  {
    name: 'remove',
    covers:
      '正しい版で消す: 応答は「消した」・日誌は decision（kind と title 入り）・grounds・target。行は消える。同じ slug をもう一度呼ぶと「もともと無かった」（日誌も足さない・履歴は残る）',
    seed: [SEED],
    steps: [
      { slug: 'review', base: 'current', writes: 'some' },
      { slug: 'review', base: 'none', writes: 'none' },
      { slug: 'review', base: { raw: practiceVersion(SEED) }, writes: 'none' },
    ],
  },
  {
    name: 'remove-forms',
    covers:
      '消す行の形: 履歴が複数ある（版は消さずに残る）・kind と title が多バイト・title が長い・title が空・本文が空。日誌の decision に kind と title がそのまま入る。スラッグの通る形も消せる',
    seed: [
      { slug: 'h1', kind: '調査', title: '一版目', content: BODY },
      { slug: 'h1', kind: '調査', title: '二版目', content: NEW_BODY },
      { slug: 'h1', kind: '実装', title: '三版目', content: `${NEW_BODY}追記\n` },
      { slug: 'a.b_c-1', kind: '日報', title: '日本語 😀 の題', content: BODY },
      { slug: 'long-title', kind: 'x', title: '長'.repeat(300), content: BODY },
      { slug: 'empty-title', kind: 'x', title: '', content: BODY },
      { slug: 'empty-body', kind: 'x', title: '空', content: '' },
    ],
    steps: [
      { slug: 'h1', base: 'current', writes: 'some' },
      { slug: 'a.b_c-1', base: 'current', writes: 'some' },
      { slug: 'long-title', base: 'current', writes: 'some' },
      { slug: 'empty-title', base: 'current', writes: 'some' },
      { slug: 'empty-body', base: 'current', writes: 'some' },
    ],
  },
  {
    name: 'remove-isolated',
    covers:
      '別の slug は巻き込まない: 2 件のうち 1 件だけ消す。もう 1 件の行・版・履歴は呼ぶ前のまま（practices に両方出る）',
    seed: [
      { ...SEED, slug: 'keep' },
      { ...SEED, slug: 'drop' },
    ],
    steps: [{ slug: 'drop', base: 'current', writes: 'some' }],
  },
  // ---- 版の食い違い ----
  {
    name: 'conflict',
    covers:
      '版の食い違い: 外から書き換えた後の古い版（いまの版と字数を名乗って断る）・でたらめな版・読んだ直後に別の手が書いた（競合）・読んだ直後に別の手が消した（いまそのやり方は無い）。どれも道具は何も消さず、日誌も足さない。remove には渡した ifMatch が残る',
    seed: [
      { ...SEED, slug: 'a1' },
      { ...SEED, slug: 'a2' },
      { ...SEED, slug: 'a3' },
      { ...SEED, slug: 'a4' },
    ],
    steps: [
      {
        slug: 'a1',
        base: 'stale',
        writes: 'none',
        externalEdit: { ...SEED, slug: 'a1', content: '人間が直した\n' },
      },
      { slug: 'a2', base: { raw: 'deadbeef' }, writes: 'none' },
      {
        slug: 'a3',
        base: 'current',
        writes: 'hook',
        hooks: {
          race: { to: { kind: 'レビュー', title: '題', content: '別のターンが書いた\n' } },
        },
      },
      { slug: 'a4', base: 'current', writes: 'hook', hooks: { race: { to: null } } },
    ],
  },
  {
    name: 'conflict-then-retry',
    covers:
      '断られたあと、読み直した版を渡すと消える（古い版で断られる→いまの版で消える）。断られた呼びでは行は残り、2 回目で消える',
    seed: [{ ...SEED, slug: 'r1' }],
    steps: [
      {
        slug: 'r1',
        base: 'stale',
        writes: 'none',
        externalEdit: { ...SEED, slug: 'r1', content: '人間が直した\n' },
      },
      { slug: 'r1', base: 'current', writes: 'some' },
    ],
  },
  {
    name: 'race-identical',
    covers:
      '読んだ直後に別の手が「同じ中身」で書き直した: 版は中身で決まるので同じまま。ifMatch は合って消える（履歴は 1 件増える）',
    seed: [{ ...SEED, slug: 'same' }],
    steps: [
      {
        slug: 'same',
        base: 'current',
        writes: 'some',
        hooks: { race: { to: { kind: SEED.kind, title: SEED.title, content: SEED.content } } },
      },
    ],
  },
  // ---- 読めない行 ----
  {
    name: 'unreadable',
    covers:
      '在ったが読めない行（`read` が `UnreadablePracticeError`）: 版なしで消える・でたらめな版や正しい版を渡しても remove に ifMatch は渡らない（options なし）・行が無いのに読めない扱いでも消した扱いになる。応答は「読めない形で入っていたやり方 … を消した」。日誌は「読めない形で入っていた…」で kind と title は出ない',
    seed: [
      { ...SEED, slug: 'u1' },
      { ...SEED, slug: 'u2' },
      { ...SEED, slug: 'u3' },
    ],
    steps: [
      { slug: 'u1', base: 'none', writes: 'some', hooks: { unreadable: true } },
      { slug: 'u2', base: { raw: 'deadbeef' }, writes: 'some', hooks: { unreadable: true } },
      { slug: 'u3', base: 'current', writes: 'some', hooks: { unreadable: true } },
      { slug: 'u-gone', base: 'none', writes: 'some', hooks: { unreadable: true } },
      { slug: 'u1', base: 'none', writes: 'none' },
    ],
  },
  {
    name: 'unreadable-empty-base',
    covers: '読めない行に空文字の版を渡す: 版は使われず（ifMatch なし）そのまま消える',
    seed: [{ ...SEED, slug: 'u1' }],
    steps: [{ slug: 'u1', base: { raw: '' }, writes: 'some', hooks: { unreadable: true } }],
  },
  // ---- 失敗 ----
  {
    name: 'failures',
    covers:
      '例外: read が別の例外を投げる（そのまま投げる・消さない・日誌なし）・名前だけ UnreadablePracticeError の別の例外（instanceof で見るので投げる）・remove が落ちる（在る行・読めない行。行も日誌も呼ぶ前のまま）・日誌が書けない（行は消えているが日誌は空・「完了済み・未記録・やり直し禁止」の例外。在る行・読めない行）',
    seed: [
      { ...SEED, slug: 'f1' },
      { ...SEED, slug: 'f2' },
      { ...SEED, slug: 'f3' },
      { ...SEED, slug: 'f4' },
      { ...SEED, slug: 'f5' },
      { ...SEED, slug: 'f6' },
    ],
    steps: [
      { slug: 'f1', base: 'current', writes: 'none', hooks: { readThrows: true } },
      { slug: 'f2', base: 'current', writes: 'none', hooks: { readLookalike: true } },
      { slug: 'f3', base: 'current', writes: 'none', hooks: { removeThrows: true } },
      {
        slug: 'f4',
        base: 'none',
        writes: 'none',
        hooks: { unreadable: true, removeThrows: true },
      },
      { slug: 'f5', base: 'current', writes: 'some', hooks: { journalFails: true } },
      {
        slug: 'f6',
        base: 'none',
        writes: 'some',
        hooks: { unreadable: true, journalFails: true },
      },
    ],
  },
  {
    name: 'journal-skipped-when-absent',
    covers:
      '日誌が書けない状態でも、無い slug は日誌を呼ばない（もともと無かったと返る・呼びは read だけ）。版の前提で断る場面も日誌を呼ばない',
    seed: [{ ...SEED, slug: 'j1' }],
    steps: [
      { slug: 'nothing', base: 'none', writes: 'none', hooks: { journalFails: true } },
      { slug: 'j1', base: 'none', writes: 'none', hooks: { journalFails: true } },
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

/** ストアから読める形のまま（`practices.read` の中身）に、版（practiceVersion）と履歴の件数を足したもの。消えた行は `{ absent, versions }`。読めないまま残ったときは `{ unreadable: true }` */
type PinnedPractice = Record<string, unknown>;

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 場面で触れたやり方（呼んだあと）。行も履歴も無ければ null */
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
  const versions = await stores.practices.listVersions(slug);
  if (found === null)
    return versions.length === 0 ? null : { absent: true, versions: versions.length };
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
    write: async (input, options) => {
      calls.push({
        op: 'practices.write',
        args: { input: plain(input), options: options === undefined ? '(なし)' : plain(options) },
        outcome: 'called',
      });
      return base.practices.write(input, options);
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
    remove: async (slug, options) => {
      const now = hooks();
      const args = { slug, options: options === undefined ? '(なし)' : plain(options) };
      try {
        if (now.removeThrows) throw new Error('ストアが落ちた（remove）');
        await base.practices.remove(slug, options);
        calls.push({ op: 'practices.remove', args, outcome: 'ok' });
      } catch (error) {
        calls.push({ op: 'practices.remove', args, outcome: failureOf(error) });
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
  const found = tools.find((entry) => entry.name === 'practice_remove');
  if (!found) throw new Error('practice_remove が無い');

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
    // 読めない行を消せなかった呼びは、行が呼ぶ前のまま残る＝読めないままである
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

describe('practice_remove の出力と呼んだあとの状態の固定（場面ごとの出力の全文・やり方の行・日誌の行・ストアの呼び）', () => {
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
          expect(
            gotRow,
            `場面 ${key} のやり方 ${slug}（版・kind・title・本文・時刻・履歴の件数・消えた／読めないままか）が固定値からずれた`,
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
    const removeCall = (key: string): PinnedCall | undefined =>
      actual[key]?.calls.find((entry) => entry.op === 'practices.remove');
    const removeOptions = (key: string): unknown => removeCall(key)?.args.options;
    const row = (key: string, slug: string): PinnedPractice | null =>
      actual[key]?.practices[slug] ?? null;
    const READ = ['practices.read'];
    const READ_REMOVE = ['practices.read', 'practices.remove'];
    const ALL = ['practices.read', 'practices.remove', 'journal.append'];

    // スラッグの検査: ストアを1つも呼ばない
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

    // もともと無い: 読むだけ・日誌なし
    for (const key of ['not-found#1', 'not-found#2', 'not-found#3', 'not-found#4', 'not-found#5']) {
      expect(text(key), key).toContain('はもともと無かった（何もしていない）。');
      expect(ops(key), key).toEqual(READ);
      expect(journal(key), key).toEqual([]);
    }

    // 版の前提
    expect(text('needs-base#1')).toContain('を消すには、先に practice_read slug=review で読み、');
    expect(text('needs-base#1')).toContain('**何も消していない。**');
    expect(ops('needs-base#1')).toEqual(READ);
    expect(text('needs-base#2')).toContain('その間に変わった');
    expect(text('needs-base#2')).toContain('**何も消していない**');
    expect(ops('needs-base#2')).toEqual(READ_REMOVE);
    expect(removeOptions('needs-base#2')).toEqual({ ifMatch: '' });
    expect(text('needs-base#3')).toBe('やり方 review を消した。');
    expect(removeOptions('needs-base#3')).toEqual({ ifMatch: practiceVersion(SEED) });

    // 消す
    expect(text('remove#1')).toBe('やり方 review を消した。');
    expect(ops('remove#1')).toEqual(ALL);
    expect(journal('remove#1')[0]).toMatchObject({
      type: 'decision',
      decision: 'やり方 review（レビュー）を消した: 題',
      grounds: '不要になったと判断した',
      target: { kind: 'practice', slug: 'review' },
    });
    expect(row('remove#1', 'review')).toEqual({ absent: true, versions: 1 });
    expect(text('remove#2')).toContain('はもともと無かった');
    expect(ops('remove#2')).toEqual(READ);
    expect(row('remove#2', 'review')).toEqual({ absent: true, versions: 1 });
    expect(text('remove#3')).toContain('はもともと無かった');
    expect(row('remove-forms#1', 'h1')).toEqual({ absent: true, versions: 3 });
    expect(journal('remove-forms#1')[0]?.decision).toBe('やり方 h1（実装）を消した: 三版目');
    expect(journal('remove-forms#2')[0]?.decision).toContain('日本語 😀 の題');
    expect(journal('remove-forms#3')[0]?.decision).toContain('長'.repeat(300));
    expect(journal('remove-forms#4')[0]?.decision).toBe('やり方 empty-title（x）を消した: ');
    expect(text('remove-forms#5')).toBe('やり方 empty-body を消した。');
    expect(row('remove-isolated', 'keep')).toMatchObject({ versions: 1 });
    expect(row('remove-isolated', 'drop')).toEqual({ absent: true, versions: 1 });

    // 版の食い違い
    expect(text('conflict#1')).toContain('いまの版は base_version=');
    expect(text('conflict#1')).toContain('（7 文字）');
    expect(text('conflict#2')).toContain('いまの版は base_version=');
    expect(text('conflict#3')).toContain('（10 文字）');
    expect(text('conflict#4')).toContain('いまそのやり方は無い（読んだ後に消された）');
    for (const key of ['conflict#1', 'conflict#2', 'conflict#3', 'conflict#4']) {
      expect(text(key), key).toContain('削除を**しなかった**');
      expect(text(key), key).toContain('**何も消していない**');
      expect(ops(key), key).toEqual(READ_REMOVE);
      expect(actual[key]?.calls.at(-1)?.outcome, key).toMatch(/^threw PracticeConflictError/);
      expect(journal(key), key).toEqual([]);
    }
    expect(removeOptions('conflict#2')).toEqual({ ifMatch: 'deadbeef' });
    expect(row('conflict#3', 'a3')?.content).toBe('別のターンが書いた\n');
    expect(row('conflict#4', 'a4')).toEqual({ absent: true, versions: 1 });
    expect(row('conflict#1', 'a1')?.content).toBe('人間が直した\n');
    expect(row('conflict-then-retry#1', 'r1')?.versions).toBe(2);
    expect(text('conflict-then-retry#2')).toBe('やり方 r1 を消した。');
    expect(row('conflict-then-retry#2', 'r1')).toEqual({ absent: true, versions: 2 });
    expect(text('race-identical')).toBe('やり方 same を消した。');
    expect(ops('race-identical')).toEqual(ALL);
    expect(row('race-identical', 'same')).toEqual({ absent: true, versions: 2 });

    // 読めない行: ifMatch が渡らない（options なし）
    for (const key of ['unreadable#1', 'unreadable#2', 'unreadable#3', 'unreadable#4']) {
      expect(text(key), key).toBe(
        `読めない形で入っていたやり方 ${key === 'unreadable#4' ? 'u-gone' : key.replace('unreadable#', 'u')} を消した。`,
      );
      expect(ops(key), key).toEqual(ALL);
      expect(actual[key]?.calls[0]?.outcome, key).toMatch(/^threw UnreadablePracticeError/);
      expect(removeOptions(key), key).toBe('(なし)');
      expect(journal(key)[0]?.decision, key).toContain('読めない形で入っていたやり方 ');
      expect(journal(key)[0]?.grounds, key).toBe('読めない形で入っていたやり方を外した');
      expect(journal(key)[0]?.decision, key).not.toContain('レビュー');
    }
    expect(removeOptions('unreadable-empty-base')).toBe('(なし)');
    expect(text('unreadable-empty-base')).toBe('読めない形で入っていたやり方 u1 を消した。');
    expect(row('unreadable#1', 'u1')).toEqual({ absent: true, versions: 1 });
    expect(row('unreadable#4', 'u-gone')).toBeNull();
    // 読めない形で消したあと、読める扱いで呼ぶと「もともと無かった」
    expect(text('unreadable#5')).toContain('はもともと無かった');

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
    for (const key of ['failures#3', 'failures#4']) {
      expect(actual[key]?.output, key).toMatchObject({
        thrown: true,
        errorName: 'Error',
        text: 'ストアが落ちた（remove）',
      });
      expect(ops(key), key).toEqual(READ_REMOVE);
      expect(journal(key), key).toEqual([]);
    }
    expect(row('failures#3', 'f3')?.content).toBe(BODY);
    expect(row('failures#4', 'f4')).toEqual({ unreadable: true });
    for (const key of ['failures#5', 'failures#6']) {
      expect(actual[key]?.output.errorName, key).toBe('JournalNotRecordedError');
      expect(text(key).split('\n')[0], key).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
      expect(journal(key), key).toEqual([]);
      expect(ops(key), key).toEqual(ALL);
      expect(actual[key]?.wrote, key).toBe(true);
    }
    expect(row('failures#5', 'f5')).toEqual({ absent: true, versions: 1 });
    expect(row('failures#6', 'f6')).toEqual({ absent: true, versions: 1 });
    expect(text('journal-skipped-when-absent#1')).toContain('はもともと無かった');
    expect(ops('journal-skipped-when-absent#1')).toEqual(READ);
    expect(ops('journal-skipped-when-absent#2')).toEqual(READ);
    expect(text('journal-skipped-when-absent#2')).toContain('を消すには、先に practice_read');
  });
});
