import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { InboxEvent, UnreadableInboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `inbox_remove_many` の出力（全文と字数）と、呼んだあとの状態（受信箱の行・日誌へ足された行・配達を止めた id）を、
// 場面ごとにコミットした固定値（clone-tools-inbox-remove-many-output-pin.json）と丸ごと比べる。
// `clone-tools-task.ts` の `tool('inbox_remove_many', …)`（約 270 行・入れ子 8 段の式）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
// この道具は受信箱の行を消すので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - inbox: 呼んだあとの受信箱の行（消された行は無く、残った行だけが在る）と、読めない行の一覧。ストアから読んだ形のまま
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま）
//   - delivery: 配達の待ち行列から落とす口（dropQueuedInboxEvents）へ渡された id の塊
//   - wrote: 受信箱か日誌のどちらかが呼ぶ前から変わったか。断った・当たらなかった・試算の場面は false で、受信箱と日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_INBOX_REMOVE_MANY_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-inbox-remove-many-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-inbox-remove-many-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、受信箱・日誌のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 受信箱の行は場面の頭に固定の at（基準の 2026-10-01 から分単位）で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ
// （日誌の at が呼び順に増える）。行の id は入力の側で固定する。日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 塊（日誌の1行）の割り方は id の字数の予算（3,600 字）で決まるので、複数の塊を作る場面は id の長さを入力の側で選ぶ
// （1,200 字の id は 1 塊 2 件、300 字の id は 1 塊 11 件）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（受信箱か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

type EventType = InboxEvent['type'];

interface SeedRow {
  id: string;
  type: EventType;
  /** at（基準から何分後か） */
  minute: number;
  extra: Record<string, unknown>;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** この id を道具が消す直前に、別の経路が先に消す（競合。呼びごとに1度だけ） */
  raceFirst: string[];
  /** `inbox.removeMany` の何回目（呼びの中・1 から）を投げさせるか */
  removeManyFailsAt: number[];
  /** `dropQueuedInboxEvents` が投げる */
  dropThrows: boolean;
  /** `dropQueuedInboxEvents` が渡された件数より 1 件少なく返す */
  dropShort: boolean;
  /** `peekPending` が返す「読めない行」 */
  unreadable: UnreadableInboxEvent[];
  /** `peekPending` そのものが落ちる */
  peekFails: boolean;
  /** 競合を起こした id の記録 */
  done: Set<string>;
  removeCalls: number;
  /** 配達の口へ渡された id の塊 */
  dropCalls: string[][];
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Omit<Hooks, 'done' | 'removeCalls' | 'dropCalls'>>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedRow[];
  steps: Step[];
  /** journal.append の何回目（場面の通し・1 から。打ち消しの行も数える）を投げさせるか */
  journalFailsAt?: number[];
  /** `dropQueuedInboxEvents` を渡さない（配線の不備の形） */
  noDelivery?: boolean;
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const ROW_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const PIN_URL = new URL('./clone-tools-inbox-remove-many-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_INBOX_REMOVE_MANY_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteIso(minute: number): string {
  return new Date(ROW_BASE + minute * 60_000).toISOString();
}

function r(
  id: string,
  type: EventType,
  minute: number,
  extra: Record<string, unknown> = {},
): SeedRow {
  return { id, type, minute, extra };
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
function longRows(count: number, type: EventType = 'external'): SeedRow[] {
  return LONG.slice(0, count).map((id, index) => r(id, type, index + 1));
}
function longAt(n: number): string {
  return LONG[n - 1] ?? '';
}

const MID = Array.from({ length: 30 }, (_, index) => midId(index + 1));
function midRows(count: number, type: EventType = 'external'): SeedRow[] {
  return MID.slice(0, count).map((id, index) => r(id, type, index + 1));
}

function buildEvent(row: SeedRow): InboxEvent {
  const base = { id: row.id, at: minuteIso(row.minute) };
  switch (row.type) {
    case 'manager_message':
      return {
        ...base,
        type: 'manager_message',
        managerId: 'mgr-1',
        kind: 'report',
        text: `報告 ${row.id.slice(0, 12)}`,
        ...row.extra,
      } as InboxEvent;
    case 'external':
      return { ...base, type: 'external', source: 'token-pool', ...row.extra } as InboxEvent;
    case 'distill':
      return { ...base, type: 'distill', reason: 'shutdown', ...row.extra } as InboxEvent;
    case 'timer':
      return { ...base, type: 'timer', kind: 'daily_report', ...row.extra } as InboxEvent;
    case 'self_initiative':
      return { ...base, type: 'self_initiative', reason: '暇なので', ...row.extra } as InboxEvent;
    case 'human_message':
      return {
        ...base,
        type: 'human_message',
        text: `人間の発言 ${row.id.slice(0, 12)}`,
        conversationId: 'conv-1',
        ...row.extra,
      } as InboxEvent;
    case 'human_answer':
      return {
        ...base,
        type: 'human_answer',
        approvalId: 'ap-1',
        answer: 'はい',
        ...row.extra,
      } as InboxEvent;
  }
}

const ALL5 = ['distill', 'timer', 'external', 'self_initiative', 'manager_message'];

function call(args: Args): Args {
  return { reason: '片付いた', dryRun: false, ...args };
}

const LONG_REASON = `長い理由。${'あ'.repeat(1_999)}`;

/** 5 種類が1件ずつ + 人間起点 2 件（時刻は 10 分刻み） */
const MIXED: SeedRow[] = [
  r('m-1', 'manager_message', 10),
  r('x-1', 'external', 20, { source: 'webhook' }),
  r('d-1', 'distill', 30),
  r('t-1', 'timer', 40),
  r('s-1', 'self_initiative', 50),
  r('h-1', 'human_message', 60),
  r('a-1', 'human_answer', 70),
];

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-errors',
    covers:
      '検査の順序と各文言（limit・types・sources・before・reason・5種類全部・時差の無い before）。どれも1件も消さない。先に当たった違反だけを返す',
    seed: [
      r('m-1', 'manager_message', 10),
      r('x-1', 'external', 20),
      r('h-1', 'human_message', 30),
    ],
    steps: [
      { args: call({ types: ['manager_message'], limit: 0 }), writes: 'none' },
      { args: call({ types: ['manager_message'], limit: 2001 }), writes: 'none' },
      { args: call({ types: ['manager_message'], limit: 1.5 }), writes: 'none' },
      { args: call({ types: ['manager_message'], limit: -1 }), writes: 'none' },
      { args: call({ types: [] }), writes: 'none' },
      { args: call({ types: [], limit: 0 }), writes: 'none' },
      { args: call({ types: [], sources: [] }), writes: 'none' },
      { args: call({ types: ['human_message'] }), writes: 'none' },
      { args: call({ types: ['manager_message', 'human_answer'] }), writes: 'none' },
      { args: call({ types: ['bogus'] }), writes: 'none' },
      { args: call({ types: ['manager_message'], sources: [] }), writes: 'none' },
      { args: call({ types: ['manager_message'], sources: ['ok', ''] }), writes: 'none' },
      { args: call({ types: ['manager_message'], sources: ['\u0000'] }), writes: 'none' },
      { args: call({ types: ['manager_message'], before: '' }), writes: 'none' },
      { args: call({ types: ['manager_message'], before: '\u0000' }), writes: 'none' },
      { args: call({ types: ['manager_message'], reason: '' }), writes: 'none' },
      { args: call({ types: ['manager_message'], reason: '   ' }), writes: 'none' },
      { args: call({ types: ['manager_message'], reason: '\u0000' }), writes: 'none' },
      { args: call({ types: ['manager_message'], reason: '\u0000 \n' }), writes: 'none' },
      { args: call({ types: ['manager_message'], sources: [], reason: '' }), writes: 'none' },
      { args: call({ types: ['manager_message'], before: '', reason: '' }), writes: 'none' },
      { args: call({ types: ALL5 }), writes: 'none' },
      { args: call({ types: [...ALL5].reverse(), dryRun: undefined }), writes: 'none' },
      { args: call({ types: [...ALL5, 'external', 'timer'], dryRun: true }), writes: 'none' },
      { args: call({ types: ALL5, before: '2026-10-02' }), writes: 'none' },
      { args: call({ types: ALL5, sources: ['x'], limit: 5 }), writes: 'none' },
      { args: call({ types: ALL5, reason: '' }), writes: 'none' },
      { args: call({ types: ['manager_message'], before: '2026-10-02T00:00:00' }), writes: 'none' },
      { args: call({ types: ['manager_message'], before: '2026-10-02' }), writes: 'none' },
      { args: call({ types: ['manager_message'], before: 'きのう' }), writes: 'none' },
      {
        args: call({ types: ['manager_message'], before: '2026-10-02', reason: '' }),
        writes: 'none',
      },
    ],
  },
  // ---- 0件（段ごとの理由） ----
  {
    name: 'zero-empty',
    covers:
      '受信箱に未読が1件も無い（読めない行も無い）: 「絞り込みの問題ではない」。試算でも実行でも同じ文言。絞り込みの軸（sources・before）を渡しても同じ',
    seed: [],
    steps: [
      { args: { types: ['manager_message'], reason: '試算' }, writes: 'none' },
      { args: call({ types: ['manager_message'] }), writes: 'none' },
      {
        args: call({
          types: ['external', 'timer'],
          sources: ['external:x'],
          before: '2026-10-05T00:00:00Z',
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-empty-unreadable',
    covers:
      '読めた未読が1件も無く、読めない行だけが在る: 「読めた未読が1件も無い。ただし読めない合図が N 件ある」。id が取れない行・id の無い行・多数の行・試算と実行',
    seed: [],
    steps: [
      {
        args: call({ types: ['manager_message'] }),
        writes: 'none',
        hooks: { unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }] },
      },
      {
        args: { types: ['external'], reason: '試算' },
        writes: 'none',
        hooks: {
          unreadable: [
            { id: 'broken-1', reason: '壊れた行（テスト用）' },
            { reason: 'id が取れない行（テスト用）' },
          ],
        },
      },
      {
        args: call({ types: ['timer'] }),
        writes: 'none',
        hooks: { unreadable: [{ reason: 'id が取れない行（テスト用）' }] },
      },
      {
        args: call({ types: ['distill'] }),
        writes: 'none',
        hooks: {
          unreadable: Array.from({ length: 12 }, (_, index) => ({
            id: `broken-${String(index + 1)}`,
            at: minuteIso(index + 1),
            reason: '壊れた行（テスト用）',
          })),
        },
      },
    ],
  },
  {
    name: 'zero-types',
    covers:
      '未読は在るが types に当たらない: 選べる5種類の内訳（0 の種類も並ぶ）と、人間起点の行の注意。人間起点が無ければ注意は付かない。試算でも実行でも同じ。読めない行が在っても注意は付かない（この分岐には無い）',
    seed: [
      r('m-1', 'manager_message', 10),
      r('m-2', 'manager_message', 20),
      r('x-1', 'external', 30),
      r('h-1', 'human_message', 40),
      r('a-1', 'human_answer', 50),
    ],
    steps: [
      { args: { types: ['timer'], reason: '試算' }, writes: 'none' },
      { args: call({ types: ['self_initiative'] }), writes: 'none' },
      {
        args: call({ types: ['distill', 'timer'], sources: ['external:token-pool'] }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-types-no-human',
    covers: '人間起点の行が無い受信箱で types に当たらない: 内訳だけで人間起点の注意は付かない',
    seed: [r('m-1', 'manager_message', 10), r('m-2', 'manager_message', 20), r('t-1', 'timer', 30)],
    steps: [
      { args: { types: ['external'], reason: '試算' }, writes: 'none' },
      { args: call({ types: ['distill', 'self_initiative'] }), writes: 'none' },
    ],
  },
  {
    name: 'zero-types-human-only',
    covers: '未読が人間起点の行だけ: 内訳はすべて 0・人間起点の注意が付く（選べず消えない）',
    seed: [
      r('h-1', 'human_message', 10),
      r('h-2', 'human_message', 20),
      r('a-1', 'human_answer', 30),
    ],
    steps: [
      { args: call({ types: ['manager_message'] }), writes: 'none' },
      { args: { types: ['timer'], reason: '試算' }, writes: 'none' },
    ],
  },
  {
    name: 'zero-sources',
    covers:
      'types には当たったが sources の完全一致で0件: external:・manager: の表記・部分一致や前方一致は当たらない・送信元を言えない種類（distill / timer / self_initiative）は sources を渡すと必ず外れる',
    seed: [
      r('x-1', 'external', 10, { source: 'token-pool' }),
      r('x-2', 'external', 20, { source: 'ci-watch' }),
      r('m-1', 'manager_message', 30),
      r('d-1', 'distill', 40),
      r('t-1', 'timer', 50),
      r('s-1', 'self_initiative', 60),
    ],
    steps: [
      { args: call({ types: ['external'], sources: ['token-pool'] }), writes: 'none' },
      { args: call({ types: ['external'], sources: ['external:token'] }), writes: 'none' },
      { args: call({ types: ['external'], sources: ['external:Token-Pool'] }), writes: 'none' },
      {
        args: call({ types: ['manager_message'], sources: ['manager:mgr-2', 'mgr-1'] }),
        writes: 'none',
      },
      {
        args: call({
          types: ['distill', 'timer', 'self_initiative'],
          sources: ['external:token-pool'],
        }),
        writes: 'none',
      },
      { args: { types: ['distill'], sources: ['z'], reason: '試算' }, writes: 'none' },
    ],
  },
  {
    name: 'zero-before',
    covers:
      'sources までは当たったが before より前の行が0件: 絞り込みの文字列は before も出す。+09:00 の時差・ミリ秒・基準ちょうどの1ミリ秒前',
    seed: [
      r('x-1', 'external', 30, { source: 'a' }),
      r('x-2', 'external', 10, { source: 'a' }),
      r('x-3', 'external', 20, { source: 'b' }),
    ],
    steps: [
      { args: call({ types: ['external'], before: '2026-09-30T00:00:00Z' }), writes: 'none' },
      {
        args: call({
          types: ['external'],
          sources: ['external:a'],
          before: '2026-10-01T08:59:59+09:00',
        }),
        writes: 'none',
      },
      {
        args: {
          types: ['external'],
          before: '2026-10-01T00:09:59.999Z',
          reason: '試算',
        },
        writes: 'none',
      },
    ],
  },
  // ---- 試算（dryRun） ----
  {
    name: 'dry-run',
    covers:
      'dryRun を省くと試算（既定）・dryRun: true・絞り込みの全軸（sources・before）が漏斗と「絞り込み」に出る・limit に当たると残りの件数と呼び直しの案内・types の重複と複数・sources の重複。読めない行が在っても試算の出力には出ない。1件も消さない',
    seed: [
      r('x-1', 'external', 10, { source: 'token-pool' }),
      r('x-2', 'external', 20, { source: 'token-pool' }),
      r('x-3', 'external', 30, { source: 'ci-watch' }),
      r('m-1', 'manager_message', 40),
      r('m-2', 'manager_message', 50),
      r('d-1', 'distill', 60),
      r('h-1', 'human_message', 70),
    ],
    steps: [
      { args: { types: ['external'], reason: '片付いた' }, writes: 'none' },
      { args: { types: ['manager_message'], reason: 'やめた', dryRun: true }, writes: 'none' },
      {
        args: {
          types: ['external', 'manager_message'],
          sources: ['external:token-pool', 'manager:mgr-1', 'external:token-pool'],
          before: '2026-10-01T00:50:00.000Z',
          reason: '全軸',
        },
        writes: 'none',
      },
      {
        args: {
          types: ['external', 'external', 'distill'],
          limit: 3,
          reason: '上限',
          dryRun: true,
        },
        writes: 'none',
      },
      {
        args: { types: ['external', 'manager_message'], limit: 1, reason: '1件' },
        writes: 'none',
        hooks: { unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }] },
      },
      {
        args: { types: ['distill', 'timer', 'self_initiative'], reason: '1件だけ' },
        writes: 'none',
      },
    ],
  },
  {
    name: 'dry-run-many',
    covers:
      '試算で対象が 20 件を超える: 先頭 20 件の id と「ほか N 件は省略」・上限（limit）に当たるときの残りの案内と省略の両方・20 件ちょうど',
    seed: Array.from({ length: 25 }, (_, index) =>
      r(`ext-${String(index + 1).padStart(2, '0')}`, 'external', index + 1),
    ),
    steps: [
      { args: { types: ['external'], reason: '多数' }, writes: 'none' },
      { args: { types: ['external'], reason: '多数と上限', limit: 22 }, writes: 'none' },
      { args: { types: ['external'], reason: '20 件ちょうど', limit: 20 }, writes: 'none' },
    ],
  },
  {
    name: 'default-limit',
    covers:
      '当たる行が既定の上限（500 件）を超える（501 件）: 試算で対象は 500 件・残り 1 件・上限 500・省略の件数。実行は 500 件を 2 塊に割って消し（省略の件数・日誌の塊の数）、続けて呼ぶと最後の 1 件',
    seed: Array.from({ length: 501 }, (_, index) =>
      r(`bulk-${String(index + 1).padStart(3, '0')}`, 'external', index + 1),
    ),
    steps: [
      { args: { types: ['external'], reason: '上限の外' }, writes: 'none' },
      { args: call({ types: ['external'], reason: '上限の外' }), writes: 'some' },
      { args: call({ types: ['external'], reason: '残り' }), writes: 'some' },
    ],
  },
  {
    name: 'sort-order',
    covers:
      '対象は積んだ順ではなく at の古い側から（同時刻は積んだ順）。試算の「いちばん古い・新しい」・limit は古い側から・残りは次の呼びで続く',
    seed: [
      r('c-new', 'external', 50),
      r('a-old', 'external', 10),
      r('b-mid', 'external', 30),
      r('d-old-tie', 'external', 10),
      r('e-mid-tie', 'external', 30),
    ],
    steps: [
      { args: { types: ['external'], reason: '試算' }, writes: 'none' },
      { args: call({ types: ['external'], limit: 3 }), writes: 'some' },
      { args: call({ types: ['external'], limit: 3 }), writes: 'some' },
      { args: call({ types: ['external'], limit: 3 }), writes: 'none' },
    ],
  },
  // ---- 実行 ----
  {
    name: 'execute-basic',
    covers:
      'dryRun: false で当たった行だけを消し、理由・絞り込み・消した id を日誌の1行に残し、配達の口へ消した id を渡す。他の種類・人間起点の行は無傷。続けて同じ呼びは0件の理由（内訳）',
    seed: [...MIXED, r('m-2', 'manager_message', 15), r('x-2', 'external', 25)],
    steps: [
      { args: call({ types: ['manager_message'], reason: 'やった' }), writes: 'some' },
      { args: call({ types: ['manager_message'], reason: 'やった' }), writes: 'none' },
      { args: call({ types: ['external', 'distill'], reason: '二種類' }), writes: 'some' },
      {
        args: call({ types: ['timer', 'self_initiative'], reason: '残りの二種類' }),
        writes: 'some',
      },
      {
        args: call({ types: ['timer', 'self_initiative', 'distill'], reason: '空振り' }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'execute-axes',
    covers:
      'sources は完全一致（external:<source>・manager:<managerId>）・before は境界ちょうどを含み後を含まない（+09:00 でも同じ瞬間）・types と sources と before の組み合わせの漏斗と日誌の「絞り込み」',
    seed: [
      r('exact', 'external', 1, { source: 'token-pool' }),
      r('near', 'external', 2, { source: 'token-pool-2' }),
      r('edge-in', 'external', 20, { source: 'edge' }),
      r('edge-out', 'external', 21, { source: 'edge' }),
      r('combo-1', 'manager_message', 30, { managerId: 'mgr-1' }),
      r('combo-2', 'manager_message', 31, { managerId: 'mgr-2' }),
      r('combo-3', 'manager_message', 90, { managerId: 'mgr-1' }),
      r('mixed-x', 'external', 100, { source: 'ci' }),
      r('mixed-m', 'manager_message', 101, { managerId: 'ci' }),
      r('nosrc', 'timer', 102),
    ],
    steps: [
      {
        args: call({ types: ['external'], sources: ['external:token-pool'], reason: 'source' }),
        writes: 'some',
      },
      {
        args: call({
          types: ['external'],
          sources: ['external:edge'],
          before: '2026-10-01T00:20:00.000Z',
          reason: 'before',
        }),
        writes: 'some',
      },
      {
        args: call({
          types: ['manager_message'],
          sources: ['manager:mgr-1', 'manager:mgr-3'],
          before: '2026-10-01T09:30:00+09:00',
          reason: '全軸',
        }),
        writes: 'some',
      },
      {
        args: call({
          types: ['external', 'manager_message', 'timer'],
          sources: ['external:ci', 'manager:ci'],
          reason: '二種類の source',
        }),
        writes: 'some',
      },
      {
        args: call({ types: ['timer'], sources: ['timer'], reason: 'timer は外れる' }),
        writes: 'none',
      },
      {
        args: call({
          types: ['manager_message'],
          before: '2026-10-01T01:00:00.000Z',
          reason: 'before だけ',
        }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'rich-rows',
    covers:
      '受信箱の行の形（payload・identity・via・attachments・requestId・markup・foldWhenBack・rejectedAttachments など任意の欄）。消さなかった行は欄ごとそのまま残り、deliveries も保たれる',
    seed: [
      r('x-rich', 'external', 10, {
        source: 'webhook',
        payload: { n: 1, nested: { a: [1, 2, 3] } },
        identity: 'id-1',
        via: { keyId: 'key-1', name: 'テストの鍵' },
        attachments: [
          {
            id: 'att-1',
            name: 'a.txt',
            mediaType: 'text/plain',
            size: 3,
            sha256: 'abc123',
          },
        ],
      }),
      r('m-rich', 'manager_message', 20, {
        managerId: 'mgr-9',
        kind: 'question',
        text: '質問です\n二行目',
        requestId: 'req-1',
        markup: 'markdown',
        statusAtDelivery: 'running',
        synthesized: true,
        foldedTurn: true,
        quotaStop: true,
        quotaSessionWindow: true,
        foldWhenBack: { movedFromGeneration: 3 },
        rejectedAttachments: [{ name: 'big.bin', reason: '大きすぎる' }],
      }),
      r('t-rich', 'timer', 30, { target: '2026-09-30', cause: 'manual', heldForUsage: true }),
      r('s-rich', 'self_initiative', 40, { cause: 'schedule_catchup' }),
      r('h-rich', 'human_message', 50, { supersedes: 'h-old', clientMessageId: 'c-1' }),
      r('a-rich', 'human_answer', 60, { conversationId: 'conv-2' }),
    ],
    steps: [
      { args: call({ types: ['external', 'self_initiative'], reason: '二件' }), writes: 'some' },
      {
        args: call({ types: ['manager_message'], sources: ['manager:mgr-9'], reason: '一件' }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'reason-forms',
    covers:
      '理由の形: 改行・NUL を含む・前後に空白・長い理由（上限は無い）・記号。出力・日誌にどう残るか',
    seed: [
      r('r-1', 'external', 1),
      r('r-2', 'external', 2),
      r('r-3', 'external', 3),
      r('r-4', 'external', 4),
    ],
    steps: [
      {
        args: call({ types: ['external'], limit: 1, reason: '一行目\n二行目\u0000です' }),
        writes: 'some',
      },
      { args: call({ types: ['external'], limit: 1, reason: '  前後に空白  ' }), writes: 'some' },
      { args: call({ types: ['external'], limit: 1, reason: LONG_REASON }), writes: 'some' },
      {
        args: call({ types: ['external'], limit: 1, reason: '**強調** `code` [x](y)' }),
        writes: 'some',
      },
    ],
  },
  {
    name: 'limit-steps',
    covers:
      'limit は古い側から limit 件だけ消し、残りの件数と呼び直しの案内を言う。続けて呼ぶと続きを消し、最後は残りの案内が消える。limit 1・limit 2000（上限ちょうど）',
    seed: [
      r('e-1', 'external', 1),
      r('e-2', 'external', 2),
      r('e-3', 'external', 3),
      r('e-4', 'external', 4),
      r('e-5', 'external', 5),
      r('m-1', 'manager_message', 6),
      r('m-2', 'manager_message', 7),
    ],
    steps: [
      { args: call({ types: ['external'], limit: 2 }), writes: 'some' },
      { args: call({ types: ['external'], limit: 2 }), writes: 'some' },
      { args: call({ types: ['external'], limit: 2 }), writes: 'some' },
      { args: call({ types: ['external'], limit: 2 }), writes: 'none' },
      { args: call({ types: ['manager_message'], limit: 1 }), writes: 'some' },
      { args: call({ types: ['manager_message'], limit: 2000 }), writes: 'some' },
    ],
  },
  {
    name: 'dropper-counts',
    covers:
      '配達の待ち行列から外した件数は、口が返した件数（消えた件数より少なくてもよい）。0 件を返す口・1 件少なく返す口。消えた id が 0 件の塊では口を呼ばない',
    seed: [r('e-1', 'external', 1), r('e-2', 'external', 2), r('e-3', 'external', 3)],
    steps: [
      { args: call({ types: ['external'], limit: 1 }), writes: 'some', hooks: { dropShort: true } },
      { args: call({ types: ['external'], limit: 2 }), writes: 'some', hooks: { dropShort: true } },
    ],
  },
  // ---- 塊（日誌の1行）が複数 ----
  {
    name: 'many-ok',
    covers:
      '対象が複数の塊に割れる（300 字の id・11 件ずつ）・消した id が 20 件を超えて出力は省略・全 id は日誌に塊の数だけの行で残る・配達の口は塊ごとに呼ばれる・続けて呼ぶと0件',
    seed: [...midRows(25), r('h-1', 'human_message', 100)],
    steps: [
      { args: call({ types: ['external'], reason: '多数' }), writes: 'some' },
      { args: call({ types: ['external'], reason: '多数' }), writes: 'none' },
    ],
  },
  {
    name: 'many-race',
    covers:
      '塊が丸ごと競合になる（最後の塊の 8 件を別の経路が先に消す）と配達の口は呼ばず、日誌には「消す」行と打ち消しの行が残る・日誌の件数は書いた塊の数・「消せなかった」の注意',
    seed: midRows(30),
    steps: [
      {
        args: call({ types: ['external'], reason: '競合あり' }),
        writes: 'some',
        hooks: { raceFirst: MID.slice(22, 30) },
      },
    ],
  },
  {
    name: 'race',
    covers:
      '当たったのに消せなかった: 1塊の途中の id を別の経路が先に消した（一部の競合）・1塊で全件が競合・次の呼びで残りを消す。打ち消しの行は消せなかった id だけを名指しする',
    seed: [...longRows(9), r('h-1', 'human_message', 100)],
    steps: [
      {
        args: call({ types: ['external'], reason: '競合', limit: 6 }),
        writes: 'some',
        hooks: { raceFirst: [longAt(2), longAt(3), longAt(4)] },
      },
      {
        args: call({ types: ['external'], reason: '全件の競合', limit: 2 }),
        writes: 'some',
        hooks: { raceFirst: [longAt(7), longAt(8)] },
      },
      { args: call({ types: ['external'], reason: '残り' }), writes: 'some' },
    ],
  },
  {
    name: 'race-single',
    covers: '塊が1つで一部が競合（日誌は「消す」行と打ち消しの行の2行・配達の口は消えた分だけ）',
    seed: [r('e-1', 'external', 1), r('e-2', 'external', 2), r('e-3', 'external', 3)],
    steps: [
      {
        args: call({ types: ['external'], reason: '一部競合' }),
        writes: 'some',
        hooks: { raceFirst: ['e-2'] },
      },
    ],
  },
  // ---- 消す側が落ちる ----
  {
    name: 'remove-fails',
    covers:
      '1塊目の消す操作が落ちる: 日誌には「消す」行と「確かめられていない」行・例外がそのまま出る（受信箱は器の側で消えていない）→ 2塊構成の2塊目で落ちる（1塊目は消えていて日誌に在る）→ 直して続きを消す',
    seed: longRows(4),
    steps: [
      {
        args: call({ types: ['external'] }),
        writes: 'some',
        hooks: { removeManyFailsAt: [1] },
      },
      {
        args: call({ types: ['external'] }),
        writes: 'some',
        hooks: { removeManyFailsAt: [2] },
      },
      { args: call({ types: ['external'] }), writes: 'some' },
    ],
  },
  {
    name: 'dropper-fails',
    covers:
      '配達の口が投げる: 行は消えたあと（器から消してから口を呼ぶ）で、日誌に「確かめられていない」行（消えた id も未確認に数える）・例外がそのまま出る',
    seed: [r('e-1', 'external', 1), r('e-2', 'external', 2)],
    steps: [
      { args: call({ types: ['external'] }), writes: 'some', hooks: { dropThrows: true } },
      { args: call({ types: ['external'] }), writes: 'none' },
    ],
  },
  // ---- 配線の不備 ----
  {
    name: 'no-delivery',
    covers:
      '配達を止める口が渡されていない: 実行は1件も消さず断る（日誌も書かない）。試算・0件・引数の違反はその前に返るので普段どおり',
    seed: [r('e-1', 'external', 1), r('e-2', 'external', 2), r('h-1', 'human_message', 3)],
    noDelivery: true,
    steps: [
      { args: { types: ['external'], reason: '試算' }, writes: 'none' },
      { args: call({ types: ['external'] }), writes: 'none' },
      { args: call({ types: ['timer'] }), writes: 'none' },
      { args: call({ types: ALL5 }), writes: 'none' },
      { args: call({ types: ['external'], limit: 0 }), writes: 'none' },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails-single',
    covers:
      '唯一の塊の先の日誌が書けない: 1件も消さずに投げる（行為は起きていない）。配達の口は呼ばない。次の呼びで日誌が戻れば消える',
    seed: [r('e-1', 'external', 1), r('e-2', 'external', 2), r('e-3', 'external', 3)],
    journalFailsAt: [1],
    steps: [
      { args: call({ types: ['external'], reason: '日誌が落ちる' }), writes: 'none' },
      { args: call({ types: ['external'], reason: '日誌が戻った' }), writes: 'some' },
    ],
  },
  {
    name: 'journal-fails-first-of-many',
    covers: '複数の塊の1塊目の日誌が書けない（日誌の書き込みの1回目）: 後ろの塊も消さずに投げる',
    seed: longRows(8),
    journalFailsAt: [1],
    steps: [{ args: call({ types: ['external'] }), writes: 'none' }],
  },
  {
    name: 'journal-fails-mid',
    covers:
      '途中の塊（2/4）の先の日誌が書けない: その塊と以降は消さずに止め、前の 1 塊は消えていて日誌に在る（投げず、どこまで消したかを返す）。日誌が戻ってから同じ絞り込みで続きを消す',
    seed: longRows(8),
    journalFailsAt: [2],
    steps: [
      { args: call({ types: ['external'] }), writes: 'some' },
      { args: call({ types: ['external'] }), writes: 'some' },
    ],
  },
  {
    name: 'journal-fails-last-rest',
    covers:
      '最後の塊（4/4）の先の日誌が書けず、上限に収まらず対象にしなかった行がある（止めた案内と上限の案内の両方）',
    seed: longRows(9),
    journalFailsAt: [4],
    steps: [{ args: call({ types: ['external'], limit: 8 }), writes: 'some' }],
  },
  {
    name: 'journal-fails-retraction',
    covers:
      '打ち消しの行の日誌が書けない（先の行は書けて、競合で消せなかった id が在り、打ち消しの書き込み＝2回目が落ちる）: 打ち消しは黙って諦める（best effort）。出力は競合の注意を付けて普段どおり',
    seed: [r('e-1', 'external', 1), r('e-2', 'external', 2)],
    journalFailsAt: [2],
    steps: [
      {
        args: call({ types: ['external'] }),
        writes: 'some',
        hooks: { raceFirst: ['e-1'] },
      },
    ],
  },
  {
    name: 'journal-fails-unconfirmed',
    covers:
      '消す操作が落ち、さらに「確かめられていない」行の日誌も書けない（2回目が落ちる）: 補いの行は黙って諦め、元の例外が出る',
    seed: [r('e-1', 'external', 1)],
    journalFailsAt: [2],
    steps: [
      {
        args: call({ types: ['external'] }),
        writes: 'some',
        hooks: { removeManyFailsAt: [1] },
      },
    ],
  },
  // ---- 読めない行 ----
  {
    name: 'unreadable-with-pending',
    covers:
      '読めない行が在る受信箱: 当たる行が在れば実行も試算も読めない行は出力に出ない（消さず・数えず）。当たらない（内訳の）分岐にも出ない。受信箱の読めない行の一覧は呼ぶ前後で同じ',
    seed: [r('e-1', 'external', 1), r('m-1', 'manager_message', 2), r('h-1', 'human_message', 3)],
    steps: [
      {
        args: { types: ['external'], reason: '試算' },
        writes: 'none',
        hooks: { unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }] },
      },
      {
        args: call({ types: ['timer'] }),
        writes: 'none',
        hooks: { unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }] },
      },
      {
        args: call({ types: ['external'] }),
        writes: 'some',
        hooks: {
          unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }, { reason: 'id 無し' }],
        },
      },
      {
        args: call({ types: ['manager_message'] }),
        writes: 'some',
        hooks: { unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }] },
      },
      {
        args: call({ types: ['external'] }),
        writes: 'none',
        hooks: { unreadable: [{ id: 'broken-1', reason: '壊れた行（テスト用）' }] },
      },
    ],
  },
  // ---- 一覧が読めない ----
  {
    name: 'peek-fails',
    covers:
      '受信箱の一覧そのものが落ちる: 例外がそのまま出る。試算でも実行でも受信箱・日誌は変わらない',
    seed: [r('e-1', 'external', 1)],
    steps: [
      { args: { types: ['external'], reason: '試算' }, writes: 'none', hooks: { peekFails: true } },
      { args: call({ types: ['external'] }), writes: 'none', hooks: { peekFails: true } },
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

interface PinnedInbox {
  /** 呼んだあとの受信箱の行（消えた行は無い。ストアから読んだ形のまま） */
  entries: unknown[];
  /** 呼んだあとの読めない行（この呼びの間 `peekPending` が返した一覧） */
  unreadable: UnreadableInboxEvent[];
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  inbox: PinnedInbox;
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 配達の口（dropQueuedInboxEvents）へ渡された id の塊 */
  delivery: string[][];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function snapshot(
  base: Stores,
  unreadable: readonly UnreadableInboxEvent[],
): Promise<{ inbox: PinnedInbox; journal: unknown[] }> {
  return {
    inbox: {
      entries: plain((await base.inbox.peekPending()).entries) as unknown[],
      unreadable: plain([...unreadable]),
    },
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown[],
  };
}

function freshHooks(): Hooks {
  return {
    raceFirst: [],
    removeManyFailsAt: [],
    dropThrows: false,
    dropShort: false,
    unreadable: [],
    peekFails: false,
    done: new Set(),
    removeCalls: 0,
    dropCalls: [],
  };
}

function withHooks(base: Stores, hooks: Hooks, failJournalAt: readonly number[]): Stores {
  let journalCalls = 0;
  const inbox: Stores['inbox'] = {
    ...base.inbox,
    peekPending: async () => {
      if (hooks.peekFails) throw new Error('受信箱の一覧が読めない');
      const peeked = await base.inbox.peekPending();
      return { entries: peeked.entries, unreadable: hooks.unreadable };
    },
    removeMany: async (ids) => {
      hooks.removeCalls += 1;
      if (hooks.removeManyFailsAt.includes(hooks.removeCalls)) {
        throw new Error('受信箱の削除が落ちた');
      }
      for (const id of ids) {
        if (hooks.raceFirst.includes(id) && !hooks.done.has(id)) {
          hooks.done.add(id);
          await base.inbox.remove(id);
        }
      }
      return base.inbox.removeMany(ids);
    },
  };
  return {
    ...base,
    inbox,
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

async function seedRows(base: Stores, seed: readonly SeedRow[]): Promise<void> {
  for (const row of seed) {
    const event = buildEvent(row);
    await base.inbox.put(event, event.at);
  }
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedRows(base, scenario.seed);
  const hooks = freshHooks();
  const stores = withHooks(base, hooks, scenario.journalFailsAt ?? []);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.noDelivery === true
      ? {}
      : {
          dropQueuedInboxEvents: async (ids: readonly string[]) => {
            hooks.dropCalls.push([...ids]);
            if (hooks.dropThrows) throw new Error('配達の口が落ちた');
            return hooks.dropShort ? Math.max(0, ids.length - 1) : ids.length;
          },
        }),
  });
  const found = tools.find((entry) => entry.name === 'inbox_remove_many');
  if (!found) throw new Error('inbox_remove_many が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    Object.assign(hooks, freshHooks(), step.hooks ?? {});
    const before = await snapshot(base, hooks.unreadable);
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
    const after = await snapshot(base, hooks.unreadable);
    const delivery = hooks.dropCalls;
    // 次の呼びへ口を持ち越さない（この呼びの仕込みだけが効く）
    Object.assign(hooks, freshHooks());
    const wrote =
      JSON.stringify(before.inbox.entries) !== JSON.stringify(after.inbox.entries) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      inbox: after.inbox,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      delivery,
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、受信箱が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
      expect(
        after.inbox.entries,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、受信箱が呼ぶ前から変わった`,
      ).toEqual(before.inbox.entries);
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

describe('inbox_remove_many の出力と呼んだあとの状態の固定（場面ごとの出力の全文・受信箱の行・日誌の行）', () => {
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

      it(`${key} の呼んだあとの受信箱の行と配達の口へ渡した id が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.inbox.entries.map((row) => (row as { event: { id: string } }).event.id),
          `場面 ${key} の受信箱: 残った行の並び（id）が変わった`,
        ).toEqual(want?.inbox.entries.map((row) => (row as { event: { id: string } }).event.id));
        for (const [row, wantRow] of (want?.inbox.entries ?? []).entries()) {
          expect(
            got?.inbox.entries[row],
            `場面 ${key} の受信箱の ${String((wantRow as { event: { id: string } }).event.id).slice(0, 16)}（${String(row)} 行目）が固定値からずれた（種類・source・時刻・会話・本文・deliveries など）`,
          ).toEqual(wantRow);
        }
        expect(got?.inbox.unreadable, `場面 ${key} の受信箱: 読めない行の一覧が変わった`).toEqual(
          want?.inbox.unreadable,
        );
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
        expect(
          got?.delivery.map((ids) => ids.map((id) => id.slice(0, 16))),
          `場面 ${key} の配達の口へ渡した id の塊が変わった`,
        ).toEqual(want?.delivery.map((ids) => ids.map((id) => id.slice(0, 16))));
        expect(got?.delivery, `場面 ${key} の配達の口へ渡した id（全文）が変わった`).toEqual(
          want?.delivery,
        );
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

  it('同じ入力で2回回すと、全場面で同じ出力・受信箱・日誌になる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const step = (key: string): PinnedStep | undefined => actual[key];
    const ids = (key: string): string[] =>
      (step(key)?.inbox.entries ?? []).map((row) => (row as { event: { id: string } }).event.id);
    const journal = (key: string): Record<string, unknown>[] => step(key)?.journal ?? [];
    const decisionOf = (key: string, row: number): string => {
      const entry = journal(key)[row];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    // 引数の検査
    expect(text('arg-errors#1')).toContain('limit 0 は使えない');
    expect(text('arg-errors#2')).toContain('limit 2001 は使えない');
    expect(text('arg-errors#3')).toContain('limit 1.5 は使えない');
    expect(text('arg-errors#5')).toContain('types は使えない');
    expect(text('arg-errors#6')).toContain('limit 0 は使えない');
    expect(text('arg-errors#8')).toContain('types は使えない');
    expect(text('arg-errors#11')).toContain('sources は使えない');
    expect(text('arg-errors#12')).toContain('1 番目（0起点）が空文字');
    expect(text('arg-errors#14')).toContain('before は使えない');
    expect(text('arg-errors#16')).toContain('reason は使えない');
    expect(text('arg-errors#17')).toContain('空白だけの値');
    expect(text('arg-errors#22')).toContain('を全部並べた呼びは断る');
    expect(text('arg-errors#24')).toContain('を全部並べた呼びは断る');
    // 5種類全部の検査は before の時差の検査より先、reason の検査より後
    expect(text('arg-errors#25')).toContain('を全部並べた呼びは断る');
    expect(text('arg-errors#25')).not.toContain('時差');
    expect(text('arg-errors#27')).toContain('reason は使えない');
    expect(text('arg-errors#28')).toContain('時差が無い');
    expect(text('arg-errors#30')).toContain('きのう');
    expect(text('arg-errors#31')).toContain('reason は使えない');
    // 0件
    expect(text('zero-empty#1')).toContain('受信箱に未読が1件も無い');
    expect(text('zero-empty-unreadable#1')).toContain('読めた未読が1件も無い');
    expect(text('zero-empty-unreadable#2')).toContain('id が取れない行が 1 件');
    expect(text('zero-empty-unreadable#4')).toContain('ほか 2 件');
    expect(text('zero-types#1')).toContain('manager_message 2（このほか人間起点の行が 2 件');
    expect(text('zero-types-no-human#1')).not.toContain('人間起点');
    expect(text('zero-types-human-only#1')).toContain('人間起点の行が 3 件');
    expect(text('zero-sources#5')).toContain('distill 1 / timer 1 / external 2');
    expect(text('zero-before#2')).toContain('絞り込みが外れている');
    // 試算
    expect(text('dry-run#1')).toContain('**試算（dryRun）。1件も消していない。**');
    expect(text('dry-run#3')).toContain('（完全一致） / before=2026-10-01T00:50:00.000Z');
    expect(text('dry-run#4')).toContain('残り 1 件は対象にしていない');
    expect(text('dry-run-many#1')).toContain('…ほか 5 件は省略');
    expect(text('dry-run-many#2')).toContain('残り 3 件は対象にしていない');
    expect(text('dry-run-many#3')).not.toContain('省略');
    expect(text('default-limit#1')).toContain('1回の上限（500 件）');
    expect(text('sort-order#1')).toContain('いちばん古いのは 2026-10-01T00:10:00.000Z');
    expect(text('sort-order#1')).toContain('a-old, d-old-tie, b-mid, e-mid-tie, c-new');
    // 実行
    expect(text('default-limit#2')).toContain('全 id は日誌に 2 件に分けて残してある');
    expect(journal('default-limit#2')).toHaveLength(2);
    expect(ids('default-limit#2')).toEqual(['bulk-501']);
    expect(text('execute-basic#1')).toContain('**2 件を畳んだ（消した）**');
    expect(ids('execute-basic#1')).not.toContain('m-1');
    expect(ids('execute-basic#1')).toContain('h-1');
    expect(journal('execute-basic#1')).toHaveLength(1);
    expect(journal('execute-basic#1')[0]?.type).toBe('decision');
    expect(decisionOf('execute-basic#1', 0)).toContain('消す id: m-1 m-2');
    expect(step('execute-basic#1')?.delivery).toEqual([['m-1', 'm-2']]);
    expect(ids('execute-axes#1')).not.toContain('exact');
    expect(ids('execute-axes#1')).toContain('near');
    expect(ids('execute-axes#2')).not.toContain('edge-in');
    expect(ids('execute-axes#2')).toContain('edge-out');
    expect(ids('execute-axes#3')).not.toContain('combo-1');
    expect(ids('execute-axes#3')).toContain('combo-3');
    expect(decisionOf('execute-axes#3', 0)).toContain(
      '絞り込み: types=[manager_message] / sources=[manager:mgr-1, manager:mgr-3]（完全一致） / before=',
    );
    expect(ids('execute-axes#5')).toContain('nosrc');
    expect(ids('rich-rows#2')).toEqual(['t-rich', 'h-rich', 'a-rich']);
    expect(text('reason-forms#3')).toContain(LONG_REASON);
    expect(text('limit-steps#1')).toContain('残り 3 件');
    expect(text('limit-steps#3')).not.toContain('に当たったので');
    expect(text('dropper-counts#1')).toContain('配達の待ち行列からも外したのは 0 件');
    expect(text('dropper-counts#2')).toContain('配達の待ち行列からも外したのは 1 件');
    // 複数の塊
    expect(text('many-ok#1')).toContain(
      '…ほか 5 件は省略（**全 id は日誌に 3 件に分けて残してある**）',
    );
    expect(journal('many-ok#1')).toHaveLength(3);
    expect(step('many-ok#1')?.delivery.map((chunk) => chunk.length)).toEqual([11, 11, 3]);
    expect(text('many-race')).toContain('件は消せなかった');
    expect(text('many-race')).toContain('⚠ 対象 30 件のうち 8 件は消せなかった');
    expect(journal('many-race')).toHaveLength(4);
    expect(step('many-race')?.delivery.map((chunk) => chunk.length)).toEqual([11, 11]);
    expect(decisionOf('many-race', 3)).toContain('直前の行を一部打ち消す');
    expect(text('race#1')).toContain('⚠ 対象 6 件のうち 3 件は消せなかった');
    expect(text('race#2')).toContain('**0 件を畳んだ（消した）**');
    expect(step('race#2')?.delivery).toEqual([]);
    expect(text('race-single')).toContain('⚠ 対象 3 件のうち 1 件は消せなかった');
    expect(decisionOf('race-single', 1)).toContain('直前の行を一部打ち消す');
    expect(decisionOf('race-single', 1)).toContain('e-2');
    // 消す側が落ちる
    expect(text('remove-fails#1')).toBe('受信箱の削除が落ちた');
    expect(step('remove-fails#1')?.output.thrown).toBe(true);
    expect(decisionOf('remove-fails#1', 1)).toContain('確かめられていない');
    expect(journal('remove-fails#2')).toHaveLength(3);
    expect(ids('remove-fails#2')).toHaveLength(2);
    expect(text('remove-fails#3')).toContain('**2 件を畳んだ（消した）**');
    expect(text('dropper-fails#1')).toBe('配達の口が落ちた');
    expect(ids('dropper-fails#1')).toEqual([]);
    expect(decisionOf('dropper-fails#1', 1)).toContain('確かめられていない');
    // 配線の不備
    expect(text('no-delivery#1')).toContain('**試算（dryRun）。1件も消していない。**');
    expect(text('no-delivery#2')).toContain('配達の待ち行列から落とす口が渡されていない');
    expect(text('no-delivery#3')).toContain('絞り込みに当たる未読は0件だった');
    expect(text('no-delivery#4')).toContain('を全部並べた呼びは断る');
    expect(text('no-delivery#5')).toContain('limit 0 は使えない');
    // 日誌が落ちる
    expect(text('journal-fails-single#1')).toContain(
      '⚠⚠ 未記録・行為は起きていない・やり直してよい',
    );
    expect(step('journal-fails-single#1')?.output.thrown).toBe(true);
    expect(journal('journal-fails-single#1')).toEqual([]);
    expect(text('journal-fails-first-of-many')).toContain('行為は起きていない');
    expect(ids('journal-fails-first-of-many')).toHaveLength(8);
    expect(text('journal-fails-mid#1').split('\n')[0]).toContain(
      '⚠⚠ 2/4 塊目の先の日誌が書けなかった',
    );
    expect(text('journal-fails-mid#1')).toContain('止める前の 1 塊は消えていて日誌にも残っている');
    expect(text('journal-fails-last-rest')).toContain('4/4 塊目の先の日誌が書けなかった');
    expect(text('journal-fails-last-rest')).toContain('残り 1 件は対象にしていない');
    expect(text('journal-fails-retraction')).toContain('⚠ 対象 2 件のうち 1 件は消せなかった');
    expect(journal('journal-fails-retraction')).toHaveLength(1);
    expect(text('journal-fails-unconfirmed')).toBe('受信箱の削除が落ちた');
    expect(journal('journal-fails-unconfirmed')).toHaveLength(1);
    // 読めない行（実行・試算の出力には出ない）
    expect(text('unreadable-with-pending#1')).not.toContain('読めない');
    expect(text('unreadable-with-pending#3')).not.toContain('読めない');
    expect(step('unreadable-with-pending#3')?.inbox.unreadable).toHaveLength(2);
    // 一覧が落ちる
    expect(text('peek-fails#1')).toBe('受信箱の一覧が読めない');
    expect(text('peek-fails#2')).toBe('受信箱の一覧が読めない');
  });
});
