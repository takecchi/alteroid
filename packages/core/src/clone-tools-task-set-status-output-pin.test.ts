import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `task_set_status` の出力（全文と字数）と、呼んだあとの状態（task の行・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-task-set-status-output-pin.json）と丸ごと比べる。
// `clone-tools-task.ts` の `tool('task_set_status', …)`（ハンドラ約 107 行・入れ子 5 段の式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・task の本文）を固定して毎回同じにする。
// この道具は task を書き換え、開き直しだけ日誌を先に書くので、出力だけでなく「呼んだあとの状態」と「ストアの呼びの順」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - tasks: 呼んだあとの task の行を、ストアから読んだ形のまま（閉じた行を含む全件）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま。書けなかった行は含まない）
//   - calls: ストアの呼びの並び（tasks.get・tasks.setStatus（渡した reason・by・at と結果）・journal.append（行の全体と成否））
//   - wrote: task か日誌のどちらかが呼ぶ前から変わったか。断った・当たらなかった場面は false で、task・日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_TASK_SET_STATUS_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-task-set-status-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-task-set-status-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、task・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// task は場面の頭に固定の createdAt で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（閉じた時刻 closedAt・日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 「開き直しの間に別の手で変わる」は、道具が tasks.get で読んだ後・tasks.setStatus を呼ぶ直前に、
// 別の経路（人間）が土台のストアを直に書き換える口（beforeSetStatus）で作る。呼びの記録（calls）には道具の呼びだけが残り、口の書き換えは残らない。
//
// 作れない分岐（理由）:
//   - 開き直し（journaledFirst がある）のとき setStatus が `rejected` を返す分岐: 移し先が queued で、閉じた件・開いている件のどちらからも
//     `planTaskTransition` は queued を拒まない（同じ状態は unchanged）。開き直しの打ち消しの文言のうち「別の手で状態が変わっていた」は、
//     実際には unchanged（別の手が先に開き直した）でだけ出る。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（task か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

type Failure = 'unreadable' | 'plain';

type RaceAction =
  | 'remove' // task を消す
  | 'other-reopen' // 別の手が先に開き直す（queued へ）
  | 'reclose' // 別の手が開き直して、別の時刻で閉じ直す
  | 'reclose-same-time' // 別の手が開き直して、同じ時刻（closedAt）・別の理由で閉じ直す
  | 'other-moved'; // 別の手が開き直して、waiting へ動かす

