import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import type { Task, TaskOrigin } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `task_keep` の出力（全文と字数）と、呼んだあとの状態（動かした task の行・印のついた task の id・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-task-keep-output-pin.json）と丸ごと比べる。
// `clone-tools-task.ts` の `tool('task_keep', …)`（`tasks.setKeep` → 読めない行の断り・無い・変わらない → 日誌 → 応答）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の題と本文）を固定して毎回同じにする。
// この道具は task の「続く」の印を書き換え、印が変わったときだけ日誌を「変えた後」に書くので、出力に加えて次も場面ごとに固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - row: 引数の taskId の行（ストアから読んだ形のまま。無ければ null。印は `keep: true` で、外すと欄ごと無い）
//   - keptIds: 呼んだあとに印のついた task の id（閉じた件を含む全件。ほかの task の印が動かないことを見る）
//   - journal: 呼んだあとに日誌へ足された行（種類・対象・本文・grounds・id・at をそのまま。書けなかった行は含まない）
//   - dropped: 日誌の書き損じを握ったとき stderr へ残る跡（`noteDroppedRecord`。本文は含まない）
//   - calls: ストアの呼びの並び（tasks.setKeep（渡した taskId と keep・結果の種類）・journal.append（行の全体と成否））
//   - wrote: 呼ぶ前から変わったもの。none（task も日誌も同じ）/ task（印だけ。日誌が書けなかった）/ task-and-journal（印が変わって日誌も足された）。
//     場面ごとの宣言と実際が合うことも確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_KEEP_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-keep-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-keep-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、task・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。task は場面の頭に固定の createdAt で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ場面で続けて呼ぶと状態（印）が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 秘密: task の題・本文は作りもの（`仕事 <id>` / `本文 <id>` ほか）だけ。json の全文に鍵らしい形が無いことを確かめる。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。
// 長い id・題は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

type Writes = 'none' | 'task' | 'task-and-journal';

type Failure = 'unreadable' | 'plain';

