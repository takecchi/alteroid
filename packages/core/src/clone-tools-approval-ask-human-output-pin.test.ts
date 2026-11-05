import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import type { Job, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `ask_human` の出力（全文と字数）と、呼んだあとの状態（承認の行・日誌へ足された行）・呼びの並び
// （context.conversationId / workConversationId・委譲の行の読み（jobs.listJobs）・flushReply・jobs.putApproval・journal.append・
// context.noteQuestionAsked・context.emit など）を、場面ごとにコミットした固定値（clone-tools-approval-ask-human-output-pin.json）と丸ごと比べる。
// `clone-tools-approval.ts` の `tool('ask_human', …)`（ハンドラ約 50 行の長い式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか。例外なら name と message）
//   - approvals: 呼んだあとの承認の全行（ストアから読んだ形のまま）
//   - journal: 呼んだあとに日誌へ足された行（書けなかった行は含まない）
//   - calls: 呼びの並び（context への読み・知らせ、ストアの読み書き。渡した引数と成否をそのまま）
//   - stderr: 記録を落としたときに stderr へ残る跡（noteDroppedRecord。時刻は固定した時計）
//   - wrote: 承認か日誌のどちらかが呼ぶ前から変わったか。断った場面・承認が書けない場面は false で、承認・日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_ASK_HUMAN_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-approval-ask-human-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-approval-ask-human-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、承認・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。呼びごとに基準時刻から 1 分ずつ進めて呼ぶ。
// 乱数: 承認の id は `randomUUID()` で作られるので、`node:crypto` の randomUUID を呼び順に
// 00000000-0000-4000-8000-000000000001, …02, … を返すものへ差し替える。番号は場面ごとに 1 から数え直す（場面の中では呼びをまたいで進む）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 宛先の会話の連鎖（① getConversationId() → ② managerId の委譲の起点 → ③ getWorkConversationId()）は、
// context.conversationId（ctx.conv）・context.workConversationId（ctx.work）・ストアの委譲の行（jobs）・引数 managerId で作る。
// workConversationId の口を渡さないと、③ は conversationId の読みへ倒れる（tools.ts の `context.workConversationId ?? getConversationId`）。
// 承認の行の taskIds は context.currentTaskIds で作る。
//
// 作れない分岐（理由）:
//   - zod の入力スキーマが断る型違い（question が文字列でない・設問の options が空・設問 id が空 など）は、ハンドラを直に呼ぶこの試験では通らない。
//     「ハンドラを直に呼んだときだけ起こる」ものは questions-direct-bad-shape（options が空の設問はハンドラは通し、ストアが断る）として別に固定する。
//   - question が undefined の経路（ハンドラを直に呼んだときだけ）は、断りにならず素の TypeError で落ちる。question-undefined として固定する。
//   - `getConversationId()` が例外を投げる経路・`context.emit` が例外を投げる経路・`noteQuestionAsked` が例外を投げる経路:
//     いずれも道具の側に守りが無く、そのまま外へ出るだけの経路で、式を分けても変わりようが無いので作っていない。
//   - 日誌が書けないときの `noteQuestionAsked`・`emit` が呼ばれない振る舞いは、いまの振る舞いのまま固定している（Issue #6490 で扱う予定）。

const uuidState = vi.hoisted(() => ({ drawn: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
      uuidState.drawn += 1;
      return `00000000-0000-4000-8000-${String(uuidState.drawn).padStart(12, '0')}`;
    },
  };
});

type Args = Record<string, unknown>;

/** 呼びが起こした書き込みの形。none は承認も日誌も変わらない。both は承認の行と日誌の両方。approval-only は承認の行だけ（日誌が書けない） */
type Writes = 'none' | 'both' | 'approval-only';

interface Hooks {
  /** jobs.putApproval が落ちる（行は書かれない） */
  putFails?: boolean;
  /** journal.append が落ちる */
  journalFails?: boolean;
  /** context.flushReply が落ちる */
  flushFails?: boolean;
  /** jobs.listJobs が落ちる（委譲の行が読めない） */
  listFails?: boolean;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Hooks;
}

interface Ctx {
  /** context.conversationId の値（既定は undefined） */
  conv?: string;
  /** context.workConversationId を渡す。string はその値、null は undefined を返す。省略は口ごと渡さない（conversationId へ倒れる） */
  work?: string | null;
  /** context.currentTaskIds を渡す。省略は口ごと渡さない */
  taskIds?: string[];
  /** context.flushReply を渡さない */
  noFlush?: boolean;
  /** context.noteQuestionAsked を渡さない */
  noNote?: boolean;
}