interface SeedTask {
  id: string;
  /** createdAt（基準から何分後か） */
  minute: number;
  /** 省略すると queued。done / cancelled は積んだ後に閉じる（閉じた時刻は SEED_CLOSED_ISO・主体は human） */
  status?: 'queued' | 'waiting' | 'needs_decision' | 'done' | 'cancelled';
  /** 閉じた理由（既定は「先に閉じた」） */
  closedReason?: string;
  /** 閉じた主体・理由を持たない閉じた行（closedAt だけ）を直に積む */
  bare?: boolean;
  conv?: string;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い） */
interface Hooks {
  /** tasks.get が落ちる */
  getFails?: Failure;
  /** tasks.setStatus が落ちる（口の書き換えより前） */
  setStatusFails?: Failure;
  /** tasks.setStatus を呼ぶ直前に、別の経路が土台を書き換える */
  beforeSetStatus?: RaceAction;
  /** この呼びの journal.append の何回目（1 から。先の行も打ち消しの行も数える）を投げさせるか */
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
const OTHER_OPEN_ISO = '2026-10-28T12:00:00.000Z';
const OTHER_CLOSE_ISO = '2026-10-28T13:00:00.000Z';
const PIN_URL = new URL('./clone-tools-task-set-status-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_TASK_SET_STATUS_PIN === '1';

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

function set(taskId: string, status: string, reason?: string): Args {
  return reason === undefined ? { taskId, status } : { taskId, status, reason };
}

const SCENARIOS: Scenario[] = [
  // ---- 閉じるときの reason ----
  {
    name: 'reason-missing',
    covers:
      '閉じる（done / cancelled）のに reason が無い（undefined）: 断りの文。task・日誌は変わらず、ストアは呼ばない',
    seed: [t('q-1', 1)],
    steps: [
      { args: set('q-1', 'done'), writes: 'none' },
      { args: set('q-1', 'cancelled'), writes: 'none' },
      { args: { taskId: 'q-1', status: 'done', reason: undefined }, writes: 'none' },
    ],
  },
  {
    name: 'reason-invalid',
    covers:
      'reason が空・空白だけ・NUL: 閉じる呼びも開いている状態への呼び・閉じた件の開き直しも、ストアを呼ぶ前に同じ検査で断る（get も呼ばない）',
    seed: [t('q-1', 1), t('d-1', 2, { status: 'done' })],
    steps: [
      { args: set('q-1', 'done', ''), writes: 'none' },
      { args: set('q-1', 'cancelled', ''), writes: 'none' },
      { args: set('q-1', 'done', '   '), writes: 'none' },
      { args: set('q-1', 'done', '\n\t　'), writes: 'none' },
      { args: set('q-1', 'done', '\u0000'), writes: 'none' },
      { args: set('q-1', 'waiting', ''), writes: 'none' },
      { args: set('q-1', 'needs_decision', '  '), writes: 'none' },
      { args: set('d-1', 'queued', ''), writes: 'none' },
      { args: set('d-1', 'queued', '   '), writes: 'none' },
    ],
  },
  // ---- 開いている状態どうし ----
  {
    name: 'open-moves',
    covers:
      '開いている3つ（queued / waiting / needs_decision）の行き来: reason の有無。queued への呼びだけ tasks.get を先に呼ぶが、閉じていないので日誌は先に書かない。日誌は setStatus のあと（act-completed）',
    seed: [
      t('q-1', 1),
      t('w-1', 2, { status: 'waiting' }),
      t('n-1', 3, { status: 'needs_decision' }),
    ],
    steps: [
      { args: set('q-1', 'waiting', '返事待ち'), writes: 'some' },
      { args: set('w-1', 'needs_decision'), writes: 'some' },
      { args: set('n-1', 'queued', '判断が出た'), writes: 'some' },
      { args: set('q-1', 'queued'), writes: 'some' },
      { args: set('w-1', 'needs_decision', '同じ状態'), writes: 'none' },
      { args: set('q-1', 'needs_decision'), writes: 'some' },
      { args: set('q-1', 'queued', '戻した'), writes: 'some' },
    ],
  },
  // ---- 閉じる ----
  {
    name: 'close',
    covers:
      '閉じる（done / cancelled）: どの開いている状態からも。閉じた記録（closedAt・closedBy=clone・closedReason は cleanText 済み）。日誌は setStatus のあと（act-completed）。tasks.get は呼ばない',
    seed: [
      t('q-1', 1),
      t('w-1', 2, { status: 'waiting' }),
      t('n-1', 3, { status: 'needs_decision' }),
      t('q-2', 4),
    ],
    steps: [
      { args: set('q-1', 'done', '片付いた'), writes: 'some' },
      { args: set('w-1', 'cancelled', 'やめた'), writes: 'some' },
      { args: set('n-1', 'done', '  前後に空白  '), writes: 'some' },
      { args: set('q-2', 'cancelled', '一行目\n二行目'), writes: 'some' },
    ],
  },
  // ---- 同じ状態 ----
  {
    name: 'unchanged',
    covers:
      '同じ状態（unchanged）: 何もしないの文。queued への呼びは get を呼ぶ（閉じていないので日誌は先に書かない）。done→done・cancelled→cancelled も同じ。日誌も task も変わらない',
    seed: [
      t('q-1', 1),
      t('w-1', 2, { status: 'waiting' }),
      t('n-1', 3, { status: 'needs_decision' }),
      t('d-1', 4, { status: 'done' }),
      t('c-1', 5, { status: 'cancelled' }),
    ],
    steps: [
      { args: set('q-1', 'queued'), writes: 'none' },
      { args: set('w-1', 'waiting', 'まだ待つ'), writes: 'none' },
      { args: set('n-1', 'needs_decision'), writes: 'none' },
      { args: set('d-1', 'done', '別の理由で閉じ直したい'), writes: 'none' },
      { args: set('c-1', 'cancelled', '別の理由'), writes: 'none' },
    ],
  },
  // ---- 閉じた件から queued 以外 ----
  {
    name: 'rejected',
    covers:
      '閉じた件から queued 以外（rejected）: done と cancelled の付け替え・閉じた件から waiting / needs_decision。断りの文。日誌も task も変わらない（queued ではないので日誌を先に書く経路に入らない）',
    seed: [t('d-1', 1, { status: 'done' }), t('c-1', 2, { status: 'cancelled' })],
    steps: [
      { args: set('d-1', 'cancelled', 'やっぱりやめた'), writes: 'none' },
      { args: set('c-1', 'done', 'やっぱり終わった'), writes: 'none' },
      { args: set('d-1', 'waiting', '待ちに戻す'), writes: 'none' },
      { args: set('c-1', 'needs_decision'), writes: 'none' },
    ],
  },
  // ---- 無い task ----
  {
    name: 'not-found',
    covers:
      '無い task: 閉じる呼び（get を呼ばない）・queued への呼び（get が null のあと setStatus が not-found）・waiting への呼び。何もしていないの文。日誌は書かない',
    seed: [t('q-1', 1)],
    steps: [
      { args: set('ghost', 'done', '消えた'), writes: 'none' },
      { args: set('ghost', 'queued'), writes: 'none' },
      { args: set('ghost', 'waiting'), writes: 'none' },
    ],
  },
  // ---- 開き直し ----
  {
    name: 'reopen',
    covers:
      '開き直し（閉じた件を queued へ）の成功: 日誌を先に書く（開き直す前の記録を逐語で含む・act-not-performed 側の行）→ setStatus → 「閉じた記録は日誌に残してある」。reason の有無・cancelled からの開き直し・閉じた主体と理由を持たない行（記録なし）。同じ行を続けて呼ぶと unchanged',
    seed: [
      t('d-1', 1, { status: 'done' }),
      t('c-1', 2, { status: 'cancelled', closedReason: 'もう要らない' }),
      t('b-1', 3, { bare: true }),
      t('d-2', 4, { status: 'done' }),
    ],
    steps: [
      { args: set('d-1', 'queued', 'やり直す'), writes: 'some' },
      { args: set('c-1', 'queued'), writes: 'some' },
      { args: set('b-1', 'queued', '記録なしの行'), writes: 'some' },
      { args: set('d-1', 'queued', 'もう一度'), writes: 'none' },
      { args: set('d-2', 'queued', 'ここは別の行'), writes: 'some' },
    ],
  },
  {
    name: 'reopen-get-fails',
    covers:
      '開き直しの tasks.get が落ちる: 読めない形は断りの文（setStatus を呼ばない）・ほかの例外はそのまま投げる。開いている件（queued→queued）も同じ。閉じる呼びは get を呼ばないので影響を受けない',
    seed: [t('d-1', 1, { status: 'done' }), t('q-1', 2), t('q-2', 3)],
    steps: [
      { args: set('d-1', 'queued', 'やり直す'), writes: 'none', hooks: { getFails: 'unreadable' } },
      { args: set('d-1', 'queued', 'やり直す'), writes: 'none', hooks: { getFails: 'plain' } },
      { args: set('q-1', 'queued'), writes: 'none', hooks: { getFails: 'unreadable' } },
      { args: set('q-1', 'queued'), writes: 'none', hooks: { getFails: 'plain' } },
      { args: set('q-2', 'done', '閉じる'), writes: 'some', hooks: { getFails: 'plain' } },
    ],
  },
  {
    name: 'reopen-setstatus-fails',
    covers:
      '開き直しの setStatus が落ちる: 読めない形は打ち消しの行（行が読めない形になった）を書いて断りの文・ほかの例外は打ち消さずにそのまま投げる（先の行が日誌に残る）。閉じる呼び・開いている状態への呼びは打ち消す行が無い',
    seed: [
      t('d-1', 1, { status: 'done' }),
      t('d-2', 2, { status: 'done' }),
      t('q-1', 3),
      t('q-2', 4),
    ],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { setStatusFails: 'unreadable' },
      },
      {
        args: set('d-2', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { setStatusFails: 'plain' },
      },
      {
        args: set('q-1', 'done', '閉じる'),
        writes: 'none',
        hooks: { setStatusFails: 'unreadable' },
      },
      { args: set('q-1', 'done', '閉じる'), writes: 'none', hooks: { setStatusFails: 'plain' } },
      { args: set('q-2', 'queued'), writes: 'none', hooks: { setStatusFails: 'unreadable' } },
      { args: set('q-2', 'waiting'), writes: 'none', hooks: { setStatusFails: 'plain' } },
    ],
  },
  {
    name: 'reopen-retract-fails-setstatus',
    covers:
      '開き直しの setStatus が読めない形で落ちて、打ち消しの日誌（2 回目）も書けない: 黙って諦め、断りの文は同じ。日誌には先の行だけが残る',
    seed: [t('d-1', 1, { status: 'done' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { setStatusFails: 'unreadable', journalFailsAt: [2] },
      },
    ],
  },
  {
    name: 'reopen-removed',
    covers:
      '開き直しの間に task が消えた（setStatus が not-found）: 打ち消しの行（task が消えていた）を書いて「無い」の文。行は無いまま',
    seed: [t('d-1', 1, { status: 'done', conv: 'conv-1' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'remove' },
      },
    ],
  },
  {
    name: 'reopen-removed-retract-fails',
    covers:
      '開き直しの間に task が消え、打ち消しの日誌（2 回目）も書けない: 黙って諦め、「無い」の文は同じ。日誌には先の行だけが残る',
    seed: [t('d-1', 1, { status: 'done', conv: 'conv-1' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'remove', journalFailsAt: [2] },
      },
    ],
  },
  {
    name: 'reopen-other-reopened',
    covers:
      '開き直しの間に別の手が先に開き直した（setStatus が unchanged）: 打ち消しの行（別の手で状態が変わっていた）を書いて「既に queued」の文。行は別の手の更新時刻のまま',
    seed: [t('d-1', 1, { status: 'done' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'other-reopen' },
      },
    ],
  },
  {
    name: 'reopen-other-reopened-retract-fails',
    covers:
      '別の手が先に開き直し、打ち消しの日誌（2 回目）も書けない: 黙って諦め、「既に queued」の文は同じ',
    seed: [t('d-1', 1, { status: 'done' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'other-reopen', journalFailsAt: [2] },
      },
    ],
  },
  {
    name: 'reopen-reclosed',
    covers:
      '開き直しの間に別の手が開き直して閉じ直した（setStatus が changed で before.closedAt が先の行と違う）: 「間に閉じ直されていた」注の日誌（実際に外した記録と先の行の記録）を足し、移した文は通常どおり。注の日誌が書けなくても（2 回目）黙って諦め、文は同じ',
    seed: [t('d-1', 1, { status: 'done' }), t('d-2', 2, { status: 'done' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'reclose' },
      },
      {
        args: set('d-2', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'reclose', journalFailsAt: [2] },
      },
    ],
  },
  {
    name: 'reopen-reclosed-same-time',
    covers:
      '別の手が開き直して、同じ closedAt・別の理由で閉じ直した: 比べるのは closedAt だけなので注の日誌は足されない（実際に外した記録は先の行の記録と理由が違うのに残らない）',
    seed: [t('d-1', 1, { status: 'done' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'reclose-same-time' },
      },
    ],
  },
  {
    name: 'reopen-other-moved',
    covers:
      '別の手が開き直して waiting へ動かした（setStatus が changed で before に閉じた記録が無い）: 注の日誌（実際に外した記録は「閉じた記録なし」）を足し、「閉じた記録は日誌に残してある」の注は付かない（before が閉じていないため）。日誌には先の行と注の行が残り、行は queued になる',
    seed: [t('d-1', 1, { status: 'done' })],
    steps: [
      {
        args: set('d-1', 'queued', 'やり直す'),
        writes: 'some',
        hooks: { beforeSetStatus: 'other-moved' },
      },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails',
    covers:
      '日誌が書けない: 開き直しの先の日誌（1 回目）は「未記録・行為は起きていない」の例外で setStatus を呼ばず行は閉じたまま・閉じる日誌（act-completed）は「完了済み・未記録・やり直し禁止」の例外だが行は閉じている・開いている状態への日誌も同じ例外で行は動いている。同じ状態・無い task・断る場面は日誌を呼ばない',
    seed: [
      t('d-1', 1, { status: 'done' }),
      t('q-1', 2),
      t('q-2', 3),
      t('d-2', 4, { status: 'done' }),
    ],
    steps: [
      { args: set('d-1', 'queued', 'やり直す'), writes: 'none', hooks: { journalFailsAt: [1] } },
      { args: set('q-1', 'done', '閉じる'), writes: 'some', hooks: { journalFailsAt: [1] } },
      { args: set('q-2', 'waiting', '待つ'), writes: 'some', hooks: { journalFailsAt: [1] } },
      { args: set('d-2', 'done', '同じ'), writes: 'none', hooks: { journalFailsAt: [1] } },
      { args: set('ghost', 'done', '無い'), writes: 'none', hooks: { journalFailsAt: [1] } },
      { args: set('d-2', 'waiting'), writes: 'none', hooks: { journalFailsAt: [1] } },
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

interface PinnedCall {
  op: 'tasks.get' | 'tasks.setStatus' | 'journal.append';
  args: unknown;
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの task の行（閉じた行を含む全件。ストアから読んだ形のまま） */
  tasks: Task[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
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

async function snapshot(stores: Stores): Promise<{ tasks: Task[]; journal: unknown[] }> {
  return {
    tasks: plain((await stores.tasks.list({ includeClosed: true })).entries),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

function failureOf(error: unknown): string {
  const kind = error instanceof UnreadableTaskError ? 'UnreadableTaskError' : 'Error';
  return `threw ${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

async function race(base: Stores, id: string, action: RaceAction): Promise<void> {
  if (action === 'remove') {
    const conv = (await base.tasks.get(id))?.originConversationId;
    if (conv !== undefined) await base.tasks.removeForConversation(conv);
    return;
  }
  await base.tasks.setStatus(id, 'queued', { by: 'human', at: OTHER_OPEN_ISO });
  if (action === 'other-reopen') return;
  if (action === 'other-moved') {
    await base.tasks.setStatus(id, 'waiting', { by: 'human', at: OTHER_CLOSE_ISO });
    return;
  }
  await base.tasks.setStatus(id, 'done', {
    reason: '別の手が閉じ直した',
    by: 'human',
    at: action === 'reclose' ? OTHER_CLOSE_ISO : SEED_CLOSED_ISO,
  });
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗・競合を起こす。口の書き換えは土台を直に叩くので記録に残らない */
function withHooks(base: Stores, hooks: Hooks, calls: PinnedCall[]): Stores {
  const tasks: Stores['tasks'] = {
    ...base.tasks,
    get: async (id) => {
      try {
        if (hooks.getFails === 'unreadable')
          throw new UnreadableTaskError('読めない行（テスト用）');
        if (hooks.getFails === 'plain') throw new Error('ストアが落ちた（get）');
        const found = await base.tasks.get(id);
        calls.push({
          op: 'tasks.get',
          args: { id },
          outcome: found === null ? 'null' : `found ${found.status}`,
        });
        return found;
      } catch (error) {
        calls.push({ op: 'tasks.get', args: { id }, outcome: failureOf(error) });
        throw error;
      }
    },
    setStatus: async (id, status, options) => {
      const args = plain({ id, status, options });
      try {
        if (hooks.setStatusFails === 'unreadable')
          throw new UnreadableTaskError('読めない行（テスト用）');
        if (hooks.setStatusFails === 'plain') throw new Error('ストアが落ちた（setStatus）');
        // この呼びの最初の setStatus の直前にだけ起こす
        if (hooks.beforeSetStatus !== undefined && !calls.some((c) => c.op === 'tasks.setStatus')) {
          await race(base, id, hooks.beforeSetStatus);
        }
        const result = await base.tasks.setStatus(id, status, options);
        calls.push({ op: 'tasks.setStatus', args, outcome: result.kind });
        return result;
      } catch (error) {
        calls.push({ op: 'tasks.setStatus', args, outcome: failureOf(error) });
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
        const journalCalls = calls.filter((entry) => entry.op === 'journal.append').length + 1;
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
      ...(spec.conv === undefined ? {} : { originConversationId: spec.conv }),
    };
    if (spec.bare === true) {
      await base.tasks.add({ ...task, status: 'done', closedAt: SEED_CLOSED_ISO });
      continue;
    }
    await base.tasks.add(task);
    if (closing && spec.status !== undefined) {
      await base.tasks.setStatus(spec.id, spec.status, {
        reason: spec.closedReason ?? '先に閉じた',
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
  const hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const stores = withHooks(base, hooks, calls);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'task_set_status');
  if (!found) throw new Error('task_set_status が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base);
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    Object.assign(hooks, step.hooks ?? {});
    calls.length = 0;
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
    for (const key of Object.keys(hooks)) delete hooks[key as keyof Hooks];
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.tasks) !== JSON.stringify(after.tasks) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      tasks: after.tasks,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
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

describe('task_set_status の出力と呼んだあとの状態の固定（場面ごとの出力の全文・task の行・日誌の行・ストアの呼び）', () => {
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
            `場面 ${key} の task ${wantTask.id}（${String(row)} 行目）が固定値からずれた（状態・理由・閉じた時刻など）`,
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

      it(`${key} のストアの呼びの並びが固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} のストアの呼び: 並び（tasks.get・tasks.setStatus・journal.append）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び: 渡した引数（reason・by・at・日誌の行）か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・task・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const task = (key: string, id: string): Task | undefined =>
      actual[key]?.tasks.find((row) => row.id === id);
    const decisionOf = (key: string, row: number): string => {
      const entry = journal(key)[row];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    const RETRACT = '直前の task の開き直しの行は効いていない（開き直していない）。理由: ';
    // reason
    expect(text('reason-missing#1')).toContain('status=done には reason が要る');
    expect(text('reason-missing#2')).toContain('status=cancelled には reason が要る');
    expect(text('reason-missing#3')).toContain('status=done には reason が要る');
    for (let n = 1; n <= 9; n += 1) expect(ops(`reason-invalid#${String(n)}`)).toEqual([]);
    expect(text('reason-invalid#1')).toContain('reason');
    expect(text('reason-invalid#3')).toContain('空白だけの値');
    // 開いている状態どうし・閉じる
    expect(ops('open-moves#1')).toEqual(['tasks.setStatus', 'journal.append']);
    expect(ops('open-moves#3')).toEqual(['tasks.get', 'tasks.setStatus', 'journal.append']);
    expect(text('open-moves#1')).toBe('task q-1 を queued から waiting へ移した。');
    expect(task('close#1', 'q-1')?.status).toBe('done');
    expect(task('close#1', 'q-1')?.closedBy).toBe('clone');
    expect(ops('close#1')).toEqual(['tasks.setStatus', 'journal.append']);
    // 同じ状態・rejected・無い
    expect(text('unchanged#1')).toBe('task q-1 は既に queued。何もしていない。');
    expect(ops('unchanged#1')).toEqual(['tasks.get', 'tasks.setStatus']);
    expect(text('rejected#1')).toContain('done から cancelled へは移せない');
    expect(ops('rejected#1')).toEqual(['tasks.setStatus']);
    expect(text('not-found#1')).toContain('は無い');
    expect(ops('not-found#2')).toEqual(['tasks.get', 'tasks.setStatus']);
    // 開き直し
    expect(ops('reopen#1')).toEqual(['tasks.get', 'journal.append', 'tasks.setStatus']);
    expect(text('reopen#1')).toContain('（閉じた記録は日誌に残してある）');
    expect(decisionOf('reopen#1', 0)).toContain('done → queued（やり直す）');
    expect(text('reopen#4')).toBe('task d-1 は既に queued。何もしていない。');
    expect(ops('reopen#4')).toEqual(['tasks.get', 'tasks.setStatus']);
    expect(journal('reopen#3')[0]?.grounds).toContain(
      '閉じた主体=（記録なし） / 理由=（理由の記録なし）',
    );
    expect(ops('reopen-get-fails#1')).toEqual(['tasks.get']);
    expect(text('reopen-get-fails#1')).toContain('読めない形で入っている');
    expect(text('reopen-get-fails#2')).toBe('ストアが落ちた（get）');
    expect(ops('reopen-get-fails#5')).toEqual(['tasks.setStatus', 'journal.append']);
    expect(ops('reopen-setstatus-fails#1')).toEqual([
      'tasks.get',
      'journal.append',
      'tasks.setStatus',
      'journal.append',
    ]);
    expect(decisionOf('reopen-setstatus-fails#1', 1)).toBe(
      `${RETRACT}開き直す直前に行が読めない形になった`,
    );
    expect(journal('reopen-setstatus-fails#2')).toHaveLength(1);
    expect(text('reopen-setstatus-fails#2')).toBe('ストアが落ちた（setStatus）');
    expect(ops('reopen-setstatus-fails#3')).toEqual(['tasks.setStatus']);
    expect(journal('reopen-retract-fails-setstatus')).toHaveLength(1);
    expect(decisionOf('reopen-removed', 1)).toBe(`${RETRACT}開き直す直前に task が消えていた`);
    expect(text('reopen-removed')).toContain('は無い');
    expect(journal('reopen-removed-retract-fails')).toHaveLength(1);
    expect(decisionOf('reopen-other-reopened', 1)).toBe(
      `${RETRACT}開き直す直前に別の手で状態が変わっていた`,
    );
    expect(text('reopen-other-reopened')).toBe('task d-1 は既に queued。何もしていない。');
    expect(journal('reopen-other-reopened-retract-fails')).toHaveLength(1);
    expect(decisionOf('reopen-reclosed#1', 1)).toContain('の間に閉じ直されていた');
    expect(text('reopen-reclosed#1')).toContain('（閉じた記録は日誌に残してある）');
    expect(journal('reopen-reclosed#2')).toHaveLength(1);
    expect(journal('reopen-reclosed-same-time')).toHaveLength(1);
    expect(decisionOf('reopen-other-moved', 1)).toContain('（閉じた記録なし）');
    expect(text('reopen-other-moved')).toBe('task d-1 を waiting から queued へ移した。');
    // 日誌が書けない
    expect(ops('journal-fails#1')).toEqual(['tasks.get', 'journal.append']);
    expect(task('journal-fails#1', 'd-1')?.status).toBe('done');
    expect(task('journal-fails#2', 'q-1')?.status).toBe('done');
    expect(task('journal-fails#3', 'q-2')?.status).toBe('waiting');
    // 日誌の失敗は JournalNotRecordedError が投げられ、その message が応答の文になる（thrown: true）
    expect(text('journal-fails#1')).toContain('⚠⚠ 未記録・行為は起きていない・やり直してよい');
    expect(text('journal-fails#2')).toContain('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(text('journal-fails#3')).toContain('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(actual['journal-fails#1']?.output.thrown).toBe(true);
    expect(actual['journal-fails#2']?.output.thrown).toBe(true);
    expect(actual['journal-fails#3']?.output.thrown).toBe(true);
    expect(actual['reopen-get-fails#2']?.output.thrown).toBe(true);
    expect(actual['reopen-setstatus-fails#2']?.output.thrown).toBe(true);
    expect(ops('journal-fails#4')).toEqual(['tasks.setStatus']);
  });
});
