import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import type { Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `task_move` の出力（全文と字数）と、呼んだあとの状態（開いている task の並び・動かした task の行・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-task-move-output-pin.json）と丸ごと比べる。
// `clone-tools-task.ts` の `tool('task_move', …)`（置き場所の検査 → `tasks.move` → 種類ごとの断り → 日誌 → 応答）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の本文）を固定して毎回同じにする。
// この道具は開いている task の並びを書き換え、動かせたときだけ日誌を「動かした後」に書くので、出力に加えて次も場面ごとに固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外なら名前と文言）
//   - openOrder: 呼んだあとの開いている task の並び（id の順。先頭が先にやるもの）
//   - moved: 引数の taskId の行（ストアから読んだ形のまま。無ければ null）
//   - journal: 呼んだあとに日誌へ足された行（種類・対象・本文・grounds・id・at をそのまま。書けなかった行は含まない）
//   - dropped: 日誌の書き損じを握ったとき stderr へ残る跡（`noteDroppedRecord`。本文は含まない）
//   - calls: ストアの呼びの並び（tasks.move（渡した taskId と置き場所・結果の種類）・journal.append（行の全体と成否））
//   - wrote: 呼ぶ前から変わったもの。none（並びも日誌も同じ）/ journal（日誌だけ。同じ所へ動かした）/ task（並びだけ。日誌が書けなかった）/
//     task-and-journal（動いて日誌も足された）。場面ごとの宣言と実際が合うことも確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_MOVE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-move-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-move-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、並び・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。task は場面の頭に固定の createdAt で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ場面で続けて呼ぶと状態（並び）が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 秘密: task の題・本文は作りもの（`仕事 <id>` / `本文 <id>`）だけ。json の全文に鍵らしい形が無いことを確かめる。
// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない（`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。
// 長い id は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

type Writes = 'none' | 'journal' | 'task' | 'task-and-journal';

type Failure = 'unreadable' | 'plain';

interface SeedTask {
  id: string;
  /** createdAt（基準から何分後か） */
  minute: number;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** tasks.move が落ちる */
  moveFails?: Failure;
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
const PIN_URL = new URL('./clone-tools-task-move-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_MOVE_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteIso(minute: number): string {
  return new Date(TASK_BASE + minute * 60_000).toISOString();
}

function t(id: string, minute: number, status?: SeedTask['status']): SeedTask {
  return status === undefined ? { id, minute } : { id, minute, status };
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function mv(
  taskId: string,
  to: string,
  anchorId: string | undefined,
  writes: Writes,
  hooks?: Hooks,
): Step {
  const args: Args = anchorId === undefined ? { taskId, to } : { taskId, to, anchorId };
  return { args, writes, ...(hooks === undefined ? {} : { hooks }) };
}

/** a b c d e の5件（作成の古い順 ＝ 既定の並び） */
const FIVE = [t('a', 1), t('b', 2), t('c', 3), t('d', 4), t('e', 5)];
const THREE = [t('a', 1), t('b', 2), t('c', 3)];
const LONG_ID = spaced(200, 'longid');

const SCENARIOS: Scenario[] = [
  // ---- front ----
  {
    name: 'to-front',
    covers:
      'to=front: 真ん中の件・末尾の件を先頭へ動かす。先頭の件を先頭へ（並びは動かないが、動かせたので日誌は書く）。anchorId は付けない',
    seed: FIVE,
    steps: [
      mv('c', 'front', undefined, 'task-and-journal'),
      mv('e', 'front', undefined, 'task-and-journal'),
      mv('e', 'front', undefined, 'journal'),
    ],
  },
  // ---- back ----
  {
    name: 'to-back',
    covers:
      'to=back: 先頭の件・真ん中の件を末尾へ動かす。末尾の件を末尾へ（並びは動かないが日誌は書く）',
    seed: FIVE,
    steps: [
      mv('a', 'back', undefined, 'task-and-journal'),
      mv('c', 'back', undefined, 'task-and-journal'),
      mv('c', 'back', undefined, 'journal'),
    ],
  },
  // ---- before ----
  {
    name: 'to-before',
    covers:
      'to=before: 基準の直前へ。末尾を先頭の直前へ・先頭を末尾の直前へ・真ん中の件を真ん中の直前へ。すでに基準の直前にある件を同じ基準の直前へ（並びは動かない）',
    seed: FIVE,
    steps: [
      mv('e', 'before', 'a', 'task-and-journal'),
      mv('e', 'before', 'a', 'journal'),
      mv('e', 'before', 'c', 'task-and-journal'),
      mv('a', 'before', 'b', 'journal'),
    ],
  },
  // ---- after ----
  {
    name: 'to-after',
    covers:
      'to=after: 基準の直後へ。先頭を末尾の直後へ・末尾を先頭の直後へ・真ん中の件を真ん中の直後へ。すでに基準の直後にある件を同じ基準の直後へ（並びは動かない）',
    seed: FIVE,
    steps: [
      mv('a', 'after', 'e', 'task-and-journal'),
      mv('a', 'after', 'e', 'journal'),
      mv('e', 'after', 'b', 'task-and-journal'),
      mv('b', 'after', 'a', 'task-and-journal'),
    ],
  },
  {
    name: 'three-items',
    covers:
      '3件の並びで真ん中の件を動かす（front / back / before / after）。3件の真ん中を真ん中の直前・直後へ',
    seed: THREE,
    steps: [
      mv('b', 'front', undefined, 'task-and-journal'),
      mv('b', 'back', undefined, 'task-and-journal'),
      mv('b', 'before', 'a', 'task-and-journal'),
      mv('b', 'after', 'c', 'task-and-journal'),
    ],
  },
  {
    name: 'one-item',
    covers:
      '1件だけの並び: front / back を同じ所へ動かす（日誌は書く）。before / after の基準は自分自身しか居ないので断られる',
    seed: [t('only', 1)],
    steps: [
      mv('only', 'front', undefined, 'journal'),
      mv('only', 'back', undefined, 'journal'),
      mv('only', 'before', 'only', 'none'),
      mv('only', 'after', 'only', 'none'),
    ],
  },
  {
    name: 'open-states',
    covers:
      '開いている件は状態（queued / waiting / needs_decision）に関わらず動かせる。基準にもできる。閉じた件が並びに混ざっていても、開いている件の並びだけが動く',
    seed: [
      t('q-1', 1),
      t('w-1', 2, 'waiting'),
      t('n-1', 3, 'needs_decision'),
      t('d-1', 4, 'done'),
      t('q-2', 5),
    ],
    steps: [
      mv('w-1', 'front', undefined, 'task-and-journal'),
      mv('n-1', 'back', undefined, 'task-and-journal'),
      mv('q-2', 'before', 'w-1', 'task-and-journal'),
      mv('q-1', 'after', 'n-1', 'task-and-journal'),
    ],
  },

  // ---- 置き場所の検査 ----
  {
    name: 'placement-invalid',
    covers:
      '置き場所の検査（resolveTaskPlacement）の断り: before / after で anchorId が無い・空文字、front / back で anchorId を渡す（空文字でも）、to が無く anchorId だけ（#10）。いずれも `tasks.move` を呼ばず、並び・日誌は変わらない。検査をすり抜ける入力（#9 to も anchorId も無い: placement が undefined のまま tasks.move へ渡り TypeError が例外のまま出る。#11 未知の to: ストアが anchor-not-found）は zod の入力スキーマが先に断るので道具の外からは来ない。いまの振る舞いのまま固定する',
    seed: THREE,
    steps: [
      mv('a', 'before', undefined, 'none'),
      mv('a', 'after', undefined, 'none'),
      mv('a', 'before', '', 'none'),
      mv('a', 'after', '', 'none'),
      mv('a', 'front', 'b', 'none'),
      mv('a', 'back', 'b', 'none'),
      mv('a', 'front', '', 'none'),
      mv('a', 'back', '', 'none'),
      { args: { taskId: 'a' }, writes: 'none' },
      { args: { taskId: 'a', anchorId: 'b' }, writes: 'none' },
      mv('a', 'middle', undefined, 'none'),
    ],
  },
  {
    name: 'placement-invalid-before-lookup',
    covers:
      '置き場所の検査は task の有無・閉じているかの検査より先: 無い id・閉じた件でも、置き場所が不正なら置き場所の断りが出る（tasks.move を呼ばない）',
    seed: [t('a', 1), t('d-1', 2, 'done')],
    steps: [
      mv('no-such', 'before', undefined, 'none'),
      mv('d-1', 'front', 'a', 'none'),
      mv('a', 'before', 'no-such', 'none'),
    ],
  },

  // ---- 動かせない ----
  {
    name: 'not-found',
    covers:
      '無い taskId: 「task X は無い（task_list で実在する id を確かめること）。何もしていない。」。空文字・大文字小文字違い・前後の空白も無い扱い。basis が無くても anchor の検査より先',
    seed: THREE,
    steps: [
      mv('no-such', 'front', undefined, 'none'),
      mv('', 'front', undefined, 'none'),
      mv('A', 'back', undefined, 'none'),
      mv(' a', 'front', undefined, 'none'),
      mv('no-such', 'before', 'a', 'none'),
      mv('no-such', 'before', 'no-anchor', 'none'),
    ],
  },
  {
    name: 'closed',
    covers:
      '閉じた task（done・cancelled）は動かせない: 「task X は閉じている（並びに載っていない）ので動かせない。戻すなら task_set_status で queued にする。」。front / back / before / after のどれでも同じ。anchor が無くても閉じている断りが先',
    seed: [t('a', 1), t('d-1', 2, 'done'), t('x-1', 3, 'cancelled'), t('b', 4)],
    steps: [
      mv('d-1', 'front', undefined, 'none'),
      mv('x-1', 'back', undefined, 'none'),
      mv('d-1', 'before', 'a', 'none'),
      mv('x-1', 'after', 'b', 'none'),
      mv('d-1', 'before', 'no-anchor', 'none'),
      mv('d-1', 'before', 'd-1', 'none'),
    ],
  },
  {
    name: 'anchor-is-self',
    covers:
      'anchorId が動かす task 自身: 「anchorId に動かす task 自身は指せない。何もしていない。」。before / after の両方。先頭・末尾・真ん中の件で同じ',
    seed: THREE,
    steps: [
      mv('a', 'before', 'a', 'none'),
      mv('b', 'after', 'b', 'none'),
      mv('c', 'before', 'c', 'none'),
    ],
  },
  {
    name: 'anchor-not-found',
    covers:
      'anchorId が開いている件に無い: 無い id・閉じた件（done・cancelled）・空白・大文字小文字違いは基準にできない: 「anchorId X は開いている task に無い（閉じた件・無い id は基準にできない）。何も動かしていない。」',
    seed: [t('a', 1), t('b', 2), t('d-1', 3, 'done'), t('x-1', 4, 'cancelled')],
    steps: [
      mv('a', 'before', 'no-such', 'none'),
      mv('a', 'after', 'd-1', 'none'),
      mv('b', 'before', 'x-1', 'none'),
      mv('a', 'after', ' b', 'none'),
      mv('a', 'before', 'B', 'none'),
    ],
  },

  // ---- ストアの失敗 ----
  {
    name: 'unreadable',
    covers:
      '読めない task（`tasks.move` が UnreadableTaskError を投げる）: 例外にせず「task X は読めない形で入っている。読めない形のまま書き直さないので、動かしていない。」。日誌は書かない。並びも変わらない',
    seed: THREE,
    steps: [
      mv('a', 'front', undefined, 'none', { moveFails: 'unreadable' }),
      mv('b', 'before', 'a', 'none', { moveFails: 'unreadable' }),
    ],
  },
  {
    name: 'move-throws',
    covers:
      '`tasks.move` が UnreadableTaskError 以外で落ちる: 飲み込まず例外のまま出る（THREW。名前と message）。日誌は書かない。並びも変わらない',
    seed: THREE,
    steps: [
      mv('a', 'back', undefined, 'none', { moveFails: 'plain' }),
      mv('a', 'before', 'b', 'none', { moveFails: 'plain' }),
    ],
  },
  {
    name: 'journal-fails',
    covers:
      '動かせたあとの日誌が書けない: 並びは動いた後なので、道具は JournalNotRecordedError を投げ（act-completed）、並びは動いたまま残る（巻き戻さない）。握った書き損じの跡（stderr）が1件。同じ所へ動かした呼びは並びが同じで日誌だけ落ちる。その次の呼びは普通に書ける',
    seed: THREE,
    steps: [
      mv('c', 'front', undefined, 'task', { journalFailsAt: [1] }),
      mv('c', 'front', undefined, 'none', { journalFailsAt: [1] }),
      mv('a', 'back', undefined, 'task-and-journal'),
    ],
  },

  // ---- id の形 ----
  {
    name: 'id-forms',
    covers:
      'id の形の境目: 長い id（200 字）・日本語・空白入り・記号入り・数字だけ・絵文字。そのまま応答・日誌の文言・target に出る（切り詰めない）。anchorId が長い id でも同じ。無い長い id は「無い」',
    seed: [
      t(LONG_ID, 1),
      t('仕事', 2),
      t('with space', 3),
      t('a/b:c', 4),
      t('12345', 5),
      t('😀', 6),
    ],
    steps: [
      mv(LONG_ID, 'back', undefined, 'task-and-journal'),
      mv('仕事', 'front', undefined, 'journal'),
      mv('with space', 'before', LONG_ID, 'task-and-journal'),
      mv('a/b:c', 'after', '仕事', 'journal'),
      mv('12345', 'before', '😀', 'journal'),
      mv('😀', 'after', 'with space', 'task-and-journal'),
      mv(`${LONG_ID}!`, 'front', undefined, 'none'),
      mv('a/b:c', 'before', `${LONG_ID}!`, 'none'),
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
  op: 'tasks.move' | 'journal.append';
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: Writes;
  /** 呼んだあとの開いている task の並び（id の順） */
  openOrder: string[];
  /** 引数の taskId の行（ストアから読んだ形のまま。無ければ null） */
  moved: Task | null;
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
  openOrder: string[];
  journal: Record<string, unknown>[];
}

async function snapshot(stores: Stores): Promise<Snapshot> {
  const all = plain((await stores.tasks.list({ includeClosed: true })).entries);
  const open = (await stores.tasks.list({ includeClosed: false })).entries;
  return {
    all,
    openOrder: open.map((task) => task.id),
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
    move: async (id, placement) => {
      const args = plain({ taskId: id, placement });
      try {
        if (hooks.moveFails === 'unreadable') {
          throw new UnreadableTaskError('読めない行（テスト用）');
        }
        if (hooks.moveFails === 'plain') throw new Error('ストアが落ちた（move）');
        const result = await base.tasks.move(id, placement);
        calls.push({ op: 'tasks.move', args, outcome: result.kind });
        return result;
      } catch (error) {
        calls.push({ op: 'tasks.move', args, outcome: failureOf(error) });
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
      origin: 'external',
      title: `仕事 ${spec.id}`,
      body: `本文 ${spec.id}`,
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
  const taskChanged =
    JSON.stringify(before.all) !== JSON.stringify(after.all) ||
    JSON.stringify(before.openOrder) !== JSON.stringify(after.openOrder);
  const journalChanged = before.journal.length !== after.journal.length;
  if (taskChanged && journalChanged) return 'task-and-journal';
  if (taskChanged) return 'task';
  if (journalChanged) return 'journal';
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
  const found = tools.find((entry) => entry.name === 'task_move');
  if (!found) throw new Error('task_move が無い');

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
        openOrder: after.openOrder,
        moved: after.all.find((task) => task.id === taskId) ?? null,
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

describe('task_move の出力と呼んだあとの状態の固定（場面ごとの出力の全文・並び・日誌の行・ストアの呼び）', () => {
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

  it('書き込みの有無が、場面の宣言・固定値と同じ（none と宣言した場面は並びも日誌も呼ぶ前と同じ）', () => {
    const mismatched: string[] = [];
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        if (actual[key]?.wrote !== step.writes) {
          mismatched.push(`${key}: 宣言 ${step.writes} / 実際 ${String(actual[key]?.wrote)}`);
        }
      }
    }
    if (mismatched.length > 0) {
      throw new Error(`書き込みの有無が宣言と違う場面: ${mismatched.join(' | ')}`);
    }
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes);
        expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote が宣言と違う`).toBe(
          step.writes,
        );
        if (step.writes === 'none') {
          expect(actual[key]?.journal, `${key}: 書かないはずの日誌に行が足された`).toEqual([]);
        }
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

      it(`${key} の呼んだあとの開いている task の並びと動かした task の行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got?.openOrder, `場面 ${key} の開いている task の並び（id）が変わった`).toEqual(
          want?.openOrder,
        );
        expect(
          got?.moved,
          `場面 ${key} の動かした task の行が固定値からずれた（状態・時刻など）`,
        ).toEqual(want?.moved);
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
          `場面 ${key} のストアの呼び: 並び（tasks.move・journal.append）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び: 渡した引数（taskId・置き場所・日誌の行）か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・並び・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('作りものの値だけ（json の全文に鍵らしい形が無い。task の題・本文は `仕事`・`本文` の作りもの）', () => {
    expect(pinnedRaw).not.toMatch(
      /(^|[^A-Za-z])sk-|ghp_|github_pat_|AKIA|xox[abp]-|BEGIN [A-Z ]*PRIVATE KEY/,
    );
    expect(pinnedRaw).not.toMatch(/Bearer /);
    for (const key of ALL_KEYS) {
      for (const task of actual[key]?.moved === null ? [] : [actual[key]?.moved]) {
        expect(task?.title, `${key}: 題が作りものでない`).toBe(`仕事 ${task?.id}`);
        expect(task?.body, `${key}: 本文が作りものでない`).toBe(`本文 ${task?.id}`);
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
    const order = (key: string): string => step(key).openOrder.join(',');
    const ops = (key: string): string[] => step(key).calls.map((entry) => entry.op);
    const results = (key: string): string[] => step(key).calls.map((entry) => entry.outcome);
    const decision = (key: string): string => {
      const entry = step(key).journal[0];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    const NOT_FOUND = (id: string): string =>
      `task ${id} は無い（task_list で実在する id を確かめること）。何もしていない。`;
    const CLOSED = (id: string): string =>
      `task ${id} は閉じている（並びに載っていない）ので動かせない。戻すなら task_set_status で queued にする。`;
    const ANCHOR_SELF = 'anchorId に動かす task 自身は指せない。何もしていない。';
    const ANCHOR_MISSING = (id: string): string =>
      `anchorId ${id} は開いている task に無い（閉じた件・無い id は基準にできない）。何も動かしていない。`;

    // 動く
    expect(text('to-front#1')).toBe('task c を先頭へ動かした。');
    expect(order('to-front#1')).toBe('c,a,b,d,e');
    expect(order('to-front#2')).toBe('e,c,a,b,d');
    expect(order('to-front#3')).toBe('e,c,a,b,d');
    expect(decision('to-front#1')).toBe('task の並びを変えた（c）: 先頭へ');
    expect(step('to-front#1').journal[0]).toMatchObject({
      type: 'decision',
      target: { kind: 'task', id: 'c' },
      grounds: '自分で task_move した',
    });
    expect(ops('to-front#1')).toEqual(['tasks.move', 'journal.append']);
    expect(ops('to-front#3')).toEqual(['tasks.move', 'journal.append']);
    expect(text('to-back#1')).toBe('task a を末尾へ動かした。');
    expect(order('to-back#1')).toBe('b,c,d,e,a');
    expect(order('to-back#2')).toBe('b,d,e,a,c');
    expect(order('to-back#3')).toBe('b,d,e,a,c');
    expect(text('to-before#1')).toBe('task e をa の直前へ動かした。');
    expect(order('to-before#1')).toBe('e,a,b,c,d');
    expect(order('to-before#2')).toBe('e,a,b,c,d');
    expect(order('to-before#3')).toBe('a,b,e,c,d');
    expect(order('to-before#4')).toBe('a,b,e,c,d');
    expect(text('to-after#1')).toBe('task a をe の直後へ動かした。');
    expect(order('to-after#1')).toBe('b,c,d,e,a');
    expect(order('to-after#2')).toBe('b,c,d,e,a');
    expect(order('to-after#3')).toBe('b,e,c,d,a');
    expect(order('to-after#4')).toBe('e,c,d,a,b');
    expect(text('to-after#4')).toBe('task b をa の直後へ動かした。');
    expect(text('three-items#1')).toBe('task b を先頭へ動かした。');
    expect(order('three-items#1')).toBe('b,a,c');
    expect(order('three-items#2')).toBe('a,c,b');
    expect(order('three-items#3')).toBe('b,a,c');
    expect(order('three-items#4')).toBe('a,c,b');
    expect(ops('one-item#1')).toEqual(['tasks.move', 'journal.append']);
    expect(order('one-item#2')).toBe('only');
    expect(text('one-item#3')).toBe(ANCHOR_SELF);
    expect(text('one-item#4')).toBe(ANCHOR_SELF);
    expect(order('open-states#1')).toBe('w-1,q-1,n-1,q-2');
    expect(order('open-states#2')).toBe('w-1,q-1,q-2,n-1');
    expect(order('open-states#3')).toBe('q-2,w-1,q-1,n-1');
    expect(order('open-states#4')).toBe('q-2,w-1,n-1,q-1');
    expect(step('open-states#4').moved?.status).toBe('queued');
    expect(step('open-states#1').moved?.status).toBe('waiting');
    expect(step('open-states#2').moved?.status).toBe('needs_decision');

    // 置き場所の検査
    expect(text('placement-invalid#1')).toBe(
      'to=before には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#2')).toBe(
      'to=after には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#3')).toBe(
      'to=before には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#4')).toBe(
      'to=after には anchorId（基準にする task の id）が要る。',
    );
    expect(text('placement-invalid#5')).toBe(
      'to=front に anchorId は付けられない（before / after のときだけ使う）。',
    );
    expect(text('placement-invalid#6')).toBe(
      'to=back に anchorId は付けられない（before / after のときだけ使う）。',
    );
    expect(text('placement-invalid#7')).toContain('to=front に anchorId は付けられない');
    expect(text('placement-invalid#8')).toContain('to=back に anchorId は付けられない');
    expect(text('placement-invalid#10')).toBe(
      'anchorId だけでは置き場所が決まらない。to に before か after を渡すこと。',
    );
    for (let n = 1; n <= 8; n += 1) {
      expect(ops(`placement-invalid#${String(n)}`), `placement-invalid#${String(n)}`).toEqual([]);
      expect(step(`placement-invalid#${String(n)}`).output.isError).toBe(false);
    }
    expect(ops('placement-invalid#10')).toEqual([]);
    // 検査をすり抜ける入力（zod の入力スキーマが先に断るので道具の外からは来ない）: いまの振る舞いのまま固定する
    // to が無く anchorId も無い: placement が undefined のまま tasks.move へ渡り、ストアが TypeError で落ちる（例外のまま出る）
    expect(step('placement-invalid#9').output.thrown).toBe(true);
    expect(step('placement-invalid#9').output.errorName).toBe('TypeError');
    expect(text('placement-invalid#9')).toBe(
      "Cannot read properties of undefined (reading 'kind')",
    );
    expect(ops('placement-invalid#9')).toEqual(['tasks.move']);
    // 未知の to（middle）: 検査は通り、ストアは anchorId の無い before / after 扱いで anchor-not-found を返す
    expect(text('placement-invalid#11')).toBe(
      'anchorId undefined は開いている task に無い（閉じた件・無い id は基準にできない）。何も動かしていない。',
    );
    expect(ops('placement-invalid#11')).toEqual(['tasks.move']);
    for (let n = 1; n <= 2; n += 1) {
      expect(ops(`placement-invalid-before-lookup#${String(n)}`)).toEqual([]);
    }
    // #3 は置き場所として正しい（無い基準）ので、ストアまで届いて anchor-not-found
    expect(ops('placement-invalid-before-lookup#3')).toEqual(['tasks.move']);
    expect(text('placement-invalid-before-lookup#3')).toContain(
      'anchorId no-such は開いている task に無い',
    );
    expect(text('placement-invalid-before-lookup#1')).toContain('to=before には anchorId');
    expect(text('placement-invalid-before-lookup#2')).toContain(
      'to=front に anchorId は付けられない',
    );

    // 動かせない
    expect(text('not-found#1')).toBe(NOT_FOUND('no-such'));
    expect(text('not-found#2')).toBe(NOT_FOUND(''));
    expect(text('not-found#3')).toBe(NOT_FOUND('A'));
    expect(text('not-found#4')).toBe(NOT_FOUND(' a'));
    expect(text('not-found#5')).toBe(NOT_FOUND('no-such'));
    expect(text('not-found#6')).toBe(NOT_FOUND('no-such'));
    for (let n = 1; n <= 6; n += 1) {
      expect(results(`not-found#${String(n)}`)).toEqual(['not-found']);
    }
    expect(text('closed#1')).toBe(CLOSED('d-1'));
    expect(text('closed#2')).toBe(CLOSED('x-1'));
    expect(text('closed#3')).toBe(CLOSED('d-1'));
    expect(text('closed#4')).toBe(CLOSED('x-1'));
    expect(text('closed#5')).toBe(CLOSED('d-1'));
    expect(text('closed#6')).toBe(CLOSED('d-1'));
    for (let n = 1; n <= 6; n += 1) expect(results(`closed#${String(n)}`)).toEqual(['closed']);
    for (let n = 1; n <= 3; n += 1) {
      expect(text(`anchor-is-self#${String(n)}`)).toBe(ANCHOR_SELF);
      expect(results(`anchor-is-self#${String(n)}`)).toEqual(['anchor-is-self']);
    }
    expect(text('anchor-not-found#1')).toBe(ANCHOR_MISSING('no-such'));
    expect(text('anchor-not-found#2')).toBe(ANCHOR_MISSING('d-1'));
    expect(text('anchor-not-found#3')).toBe(ANCHOR_MISSING('x-1'));
    expect(text('anchor-not-found#4')).toBe(ANCHOR_MISSING(' b'));
    expect(text('anchor-not-found#5')).toBe(ANCHOR_MISSING('B'));
    for (let n = 1; n <= 5; n += 1) {
      expect(results(`anchor-not-found#${String(n)}`)).toEqual(['anchor-not-found']);
    }

    // ストアの失敗
    for (const key of ['unreadable#1', 'unreadable#2']) {
      expect(step(key).output.thrown, key).toBe(false);
      expect(text(key), key).toContain(
        'は読めない形で入っている。読めない形のまま書き直さないので、動かしていない。',
      );
      expect(ops(key), key).toEqual(['tasks.move']);
      expect(results(key)[0], key).toContain('threw UnreadableTaskError');
    }
    for (const key of ['move-throws#1', 'move-throws#2']) {
      expect(step(key).output.thrown, key).toBe(true);
      expect(step(key).output.errorName, key).toBe('Error');
      expect(text(key), key).toBe('ストアが落ちた（move）');
      expect(ops(key), key).toEqual(['tasks.move']);
    }
    expect(step('journal-fails#1').output.thrown).toBe(true);
    expect(step('journal-fails#1').output.errorName).toBe('JournalNotRecordedError');
    expect(order('journal-fails#1')).toBe('c,a,b');
    expect(step('journal-fails#1').journal).toEqual([]);
    expect(step('journal-fails#1').dropped).toHaveLength(1);
    expect(ops('journal-fails#1')).toEqual(['tasks.move', 'journal.append']);
    expect(step('journal-fails#2').output.thrown).toBe(true);
    expect(order('journal-fails#2')).toBe('c,a,b');
    expect(step('journal-fails#2').dropped).toHaveLength(1);
    expect(step('journal-fails#3').output.thrown).toBe(false);
    expect(order('journal-fails#3')).toBe('c,b,a');
    expect(step('journal-fails#3').dropped).toEqual([]);

    // id の形
    expect(text('id-forms#1')).toBe(`task ${LONG_ID} を末尾へ動かした。`);
    expect(decision('id-forms#1')).toBe(`task の並びを変えた（${LONG_ID}）: 末尾へ`);
    expect(text('id-forms#2')).toBe('task 仕事 を先頭へ動かした。');
    expect(text('id-forms#3')).toBe(`task with space を${LONG_ID} の直前へ動かした。`);
    expect(text('id-forms#4')).toBe('task a/b:c を仕事 の直後へ動かした。');
    expect(text('id-forms#6')).toBe('task 😀 をwith space の直後へ動かした。');
    expect(text('id-forms#7')).toBe(NOT_FOUND(`${LONG_ID}!`));
    expect(text('id-forms#8')).toBe(ANCHOR_MISSING(`${LONG_ID}!`));
    expect(LONG_ID).toHaveLength(200);
  });
});
