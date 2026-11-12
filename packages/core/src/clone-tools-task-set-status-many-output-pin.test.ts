import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task, TaskOrigin } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `task_set_status_many` の出力（全文と字数）と、呼んだあとの状態（task の行・日誌へ足された行）を、
// 場面ごとにコミットした固定値（clone-tools-task-set-status-many-output-pin.json）と丸ごと比べる。
// `clone-tools-task-set-status-many.ts` の `tool('task_set_status_many', …)`（約 120 行）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の本文）を固定して毎回同じにする。
// この道具は task を書き換えるので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - tasks: 呼んだあとの task の行を、ストアから読んだ形のまま（閉じた行を含む全件。対象になった行も、ならなかった行も）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま）
//   - wrote: task か日誌のどちらかが呼ぶ前から変わったか。断った・当たらなかった・試算の場面は false で、task が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_SET_STATUS_MANY_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-set-status-many-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-set-status-many-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、task・日誌のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// task は場面の頭に固定の createdAt（基準の 2026-10-01 から分単位）で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ
// （閉じた時刻 closedAt・日誌の at が呼び順に増える）。task の id は入力の側で固定する。日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 塊（日誌の1行）の割り方は id の字数の予算（3,600 字）で決まるので、複数の塊を作る場面は id の長さを入力の側で選ぶ
// （1,200 字の id は 1 塊 2 件、300 字の id は 1 塊 11 件）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（task か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