interface SeedTask {
  id: string;
  /** createdAt（基準から何分後か） */
  minute: number;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
  /** 省略すると external */
  origin?: TaskOrigin;
  /** 最初から「続く」の印がついている */
  keep?: true;
  /** 省略すると `仕事 <id>` */
  title?: string;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** tasks.setKeep が落ちる */
  setKeepFails?: Failure;
  /** この呼びの journal.append の何回目（1 から）を投げさせるか */
  journalFailsAt?: number[];
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Hooks;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedTask[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const TASK_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const SEED_UPDATED_ISO = '2026-10-02T00:00:00.000Z';
const SEED_CLOSED_ISO = '2026-10-03T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-task-keep-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_KEEP_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteIso(minute: number): string {
  return new Date(TASK_BASE + minute * 60_000).toISOString();
}

function t(
  id: string,
  minute: number,
  extra: Partial<Omit<SeedTask, 'id' | 'minute'>> = {},
): SeedTask {
  return { id, minute, ...extra };
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function k(taskId: string, keep: boolean, writes: Writes, hooks?: Hooks): Step {
  return { args: { taskId, keep }, writes, ...(hooks === undefined ? {} : { hooks }) };
}

const LONG_ID = spaced(200, 'longid');

const SCENARIOS: Scenario[] = [
  {
    name: 'keep-on',
    covers:
      'keep=true で立てる: 「task X の「続く」の印を立てた。返答しても器は自動では done にしない。」。task の行に keep: true が付き、日誌は「立てた」と grounds（自分で task_keep した。…閉じるのは task_set_status）。状態・並び・updatedAt は変わらない。同じ task にもう一度 true は「既に「続く」の印つき」（何もしない）。ほかの task の印は動かない',
    seed: [t('a', 1), t('b', 2)],
    steps: [
      k('a', true, 'task-and-journal'),
      k('a', true, 'none'),
      k('b', true, 'task-and-journal'),
    ],
  },
  {
    name: 'keep-off',
    covers:
      'keep=false で外す: 「task X の「続く」の印を外した。」。task の行から keep が消え、日誌は「外した」と grounds（印を外したので、queued のままなら…器が自動で done にしうる）。印が無いものへの false は「既に印なし」（何もしない）。ほかの task の印は動かない',
    seed: [t('a', 1, { keep: true }), t('b', 2, { keep: true }), t('c', 3)],
    steps: [
      k('a', false, 'task-and-journal'),
      k('a', false, 'none'),
      k('c', false, 'none'),
      k('b', false, 'task-and-journal'),
    ],
  },
  {
    name: 'toggle-sequence',
    covers:
      '立てる・外す・立てる・外すを同じ task へ続ける（呼びごとに日誌が1行ずつ足される。行の at は呼びの時刻）',
    seed: [t('a', 1)],
    steps: [
      k('a', true, 'task-and-journal'),
      k('a', false, 'task-and-journal'),
      k('a', true, 'task-and-journal'),
      k('a', false, 'task-and-journal'),
    ],
  },
  {
    name: 'open-states',
    covers:
      '開いている各状態（queued・waiting・needs_decision）の task に立てる・外す: どの状態でも印だけが変わり、状態は動かない',
    seed: [
      t('q-1', 1),
      t('w-1', 2, { status: 'waiting' }),
      t('n-1', 3, { status: 'needs_decision' }),
    ],
    steps: [
      k('q-1', true, 'task-and-journal'),
      k('w-1', true, 'task-and-journal'),
      k('n-1', true, 'task-and-journal'),
      k('q-1', false, 'task-and-journal'),
      k('w-1', false, 'task-and-journal'),
      k('n-1', false, 'task-and-journal'),
    ],
  },
  {
    name: 'closed',
    covers:
      '閉じた task（done・cancelled）にも立てる・外せる（「開き直したときに効く」）: 状態・閉じた時刻・理由は動かず、印だけが変わる。立っているものへの true・無いものへの false は変わらない',
    seed: [
      t('d-1', 1, { status: 'done' }),
      t('x-1', 2, { status: 'cancelled' }),
      t('d-2', 3, { status: 'done', keep: true }),
    ],
    steps: [
      k('d-1', true, 'task-and-journal'),
      k('x-1', true, 'task-and-journal'),
      k('d-1', true, 'none'),
      k('d-2', false, 'task-and-journal'),
      k('x-1', false, 'task-and-journal'),
      k('x-1', false, 'none'),
    ],
  },
  {
    name: 'origins-and-titles',
    covers:
      '起点の種類（human・manager・external・self）と題の形（200 字・改行入り・絵文字・空白だけに近い短い題）: 日誌の decision は「（id: 題）」と題をそのまま入れる（切り詰めない・改行も畳まない）。起点の種類は日誌の行を変えない',
    seed: [
      t('o-human', 1, { origin: 'human' }),
      t('o-manager', 2, { origin: 'manager' }),
      t('o-external', 3, { origin: 'external' }),
      t('o-self', 4, { origin: 'self' }),
      t('t-long', 5, { title: spaced(200, 'title') }),
      t('t-lines', 6, { title: '一行目\n二行目' }),
      t('t-emoji', 7, { title: '😀 題' }),
      t('t-short', 8, { title: 'x' }),
    ],
    steps: [
      k('o-human', true, 'task-and-journal'),
      k('o-manager', true, 'task-and-journal'),
      k('o-external', true, 'task-and-journal'),
      k('o-self', true, 'task-and-journal'),
      k('t-long', true, 'task-and-journal'),
      k('t-lines', true, 'task-and-journal'),
      k('t-emoji', true, 'task-and-journal'),
      k('t-short', true, 'task-and-journal'),
    ],
  },
  {
    name: 'not-found',
    covers:
      '無い taskId: 「task X は無い（task_list で実在する id を確かめること）。何もしていない。」。keep の真偽に関わらず同じ。空文字・大文字小文字違い・前後の空白も無い扱い。日誌は書かない',
    seed: [t('a', 1)],
    steps: [
      k('no-such', true, 'none'),
      k('no-such', false, 'none'),
      k('', true, 'none'),
      k('A', true, 'none'),
      k(' a', false, 'none'),
    ],
  },
  {
    name: 'unreadable',
    covers:
      '読めない task（`tasks.setKeep` が UnreadableTaskError を投げる）: 例外にせず「task X は読めない形で入っている。読めない形のまま書き直さないので、印を変えていない。」。日誌は書かない。印も変わらない',
    seed: [t('a', 1)],
    steps: [
      k('a', true, 'none', { setKeepFails: 'unreadable' }),
      k('a', false, 'none', { setKeepFails: 'unreadable' }),
    ],
  },
  {
    name: 'set-keep-throws',
    covers:
      '`tasks.setKeep` が UnreadableTaskError 以外で落ちる: 飲み込まず例外のまま出る（THREW。名前と message）。日誌は書かない。印も変わらない',
    seed: [t('a', 1)],
    steps: [
      k('a', true, 'none', { setKeepFails: 'plain' }),
      k('a', false, 'none', { setKeepFails: 'plain' }),
    ],
  },
  {
    name: 'journal-fails',
    covers:
      '印を変えたあとの日誌が書けない: 印は変わった後なので、道具は JournalNotRecordedError を投げ（act-completed）、印は変わったまま残る（巻き戻さない）。握った書き損じの跡（stderr）が1件。その次の呼びは普通に書ける。外す呼びも同じ',
    seed: [t('a', 1), t('b', 2, { keep: true })],
    steps: [
      k('a', true, 'task', { journalFailsAt: [1] }),
      k('a', true, 'none', { journalFailsAt: [1] }),
      k('b', false, 'task', { journalFailsAt: [1] }),
      k('b', true, 'task-and-journal'),
    ],
  },
  {
    name: 'id-forms',
    covers:
      'id の形の境目: 長い id（200 字）・日本語・空白入り・記号入り・数字だけ・絵文字。そのまま応答・日誌の文言・target に出る（切り詰めない）。無い長い id は「無い」',
    seed: [
      t(LONG_ID, 1),
      t('仕事', 2),
      t('with space', 3),
      t('a/b:c', 4),
      t('12345', 5),
      t('😀', 6),
    ],
    steps: [
      k(LONG_ID, true, 'task-and-journal'),
      k('仕事', true, 'task-and-journal'),
      k('with space', true, 'task-and-journal'),
      k('a/b:c', true, 'task-and-journal'),
      k('12345', true, 'task-and-journal'),
      k('😀', true, 'task-and-journal'),
      k(`${LONG_ID}!`, true, 'none'),
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
  /** 例外の名前（投げていなければ null） */
  errorName: string | null;
}

interface PinnedCall {
  op: 'tasks.setKeep' | 'journal.append';
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: Writes;
  /** 引数の taskId の行（ストアから読んだ形のまま。無ければ null） */
  row: Task | null;
  /** 呼んだあとに印のついた task の id（閉じた件を含む全件） */
  keptIds: string[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 日誌の書き損じを握ったときに stderr へ残った跡 */
  dropped: string[];
  /** ストアの呼びの並び */
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

interface Snapshot {
  all: Task[];
  journal: Record<string, unknown>[];
}

async function snapshot(stores: Stores): Promise<Snapshot> {
  return {
    all: plain((await stores.tasks.list({ includeClosed: true })).entries),
    journal: plain(await stores.journal.list({ order: 'asc' })) as Record<string, unknown>[],
  };
}

function failureOf(error: unknown): string {
  const kind = error instanceof UnreadableTaskError ? 'UnreadableTaskError' : 'Error';
  return `threw ${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗を起こす */
function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[]): Stores {
  const tasks: Stores['tasks'] = {
    ...base.tasks,
    setKeep: async (id, keep) => {
      const args = plain({ taskId: id, keep });
      try {
        if (hooks.setKeepFails === 'unreadable') {
          throw new UnreadableTaskError('読めない行（テスト用）');
        }
        if (hooks.setKeepFails === 'plain') throw new Error('ストアが落ちた（setKeep）');
        const result = await base.tasks.setKeep(id, keep);
        calls.push({ op: 'tasks.setKeep', args, outcome: result.kind });
        return result;
      } catch (error) {
        calls.push({ op: 'tasks.setKeep', args, outcome: failureOf(error) });
        throw error;
      }
    },
  };
  return {
    ...base,
    tasks,
    journal: {
      ...base.journal,
      append: async (entry) => {
        // この呼びの中の何回目か（calls は呼びごとに空にする）
        const journalCalls = calls.filter((item) => item.op === 'journal.append').length + 1;
        const args = plain(entry);
        if ((hooks.journalFailsAt ?? []).includes(journalCalls)) {
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

async function seedTasks(base: Stores, seed: readonly SeedTask[]): Promise<void> {
  for (const spec of seed) {
    const closing = spec.status === 'done' || spec.status === 'cancelled';
    const status = spec.status === undefined || closing ? 'queued' : spec.status;
    const task: Task = {
      id: spec.id,
      createdAt: minuteIso(spec.minute),
      updatedAt: status === 'queued' ? minuteIso(spec.minute) : SEED_UPDATED_ISO,
      status,
      origin: spec.origin ?? 'external',
      title: spec.title ?? `仕事 ${spec.id}`,
      body: `本文 ${spec.id}`,
      ...(spec.keep === true ? { keep: true as const } : {}),
    };
    await base.tasks.add(task);
    if (closing && spec.status !== undefined) {
      await base.tasks.setStatus(spec.id, spec.status, {
        reason: '先に閉じた',
        by: 'human',
        at: SEED_CLOSED_ISO,
      });
    }
  }
}

function classify(before: Snapshot, after: Snapshot): Writes {
  const taskChanged = JSON.stringify(before.all) !== JSON.stringify(after.all);
  const journalChanged = before.journal.length !== after.journal.length;
  if (taskChanged && journalChanged) return 'task-and-journal';
  if (taskChanged) return 'task';
  if (journalChanged) throw new Error('日誌だけが変わった（この道具は印を変えずに日誌を書かない）');
  return 'none';
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedTasks(base, scenario.seed);
  const hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const dropped: string[] = [];
  const stores = withHooks(base, hooks, calls);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'task_keep');
  if (!found) throw new Error('task_keep が無い');

  setStderrSinkForTesting((line) => {
    dropped.push(line);
  });
  const results: PinnedStep[] = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const before = await snapshot(base);
      for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
      Object.assign(hooks, step.hooks ?? {});
      calls.length = 0;
      dropped.length = 0;
      vi.setSystemTime(new Date(callTime(index)));
      let output: PinnedOutput;
      try {
        const result = await found.handler(step.args as never, {});
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
          errorName: error instanceof Error ? error.name : null,
        };
      }
      for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
      const after = await snapshot(base);
      const taskId = (step.args as { taskId?: unknown }).taskId;
      results.push({
        output,
        wrote: classify(before, after),
        row: after.all.find((task) => task.id === taskId) ?? null,
        keptIds: after.all.filter((task) => task.keep === true).map((task) => task.id),
        journal: after.journal.slice(before.journal.length),
        dropped: [...dropped],
        calls: plain(calls),
      });
    }
  } finally {
    setStderrSinkForTesting(null);
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

describe('task_keep の出力と呼んだあとの状態の固定（場面ごとの出力の全文・印・日誌の行・ストアの呼び）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };
  let pinnedRaw = '';

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
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 60_000);

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

  it('書き込みの有無が、場面の宣言・固定値と同じ（none と宣言した場面は task も日誌も呼ぶ前と同じ）', () => {
    const mismatched: string[] = [];
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        if (actual[key]?.wrote !== step.writes) {
          mismatched.push(`${key}: 宣言 ${step.writes} / 実際 ${String(actual[key]?.wrote)}`);
        }
        if (pinned.scenarios[key]?.wrote !== step.writes) {
          mismatched.push(`${key}: 固定値の wrote が宣言と違う`);
        }
        if (step.writes === 'none') {
          expect(actual[key]?.journal, `${key}: 書かないはずの日誌に行が足された`).toEqual([]);
        }
      }
    }
    if (mismatched.length > 0) {
      throw new Error(`書き込みの有無が宣言と違う場面: ${mismatched.join(' | ')}`);
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

      it(`${key} の呼んだあとの task の行と印のついた task が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.keptIds, `場面 ${key} の印のついた task の id が変わった`).toEqual(
          want?.keptIds,
        );
        expect(
          got?.row,
          `場面 ${key} の動かした task の行が固定値からずれた（印・状態・時刻など）`,
        ).toEqual(want?.row);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} の呼んだあとに日誌へ足された行と握った跡が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・対象・本文・grounds・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
        expect(got?.dropped, `場面 ${key} の握った書き損じの跡（stderr）が変わった`).toEqual(
          want?.dropped,
        );
      });

      it(`${key} のストアの呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} のストアの呼び: 並び（tasks.setKeep・journal.append）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び: 渡した引数（taskId・keep・日誌の行）か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・印・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値だけ（json の全文に鍵らしい形が無い。task の本文は `本文 <id>` の作りもの）', () => {
    expect(pinnedRaw).not.toMatch(/(^|[^A-Za-z])sk-|ghp_|github_pat_|AKIA|xox[abp]-/);
    expect(pinnedRaw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|Bearer /);
    for (const key of ALL_KEYS) {
      const row = actual[key]?.row;
      if (row !== null && row !== undefined) {
        expect(row.body, `${key}: 本文が作りものでない`).toBe(`本文 ${row.id}`);
      }
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep => {
      const found = actual[key];
      if (found === undefined) throw new Error(`${key} が無い`);
      return found;
    };
    const text = (key: string): string => step(key).output.text;
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const results = (key: string): string[] => step(key).calls.map((entry) => entry.outcome);
    const kept = (key: string): string => step(key).keptIds.join(',');
    const decision = (key: string): string => {
      const entry = step(key).journal[0];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    const grounds = (key: string): string => {
      const entry = step(key).journal[0];
      return typeof entry?.grounds === 'string' ? entry.grounds : '';
    };
    const ON = (id: string): string =>
      `task ${id} の「続く」の印を立てた。返答しても器は自動では done にしない。`;
    const OFF = (id: string): string => `task ${id} の「続く」の印を外した。`;
    const UNCHANGED_ON = (id: string): string =>
      `task ${id} は既に「続く」の印つき。何もしていない。`;
    const UNCHANGED_OFF = (id: string): string => `task ${id} は既に印なし。何もしていない。`;
    const NOT_FOUND = (id: string): string =>
      `task ${id} は無い（task_list で実在する id を確かめること）。何もしていない。`;
    const GROUNDS_ON =
      '自分で task_keep した。起点の会話へ返答しても、この task は器が自動では done にしない（閉じるのは task_set_status）';

    // 立てる
    expect(text('keep-on#1')).toBe(ON('a'));
    expect(kept('keep-on#1')).toBe('a');
    expect(step('keep-on#1').row?.keep).toBe(true);
    expect(ops('keep-on#1')).toEqual(['tasks.setKeep', 'journal.append']);
    expect(results('keep-on#1')[0]).toBe('changed');
    expect(step('keep-on#1').journal[0]).toMatchObject({
      type: 'decision',
      target: { kind: 'task', id: 'a' },
    });
    expect(decision('keep-on#1')).toBe('task の「続く」の印を立てた（a: 仕事 a）');
    expect(grounds('keep-on#1')).toBe(GROUNDS_ON);
    expect(text('keep-on#2')).toBe(UNCHANGED_ON('a'));
    expect(results('keep-on#2')).toEqual(['unchanged']);
    expect(ops('keep-on#2')).toEqual(['tasks.setKeep']);
    expect(kept('keep-on#3')).toBe('a,b');
    expect(step('keep-on#1').row?.status).toBe('queued');
    expect(step('keep-on#1').row?.updatedAt).toBe(step('keep-on#2').row?.updatedAt);

    // 外す
    expect(text('keep-off#1')).toBe(OFF('a'));
    expect(kept('keep-off#1')).toBe('b');
    expect(step('keep-off#1').row?.keep).toBeUndefined();
    expect(decision('keep-off#1')).toBe('task の「続く」の印を外した（a: 仕事 a）');
    expect(grounds('keep-off#1')).toContain(
      '自分で task_keep した。印を外したので、queued のままなら',
    );
    expect(text('keep-off#2')).toBe(UNCHANGED_OFF('a'));
    expect(text('keep-off#3')).toBe(UNCHANGED_OFF('c'));
    expect(ops('keep-off#3')).toEqual(['tasks.setKeep']);
    expect(kept('keep-off#4')).toBe('');
    expect(text('keep-off#4')).toBe(OFF('b'));

    // 往復
    expect(['toggle-sequence#1', 'toggle-sequence#3'].map(text)).toEqual([ON('a'), ON('a')]);
    expect(['toggle-sequence#2', 'toggle-sequence#4'].map(text)).toEqual([OFF('a'), OFF('a')]);
    expect(kept('toggle-sequence#3')).toBe('a');
    expect(kept('toggle-sequence#4')).toBe('');
    expect(step('toggle-sequence#3').journal[0]?.at).not.toBe(
      step('toggle-sequence#1').journal[0]?.at,
    );

    // 状態
    for (const [n, id] of [
      [1, 'q-1'],
      [2, 'w-1'],
      [3, 'n-1'],
    ] as const) {
      expect(text(`open-states#${String(n)}`)).toBe(ON(id));
      expect(text(`open-states#${String(n + 3)}`)).toBe(OFF(id));
    }
    expect(step('open-states#2').row?.status).toBe('waiting');
    expect(step('open-states#3').row?.status).toBe('needs_decision');
    expect(kept('open-states#3')).toBe('q-1,w-1,n-1');
    expect(kept('open-states#6')).toBe('');
    expect(step('closed#1').row?.status).toBe('done');
    expect(step('closed#2').row?.status).toBe('cancelled');
    expect(text('closed#1')).toBe(ON('d-1'));
    expect(text('closed#2')).toBe(ON('x-1'));
    expect(text('closed#3')).toBe(UNCHANGED_ON('d-1'));
    expect(text('closed#4')).toBe(OFF('d-2'));
    expect(text('closed#5')).toBe(OFF('x-1'));
    expect(text('closed#6')).toBe(UNCHANGED_OFF('x-1'));
    // 閉じた件の並びは task の並び順（作成順）ではなくストアの一覧の順（d-1,d-2,x-1）
    expect(kept('closed#2')).toBe('d-1,d-2,x-1');
    expect(kept('closed#5')).toBe('d-1');

    // 起点・題
    for (let n = 1; n <= 4; n += 1) {
      expect(grounds(`origins-and-titles#${String(n)}`), `#${String(n)}`).toBe(GROUNDS_ON);
    }
    expect(decision('origins-and-titles#1')).toBe(
      'task の「続く」の印を立てた（o-human: 仕事 o-human）',
    );
    expect(decision('origins-and-titles#5')).toBe(
      `task の「続く」の印を立てた（t-long: ${spaced(200, 'title')}）`,
    );
    expect(decision('origins-and-titles#6')).toBe(
      'task の「続く」の印を立てた（t-lines: 一行目\n二行目）',
    );
    expect(decision('origins-and-titles#7')).toBe('task の「続く」の印を立てた（t-emoji: 😀 題）');
    expect(decision('origins-and-titles#8')).toBe('task の「続く」の印を立てた（t-short: x）');

    // 無い・読めない・落ちる
    expect(text('not-found#1')).toBe(NOT_FOUND('no-such'));
    expect(text('not-found#2')).toBe(NOT_FOUND('no-such'));
    expect(text('not-found#3')).toBe(NOT_FOUND(''));
    expect(text('not-found#4')).toBe(NOT_FOUND('A'));
    expect(text('not-found#5')).toBe(NOT_FOUND(' a'));
    for (let n = 1; n <= 5; n += 1) {
      expect(results(`not-found#${String(n)}`)).toEqual(['not-found']);
      expect(ops(`not-found#${String(n)}`)).toEqual(['tasks.setKeep']);
    }
    for (const key of ['unreadable#1', 'unreadable#2']) {
      expect(step(key).output.thrown, key).toBe(false);
      expect(text(key), key).toBe(
        'task a は読めない形で入っている。読めない形のまま書き直さないので、印を変えていない。',
      );
      expect(ops(key), key).toEqual(['tasks.setKeep']);
      expect(results(key)[0], key).toContain('threw UnreadableTaskError');
      expect(kept(key), key).toBe('');
    }
    for (const key of ['set-keep-throws#1', 'set-keep-throws#2']) {
      expect(step(key).output.thrown, key).toBe(true);
      expect(step(key).output.errorName, key).toBe('Error');
      expect(text(key), key).toBe('ストアが落ちた（setKeep）');
      expect(ops(key), key).toEqual(['tasks.setKeep']);
    }
    expect(step('journal-fails#1').output.thrown).toBe(true);
    expect(step('journal-fails#1').output.errorName).toBe('JournalNotRecordedError');
    expect(kept('journal-fails#1')).toBe('a,b');
    expect(step('journal-fails#1').journal).toEqual([]);
    expect(step('journal-fails#1').dropped).toHaveLength(1);
    expect(ops('journal-fails#1')).toEqual(['tasks.setKeep', 'journal.append']);
    // 印は前の呼びで立った後なので変わらず、日誌も書かない（落ちる日誌の口まで届かない）
    expect(step('journal-fails#2').output.thrown).toBe(false);
    expect(text('journal-fails#2')).toBe(UNCHANGED_ON('a'));
    expect(step('journal-fails#2').dropped).toEqual([]);
    expect(step('journal-fails#3').output.thrown).toBe(true);
    expect(kept('journal-fails#3')).toBe('a');
    expect(step('journal-fails#4').output.thrown).toBe(false);
    expect(text('journal-fails#4')).toBe(ON('b'));
    expect(step('journal-fails#4').dropped).toEqual([]);

    // id の形
    expect(text('id-forms#1')).toBe(ON(LONG_ID));
    expect(decision('id-forms#1')).toBe(
      `task の「続く」の印を立てた（${LONG_ID}: 仕事 ${LONG_ID}）`,
    );
    expect(text('id-forms#2')).toBe(ON('仕事'));
    expect(text('id-forms#3')).toBe(ON('with space'));
    expect(text('id-forms#4')).toBe(ON('a/b:c'));
    expect(text('id-forms#5')).toBe(ON('12345'));
    expect(text('id-forms#6')).toBe(ON('😀'));
    expect(text('id-forms#7')).toBe(NOT_FOUND(`${LONG_ID}!`));
    expect(LONG_ID).toHaveLength(200);
  });
});