interface Scenario {
  name: string;
  /** 読み手のための整理。表に出す */
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  ctx?: Ctx;
  /** 呼ぶ前にストアへ置く委譲の行（id = managerId、conversationId は第2要素） */
  jobs?: [string, string | undefined][];
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-approval-ask-human-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_ASK_HUMAN_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function u(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const OK_QUESTION = 'デプロイ先を決めたい';
const OK_BACKGROUND = '本番の切り替えを今週中にしたい';
const LONG = 'あ'.repeat(450);

function ah(overrides: Args = {}): Args {
  return { question: OK_QUESTION, ...overrides };
}

const Q_TARGET = {
  id: 'target',
  prompt: 'デプロイ先は？',
  options: [
    { id: 'railway', label: 'Railway', recommended: true },
    { id: 'fly', label: 'Fly.io', description: '東京リージョンがある' },
  ],
};
const Q_NOTIFY = {
  id: 'notify',
  prompt: '通知する先（複数可）',
  multiple: true,
  allowOther: false,
  options: [
    { id: 'slack', label: 'Slack' },
    { id: 'mail', label: 'メール' },
  ],
};

const SCENARIOS: Scenario[] = [
  // ---- 引数の断り ----
  {
    name: 'question-invalid-length',
    group: '引数の断り',
    covers:
      'question が空・NUL だけ: 長さの断り（NUL を落としてから数える）。承認も日誌も context への知らせも無く、context は1つも読まない（会話の連鎖も flushReply も呼ばない）',
    ctx: { conv: 'conv-human', work: 'conv-work', taskIds: ['task-a'] },
    jobs: [['mgr-1', 'conv-job']],
    steps: [
      { args: ah({ question: '' }), writes: 'none' },
      { args: ah({ question: '\u0000' }), writes: 'none' },
      { args: ah({ question: '', managerId: 'mgr-1' }), writes: 'none' },
    ],
  },
  {
    name: 'question-invalid-blank',
    group: '引数の断り',
    covers:
      'question が空白だけ・改行とタブと全角空白だけ・NUL と空白だけ: 空白だけの断り。長さの断りとは文言が違う',
    ctx: { conv: 'conv-human' },
    steps: [
      { args: ah({ question: '   ' }), writes: 'none' },
      { args: ah({ question: '\n\t　' }), writes: 'none' },
      { args: ah({ question: ' \u0000 ' }), writes: 'none' },
    ],
  },
  {
    name: 'question-undefined',
    group: '引数の断り',
    covers:
      'question が undefined（ハンドラを直に呼んだときだけ。2つの検査は undefined を通す）: 断らずに flushReply まで進み、putApproval（ストアの中）が TypeError を投げ、その後の noteDroppedRecord(approvalShape) も同じ TypeError で落ちるので、ApprovalNotRecordedError にならず素の TypeError が出る。承認も日誌も書かれない。実際の呼びでは z.string() が先に断る',
    steps: [{ args: { context: OK_BACKGROUND }, writes: 'none' }],
  },
  {
    name: 'questions-dup-id',
    group: '引数の断り',
    covers:
      '設問の id が重複: 設問の断り。question の検査より先（question が空でも設問の断りが出る）。設問の重複が選択肢の重複より先に見つかる',
    ctx: { conv: 'conv-human', taskIds: ['task-a'] },
    steps: [
      { args: ah({ questions: [Q_TARGET, { ...Q_NOTIFY, id: 'target' }] }), writes: 'none' },
      {
        args: ah({ question: '', questions: [Q_TARGET, { ...Q_NOTIFY, id: 'target' }] }),
        writes: 'none',
      },
      {
        args: ah({
          questions: [
            Q_TARGET,
            {
              ...Q_NOTIFY,
              id: 'target',
              options: [
                { id: 'a', label: 'A' },
                { id: 'a', label: 'A2' },
              ],
            },
          ],
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'questions-dup-option',
    group: '引数の断り',
    covers:
      '設問の中で選択肢の id が重複: 選択肢の断り（設問 id を載せる）。設問の並びの先頭から見て最初の1件だけを断りに載せる。question が空白だけでも設問の断りが先',
    ctx: { conv: 'conv-human' },
    steps: [
      {
        args: ah({
          questions: [
            {
              id: 'target',
              prompt: 'デプロイ先は？',
              options: [
                { id: 'railway', label: 'Railway' },
                { id: 'railway', label: 'Railway 2' },
              ],
            },
          ],
        }),
        writes: 'none',
      },
      {
        args: ah({
          question: '   ',
          questions: [
            Q_TARGET,
            {
              id: 'notify',
              prompt: '通知する先',
              options: [
                { id: 'slack', label: 'Slack' },
                { id: 'mail', label: 'メール' },
                { id: 'mail', label: 'メール 2' },
              ],
            },
          ],
        }),
        writes: 'none',
      },
    ],
  },
  // ---- 設問 questions ----
  {
    name: 'questions-ok',
    group: '設問 questions',
    covers:
      '設問が2つ（推奨・説明・multiple・allowOther つき）: 承認の行にそのままのコピーが入る。同じ設問を別の選択肢 id で使っても設問をまたぐ重複は断らない（選択肢 id は設問の中だけで一意）',
    steps: [
      { args: ah({ questions: [Q_TARGET, Q_NOTIFY] }), writes: 'both' },
      {
        args: ah({
          questions: [
            Q_TARGET,
            { id: 'again', prompt: '同じ選択肢 id', options: [{ id: 'railway', label: 'R' }] },
          ],
        }),
        writes: 'both',
      },
    ],
  },
  {
    name: 'questions-empty-array',
    group: '設問 questions',
    covers: 'questions が空の配列: 断らず、承認の行に questions の欄が付かない',
    steps: [{ args: ah({ questions: [] }), writes: 'both' }],
  },
  {
    name: 'questions-direct-bad-shape',
    group: '設問 questions',
    covers:
      '選択肢が空の設問（ハンドラを直に呼んだときだけ。実際の呼びでは zod の min(1) が先に断る）: describeQuestionsViolation は通すが、ストアが行の形（options は1件以上）で断るので、putApproval が落ちて「未記録」の例外になる。承認も日誌も書かれず、stderr に跡が残る',
    steps: [
      {
        args: ah({ questions: [{ id: 'empty', prompt: '選択肢の無い設問', options: [] }] }),
        writes: 'none',
      },
    ],
  },
  // ---- 積めた（引数の組み合わせ） ----
  {
    name: 'ok-minimal',
    group: '積めた',
    covers:
      'question だけ・会話も口も無い器: 承認の行は id・createdAt・question だけ。呼びは conversationId を2回読む（① と、workConversationId の口が無いための ③）→ flushReply → putApproval → journal.append → noteQuestionAsked(undefined) → emit',
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'ok-background',
    group: '積めた',
    covers:
      'context（背景）がある・空文字・前後に空白: 空文字でも context の欄は付く（undefined のときだけ付けない）。整形も切り詰めもしない',
    steps: [
      { args: ah({ context: OK_BACKGROUND }), writes: 'both' },
      { args: ah({ context: '' }), writes: 'both' },
      { args: ah({ context: '  前後に空白\n二行目  ' }), writes: 'both' },
    ],
  },
  {
    name: 'ok-question-shapes',
    group: '積めた',
    covers:
      'question の形: 前後の空白・複数行・長い文・NUL を含む文はそのまま通る（整形も切り詰めもしない）。出力は常に同じ文（本文は載らない）。日誌の question は渡した本文',
    steps: [
      { args: ah({ question: '  前後に空白  ' }), writes: 'both' },
      { args: ah({ question: '一行目\n二行目\n\n四行目' }), writes: 'both' },
      { args: ah({ question: LONG }), writes: 'both' },
      { args: ah({ question: '前\u0000後' }), writes: 'both' },
    ],
  },
  {
    name: 'ok-twice',
    group: '積めた',
    covers:
      '同じ内容で続けて呼ぶ: 承認の id は呼ぶたびに新しく振られ（…01・…02）、行が2つ積まれる。createdAt は呼びの時刻。日誌も2行',
    steps: [
      { args: ah(), writes: 'both' },
      { args: ah(), writes: 'both' },
    ],
  },
  {
    name: 'ids-manager-only',
    group: '積めた（managerId・requestId）',
    covers:
      'managerId だけ（委譲の行が無い）: 承認の行に jobId が付く。requestId は付かない。会話は結ばない。呼びは conversationId → listJobs → conversationId（③）…',
    steps: [{ args: ah({ managerId: 'mgr-1' }), writes: 'both' }],
  },
  {
    name: 'ids-request-only',
    group: '積めた（managerId・requestId）',
    covers:
      'requestId だけ（managerId が無い）: 承認の行に requestId が付く（jobId は付かない）。managerId が無いので委譲の行は読まない（listJobs を呼ばない）',
    steps: [{ args: ah({ requestId: 'req-1' }), writes: 'both' }],
  },
  {
    name: 'ids-manager-request',
    group: '積めた（managerId・requestId）',
    covers: 'managerId と requestId の両方: jobId と requestId が付く。委譲の行は在る（起点なし）',
    jobs: [['mgr-1', undefined]],
    steps: [{ args: ah({ managerId: 'mgr-1', requestId: 'req-1' }), writes: 'both' }],
  },
  {
    name: 'ids-all-fields',
    group: '積めた（managerId・requestId）',
    covers:
      '全部の引数（question・context・questions・managerId・requestId）と会話・task: 承認の行の欄が全部付く。欄の並びは id・createdAt・question・context・questions・jobId・requestId・conversationId・taskIds',
    ctx: { conv: 'conv-human', taskIds: ['task-a', 'task-b'] },
    jobs: [['mgr-1', 'conv-job']],
    steps: [
      {
        args: ah({
          context: OK_BACKGROUND,
          questions: [Q_TARGET, Q_NOTIFY],
          managerId: 'mgr-1',
          requestId: 'req-1',
        }),
        writes: 'both',
      },
    ],
  },
  // ---- 宛先の会話の連鎖 ----
  {
    name: 'chain-human-turn',
    group: '宛先の会話の連鎖',
    covers:
      '① 人間のターンの会話がある（managerId の委譲の起点も作業会話も別に在る）: ① が勝つ。委譲の行を読まず（listJobs を呼ばない）、workConversationId も読まない。noteQuestionAsked にも同じ会話',
    ctx: { conv: 'conv-human', work: 'conv-work' },
    jobs: [['mgr-1', 'conv-job']],
    steps: [{ args: ah({ managerId: 'mgr-1' }), writes: 'both' }],
  },
  {
    name: 'chain-human-turn-no-work-mouth',
    group: '宛先の会話の連鎖',
    covers: '① がある・workConversationId の口が無い: ① で決まるので conversationId は1回だけ読む',
    ctx: { conv: 'conv-human' },
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'chain-manager-origin',
    group: '宛先の会話の連鎖',
    covers:
      '② ① が無く、managerId の委譲の起点がある（作業会話も別に在る）: ② が勝つ。委譲の行を1回読む（listJobs）。workConversationId は読まない。他の委譲の行が並んでいても id で選ぶ',
    ctx: { work: 'conv-work' },
    jobs: [
      ['mgr-0', 'conv-other'],
      ['mgr-1', 'conv-job'],
    ],
    steps: [{ args: ah({ managerId: 'mgr-1' }), writes: 'both' }],
  },
  {
    name: 'chain-manager-origin-no-work-mouth',
    group: '宛先の会話の連鎖',
    covers:
      '② ① が無く、起点がある・workConversationId の口が無い: ② で決まり、conversationId は ① の1回だけ',
    jobs: [['mgr-1', 'conv-job']],
    steps: [{ args: ah({ managerId: 'mgr-1' }), writes: 'both' }],
  },
  {
    name: 'chain-manager-job-without-origin',
    group: '宛先の会話の連鎖',
    covers:
      '② 委譲の行はあるが起点（conversationId）が無い（定時の委譲など）: ③ の作業会話へ進む。listJobs は読む',
    ctx: { work: 'conv-work' },
    jobs: [['mgr-cron', undefined]],
    steps: [{ args: ah({ managerId: 'mgr-cron' }), writes: 'both' }],
  },
  {
    name: 'chain-manager-job-missing',
    group: '宛先の会話の連鎖',
    covers: '② managerId に合う委譲の行が無い: ③ の作業会話へ進む',
    ctx: { work: 'conv-work' },
    jobs: [['mgr-0', 'conv-other']],
    steps: [{ args: ah({ managerId: 'mgr-unknown' }), writes: 'both' }],
  },
  {
    name: 'chain-manager-list-fails',
    group: '宛先の会話の連鎖',
    covers:
      '② 委譲の行が読めない（listJobs が落ちる）: 断らず ③ の作業会話へ進む。例外は外へ出ない。stderr にも跡は出ない。2回目は読めて起点が使われる',
    ctx: { work: 'conv-work' },
    jobs: [['mgr-1', 'conv-job']],
    steps: [
      { args: ah({ managerId: 'mgr-1' }), writes: 'both', hooks: { listFails: true } },
      { args: ah({ managerId: 'mgr-1' }), writes: 'both' },
    ],
  },
  {
    name: 'chain-work-conversation',
    group: '宛先の会話の連鎖',
    covers:
      '③ ① が無く managerId も無い・作業会話がある: ③ の値。listJobs は読まない。呼びは conversationId → workConversationId',
    ctx: { work: 'conv-work' },
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'chain-work-conversation-fallback',
    group: '宛先の会話の連鎖',
    covers:
      '③ の口が無く conversationId も無い（① が undefined で、③ も同じ関数）で managerId の委譲の行も無い: 会話は無い。conversationId を ① と ③ で2回読み、間に listJobs を読む',
    steps: [{ args: ah({ managerId: 'mgr-1' }), writes: 'both' }],
  },
  {
    name: 'chain-none',
    group: '宛先の会話の連鎖',
    covers:
      '何も無い（① undefined・委譲の行に起点が無い・workConversationId の口は在るが undefined を返す）: 承認の行に conversationId の欄が付かず、noteQuestionAsked(undefined)',
    ctx: { work: null },
    jobs: [['mgr-1', undefined]],
    steps: [{ args: ah({ managerId: 'mgr-1' }), writes: 'both' }],
  },
  {
    name: 'chain-work-undefined-human-null',
    group: '宛先の会話の連鎖',
    covers:
      '① が undefined・managerId が無い・workConversationId の口が undefined を返す: 会話の無い承認。② は読まない',
    ctx: { work: null },
    steps: [{ args: ah(), writes: 'both' }],
  },
  // ---- task の結び付き ----
  {
    name: 'task-none',
    group: 'task の結び付き',
    covers:
      'currentTaskIds の口が無い: 承認の行に taskIds の欄が付かない。呼びに currentTaskIds の読みが出ない',
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'task-empty',
    group: 'task の結び付き',
    covers: 'currentTaskIds が空の配列を返す: 欄ごと付けない',
    ctx: { taskIds: [] },
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'task-ids',
    group: 'task の結び付き',
    covers:
      'currentTaskIds が2件を返す: 承認の行の taskIds に同じ並びのコピーが入る。currentTaskIds は flushReply のあと・putApproval の前に読む',
    ctx: { conv: 'conv-1', taskIds: ['task-a', 'task-b'] },
    steps: [{ args: ah(), writes: 'both' }],
  },
  // ---- 器が口を持たない ----
  {
    name: 'no-flush',
    group: '器が口を持たない',
    covers:
      'flushReply が無い器: 呼びに flushReply が出ず、ほかは同じ（putApproval → journal.append → noteQuestionAsked → emit）',
    ctx: { noFlush: true },
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'no-note',
    group: '器が口を持たない',
    covers: 'noteQuestionAsked が無い器: 呼びに noteQuestionAsked が出ず、emit は呼ばれる',
    ctx: { noNote: true },
    steps: [{ args: ah(), writes: 'both' }],
  },
  {
    name: 'no-optional-hooks',
    group: '器が口を持たない',
    covers:
      'flushReply・noteQuestionAsked・currentTaskIds・workConversationId のどれも無い最小の器: 呼びは conversationId の読み（2回）・putApproval・journal.append・emit だけ',
    ctx: { noFlush: true, noNote: true },
    steps: [{ args: ah(), writes: 'both' }],
  },
  // ---- 書き込みが落ちる ----
  {
    name: 'flush-fails',
    group: '書き込みが落ちる',
    covers:
      'flushReply が落ちる: 例外がそのまま出る。承認の行を作る前なので putApproval を呼ばず、承認も日誌も context への知らせも無い（id も振らない・currentTaskIds も読まない）',
    ctx: { conv: 'conv-1', taskIds: ['task-a'] },
    steps: [{ args: ah(), writes: 'none', hooks: { flushFails: true } }],
  },
  {
    name: 'put-fails',
    group: '書き込みが落ちる',
    covers:
      'putApproval が落ちる: 「未記録・確認は人間へ届いていない・やり直してよい」の例外（ApprovalNotRecordedError。文は ask_human と名乗る）。stderr に落とした跡が残る。承認の行は無く、日誌も足さず、noteQuestionAsked も emit も呼ばない。flushReply は先に呼ばれている。id は消費される（次の呼びは …02）。渡した行（questions・jobId・requestId・会話・taskIds）は呼びの引数に残る',
    ctx: { conv: 'conv-1', taskIds: ['task-a'] },
    steps: [
      {
        args: ah({
          context: OK_BACKGROUND,
          questions: [Q_TARGET],
          managerId: 'mgr-1',
          requestId: 'req-1',
        }),
        writes: 'none',
        hooks: { putFails: true },
      },
      { args: ah(), writes: 'both' },
    ],
  },
  {
    name: 'journal-fails',
    group: '書き込みが落ちる',
    covers:
      '日誌が書けない（act-completed）: 承認の行を書いた後なので行は残ったまま、「完了済み・未記録・やり直し禁止」の例外（JournalNotRecordedError）。人間には確認が届いているので、日誌より先に noteQuestionAsked と emit を呼ぶ（#6490。request_permission と同じ）。stderr に跡が残る。やり直すと行がもう1つ積まれる',
    ctx: { conv: 'conv-1' },
    steps: [
      { args: ah(), writes: 'approval-only', hooks: { journalFails: true } },
      { args: ah(), writes: 'both' },
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
  op: string;
  args?: unknown;
  outcome?: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの承認の全行（ストアから読んだ形のまま） */
  approvals: PendingApproval[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 呼びの並び */
  calls: PinnedCall[];
  /** noteDroppedRecord が stderr へ残した跡 */
  stderr: string[];
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

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗を起こす */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  return {
    ...base,
    jobs: {
      ...base.jobs,
      listJobs: async () => {
        if (hooks().listFails === true) {
          calls.push({ op: 'jobs.listJobs', outcome: 'threw Error: 台帳が読めない（listJobs）' });
          throw new Error('台帳が読めない（listJobs）');
        }
        const jobs = await base.jobs.listJobs();
        calls.push({ op: 'jobs.listJobs', outcome: `ok ${String(jobs.length)} jobs` });
        return jobs;
      },
      putApproval: async (approval) => {
        const args = plain(approval);
        if (hooks().putFails === true) {
          calls.push({
            op: 'jobs.putApproval',
            args,
            outcome: 'threw Error: ストアが落ちた（putApproval）',
          });
          throw new Error('ストアが落ちた（putApproval）');
        }
        try {
          await base.jobs.putApproval(approval);
        } catch (error) {
          // ストア自身が断った（行の形が合わない）呼びも、並びに残す
          calls.push({
            op: 'jobs.putApproval',
            args,
            outcome: `threw ${error instanceof Error ? error.name : typeof error} (store)`,
          });
          throw error;
        }
        calls.push({ op: 'jobs.putApproval', args, outcome: 'ok' });
      },
    },
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

function jobRow(id: string, conversationId: string | undefined): Job {
  return {
    id,
    managerId: id,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    status: 'done',
    summary: `${id} の依頼`,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  for (const [id, conversationId] of scenario.jobs ?? []) {
    await base.jobs.putJob(jobRow(id, conversationId));
  }
  vi.setSystemTime(new Date(BASE_ISO));
  uuidState.drawn = 0;
  let hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const ctx = scenario.ctx ?? {};
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: (event) => {
      calls.push({ op: 'context.emit', args: plain(event) });
    },
    memoryCause: () => 'clone',
    conversationId: () => {
      calls.push({ op: 'context.conversationId' });
      return ctx.conv;
    },
    ...(ctx.work === undefined
      ? {}
      : {
          workConversationId: () => {
            calls.push({ op: 'context.workConversationId' });
            return ctx.work ?? undefined;
          },
        }),
    ...(ctx.taskIds === undefined
      ? {}
      : {
          currentTaskIds: () => {
            calls.push({ op: 'context.currentTaskIds' });
            return ctx.taskIds ?? [];
          },
        }),
    ...(ctx.noFlush === true
      ? {}
      : {
          flushReply: async () => {
            if (hooks.flushFails === true) {
              calls.push({ op: 'context.flushReply', outcome: 'threw Error: flush が落ちた' });
              throw new Error('flush が落ちた');
            }
            calls.push({ op: 'context.flushReply', outcome: 'ok' });
          },
        }),
    ...(ctx.noNote === true
      ? {}
      : {
          noteQuestionAsked: (conversationId: string | undefined) => {
            calls.push({
              op: 'context.noteQuestionAsked',
              args: conversationId === undefined ? '(undefined)' : conversationId,
            });
          },
        }),
  });
  const found = tools.find((entry) => entry.name === 'ask_human');
  if (!found) throw new Error('ask_human が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base);
    hooks = step.hooks ?? {};
    calls.length = 0;
    const stderr: string[] = [];
    setStderrSinkForTesting((line) => {
      stderr.push(line);
    });
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
    } finally {
      setStderrSinkForTesting(null);
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
      stderr,
    });
    const key = stepKey(scenario, index);
    const ops = calls.map((entry) => entry.op);
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、承認の行も日誌も呼ぶ前と同じで、context への知らせも無い
      expect(
        after.approvals,
        `場面 ${key} は書き込みが起きないはずだが、承認の行が呼ぶ前から変わった`,
      ).toEqual(before.approvals);
      expect(
        after.journal,
        `場面 ${key} は書き込みが起きないはずだが、日誌が呼ぶ前から変わった`,
      ).toEqual(before.journal);
      expect(ops, `場面 ${key}: 書き込みが起きないのに context へ知らせた`).not.toContain(
        'context.noteQuestionAsked',
      );
      expect(ops, `場面 ${key}: 書き込みが起きないのに emit した`).not.toContain('context.emit');
      expect(ops, `場面 ${key}: 日誌の書き込みを呼んだ`).not.toContain('journal.append');
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

describe('ask_human の出力と呼んだあとの状態の固定（場面ごとの出力の全文・承認の行・日誌の行・呼びの並び）', () => {
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

  it('書き込みの有無が宣言と同じ（承認の行・日誌の行・context への知らせの有無）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        const got = actual[key];
        const ops = (got?.calls ?? []).map((entry) => entry.op);
        expect(got?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes !== 'none');
        expect((got?.journal.length ?? -1) > 0, `${key}: 日誌の行の有無が宣言と違う`).toBe(
          step.writes === 'both',
        );
        // 知らせ（emit）は承認の行を積めた呼びすべて（日誌が書けなくても知らせる。#6490）。noteQuestionAsked は口が在るときだけ同じ条件で呼ばれる
        expect(ops.includes('context.emit'), `${key}: emit の有無が宣言と違う`).toBe(
          step.writes !== 'none',
        );
        const hasNote = scenario.ctx?.noNote !== true;
        expect(
          ops.includes('context.noteQuestionAsked'),
          `${key}: noteQuestionAsked の有無が宣言と違う`,
        ).toBe(step.writes !== 'none' && hasNote);
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
            `場面 ${key} の承認 ${wantRow.id}（${String(row)} 行目）が固定値からずれた（質問文・context・questions・jobId・requestId・会話・taskIds など）`,
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

      it(`${key} の呼びの並び（context の読み・知らせ、ストアの読み書き）と stderr の跡が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼び: 並び（conversationId・listJobs・workConversationId・flushReply・putApproval・journal.append・noteQuestionAsked・emit など）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び: 渡した行・イベント・引数か結果がずれた`).toEqual(
          want?.calls,
        );
        expect(got?.stderr, `場面 ${key} の stderr の跡がずれた`).toEqual(want?.stderr);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・承認・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const row = (key: string, n = 0): PendingApproval | undefined => actual[key]?.approvals[n];
    const noteArg = (key: string): unknown =>
      actual[key]?.calls.find((c) => c.op === 'context.noteQuestionAsked')?.args;
    const REFUSE = '承認待ちには積まなかった: ';
    const queued = (n: number): string => `承認待ちキューに積んだ（${u(n)}）。回答は後から届く。`;
    const CONV = 'context.conversationId';
    const WORK = 'context.workConversationId';
    const LIST = 'jobs.listJobs';
    const TAIL = [
      'context.flushReply',
      'jobs.putApproval',
      'context.noteQuestionAsked',
      'context.emit',
      'journal.append',
    ];
    // 引数の断り（context は1つも読まない・書かない）
    expect(text('question-invalid-length#1')).toBe(
      `${REFUSE}question は使えない（1文字以上のみ）。`,
    );
    expect(text('question-invalid-length#2')).toBe(text('question-invalid-length#1'));
    expect(text('question-invalid-length#3')).toBe(text('question-invalid-length#1'));
    for (let n = 1; n <= 3; n += 1) {
      expect(text(`question-invalid-blank#${String(n)}`)).toBe(
        `${REFUSE}question は使えない（空白だけの値は空と同じ。1文字以上のみ）。`,
      );
    }
    for (const key of [
      'question-invalid-length#1',
      'question-invalid-length#3',
      'question-invalid-blank#1',
      'questions-dup-id#1',
      'questions-dup-option#1',
    ]) {
      expect(ops(key), `${key}: 断る場面で口を呼んだ`).toEqual([]);
    }
    expect(text('questions-dup-id#1')).toBe(
      `${REFUSE}questions の設問 id "target" が重複している（設問の id は承認待ちの中で一意にする）。`,
    );
    expect(text('questions-dup-id#2')).toBe(text('questions-dup-id#1'));
    expect(text('questions-dup-id#3')).toBe(text('questions-dup-id#1'));
    expect(text('questions-dup-option#1')).toBe(
      `${REFUSE}設問 "target" の選択肢 id "railway" が重複している（選択肢の id は設問の中で一意にする）。`,
    );
    expect(text('questions-dup-option#2')).toContain('設問 "notify" の選択肢 id "mail" が重複');
    expect(actual['question-undefined']?.output.errorName).toBe('TypeError');
    expect(ops('question-undefined')).toEqual([
      CONV,
      CONV,
      'context.flushReply',
      'jobs.putApproval',
    ]);
    // 設問
    expect(row('questions-ok#1')?.questions).toEqual([Q_TARGET, Q_NOTIFY]);
    expect(row('questions-ok#2', 1)?.questions).toHaveLength(2);
    expect(row('questions-empty-array')).not.toHaveProperty('questions');
    expect(actual['questions-direct-bad-shape']?.output.errorName).toBe('ApprovalNotRecordedError');
    expect(actual['questions-direct-bad-shape']?.approvals).toEqual([]);
    expect(ops('questions-direct-bad-shape')).toEqual([
      CONV,
      CONV,
      'context.flushReply',
      'jobs.putApproval',
    ]);
    // 積めた
    expect(ops('ok-minimal')).toEqual([CONV, CONV, ...TAIL]);
    expect(text('ok-minimal')).toBe(queued(1));
    expect(row('ok-minimal')).toEqual({ id: u(1), createdAt: callTime(0), question: OK_QUESTION });
    expect(actual['ok-minimal']?.journal[0]).toMatchObject({
      type: 'escalation',
      question: OK_QUESTION,
      approvalId: u(1),
    });
    expect(noteArg('ok-minimal')).toBe('(undefined)');
    expect(row('ok-background#1')?.context).toBe(OK_BACKGROUND);
    expect(row('ok-background#2', 1)?.context).toBe('');
    expect(row('ok-background#3', 2)?.context).toBe('  前後に空白\n二行目  ');
    expect(row('ok-question-shapes#3', 2)?.question).toBe(LONG);
    expect(text('ok-question-shapes#3')).toBe(queued(3));
    expect(actual['ok-twice#2']?.approvals.map((entry) => entry.id)).toEqual([u(1), u(2)]);
    expect(row('ok-twice#2', 1)?.createdAt).toBe(callTime(1));
    // managerId・requestId
    expect(row('ids-manager-only')?.jobId).toBe('mgr-1');
    expect(row('ids-manager-only')).not.toHaveProperty('requestId');
    expect(ops('ids-manager-only')).toEqual([CONV, LIST, CONV, ...TAIL]);
    expect(row('ids-request-only')?.requestId).toBe('req-1');
    expect(row('ids-request-only')).not.toHaveProperty('jobId');
    expect(ops('ids-request-only')).not.toContain(LIST);
    expect(row('ids-manager-request')).toMatchObject({ jobId: 'mgr-1', requestId: 'req-1' });
    // 欄の並びはストアへ渡した行（putApproval の引数）で見る（ストアから読み直した行は欄の順が変わる）
    const put = actual['ids-all-fields']?.calls.find((c) => c.op === 'jobs.putApproval');
    expect(Object.keys((put?.args as Record<string, unknown> | undefined) ?? {})).toEqual([
      'id',
      'createdAt',
      'question',
      'context',
      'questions',
      'jobId',
      'requestId',
      'conversationId',
      'taskIds',
    ]);
    // 宛先の会話の連鎖
    expect(row('chain-human-turn')?.conversationId).toBe('conv-human');
    expect(ops('chain-human-turn')).toEqual([CONV, ...TAIL]);
    expect(noteArg('chain-human-turn')).toBe('conv-human');
    expect(ops('chain-human-turn-no-work-mouth')).toEqual([CONV, ...TAIL]);
    expect(row('chain-manager-origin')?.conversationId).toBe('conv-job');
    expect(ops('chain-manager-origin')).toEqual([CONV, LIST, ...TAIL]);
    expect(noteArg('chain-manager-origin')).toBe('conv-job');
    expect(row('chain-manager-origin-no-work-mouth')?.conversationId).toBe('conv-job');
    expect(ops('chain-manager-origin-no-work-mouth')).toEqual([CONV, LIST, ...TAIL]);
    expect(row('chain-manager-job-without-origin')?.conversationId).toBe('conv-work');
    expect(ops('chain-manager-job-without-origin')).toEqual([CONV, LIST, WORK, ...TAIL]);
    expect(row('chain-manager-job-missing')?.conversationId).toBe('conv-work');
    expect(ops('chain-manager-job-missing')).toEqual([CONV, LIST, WORK, ...TAIL]);
    expect(row('chain-manager-list-fails#1')?.conversationId).toBe('conv-work');
    expect(actual['chain-manager-list-fails#1']?.output.thrown).toBe(false);
    expect(actual['chain-manager-list-fails#1']?.calls[1]?.outcome).toContain('threw');
    expect(actual['chain-manager-list-fails#1']?.stderr).toEqual([]);
    expect(row('chain-manager-list-fails#2', 1)?.conversationId).toBe('conv-job');
    expect(row('chain-work-conversation')?.conversationId).toBe('conv-work');
    expect(ops('chain-work-conversation')).toEqual([CONV, WORK, ...TAIL]);
    expect(row('chain-work-conversation-fallback')).not.toHaveProperty('conversationId');
    expect(ops('chain-work-conversation-fallback')).toEqual([CONV, LIST, CONV, ...TAIL]);
    expect(row('chain-none')).not.toHaveProperty('conversationId');
    expect(ops('chain-none')).toEqual([CONV, LIST, WORK, ...TAIL]);
    expect(noteArg('chain-none')).toBe('(undefined)');
    expect(row('chain-work-undefined-human-null')).not.toHaveProperty('conversationId');
    expect(ops('chain-work-undefined-human-null')).toEqual([CONV, WORK, ...TAIL]);
    // task
    expect(ops('task-none')).not.toContain('context.currentTaskIds');
    expect(row('task-none')).not.toHaveProperty('taskIds');
    expect(ops('task-empty')).toContain('context.currentTaskIds');
    expect(row('task-empty')).not.toHaveProperty('taskIds');
    expect(row('task-ids')?.taskIds).toEqual(['task-a', 'task-b']);
    expect(ops('task-ids')).toEqual([
      CONV,
      'context.flushReply',
      'context.currentTaskIds',
      'jobs.putApproval',
      'context.noteQuestionAsked',
      'context.emit',
      'journal.append',
    ]);
    // 口が無い
    expect(ops('no-flush')).toEqual([CONV, CONV, ...TAIL.slice(1)]);
    expect(ops('no-note')).not.toContain('context.noteQuestionAsked');
    expect(ops('no-note')).toContain('context.emit');
    expect(ops('no-optional-hooks')).toEqual([
      CONV,
      CONV,
      'jobs.putApproval',
      'context.emit',
      'journal.append',
    ]);
    // 書き込みが落ちる
    expect(actual['flush-fails']?.output.thrown).toBe(true);
    expect(text('flush-fails')).toBe('flush が落ちた');
    expect(ops('flush-fails')).toEqual([CONV, 'context.flushReply']);
    expect(actual['put-fails#1']?.output.thrown).toBe(true);
    expect(actual['put-fails#1']?.output.errorName).toBe('ApprovalNotRecordedError');
    expect(text('put-fails#1')).toContain('⚠⚠ 未記録・確認は人間へ届いていない・やり直してよい');
    expect(text('put-fails#1')).toContain('ask_human は承認待ちキューへの記録に失敗した');
    expect(ops('put-fails#1')).toEqual([
      CONV,
      'context.flushReply',
      'context.currentTaskIds',
      'jobs.putApproval',
    ]);
    expect(actual['put-fails#1']?.stderr.join('')).toContain('承認待ちを記録できませんでした');
    expect(actual['put-fails#1']?.approvals).toEqual([]);
    expect(actual['put-fails#2']?.approvals.map((entry) => entry.id)).toEqual([u(2)]);
    expect(actual['journal-fails#1']?.output.thrown).toBe(true);
    expect(actual['journal-fails#1']?.output.errorName).toBe('JournalNotRecordedError');
    expect(text('journal-fails#1')).toContain('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(text('journal-fails#1')).toContain('ask_human は完了した');
    expect(actual['journal-fails#1']?.journal).toEqual([]);
    expect(actual['journal-fails#1']?.approvals.map((entry) => entry.id)).toEqual([u(1)]);
    // 日誌が書けなくても、積んだ確認は先に知らせる（#6490）
    expect(ops('journal-fails#1').slice(-4)).toEqual([
      'jobs.putApproval',
      'context.noteQuestionAsked',
      'context.emit',
      'journal.append',
    ]);
    expect(actual['journal-fails#1']?.stderr.join('')).toContain('日誌を記録できませんでした');
    expect(actual['journal-fails#2']?.approvals.map((entry) => entry.id)).toEqual([u(1), u(2)]);
  });
});