interface SeedTask {
  id: string;
  origin: TaskOrigin;
  /** createdAt（基準から何分後か） */
  minute: number;
  source?: string;
  title?: string;
  body?: string;
  conv?: string;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる（閉じた時刻は SEED_CLOSED_ISO） */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** この id を道具が閉じる直前に、別の経路（人間）が先に閉じる（競合） */
  closeFirst: string[];
  /** この id を道具が閉じる直前に、別の経路が task を消す（id → 消す会話 id） */
  removeFirst: Record<string, string>;
  /** この id の setStatus が「読めない行」で落ちる */
  throwUnreadable: string[];
  /** この id の setStatus が器の障害で落ちる（それより前の id はもう閉じている） */
  throwError: string[];
  /** 一覧が返す「読めない行」の件数 */
  unreadable: number;
  /** 一覧そのものが落ちる */
  listFails: boolean;
  /** 場面の中の呼びごとに1度だけ起こす競合の記録 */
  done: Set<string>;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Omit<Hooks, 'done'>>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedTask[];
  steps: Step[];
  /** journal.append の何回目（場面の通し・1 から）を投げさせるか */
  journalFailsAt?: number[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const TASK_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const SEED_UPDATED_ISO = '2026-10-02T00:00:00.000Z';
const SEED_CLOSED_ISO = '2026-10-03T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-task-set-status-many-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_SET_STATUS_MANY_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteIso(minute: number): string {
  return new Date(TASK_BASE + minute * 60_000).toISOString();
}

function t(
  id: string,
  origin: TaskOrigin,
  minute: number,
  extra: Partial<Omit<SeedTask, 'id' | 'origin' | 'minute'>> = {},
): SeedTask {
  return { id, origin, minute, ...extra };
}

/** 1,200 字の id（日誌の1塊に2件） */
function longId(n: number): string {
  return `long-${String(n)}-`.padEnd(1_200, 'x');
}

/** 300 字の id（日誌の1塊に11件） */
function midId(n: number): string {
  return `mid-${String(n).padStart(2, '0')}-`.padEnd(300, 'y');
}

const LONG = Array.from({ length: 9 }, (_, index) => longId(index + 1));
function longTasks(count: number): SeedTask[] {
  return LONG.slice(0, count).map((id, index) => t(id, 'external', index + 1));
}
function longAt(n: number): string {
  return LONG[n - 1] ?? '';
}

const MID = Array.from({ length: 30 }, (_, index) => midId(index + 1));
function midTasks(count: number): SeedTask[] {
  return MID.slice(0, count).map((id, index) => t(id, 'external', index + 1));
}

function call(args: Args): Args {
  return { status: 'done', reason: '片付いた', dryRun: false, ...args };
}

const LONG_REASON = `長い理由。${'あ'.repeat(1_999)}`;

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-errors',
    covers:
      '検査の順序と各文言（status・limit・origin・source・q・until・reason・全起点・時差の無い until）。どれも1件も変えない。先に当たった違反だけを返す',
    seed: [t('ext-1', 'external', 1), t('self-1', 'self', 2)],
    steps: [
      { args: call({ origin: ['external'], status: 'queued' }), writes: 'none' },
      { args: call({ origin: ['external'], status: 'waiting' }), writes: 'none' },
      { args: call({ origin: ['external'], limit: 0 }), writes: 'none' },
      { args: call({ origin: ['external'], limit: 2001 }), writes: 'none' },
      { args: call({ origin: ['external'], limit: 1.5 }), writes: 'none' },
      { args: call({ origin: ['external'], limit: -1 }), writes: 'none' },
      { args: call({ origin: [] }), writes: 'none' },
      { args: call({ origin: [], limit: 0 }), writes: 'none' },
      { args: call({ origin: [], source: [] }), writes: 'none' },
      { args: call({ origin: ['external'], source: [] }), writes: 'none' },
      { args: call({ origin: ['external'], source: ['ok', ''] }), writes: 'none' },
      { args: call({ origin: ['external'], source: ['\u0000'] }), writes: 'none' },
      { args: call({ origin: ['external'], q: '' }), writes: 'none' },
      { args: call({ origin: ['external'], q: '\u0000' }), writes: 'none' },
      { args: call({ origin: ['external'], until: '' }), writes: 'none' },
      { args: call({ origin: ['external'], reason: '' }), writes: 'none' },
      { args: call({ origin: ['external'], reason: '   ' }), writes: 'none' },
      { args: call({ origin: ['external'], reason: '\u0000' }), writes: 'none' },
      { args: call({ origin: ['external'], reason: '\u0000 \n' }), writes: 'none' },
      { args: call({ origin: ['external'], q: '', reason: '' }), writes: 'none' },
      { args: call({ origin: ['external'], until: '', reason: '' }), writes: 'none' },
      { args: call({ origin: ['human', 'manager', 'external', 'self'] }), writes: 'none' },
      {
        args: call({ origin: ['self', 'external', 'manager', 'human', 'self'], dryRun: undefined }),
        writes: 'none',
      },
      {
        args: call({ origin: ['human', 'manager', 'external', 'self'], until: '2026-10-02' }),
        writes: 'none',
      },
      {
        args: call({ origin: ['human', 'manager', 'external', 'self'], reason: '' }),
        writes: 'none',
      },
      { args: call({ origin: ['external'], until: '2026-10-02T00:00:00' }), writes: 'none' },
      { args: call({ origin: ['external'], until: '2026-10-02' }), writes: 'none' },
      { args: call({ origin: ['external'], until: 'きのう' }), writes: 'none' },
    ],
  },
  // ---- 0件（段ごとの理由） ----
  {
    name: 'zero-no-open',
    covers:
      '開いている task が1件も無い（閉じた task だけが在る）。絞り込みの段の行は漏斗の頭の1つだけ。試算でも実行でも同じ文言で、1件も変えない',
    seed: [
      t('done-1', 'external', 1, { status: 'done' }),
      t('cancelled-1', 'self', 2, { status: 'cancelled' }),
    ],
    steps: [
      { args: { origin: ['external'], status: 'done', reason: '試算' }, writes: 'none' },
      { args: call({ origin: ['external'] }), writes: 'none' },
      {
        args: call({
          origin: ['external'],
          source: ['x'],
          q: 'y',
          until: '2026-10-05T00:00:00Z',
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-origin',
    covers:
      '開いている task は在るが origin に当たらない: 起点の内訳（閉じた task は数えない）。漏斗は source・q・until の行を（渡していれば）出す。試算でも実行でも同じ',
    seed: [
      t('human-1', 'human', 1, { status: 'waiting' }),
      t('human-2', 'human', 2),
      t('manager-1', 'manager', 3, { status: 'needs_decision' }),
      t('ext-closed', 'external', 4, { status: 'done' }),
    ],
    steps: [
      { args: { origin: ['external'], status: 'done', reason: '試算' }, writes: 'none' },
      { args: call({ origin: ['external', 'self'] }), writes: 'none' },
      {
        args: call({
          origin: ['self'],
          source: ['x'],
          q: 'y',
          until: '2026-10-05T00:00:00+09:00',
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-source',
    covers:
      'origin では当たったが source の完全一致で0件: 当たった task に実在する source を多い順に出す（同数は積んだ順）・source を持つ task が無い・source を渡した上で q・until も渡す',
    seed: [
      t('ext-1', 'external', 1, { source: 'token-pool' }),
      t('ext-2', 'external', 2, { source: 'ci-watch' }),
      t('ext-3', 'external', 3, { source: 'token-pool' }),
      t('ext-4', 'external', 4),
      t('ext-5', 'external', 5, { source: 'token-pool' }),
      t('self-1', 'self', 6),
      t('self-2', 'self', 7),
    ],
    steps: [
      {
        args: { origin: ['external'], source: ['zzz'], status: 'done', reason: 'r' },
        writes: 'none',
      },
      { args: call({ origin: ['external'], source: ['token-pool-2', 'zzz'] }), writes: 'none' },
      { args: call({ origin: ['self'], source: ['zzz'] }), writes: 'none' },
      {
        args: call({
          origin: ['external'],
          source: ['zzz'],
          q: '仕事',
          until: '2026-10-05T00:00:00Z',
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-source-many',
    covers:
      'source が当たらず、実在する source が 8 種を超える（多い順に 8 種まで。残りは「ほか N 種」）',
    seed: [
      t('s-01', 'external', 1, { source: 'src-a' }),
      t('s-02', 'external', 2, { source: 'src-b' }),
      t('s-03', 'external', 3, { source: 'src-b' }),
      t('s-04', 'external', 4, { source: 'src-c' }),
      t('s-05', 'external', 5, { source: 'src-d' }),
      t('s-06', 'external', 6, { source: 'src-e' }),
      t('s-07', 'external', 7, { source: 'src-f' }),
      t('s-08', 'external', 8, { source: 'src-g' }),
      t('s-09', 'external', 9, { source: 'src-h' }),
      t('s-10', 'external', 10, { source: 'src-i' }),
      t('s-11', 'external', 11, { source: 'src-j' }),
      t('s-12', 'external', 12, { source: 'src-c' }),
      t('s-13', 'external', 13, { source: 'src-c' }),
    ],
    steps: [{ args: call({ origin: ['external'], source: ['nothing'] }), writes: 'none' }],
  },
  {
    name: 'zero-q',
    covers:
      'source までは当たったが q が当たらない（q の部分一致は title・body・source を見る）。source を渡す呼び・渡さない呼び・until も渡す呼び',
    seed: [
      t('ext-1', 'external', 1, { source: 'token-pool' }),
      t('ext-2', 'external', 2, { source: 'ci-watch', title: 'ひとつめ', body: 'あいうえお' }),
      t('ext-3', 'external', 3),
    ],
    steps: [
      { args: call({ origin: ['external'], q: '見つからない語' }), writes: 'none' },
      {
        args: call({ origin: ['external'], source: ['token-pool', 'ci-watch'], q: 'NOPE' }),
        writes: 'none',
      },
      {
        args: call({
          origin: ['external'],
          source: ['ci-watch'],
          q: '".*"',
          until: '2026-10-05T00:00:00Z',
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-until',
    covers:
      'q までは当たったが until より前の task が0件（当たった task のうち最も古い時刻を出す）。q を渡さない呼び・source を渡す呼び・+09:00 の時差の until',
    seed: [
      t('ext-3', 'external', 30, { source: 'a' }),
      t('ext-1', 'external', 10, { source: 'a' }),
      t('ext-2', 'external', 20, { source: 'b' }),
    ],
    steps: [
      { args: call({ origin: ['external'], until: '2026-09-30T00:00:00Z' }), writes: 'none' },
      {
        args: call({
          origin: ['external'],
          source: ['a'],
          q: '仕事',
          until: '2026-10-01T08:59:59+09:00',
        }),
        writes: 'none',
      },
      {
        args: {
          origin: ['external'],
          until: '2026-09-30T23:59:59.999Z',
          status: 'cancelled',
          reason: '試算',
        },
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-unreadable',
    covers:
      '読めない task の行がある: 0件の応答・試算・実行のどれにも「読めない行が N 件」の注意が付く（対象には含めない）',
    seed: [t('ext-1', 'external', 1), t('ext-2', 'external', 2), t('human-1', 'human', 3)],
    steps: [
      { args: call({ origin: ['self'] }), writes: 'none', hooks: { unreadable: 2 } },
      {
        args: { origin: ['external'], status: 'done', reason: '試算' },
        writes: 'none',
        hooks: { unreadable: 1 },
      },
      { args: call({ origin: ['external'], limit: 1 }), writes: 'some', hooks: { unreadable: 3 } },
      { args: call({ origin: ['human'] }), writes: 'some', hooks: { unreadable: 1 } },
      { args: call({ origin: ['human'] }), writes: 'none', hooks: { unreadable: 1 } },
    ],
  },
  // ---- 試算（dryRun） ----
  {
    name: 'dry-run',
    covers:
      'dryRun を省くと試算（既定）・dryRun: true・status が done と cancelled・絞り込みの全軸（source・q・until）が漏斗と「絞り込み」に出る・limit に当たると残りの件数と呼び直しの案内。waiting / needs_decision の task も対象。1件も変えない',
    seed: [
      t('ext-1', 'external', 1, { source: 'token-pool' }),
      t('ext-2', 'external', 2, { source: 'token-pool', status: 'waiting' }),
      t('ext-3', 'external', 3, { source: 'ci-watch', status: 'needs_decision' }),
      t('ext-4', 'external', 4, { title: 'Needle の仕事' }),
      t('human-1', 'human', 5),
      t('ext-done', 'external', 6, { status: 'done' }),
    ],
    steps: [
      { args: { origin: ['external'], status: 'done', reason: '片付いた' }, writes: 'none' },
      {
        args: { origin: ['external'], status: 'cancelled', reason: 'やめた', dryRun: true },
        writes: 'none',
      },
      {
        args: {
          origin: ['external'],
          source: ['token-pool', 'ci-watch'],
          q: 'POOL',
          until: '2026-10-01T00:02:00.000Z',
          status: 'done',
          reason: '全軸',
        },
        writes: 'none',
      },
      {
        args: { origin: ['external'], limit: 3, status: 'done', reason: '上限', dryRun: true },
        writes: 'none',
      },
      {
        args: { origin: ['external', 'human'], limit: 1, status: 'cancelled', reason: '1件' },
        writes: 'none',
      },
    ],
  },
  {
    name: 'dry-run-many',
    covers:
      '試算で対象が 20 件を超える: 先頭 20 件の id と「ほか N 件は省略」・上限（limit）に当たるときの残りの案内と省略の両方',
    seed: Array.from({ length: 25 }, (_, index) =>
      t(`ext-${String(index + 1).padStart(2, '0')}`, 'external', index + 1),
    ),
    steps: [
      { args: { origin: ['external'], status: 'done', reason: '多数' }, writes: 'none' },
      {
        args: { origin: ['external'], status: 'done', reason: '多数と上限', limit: 22 },
        writes: 'none',
      },
      {
        args: { origin: ['external'], status: 'done', reason: '20 件ちょうど', limit: 20 },
        writes: 'none',
      },
    ],
  },
  {
    name: 'dry-run-default-limit',
    covers:
      '当たる task が既定の上限（500 件）を超える: 試算で対象は 500 件、残り 1 件・上限が 500 であること・省略の件数',
    seed: Array.from({ length: 501 }, (_, index) =>
      t(`bulk-${String(index + 1).padStart(3, '0')}`, 'external', index + 1, {
        title: `t${String(index + 1)}`,
        body: '',
      }),
    ),
    steps: [{ args: { origin: ['external'], status: 'done', reason: '上限の外' }, writes: 'none' }],
  },
  {
    name: 'sort-order',
    covers:
      '対象は積んだ順ではなく createdAt の古い側から（同時刻は積んだ順）。試算の「いちばん古い・新しい」・limit は古い側から・残りは次の呼びで続く',
    seed: [
      t('c-new', 'external', 50),
      t('a-old', 'external', 10),
      t('b-mid', 'external', 30),
      t('d-old-tie', 'external', 10),
      t('e-mid-tie', 'external', 30),
    ],
    steps: [
      { args: { origin: ['external'], status: 'done', reason: '試算' }, writes: 'none' },
      { args: call({ origin: ['external'], limit: 3 }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 3 }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 3 }), writes: 'none' },
    ],
  },
  // ---- 実行 ----
  {
    name: 'execute-basic',
    covers:
      'dryRun: false で当たった task だけを done / cancelled にし、理由・主体（clone）・閉じた時刻を残す。他の起点・既に閉じた行は無傷。waiting / needs_decision も閉じる。日誌は1行。続けて同じ呼びは0件の理由（起点の内訳）',
    seed: [
      t('ext-1', 'external', 1),
      t('ext-2', 'external', 2, { status: 'waiting', conv: 'conv-1' }),
      t('ext-3', 'external', 3, { status: 'needs_decision', source: 'ci-watch' }),
      t('human-1', 'human', 4),
      t('self-1', 'self', 5),
      t('mgr-1', 'manager', 6, { source: 'mgr-9' }),
      t('ext-done', 'external', 7, { status: 'done' }),
      t('ext-cancelled', 'external', 8, { status: 'cancelled' }),
    ],
    steps: [
      { args: call({ origin: ['external'], reason: 'やった' }), writes: 'some' },
      { args: call({ origin: ['external'], reason: 'やった' }), writes: 'none' },
      {
        args: call({ origin: ['human', 'manager'], status: 'cancelled', reason: 'やめた' }),
        writes: 'some',
      },
      { args: call({ origin: ['self'], status: 'cancelled', reason: '後から' }), writes: 'some' },
    ],
  },
  {
    name: 'execute-axes',
    covers:
      'source は完全一致・q は title / body / source への大小無視の部分一致（正規表現ではなく文字列）・until は境界ちょうどを含み後を含まない・全軸の組み合わせの漏斗と日誌の「絞り込み」',
    seed: [
      t('exact', 'external', 1, { source: 'token-pool' }),
      t('near', 'external', 2, { source: 'token-pool-2' }),
      t('hit-title', 'self', 3, { title: 'NeeDLE-title' }),
      t('hit-body', 'self', 4, { body: 'ここに needle がある' }),
      t('hit-source', 'self', 5, { source: 'Needle-src' }),
      t('miss', 'self', 6),
      t('edge-in', 'external', 20),
      t('edge-out', 'external', 21),
      t('combo-1', 'manager', 30, { source: 'mgr-1', title: 'ABC' }),
      t('combo-2', 'manager', 31, { source: 'mgr-1', title: 'abd' }),
      t('combo-3', 'manager', 32, { source: 'mgr-2', title: 'abc' }),
      t('regex', 'human', 40, { title: 'a.c' }),
      t('regex-miss', 'human', 41, { title: 'abc' }),
    ],
    steps: [
      {
        args: call({ origin: ['external'], source: ['token-pool'], reason: 'source' }),
        writes: 'some',
      },
      { args: call({ origin: ['self'], q: 'NEEDLE', reason: 'q' }), writes: 'some' },
      {
        args: call({ origin: ['external'], until: '2026-10-01T00:20:00.000Z', reason: 'until' }),
        writes: 'some',
      },
      {
        args: call({
          origin: ['manager'],
          source: ['mgr-1', 'mgr-3'],
          q: 'ABC',
          until: '2026-10-01T09:30:00+09:00',
          status: 'cancelled',
          reason: '全軸',
        }),
        writes: 'some',
      },
      { args: call({ origin: ['human'], q: 'a.c', reason: '正規表現ではない' }), writes: 'some' },
    ],
  },
  {
    name: 'reason-forms',
    covers:
      '理由の形: 改行・NUL を含む・前後に空白・長い理由（上限は無い）・記号。task の行（closedReason）・日誌・出力にどう残るか',
    seed: [
      t('r-1', 'external', 1),
      t('r-2', 'external', 2),
      t('r-3', 'external', 3),
      t('r-4', 'external', 4),
    ],
    steps: [
      {
        args: call({ origin: ['external'], limit: 1, reason: '一行目\n二行目\u0000です' }),
        writes: 'some',
      },
      { args: call({ origin: ['external'], limit: 1, reason: '  前後に空白  ' }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 1, reason: LONG_REASON }), writes: 'some' },
      {
        args: call({
          origin: ['external'],
          limit: 1,
          status: 'cancelled',
          reason: '**強調** `code` [x](y)',
        }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'reason-lone-surrogate',
    covers:
      '理由に孤立サロゲート（前半だけ・後半だけ）を含む: U+FFFD に置き換わって task の行（closedReason）・日誌・出力で同じ文字列になる。対になったサロゲート（絵文字）はそのまま残る',
    seed: [
      t('s-1', 'external', 1),
      t('s-2', 'external', 2),
      t('s-3', 'external', 3),
      t('s-4', 'external', 4),
    ],
    steps: [
      { args: call({ origin: ['external'], limit: 1, reason: '前\ud800後' }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 1, reason: '前\udc00後' }), writes: 'some' },
      {
        args: call({ origin: ['external'], limit: 1, reason: '対\u{1F600}と\ud800\u0000' }),
        writes: 'some',
      },
      { args: call({ origin: ['external'], limit: 1, reason: '\ud83d' }), writes: 'some' },
    ],
  },
  {
    name: 'limit-steps',
    covers:
      'limit は古い側から limit 件だけ変え、残りの件数と呼び直しの案内を言う。続けて呼ぶと続きを閉じ、最後は残りの案内が消える。limit 1・limit 2000（上限ちょうど）',
    seed: [
      t('e-1', 'external', 1),
      t('e-2', 'external', 2),
      t('e-3', 'external', 3),
      t('e-4', 'external', 4),
      t('e-5', 'external', 5),
      t('h-1', 'human', 6),
      t('h-2', 'human', 7),
    ],
    steps: [
      { args: call({ origin: ['external'], limit: 2 }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 2 }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 2 }), writes: 'some' },
      { args: call({ origin: ['external'], limit: 2 }), writes: 'none' },
      { args: call({ origin: ['human'], limit: 1 }), writes: 'some' },
      { args: call({ origin: ['human'], limit: 2000 }), writes: 'some' },
    ],
  },
  // ---- 塊（日誌の1行）が複数 ----
  {
    name: 'many-ok',
    covers:
      '対象が複数の塊に割れる（300 字の id・11 件ずつ）・変えた id が 20 件を超えて出力は省略・全 id は日誌に塊の数だけの行で残る・続けて呼ぶと0件',
    seed: [...midTasks(25), t('human-1', 'human', 100)],
    steps: [
      { args: call({ origin: ['external'], reason: '多数' }), writes: 'some' },
      { args: call({ origin: ['external'], reason: '多数' }), writes: 'none' },
    ],
  },
  {
    name: 'many-race',
    covers:
      '塊が丸ごと競合になる（最後の塊の 8 件を別の経路が先に閉じる）と日誌の行は書かない・日誌の件数は書いた行の数・読めない行（setStatus が落ちる）も数えない・「変えられなかった」の注意',
    seed: midTasks(30),
    steps: [
      {
        args: call({ origin: ['external'], reason: '競合あり' }),
        writes: 'some',
        hooks: {
          closeFirst: MID.slice(22, 30),
          throwUnreadable: [MID[1] ?? ''],
        },
      },
    ],
  },
  {
    name: 'race',
    covers:
      '当たったのに変えられなかった: 別の経路が先に閉じた（unchanged）・消えた（not-found）・読めない形だった（UnreadableTaskError）。塊が1件も変えなければ日誌へ書かない。次の呼びで残りを閉じる',
    seed: [
      ...longTasks(8).map((task, index) => (index === 1 ? { ...task, conv: 'conv-x' } : task)),
      t('human-1', 'human', 100),
    ],
    steps: [
      {
        args: call({ origin: ['external'], reason: '競合' }),
        writes: 'some',
        hooks: {
          closeFirst: [longAt(1)],
          removeFirst: { [longAt(2)]: 'conv-x' },
          throwUnreadable: [longAt(3)],
        },
      },
      { args: call({ origin: ['external'], reason: '残り' }), writes: 'some' },
    ],
  },
  {
    name: 'race-all',
    covers:
      '対象の全件が競合（別の経路が先に閉じた・消えた・読めない形だった）: 「0 件を done にした」と空の「変えた id」で終えず、「1 件も閉じられなかった」と競合の注意で言う。日誌へは書かない。閉じられなかった行は次の呼びで閉じる',
    seed: [
      t('ext-1', 'external', 1),
      t('ext-2', 'external', 2, { conv: 'conv-x' }),
      t('ext-3', 'external', 3),
    ],
    steps: [
      {
        args: call({ origin: ['external'], reason: '全件競合' }),
        writes: 'some',
        hooks: {
          closeFirst: ['ext-1'],
          removeFirst: { 'ext-2': 'conv-x' },
          throwUnreadable: ['ext-3'],
        },
      },
      { args: call({ origin: ['external'], reason: '残り' }), writes: 'some' },
    ],
  },
  {
    name: 'race-all-rest',
    covers:
      '上限（limit）で絞った対象の全件が競合し、上限の外に残りがある: 「1 件も閉じられなかった」に続けて競合の注意と残りの案内を言う',
    seed: [
      t('ext-1', 'external', 1),
      t('ext-2', 'external', 2),
      t('ext-3', 'external', 3),
      t('ext-4', 'external', 4),
    ],
    steps: [
      {
        args: call({ origin: ['external'], limit: 2, reason: '全件競合と残り' }),
        writes: 'some',
        hooks: { closeFirst: ['ext-1', 'ext-2'] },
      },
    ],
  },
  // ---- 閉じる側が落ちる ----
  {
    name: 'close-fails-first',
    covers:
      '1塊目の最初の task の書き込みが落ちる（1件も閉じていない・日誌なし）→ 1塊目の途中で落ちる（落ちる前の task は閉じていて日誌には無い）→ 直して続きを閉じる',
    seed: longTasks(8),
    steps: [
      { args: call({ origin: ['external'] }), writes: 'none', hooks: { throwError: [longAt(1)] } },
      { args: call({ origin: ['external'] }), writes: 'some', hooks: { throwError: [longAt(2)] } },
      { args: call({ origin: ['external'] }), writes: 'some' },
    ],
  },
  {
    name: 'close-fails-later',
    covers:
      '3塊目で落ちる: 前の塊の id（先頭の1塊ぶんだけ出し、残りは省略）・競合で閉じられなかった件数・上限に収まらず対象にしなかった件数。直して同じ絞り込みで続きを閉じる',
    seed: longTasks(9),
    steps: [
      {
        args: call({ origin: ['external'], limit: 8 }),
        writes: 'some',
        hooks: { closeFirst: [longAt(2)], throwError: [longAt(5)] },
      },
      { args: call({ origin: ['external'], limit: 8 }), writes: 'some' },
    ],
  },
  {
    name: 'close-fails-last',
    covers: '最後の塊で落ちる（残りの塊は1つ・前の塊の id は 6 件のうち先頭の2件だけ出す）',
    seed: longTasks(8),
    steps: [
      { args: call({ origin: ['external'] }), writes: 'some', hooks: { throwError: [longAt(8)] } },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails-single',
    covers:
      '唯一（最後）の塊の日誌が書けない: 全件は閉じ終えている・前の塊は無い・閉じ直し禁止の応答（例外）。task は閉じている。次の呼びは0件',
    seed: [t('ext-1', 'external', 1), t('ext-2', 'external', 2), t('ext-3', 'external', 3)],
    journalFailsAt: [1],
    steps: [
      { args: call({ origin: ['external'], reason: '日誌が落ちる' }), writes: 'some' },
      { args: call({ origin: ['external'], reason: '日誌が戻った' }), writes: 'none' },
    ],
  },
  {
    name: 'journal-fails-last',
    covers: '最後の塊の日誌が書けない（前の3塊は記録済みで先頭の1塊ぶんだけ id を出す）',
    seed: longTasks(8),
    journalFailsAt: [4],
    steps: [{ args: call({ origin: ['external'] }), writes: 'some' }],
  },
  {
    name: 'journal-fails-last-rest',
    covers:
      '最後の塊の日誌が書けず、上限に収まらず対象にしなかった行があり、競合で閉じられなかった行もある（journal_write で書き直した後に別の呼びで閉じる案内）',
    seed: longTasks(9),
    journalFailsAt: [4],
    steps: [
      {
        args: call({ origin: ['external'], limit: 8 }),
        writes: 'some',
        hooks: { closeFirst: [longAt(1)] },
      },
    ],
  },
  {
    name: 'journal-fails-mid',
    covers:
      '途中の塊（2/4）の日誌が書けない: 残りの塊は閉じていない・この塊の id は日誌に無い。日誌が戻ってから同じ絞り込みで続きを閉じる',
    seed: longTasks(8),
    journalFailsAt: [2],
    steps: [
      { args: call({ origin: ['external'] }), writes: 'some' },
      { args: call({ origin: ['external'] }), writes: 'some' },
    ],
  },
  {
    name: 'journal-fails-mid-rest',
    covers:
      '途中の塊の日誌が書けず、競合で閉じられなかった行と上限の外の行がある（残りの塊の案内と上限の案内）',
    seed: longTasks(9),
    journalFailsAt: [2],
    steps: [
      {
        args: call({ origin: ['external'], limit: 8 }),
        writes: 'some',
        hooks: { closeFirst: [longAt(1)] },
      },
    ],
  },
  // ---- 一覧が読めない ----
  {
    name: 'list-fails',
    covers: '一覧そのものが落ちる: 例外がそのまま出る。試算でも実行でも task・日誌は変わらない',
    seed: [t('ext-1', 'external', 1)],
    steps: [
      {
        args: { origin: ['external'], status: 'done', reason: '試算' },
        writes: 'none',
        hooks: { listFails: true },
      },
      { args: call({ origin: ['external'] }), writes: 'none', hooks: { listFails: true } },
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
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの task の行（閉じた行を含む全件。ストアから読んだ形のまま） */
  tasks: Task[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function snapshot(stores: Stores): Promise<{ tasks: Task[]; journal: unknown[] }> {
  return {
    tasks: plain((await stores.tasks.list({ includeClosed: true })).entries),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

function freshHooks(): Hooks {
  return {
    closeFirst: [],
    removeFirst: {},
    throwUnreadable: [],
    throwError: [],
    unreadable: 0,
    listFails: false,
    done: new Set(),
  };
}

function withHooks(base: Stores, hooks: Hooks, failJournalAt: readonly number[]): Stores {
  let journalCalls = 0;
  const tasks: Stores['tasks'] = {
    ...base.tasks,
    list: async (options) => {
      if (hooks.listFails) throw new Error('task の一覧が読めない');
      const listed = await base.tasks.list(options);
      if (hooks.unreadable === 0) return listed;
      return {
        entries: listed.entries,
        unreadable: Array.from({ length: hooks.unreadable }, (_, index) => ({
          id: `broken-${String(index + 1)}`,
          reason: '読めない行（テスト用）',
        })),
      };
    },
    setStatus: async (id, status, options) => {
      if (hooks.throwUnreadable.includes(id))
        throw new UnreadableTaskError('読めない行（テスト用）');
      if (hooks.throwError.includes(id)) throw new Error('ストアが落ちた');
      if (hooks.closeFirst.includes(id) && !hooks.done.has(id)) {
        hooks.done.add(id);
        await base.tasks.setStatus(id, 'done', {
          reason: '先に別の経路が閉じた',
          by: 'human',
          at: options.at,
        });
      }
      const conv = hooks.removeFirst[id];
      if (conv !== undefined && !hooks.done.has(id)) {
        hooks.done.add(id);
        await base.tasks.removeForConversation(conv);
      }
      return base.tasks.setStatus(id, status, options);
    },
  };
  return {
    ...base,
    tasks,
    journal: {
      ...base.journal,
      append: (entry) => {
        journalCalls += 1;
        if (failJournalAt.includes(journalCalls)) return Promise.reject(new Error('日誌が落ちた'));
        return base.journal.append(entry);
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
      origin: spec.origin,
      title: spec.title ?? `仕事 ${spec.id.slice(0, 12)}`,
      body: spec.body ?? `本文 ${spec.id.slice(0, 12)}`,
      ...(spec.source === undefined ? {} : { source: spec.source }),
      ...(spec.conv === undefined ? {} : { originConversationId: spec.conv }),
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

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedTasks(base, scenario.seed);
  const hooks = freshHooks();
  const stores = withHooks(base, hooks, scenario.journalFailsAt ?? []);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'task_set_status_many');
  if (!found) throw new Error('task_set_status_many が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base);
    Object.assign(hooks, freshHooks(), step.hooks ?? {});
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(step.args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = { length: text.length, text, isError: result.isError === true, thrown: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = { length: text.length, text, isError: true, thrown: true };
    }
    // 次の呼びへ口を持ち越さない（この呼びの仕込みだけが効く）
    Object.assign(hooks, freshHooks());
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.tasks) !== JSON.stringify(after.tasks) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      tasks: after.tasks,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、task が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
      expect(
        after.tasks,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、task が呼ぶ前から変わった`,
      ).toEqual(before.tasks);
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

describe('task_set_status_many の出力と呼んだあとの状態の固定（場面ごとの出力の全文・task の行・日誌の行）', () => {
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
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
      });

      it(`${key} の呼んだあとの task の行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.tasks.map((task) => task.id),
          `場面 ${key} の task: 行の並び（id）が変わった`,
        ).toEqual(want?.tasks.map((task) => task.id));
        for (const [row, wantTask] of (want?.tasks ?? []).entries()) {
          const gotTask = got?.tasks[row];
          expect(
            gotTask,
            `場面 ${key} の task ${wantTask.id.slice(0, 16)}（${String(row)} 行目）が固定値からずれた（状態・理由・閉じた時刻など）`,
          ).toEqual(wantTask);
        }
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
          `場面 ${key} の日誌: 足された行（種類・本文・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・task・日誌になる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const task = (key: string, id: string): Task | undefined =>
      actual[key]?.tasks.find((row) => row.id === id);
    const status = (key: string, id: string): string | undefined => task(key, id)?.status;
    const decisionOf = (key: string, row: number): string => {
      const entry = journal(key)[row];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    // 引数の検査
    expect(text('arg-errors#1')).toContain('status=queued はまとめて移せない');
    expect(text('arg-errors#2')).toContain('status=waiting はまとめて移せない');
    expect(text('arg-errors#3')).toContain('limit 0 は使えない');
    expect(text('arg-errors#4')).toContain('limit 2001 は使えない');
    expect(text('arg-errors#5')).toContain('limit 1.5 は使えない');
    expect(text('arg-errors#8')).toContain('limit 0 は使えない');
    expect(text('arg-errors#7')).toContain('origin は使えない');
    expect(text('arg-errors#9')).toContain('origin は使えない');
    expect(text('arg-errors#10')).toContain('source は使えない');
    expect(text('arg-errors#11')).toContain('1 番目（0起点）が空文字');
    expect(text('arg-errors#13')).toContain('q は使えない');
    expect(text('arg-errors#15')).toContain('until は使えない');
    expect(text('arg-errors#16')).toContain('reason は使えない');
    expect(text('arg-errors#17')).toContain('空白だけの値');
    expect(text('arg-errors#20')).toContain('q は使えない');
    expect(text('arg-errors#21')).toContain('until は使えない');
    expect(text('arg-errors#22')).toContain('全部');
    expect(text('arg-errors#23')).toContain('全部');
    // 全起点の検査は until の時差の検査より先（until が不正でも全起点の断りが出る）
    expect(text('arg-errors#24')).toContain('全部');
    expect(text('arg-errors#24')).not.toContain('時差');
    expect(text('arg-errors#25')).toContain('reason は使えない');
    expect(text('arg-errors#26')).toContain('2026-10-02T00:00:00');
    expect(text('arg-errors#28')).toContain('きのう');
    // 0件
    expect(text('zero-no-open#1')).toContain('開いている task が1件も無い');
    expect(text('zero-origin#1')).toContain(
      '起点の内訳: human 2 / manager 1 / external 0 / self 0',
    );
    expect(text('zero-source#1')).toContain('token-pool 3 / ci-watch 1');
    expect(text('zero-source#3')).toContain('（source を持つ task が無い）');
    expect(text('zero-source-many')).toContain('ほか');
    expect(text('zero-q#1')).toContain('q="見つからない語" に当たる task が0件');
    expect(text('zero-until#1')).toContain('当たった task のうち最も古いのは');
    expect(text('zero-unreadable#1')).toContain('読めない task の行が 2 件ある');
    expect(text('zero-unreadable#2')).toContain('読めない task の行が 1 件ある');
    expect(text('zero-unreadable#2')).toContain('試算（dryRun）');
    expect(text('zero-unreadable#3')).toContain('読めない task の行が 3 件ある');
    // 試算
    expect(text('dry-run#1')).toContain('**試算（dryRun）。1件も閉じていない。**');
    expect(text('dry-run#2')).toContain('cancelled にするには');
    expect(text('dry-run#3')).toContain('source（完全一致）で');
    expect(text('dry-run#3')).toContain('until で');
    expect(text('dry-run#4')).toContain('残り 1 件は対象にしていない');
    expect(text('dry-run-many#1')).toContain('…ほか 5 件は省略');
    expect(text('dry-run-many#2')).toContain('残り 3 件は対象にしていない');
    expect(text('dry-run-many#3')).not.toContain('省略');
    expect(text('dry-run-default-limit')).toContain('1回の上限（500 件）');
    expect(text('sort-order#1')).toContain('いちばん古いのは 2026-10-01T00:10:00.000Z');
    // 実行
    expect(status('execute-basic#1', 'ext-1')).toBe('done');
    expect(status('execute-basic#1', 'ext-2')).toBe('done');
    expect(status('execute-basic#1', 'ext-3')).toBe('done');
    expect(status('execute-basic#1', 'human-1')).toBe('queued');
    expect(task('execute-basic#1', 'ext-1')?.closedBy).toBe('clone');
    expect(task('execute-basic#1', 'ext-1')?.closedAt).toBe(callTime(0));
    expect(task('execute-basic#1', 'ext-done')?.closedReason).toBe('先に閉じた');
    expect(text('execute-basic#1')).toContain('**3 件を done にした**');
    expect(text('execute-basic#2')).toContain('起点の内訳');
    expect(status('execute-basic#3', 'human-1')).toBe('cancelled');
    expect(status('execute-basic#3', 'mgr-1')).toBe('cancelled');
    expect(status('execute-basic#3', 'self-1')).toBe('queued');
    expect(journal('execute-basic#1')).toHaveLength(1);
    expect(journal('execute-basic#1')[0]?.type).toBe('decision');
    expect(status('execute-axes#1', 'exact')).toBe('done');
    expect(status('execute-axes#1', 'near')).toBe('queued');
    expect(status('execute-axes#2', 'hit-source')).toBe('done');
    expect(status('execute-axes#2', 'miss')).toBe('queued');
    expect(status('execute-axes#3', 'edge-in')).toBe('done');
    expect(status('execute-axes#3', 'edge-out')).toBe('queued');
    expect(status('execute-axes#4', 'combo-1')).toBe('cancelled');
    expect(status('execute-axes#4', 'combo-3')).toBe('queued');
    expect(status('execute-axes#5', 'regex')).toBe('done');
    expect(status('execute-axes#5', 'regex-miss')).toBe('queued');
    expect(decisionOf('execute-axes#4', 0)).toContain(
      '絞り込み: origin=[manager] / source=[mgr-1, mgr-3]（完全一致） / q="ABC" / until=',
    );
    expect(task('reason-forms#1', 'r-1')?.closedReason).not.toContain('\u0000');
    // NUL は task と日誌と出力で同じ文字列に揃える（#6324）。前後の空白は task_set_status と同じく trim しない
    expect(task('reason-forms#1', 'r-1')?.closedReason).toBe('一行目\n二行目です');
    expect(decisionOf('reason-forms#1', 0)).not.toContain('\u0000');
    expect(decisionOf('reason-forms#1', 0)).toContain(': 一行目\n二行目です\n');
    expect(text('reason-forms#1')).not.toContain('\u0000');
    expect(text('reason-forms#1')).toContain('（理由: 一行目\n二行目です）');
    // 孤立サロゲートは U+FFFD に置き換わり、task と日誌と出力で同じ文字列になる。対になったサロゲートは残る
    expect(task('reason-lone-surrogate#1', 's-1')?.closedReason).toBe('前�後');
    expect(decisionOf('reason-lone-surrogate#1', 0)).toContain(': 前�後\n');
    expect(text('reason-lone-surrogate#1')).toContain('（理由: 前�後）');
    expect(task('reason-lone-surrogate#2', 's-2')?.closedReason).toBe('前�後');
    expect(task('reason-lone-surrogate#3', 's-3')?.closedReason).toBe('対\u{1F600}と�');
    expect(text('reason-lone-surrogate#3')).toContain('（理由: 対\u{1F600}と�）');
    expect(task('reason-lone-surrogate#4', 's-4')?.closedReason).toBe('�');
    expect(task('reason-forms#2', 'r-2')?.closedReason).toBe('  前後に空白  ');
    expect(text('reason-forms#3')).toContain(LONG_REASON);
    expect(text('limit-steps#1')).toContain('残り 3 件');
    expect(text('limit-steps#3')).not.toContain('残り');
    expect(text('limit-steps#4')).toContain('起点の内訳');
    // 複数の塊
    expect(text('many-ok#1')).toContain(
      '…ほか 5 件は省略（**全 id は日誌に 3 件に分けて残してある**）',
    );
    expect(journal('many-ok#1')).toHaveLength(3);
    expect(text('many-race')).toContain('件は変えられなかった');
    expect(text('many-race')).toContain('全 id は日誌に 2 件に分けて残してある');
    expect(journal('many-race')).toHaveLength(2);
    expect(text('race#1')).toContain('件は変えられなかった');
    // 1塊目（2件とも競合）は日誌へ書かない。2〜4塊目の3行
    expect(journal('race#1')).toHaveLength(3);
    expect(status('race#1', longAt(1))).toBe('done');
    expect(task('race#1', longAt(1))?.closedBy).toBe('human');
    expect(task('race#1', longAt(2))).toBeUndefined();
    expect(status('race#1', longAt(3))).toBe('queued');
    expect(status('race#2', longAt(3))).toBe('done');
    // 全件が競合: 「0 件を done にした」と空の id で終えない
    for (const key of ['race-all#1', 'race-all-rest']) {
      expect(text(key)).not.toContain('0 件を');
      expect(text(key)).not.toContain('変えた id');
      expect(text(key)).toContain('**1 件も閉じられなかった**');
      expect(journal(key)).toEqual([]);
    }
    expect(text('race-all#1')).toContain('⚠ 対象 3 件のうち 3 件は変えられなかった');
    expect(text('race-all-rest')).toContain('⚠ 対象 2 件のうち 2 件は変えられなかった');
    expect(text('race-all-rest')).toContain('残り 2 件は対象にしていない');
    expect(status('race-all#2', 'ext-3')).toBe('done');
    // 閉じる側が落ちる
    expect(text('close-fails-first#1')).toContain(
      '⚠⚠ 一括は途中で止まった・この塊の task の書き込みが失敗した',
    );
    expect(text('close-fails-first#1')).toContain(
      'ここまでに閉じた id は 0 件（1 塊目で失敗したので、1件も閉じていない）',
    );
    expect(status('close-fails-first#2', longAt(1))).toBe('done');
    expect(journal('close-fails-first#2')).toEqual([]);
    expect(text('close-fails-later#1')).toContain('…ほか 1 件は省略（日誌に残してある）');
    expect(text('close-fails-later#1')).toContain('1 件は閉じられなかった');
    expect(text('close-fails-later#1')).toContain('対象にしなかった 1 件');
    expect(text('close-fails-last')).toContain('この塊以降の 1 塊は閉じ切っていない');
    // 日誌が落ちる
    expect(text('journal-fails-single#1').split('\n')[0]).toBe(
      '⚠⚠ 全件を閉じ終えた・最後の塊の日誌が未記録・閉じ直し禁止',
    );
    expect(journal('journal-fails-single#1')).toEqual([]);
    expect(status('journal-fails-single#1', 'ext-1')).toBe('done');
    expect(text('journal-fails-last').split('\n')[0]).toBe(
      '⚠⚠ 全件を閉じ終えた・最後の塊の日誌が未記録・閉じ直し禁止',
    );
    expect(text('journal-fails-last')).toContain('…ほか 4 件は省略（日誌に残してある）');
    expect(text('journal-fails-last-rest')).toContain(
      'journal_write で記録を書き直した後に、別の呼びで閉じること',
    );
    expect(text('journal-fails-mid#1').split('\n')[0]).toBe(
      '⚠⚠ 一括は途中で止まった・この塊の日誌が未記録・残りの塊は閉じていない',
    );
    expect(text('journal-fails-mid#1')).toContain('残りの 2 塊は閉じていない');
    expect(text('journal-fails-mid-rest')).toContain('は、そもそもこの呼びでは閉じていない。');
    expect(text('journal-fails-mid-rest')).toContain('件は閉じられなかった');
    // 一覧が落ちる
    expect(text('list-fails#1')).toBe('task の一覧が読めない');
    expect(text('list-fails#2')).toBe('task の一覧が読めない');
  });
});
