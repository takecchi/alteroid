import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PendingApproval } from './schema.js';
import { UnreadableApprovalError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `approval_withdraw` の出力（全文と字数）と、呼んだあとの状態（承認の行・日誌へ足された行）・ストアの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-approval-withdraw-output-pin.json）と丸ごと比べる。
// `clone-tools-approval.ts` の `tool('approval_withdraw', …)`（ハンドラ約 77 行・入れ子 5 段の式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
// この道具は承認の行を書き換え、書いたあとに日誌を足すので、出力だけでなく「呼んだあとの状態」と「ストアの呼びの順」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか。例外なら name と message）
//   - approvals: 呼んだあとの承認の全行（取り下げ済み・回答済みを含む）をストアから読んだ形のまま
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま。書けなかった行は含まない）
//   - calls: ストアの呼びの並び（jobs.getApproval・jobs.updateApproval（書き込みの中で見た行 saw・mutate が返した行 mutateReturned・
//            updateApproval の結果 result）・journal.append（行の全体と成否））
//   - wrote: 承認か日誌のどちらかが呼ぶ前から変わったか。断った場面は false で、承認・日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_APPROVAL_WITHDRAW_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-approval-withdraw-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-approval-withdraw-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、承認・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 承認はストアへ直接積む（ask_human 経由にしない: id が randomUUID・時刻が実時間で、固定値にならないため）。
// 呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（withdrawnAt・日誌の at が呼び順に増える）。日誌の id はインメモリの採番で、場面ごとにストアを作り直すので毎回同じ。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 「読んでから書くまでの間に変わる」は、道具が jobs.getApproval で読んだ後・jobs.updateApproval を呼ぶ直前に、
// 別の経路（人間・別の手）が土台のストアを直に書き換える口（race）で作る。呼びの記録（calls）には道具の呼びだけが残り、口の書き換えは残らない。
//
// 作れない分岐（理由）:
//   - 無し。ただし `reason` が undefined の場面は、実際の呼びでは入力スキーマ（z.string()）が先に断るので、ハンドラを直に呼んだときだけ起こる（reason-undefined）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（承認か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

type RaceAction =
  | 'answer' // 人間が回答する（本文あり）
  | 'answer-no-text' // 人間が回答する（本文なし。answeredAt だけ）
  | 'withdraw' // 別の手が取り下げる（理由あり）
  | 'withdraw-no-reason' // 別の手が取り下げる（理由なし。withdrawnAt だけ）
  | 'answer-and-withdraw' // 回答も取り下げも立つ
  | 'remove'; // 行が消える

interface Hooks {
  /** jobs.getApproval が読めない行の例外（UnreadableApprovalError）で落ちる */
  getUnreadable?: boolean;
  /** jobs.getApproval が器の障害（普通の Error）で落ちる */
  getThrows?: boolean;
  /** jobs.updateApproval が読めない行の例外で落ちる（mutate は呼ばれない） */
  updateUnreadable?: boolean;
  /** jobs.updateApproval が器の障害で落ちる（mutate は呼ばれない） */
  updateThrows?: boolean;
  /** jobs.updateApproval を呼ぶ直前に、別の経路が土台を書き換える */
  race?: RaceAction;
  /** journal.append が落ちる */
  journalFails?: boolean;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Hooks;
}

interface Scenario {
  name: string;
  /** 読み手のための整理。表に出す */
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: PendingApproval[];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const APPROVAL_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const ANSWERED_ISO = '2026-10-28T12:00:00.000Z';
const OTHER_WITHDRAWN_ISO = '2026-10-28T13:00:00.000Z';
const PIN_URL = new URL('./clone-tools-approval-withdraw-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_APPROVAL_WITHDRAW_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteIso(minute: number): string {
  return new Date(APPROVAL_BASE + minute * 60_000).toISOString();
}

function ap(id: string, minute: number, extra: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: minuteIso(minute), question: `質問 ${id}`, ...extra };
}

function wd(id: string, reason: string): Args {
  return { id, reason };
}

const SCENARIOS: Scenario[] = [
  // ---- reason の検査 ----
  {
    name: 'reason-invalid',
    group: 'reason の検査',
    covers:
      'reason が空・空白だけ・NUL だけ: ストアを呼ぶ前に断る（getApproval も呼ばない）。長さの断り（空・NUL だけ）と空白だけの断りは文言が違う',
    seed: [ap('ap-1', 1)],
    steps: [
      { args: wd('ap-1', ''), writes: 'none' },
      { args: wd('ap-1', '\u0000'), writes: 'none' },
      { args: wd('ap-1', '   '), writes: 'none' },
      { args: wd('ap-1', '\n\t　'), writes: 'none' },
      { args: wd('ap-1', ' \u0000 '), writes: 'none' },
      { args: wd('ghost', ''), writes: 'none' },
    ],
  },
  {
    name: 'reason-undefined',
    group: 'reason の検査',
    covers:
      'reason が undefined（ハンドラを直に呼んだときだけ。2つの検査は undefined を通す）: 断らずに取り下げ、withdrawnReason の無い行・日誌になる。鍵ごと無い呼びも同じ',
    seed: [ap('ap-1', 1), ap('ap-2', 2)],
    steps: [
      { args: { id: 'ap-1', reason: undefined }, writes: 'some' },
      { args: { id: 'ap-2' }, writes: 'some' },
    ],
  },
  // ---- 読む ----
  {
    name: 'id-missing',
    group: '読む',
    covers:
      '無い id: getApproval が null。断りの文。承認も日誌も変わらず、updateApproval を呼ばない',
    seed: [ap('ap-1', 1)],
    steps: [
      { args: wd('ghost', '消えた'), writes: 'none' },
      { args: wd('', '空の id'), writes: 'none' },
    ],
  },
  {
    name: 'get-fails',
    group: '読む',
    covers:
      'getApproval が落ちる: 読めない形（UnreadableApprovalError）は断りの文（行は書き換えていない・updateApproval を呼ばない）。ほかの例外はそのまま投げる',
    seed: [ap('ap-1', 1), ap('ap-2', 2)],
    steps: [
      { args: wd('ap-1', '取り下げたい'), writes: 'none', hooks: { getUnreadable: true } },
      { args: wd('ap-2', '取り下げたい'), writes: 'none', hooks: { getThrows: true } },
    ],
  },
  // ---- 読んだ時点で決着済み ----
  {
    name: 'already-answered',
    group: '読んだ時点で決着済み',
    covers:
      '読んだ時点で回答済み: 断りの文（回答の本文あり・本文が undefined の「（本文なし）」・空文字の本文は空のまま）。回答済みかつ取り下げ済みの行は回答の文が先。updateApproval を呼ばない',
    seed: [
      ap('ap-1', 1, { answeredAt: ANSWERED_ISO, answer: 'はい、進めて' }),
      ap('ap-2', 2, { answeredAt: ANSWERED_ISO }),
      ap('ap-3', 3, { answeredAt: ANSWERED_ISO, answer: '' }),
      ap('ap-4', 4, {
        answeredAt: ANSWERED_ISO,
        answer: '回答が先',
        withdrawnAt: OTHER_WITHDRAWN_ISO,
        withdrawnReason: '先に取り下げられていた',
      }),
    ],
    steps: [
      { args: wd('ap-1', '取り下げたい'), writes: 'none' },
      { args: wd('ap-2', '取り下げたい'), writes: 'none' },
      { args: wd('ap-3', '取り下げたい'), writes: 'none' },
      { args: wd('ap-4', '取り下げたい'), writes: 'none' },
    ],
  },
  {
    name: 'already-withdrawn',
    group: '読んだ時点で決着済み',
    covers:
      '読んだ時点で取り下げ済み: 断りの文（理由あり・理由が undefined の「理由: 」が空）。updateApproval を呼ばない',
    seed: [
      ap('ap-1', 1, { withdrawnAt: OTHER_WITHDRAWN_ISO, withdrawnReason: '先に取り下げた' }),
      ap('ap-2', 2, { withdrawnAt: OTHER_WITHDRAWN_ISO }),
    ],
    steps: [
      { args: wd('ap-1', 'もう一度取り下げたい'), writes: 'none' },
      { args: wd('ap-2', 'もう一度取り下げたい'), writes: 'none' },
    ],
  },
  // ---- 取り下げる（応答の注） ----
  {
    name: 'withdraw-note-none',
    group: '取り下げる',
    covers:
      'jobId なしの取り下げ: 注なしの1文。承認の行に withdrawnAt（呼びの時刻）と withdrawnReason が付き、日誌は escalation 1行（managerId なし・act-completed で updateApproval のあと）。ほかの行は触れない。requestId だけを持つ行（jobId なし）も注なし',
    seed: [ap('ap-1', 1), ap('ap-2', 2), ap('ap-3', 3, { requestId: 'req-orphan' })],
    steps: [
      { args: wd('ap-1', '自分で答えを見つけた'), writes: 'some' },
      { args: wd('ap-3', 'requestId だけの行'), writes: 'some' },
    ],
  },
  {
    name: 'withdraw-note-job',
    group: '取り下げる',
    covers:
      'jobId あり（requestId なし）の取り下げ: マネージャーが解放されない旨の注（requestId の括弧なし）。日誌に managerId が付く',
    seed: [ap('ap-1', 1, { jobId: 'mgr-7' })],
    steps: [{ args: wd('ap-1', 'マネージャー側で解決した'), writes: 'some' }],
  },
  {
    name: 'withdraw-note-job-request',
    group: '取り下げる',
    covers:
      'jobId と requestId の両方ありの取り下げ: 注に（requestId: "…"）が付く。日誌に managerId が付く（requestId は日誌に載らない）',
    seed: [ap('ap-1', 1, { jobId: 'mgr-7', requestId: 'req-5' })],
    steps: [{ args: wd('ap-1', '許可は要らなくなった'), writes: 'some' }],
  },
  {
    name: 'withdraw-shapes',
    group: '取り下げる',
    covers:
      '取り下げる行・reason の形: reason は整形せず（前後の空白・改行）そのまま行・日誌へ入る。NUL は落ちて残る。複数行の問い・設問付き・背景付きの行。日誌の question は行の問いのまま',
    seed: [
      ap('ap-1', 1),
      ap('ap-2', 2),
      ap('ap-3', 3, { question: '一行目\n二行目', context: '背景の説明' }),
      ap('ap-4', 4, {
        question: '進め方を選んでください',
        questions: [
          {
            id: 'target',
            prompt: '対象はどれか',
            options: [
              { id: 'a', label: 'a' },
              { id: 'b', label: 'b' },
            ],
          },
        ],
      }),
    ],
    steps: [
      { args: wd('ap-1', '  前後に空白  '), writes: 'some' },
      { args: wd('ap-2', '一行目\n二行目'), writes: 'some' },
      { args: wd('ap-3', 'a\u0000b'), writes: 'some' },
      { args: wd('ap-4', '設問付きの行'), writes: 'some' },
    ],
  },
  {
    name: 'withdraw-twice',
    group: '取り下げる',
    covers:
      '同じ行を続けて取り下げる: 2回目は読んだ時点で取り下げ済み（1回目の時刻・理由）の断り。2回目は updateApproval を呼ばず、日誌も足さない',
    seed: [ap('ap-1', 1, { jobId: 'mgr-7' })],
    steps: [
      { args: wd('ap-1', '1回目'), writes: 'some' },
      { args: wd('ap-1', '2回目'), writes: 'none' },
    ],
  },
  // ---- 読んでから書くまでの間に変わる ----
  {
    name: 'race-answered',
    group: '間に決着',
    covers:
      '読んだ後・書く前に人間が回答した（書き込みの中で回答済み）: mutate が null を返し、回答済みの断り（回答の本文あり・本文なし）。回答は消えず、日誌も足さない',
    seed: [ap('ap-1', 1, { jobId: 'mgr-7' }), ap('ap-2', 2)],
    steps: [
      { args: wd('ap-1', '取り下げたい'), writes: 'none', hooks: { race: 'answer' } },
      { args: wd('ap-2', '取り下げたい'), writes: 'none', hooks: { race: 'answer-no-text' } },
    ],
  },
  {
    name: 'race-withdrawn',
    group: '間に決着',
    covers:
      '読んだ後・書く前に別の手が取り下げた（書き込みの中で取り下げ済み）: 取り下げ済みの断り（理由あり・理由なし）。別の手の理由が残り、日誌も足さない',
    seed: [ap('ap-1', 1), ap('ap-2', 2)],
    steps: [
      { args: wd('ap-1', '自分の理由'), writes: 'none', hooks: { race: 'withdraw' } },
      { args: wd('ap-2', '自分の理由'), writes: 'none', hooks: { race: 'withdraw-no-reason' } },
    ],
  },
  {
    name: 'race-both',
    group: '間に決着',
    covers:
      '読んだ後・書く前に回答も取り下げも立った: 回答済みの文が先（settledNow.answeredAt を先に見る）',
    seed: [ap('ap-1', 1)],
    steps: [
      { args: wd('ap-1', '取り下げたい'), writes: 'none', hooks: { race: 'answer-and-withdraw' } },
    ],
  },
  {
    name: 'race-removed',
    group: '間に決着',
    covers:
      '読んだ後・書く前に行が消えた（updateApproval が mutate を呼ばずに null）: 「無い（id が違う）」の文。日誌は足さない',
    seed: [ap('ap-1', 1)],
    steps: [{ args: wd('ap-1', '取り下げたい'), writes: 'none', hooks: { race: 'remove' } }],
  },
  // ---- 書き込みが落ちる ----
  {
    name: 'update-fails',
    group: '書き込みが落ちる',
    covers:
      'updateApproval が落ちる: 読めない形は断りの文（行は書き換えていない）・ほかの例外はそのまま投げる。承認も日誌も変わらず、日誌は呼ばない',
    seed: [ap('ap-1', 1), ap('ap-2', 2)],
    steps: [
      { args: wd('ap-1', '取り下げたい'), writes: 'none', hooks: { updateUnreadable: true } },
      { args: wd('ap-2', '取り下げたい'), writes: 'none', hooks: { updateThrows: true } },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails',
    group: '日誌が書けない',
    covers:
      '日誌が書けない（act-completed）: 書き込みの後なので行は取り下げ済みのまま、「完了済み・未記録・やり直し禁止」の例外（JournalNotRecordedError）。jobId の有無で日誌の行（managerId）が変わる。同じ行の再取り下げは取り下げ済みの断りになる',
    seed: [ap('ap-1', 1), ap('ap-2', 2, { jobId: 'mgr-7', requestId: 'req-5' })],
    steps: [
      { args: wd('ap-1', '日誌が落ちる'), writes: 'some', hooks: { journalFails: true } },
      { args: wd('ap-2', '日誌が落ちる'), writes: 'some', hooks: { journalFails: true } },
      { args: wd('ap-1', '日誌が戻ったあと'), writes: 'none' },
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
  /** 例外の name（投げなかったときは null） */
  errorName: string | null;
}

interface PinnedCall {
  op: 'jobs.getApproval' | 'jobs.updateApproval' | 'journal.append';
  args: unknown;
  /** updateApproval だけ: 書き込みの中で mutate が見た行（mutate が呼ばれなければ null） */
  saw?: PendingApproval | null;
  /** updateApproval だけ: mutate が返した行か null（呼ばれなければ 'not-called'） */
  mutateReturned?: PendingApproval | null | 'not-called';
  outcome: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの承認の全行（取り下げ済み・回答済みを含む。ストアから読んだ形のまま） */
  approvals: PendingApproval[];
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

async function snapshot(
  stores: Stores,
): Promise<{ approvals: PendingApproval[]; journal: unknown[] }> {
  return {
    approvals: plain((await stores.jobs.listApprovals({ pendingOnly: false })).entries),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

function failureOf(error: unknown): string {
  const kind = error instanceof UnreadableApprovalError ? 'UnreadableApprovalError' : 'Error';
  return `threw ${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

async function race(base: Stores, id: string, action: RaceAction): Promise<void> {
  if (action === 'remove') {
    await base.jobs.clear();
    return;
  }
  await base.jobs.updateApproval(id, (current) => {
    if (action === 'answer') return { ...current, answeredAt: ANSWERED_ISO, answer: '人間の回答' };
    if (action === 'answer-no-text') return { ...current, answeredAt: ANSWERED_ISO };
    if (action === 'withdraw') {
      return {
        ...current,
        withdrawnAt: OTHER_WITHDRAWN_ISO,
        withdrawnReason: '別の手の理由',
      };
    }
    if (action === 'withdraw-no-reason') return { ...current, withdrawnAt: OTHER_WITHDRAWN_ISO };
    return {
      ...current,
      answeredAt: ANSWERED_ISO,
      answer: '人間の回答',
      withdrawnAt: OTHER_WITHDRAWN_ISO,
      withdrawnReason: '別の手の理由',
    };
  });
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗・競合を起こす。口の書き換えは土台を直に叩くので記録に残らない */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  const jobs: Stores['jobs'] = {
    ...base.jobs,
    getApproval: async (id) => {
      const now = hooks();
      try {
        if (now.getUnreadable === true) {
          throw new UnreadableApprovalError({ id, reason: '読めない行（テスト用）' });
        }
        if (now.getThrows === true) throw new Error('ストアが落ちた（getApproval）');
        const found = await base.jobs.getApproval(id);
        calls.push({
          op: 'jobs.getApproval',
          args: { id },
          outcome: found === null ? 'null' : 'found',
        });
        return found;
      } catch (error) {
        calls.push({ op: 'jobs.getApproval', args: { id }, outcome: failureOf(error) });
        throw error;
      }
    },
    updateApproval: async (id, mutate) => {
      const now = hooks();
      let saw: PendingApproval | null = null;
      let mutateReturned: PendingApproval | null | 'not-called' = 'not-called';
      const record = (outcome: string): void => {
        calls.push({
          op: 'jobs.updateApproval',
          args: { id },
          saw: plain(saw),
          mutateReturned: plain(mutateReturned),
          outcome,
        });
      };
      try {
        if (now.updateUnreadable === true) {
          throw new UnreadableApprovalError({ id, reason: '読めない行（テスト用）' });
        }
        if (now.updateThrows === true) throw new Error('ストアが落ちた（updateApproval）');
        if (now.race !== undefined) await race(base, id, now.race);
        const result = await base.jobs.updateApproval(id, (current) => {
          saw = current;
          const next = mutate(current);
          mutateReturned = next;
          return next;
        });
        record(result === null ? 'null' : 'row');
        return result;
      } catch (error) {
        record(failureOf(error));
        throw error;
      }
    },
  };
  return {
    ...base,
    jobs,
    journal: {
      ...base.journal,
      append: async (entry) => {
        const args = plain(entry);
        if (hooks().journalFails === true) {
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
  for (const spec of scenario.seed) await base.jobs.putApproval(spec);
  let hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'approval_withdraw');
  if (!found) throw new Error('approval_withdraw が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base);
    hooks = step.hooks ?? {};
    calls.length = 0;
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
        errorName: error instanceof Error ? error.name : typeof error,
      };
    }
    hooks = {};
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.approvals) !== JSON.stringify(after.approvals) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      approvals: after.approvals,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、承認の行が呼ぶ前と同じ（行が消える競合の場面は口が土台を書き換えるので、ここでは対象外）
      const racedByHook = step.hooks?.race !== undefined;
      if (!racedByHook) {
        expect(
          after.approvals,
          `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、承認の行が呼ぶ前から変わった`,
        ).toEqual(before.approvals);
      }
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

describe('approval_withdraw の出力と呼んだあとの状態の固定（場面ごとの出力の全文・承認の行・日誌の行・ストアの呼び）', () => {
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
        const raced = step.hooks?.race !== undefined;
        // 競合の場面は口が土台を書き換える（承認の行が変わる）ので wrote は true になる。道具の書き込みの有無は日誌の行数と calls で見る
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes === 'some' || raced,
        );
        const journalRows = actual[key]?.journal.length ?? -1;
        expect(journalRows > 0, `${key}: 日誌の行の有無が宣言と違う`).toBe(
          step.writes === 'some' && step.hooks?.journalFails !== true,
        );
      }
    }
  });

  describe.each(SCENARIOS)('場面 $name（$group）', (scenario) => {
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
          `場面 ${key} の出力の isError／例外で返ったか（名前）、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の呼んだあとの承認の行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.approvals.map((row) => row.id),
          `場面 ${key} の承認: 行の並び（id）が変わった`,
        ).toEqual(want?.approvals.map((row) => row.id));
        for (const [row, wantRow] of (want?.approvals ?? []).entries()) {
          expect(
            got?.approvals[row],
            `場面 ${key} の承認 ${wantRow.id}（${String(row)} 行目）が固定値からずれた（取り下げの時刻・理由・回答など）`,
          ).toEqual(wantRow);
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
          `場面 ${key} のストアの呼び: 並び（jobs.getApproval・jobs.updateApproval・journal.append）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(
          got?.calls,
          `場面 ${key} のストアの呼び: 書き込みの中で見た行・返した行・日誌の行の全体か結果がずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・承認・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const row = (key: string, id: string): PendingApproval | undefined =>
      actual[key]?.approvals.find((entry) => entry.id === id);
    const update = (key: string): PinnedCall | undefined =>
      actual[key]?.calls.find((entry) => entry.op === 'jobs.updateApproval');
    const WAITING = '取り下げてもそのマネージャーは自動では解放されない';
    // reason の検査
    expect(text('reason-invalid#1')).toBe('reason は使えない（1文字以上のみ）。');
    expect(text('reason-invalid#2')).toBe('reason は使えない（1文字以上のみ）。');
    expect(text('reason-invalid#3')).toContain('空白だけの値は空と同じ');
    expect(text('reason-invalid#5')).toContain('空白だけの値は空と同じ');
    for (let n = 1; n <= 6; n += 1) expect(ops(`reason-invalid#${String(n)}`)).toEqual([]);
    expect(text('reason-undefined#1')).toBe('ap-1 を取り下げた。');
    expect(row('reason-undefined#1', 'ap-1')?.withdrawnReason).toBeUndefined();
    expect(row('reason-undefined#1', 'ap-1')?.withdrawnAt).toBe(callTime(0));
    // 読む
    expect(text('id-missing#1')).toBe('承認待ち ghost は無い（id が違う）。');
    expect(ops('id-missing#1')).toEqual(['jobs.getApproval']);
    expect(text('get-fails#1')).toContain('は在るが読めない（壊れた行。');
    expect(ops('get-fails#1')).toEqual(['jobs.getApproval']);
    expect(text('get-fails#2')).toBe('ストアが落ちた（getApproval）');
    expect(actual['get-fails#2']?.output.thrown).toBe(true);
    expect(actual['get-fails#1']?.output.thrown).toBe(false);
    // 読んだ時点で決着済み
    expect(text('already-answered#1')).toBe(
      `ap-1 は既に ${ANSWERED_ISO} に回答済みなので取り下げられない（回答: はい、進めて）。`,
    );
    expect(text('already-answered#2')).toContain('（回答: （本文なし））。');
    expect(text('already-answered#3')).toContain('（回答: ）。');
    expect(text('already-answered#4')).toContain('（回答: 回答が先）。');
    expect(text('already-withdrawn#1')).toBe(
      `ap-1 は既に ${OTHER_WITHDRAWN_ISO} に取り下げ済み（理由: 先に取り下げた）。`,
    );
    expect(text('already-withdrawn#2')).toContain('（理由: ）。');
    for (const key of [
      'already-answered#1',
      'already-answered#4',
      'already-withdrawn#1',
      'already-withdrawn#2',
    ]) {
      expect(ops(key)).toEqual(['jobs.getApproval']);
    }
    // 取り下げる
    expect(ops('withdraw-note-none#1')).toEqual([
      'jobs.getApproval',
      'jobs.updateApproval',
      'journal.append',
    ]);
    expect(text('withdraw-note-none#1')).toBe('ap-1 を取り下げた。');
    expect(text('withdraw-note-none#2')).toBe('ap-3 を取り下げた。');
    expect(journal('withdraw-note-none#1')[0]).not.toHaveProperty('managerId');
    expect(text('withdraw-note-job')).toContain(
      `ap-1 を取り下げた。 ⚠️ この確認はマネージャー mgr-7 のものである。${WAITING}`,
    );
    expect(text('withdraw-note-job')).not.toContain('requestId');
    expect(journal('withdraw-note-job')[0]).toHaveProperty('managerId', 'mgr-7');
    expect(text('withdraw-note-job-request')).toContain(
      'マネージャー mgr-7 のものである（requestId: "req-5"）。',
    );
    expect(text('withdraw-shapes#1')).toBe('ap-1 を取り下げた。');
    expect(row('withdraw-shapes#1', 'ap-1')?.withdrawnReason).toBe('  前後に空白  ');
    expect(row('withdraw-shapes#2', 'ap-2')?.withdrawnReason).toBe('一行目\n二行目');
    expect(row('withdraw-shapes#3', 'ap-3')?.withdrawnReason).toBe('ab');
    expect(journal('withdraw-shapes#3')[0]?.question).toBe('一行目\n二行目');
    expect(text('withdraw-twice#2')).toBe(
      `ap-1 は既に ${callTime(0)} に取り下げ済み（理由: 1回目）。`,
    );
    expect(ops('withdraw-twice#2')).toEqual(['jobs.getApproval']);
    // 読んでから書くまでの間に決着
    expect(ops('race-answered#1')).toEqual(['jobs.getApproval', 'jobs.updateApproval']);
    expect(update('race-answered#1')?.mutateReturned).toBeNull();
    expect(update('race-answered#1')?.saw?.answeredAt).toBe(ANSWERED_ISO);
    expect(text('race-answered#1')).toBe(
      `ap-1 は既に ${ANSWERED_ISO} に回答済みなので取り下げられない（回答: 人間の回答）。`,
    );
    expect(text('race-answered#2')).toContain('（回答: （本文なし））。');
    expect(row('race-answered#1', 'ap-1')?.withdrawnAt).toBeUndefined();
    expect(text('race-withdrawn#1')).toBe(
      `ap-1 は既に ${OTHER_WITHDRAWN_ISO} に取り下げ済み（理由: 別の手の理由）。`,
    );
    expect(text('race-withdrawn#2')).toContain('（理由: ）。');
    expect(text('race-both')).toContain('に回答済みなので取り下げられない');
    expect(text('race-removed')).toBe('承認待ち ap-1 は無い（id が違う）。');
    expect(update('race-removed')?.mutateReturned).toBe('not-called');
    expect(update('race-removed')?.saw).toBeNull();
    // 書き込みが落ちる
    expect(text('update-fails#1')).toContain('は在るが読めない（壊れた行。');
    expect(update('update-fails#1')?.mutateReturned).toBe('not-called');
    expect(text('update-fails#2')).toBe('ストアが落ちた（updateApproval）');
    expect(actual['update-fails#2']?.output.thrown).toBe(true);
    expect(ops('update-fails#2')).toEqual(['jobs.getApproval', 'jobs.updateApproval']);
    // 日誌が書けない
    expect(actual['journal-fails#1']?.output.thrown).toBe(true);
    expect(actual['journal-fails#1']?.output.errorName).toBe('JournalNotRecordedError');
    expect(text('journal-fails#1')).toContain('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(text('journal-fails#1')).toContain('approval_withdraw は完了した');
    expect(row('journal-fails#1', 'ap-1')?.withdrawnReason).toBe('日誌が落ちる');
    expect(journal('journal-fails#1')).toEqual([]);
    expect(ops('journal-fails#1')).toEqual([
      'jobs.getApproval',
      'jobs.updateApproval',
      'journal.append',
    ]);
    expect(text('journal-fails#3')).toContain('に取り下げ済み（理由: 日誌が落ちる）。');
  });
});
