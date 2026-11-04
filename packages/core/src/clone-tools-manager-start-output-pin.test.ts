import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AttachmentLimits, AttachmentMeta, AttachmentStore } from './attachment.js';
import { ManagerAttachmentsRefusedError } from './manager-attachments.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import type { PidsSaturation } from './runner-protocol.js';
import type { Job, Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_start` の出力（全文・字数・エラーか・例外で返ったか）と、日誌に足された行・ストア・pool・コールバックへの呼びの並びを、
// 場面ごとにコミットした固定値（clone-tools-manager-start-output-pin.json）と丸ごと比べる。
// `clone-tools-manager-start.ts` の `managerStartTool`（ハンドラ約 133 行・入れ子 5 段の式）を小さな関数へ分けるとき、
// 出力・日誌・呼びが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MANAGER_START_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-manager-start-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-manager-start-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの場面が何字を出しているかを見る基準）。
// 各場面の `calls` は、道具が出した呼びの並び:
//   - `stores.tasks.get(<id>)` / `stores.jobs.listJobs()`: task の確かめ・走っている委譲の探し
//   - `stores.attachments.getMeta(<id>)` / `stores.attachments.get(<id>)`: 添付の読み（大きい添付は get しない）
//   - `stores.journal.append`: 日誌の追記の試み（書けなかった回も数える。書けた行は `journal`）
//   - `pool.start(<引数を key 順で並べた JSON>)`: 起こす呼び（request・cwd・runnerId・supersedes・conversationId・taskId・attachments の有無が分かる）
//   - `context.noteDelegationStarted(<taskId>)`: 起こした事実の控え
//   - `pool.runnerPidsSaturation(<runnerId>)`: pids 飽和の問い合わせ
// `journal` は呼んだあとに日誌へ足された行（種類・本文・grounds・id・at）。`tasksUnchanged` / `jobsUnchanged` は task・委譲の台帳が呼ぶ前と同じか。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。

type Args = Record<string, unknown>;

type StartFake = { returns: Partial<ManagerSummary> } | { throws: unknown };

interface SeedAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** 省略は size 個の 'a'（大きい添付は中身を読まないので、中身は使われない） */
  text?: string;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  args: Args;
  /** 真なら pool を渡さない */
  noPool?: boolean;
  tasks?: Task[];
  jobs?: Job[];
  /** `tasks.get` が投げる値 */
  taskGetThrows?: 'unreadable' | 'plain';
  /** `jobs.listJobs` が投げる */
  listJobsThrows?: boolean;
  attachments?: SeedAttachment[];
  /** 添付の読みの失敗: getMeta が投げる id・get が投げる id・get が undefined を返す id（読む間に消えた） */
  attachFail?: { getMetaThrows?: string; getThrows?: string; vanishes?: string };
  limits?: Partial<AttachmentLimits>;
  /** `journal.append` の n 回目（1 から。書けなかった回も数える）を投げさせる */
  journalFailsAt?: number[];
  start?: StartFake;
  /** `runnerPidsSaturation` の返り値。'none' は undefined を返す・'no-method' は pool がその口を持たない。省略は 'none' */
  saturation?: PidsSaturation | 'none' | 'no-method';
  /** 真なら `noteDelegationStarted` を渡さない */
  noNote?: boolean;
  conversationId?: string;
  workConversationId?: string;
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const PIN_URL = new URL('./clone-tools-manager-start-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MANAGER_START_PIN === '1';
const AT = '2026-10-27T00:00:00.000Z';

const BASE_LIMITS: AttachmentLimits = {
  maxImageBytes: 1024,
  maxFileBytes: 64,
  maxLargeFileBytes: 4096,
  maxPerMessage: 3,
  maxTotalBytes: 100,
  retentionDays: 30,
};

function task(id: string, status: Task['status'] = 'queued'): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    origin: 'human',
    title: `${id} の仕事`,
    body: `${id} の本文`,
  };
}

function job(id: string, status: Job['status'], taskId: string): Job {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-1',
    taskId,
    ...(status === 'running' || status === 'waiting_human' ? {} : { endedAt: AT }),
  };
}

const file = (id: string, size: number, name = `${id}.txt`): SeedAttachment => ({
  id,
  name,
  mediaType: 'text/plain',
  size,
});

const REQUEST = '調べて。背景は別に書く。';

const SCENARIOS: Scenario[] = [
  // --- pool が無い
  {
    name: 'no-pool',
    covers: 'pool が無い（NO_POOL。request の検査にもストアにも触れない）',
    args: { request: REQUEST },
    noPool: true,
  },
  {
    name: 'no-pool-empty-request',
    covers: 'pool が無く request も空（pool の有無が先）',
    args: { request: '' },
    noPool: true,
  },
  // --- request の検査
  { name: 'request-empty', covers: 'request が空文字', args: { request: '' } },
  {
    name: 'request-nul-only',
    covers: 'request が NUL だけ（NUL を除くと空）',
    args: { request: '\u0000\u0000' },
  },
  {
    name: 'request-whitespace',
    covers: 'request が空白だけ（空白・改行・タブ）',
    args: { request: '  \n\t ' },
  },
  {
    name: 'request-fullwidth-space',
    covers: 'request が全角空白だけ（trim が畳む）',
    args: { request: '　' },
  },
  {
    name: 'request-whitespace-nul',
    covers: 'request が空白と NUL だけ',
    args: { request: ' \u0000 ' },
  },
  {
    name: 'request-empty-with-task',
    covers: 'request が空で taskId も渡す（task を確かめる前に断る。tasks.get を呼ばない）',
    args: { request: '', taskId: 't-1' },
    tasks: [task('t-1')],
  },
  {
    name: 'request-with-nul-inside',
    covers:
      'request の途中に NUL（検査は通る。start へは NUL を除かない素の request を渡し、日誌の行はストアが NUL を落とす）',
    args: { request: '前\u0000後' },
  },
  // --- taskId
  {
    name: 'task-missing',
    covers: 'taskId の task が無い（null）',
    args: { request: REQUEST, taskId: 't-ghost' },
  },
  {
    name: 'task-empty-string',
    covers: 'taskId が空文字（undefined ではないので確かめに行き、無い扱い）',
    args: { request: REQUEST, taskId: '' },
  },
  {
    name: 'task-unreadable',
    covers: 'tasks.get が UnreadableTaskError',
    args: { request: REQUEST, taskId: 't-1' },
    taskGetThrows: 'unreadable',
  },
  {
    name: 'task-get-throws-plain',
    covers: 'tasks.get がほかの例外（そのまま例外で返る）',
    args: { request: REQUEST, taskId: 't-1' },
    taskGetThrows: 'plain',
  },
  {
    name: 'task-done',
    covers: 'task が done（閉じている）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'done')],
  },
  {
    name: 'task-cancelled',
    covers: 'task が cancelled（閉じている）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'cancelled')],
  },
  {
    name: 'task-done-with-running-job',
    covers: 'task が done で走っている委譲も在る（閉じた判定が先。listJobs を呼ばない）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'done')],
    jobs: [job('mgr-run', 'running', 't-1')],
  },
  {
    name: 'task-running-one',
    covers: '走っている委譲が1本（running）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'waiting')],
    jobs: [job('mgr-run', 'running', 't-1')],
  },
  {
    name: 'task-running-one-waiting-human',
    covers: '走っている委譲が1本（waiting_human も待ち扱い）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'waiting')],
    jobs: [job('mgr-ask', 'waiting_human', 't-1')],
  },
  {
    name: 'task-running-many',
    covers:
      '走っている委譲が複数（running と waiting_human・台帳の並び順に「、」で並べる）。終わった委譲・別 task の委譲は並べない',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'waiting')],
    jobs: [
      job('mgr-done', 'done', 't-1'),
      job('mgr-run', 'running', 't-1'),
      job('mgr-other', 'running', 't-2'),
      job('mgr-ask', 'waiting_human', 't-1'),
    ],
  },
  {
    name: 'task-only-settled-jobs',
    covers:
      '待ちでない委譲だけ（done・failed・lost・stopped）と別 task の走っている委譲 → 断らず起こす（taskId を start へ渡し、noteDelegationStarted にも渡す）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'needs_decision')],
    jobs: [
      job('mgr-done', 'done', 't-1'),
      job('mgr-failed', 'failed', 't-1'),
      job('mgr-lost', 'lost', 't-1'),
      job('mgr-stopped', 'stopped', 't-1'),
      job('mgr-other', 'running', 't-2'),
    ],
  },
  {
    name: 'task-queued-ok',
    covers: 'task が queued・委譲なし → 起こす',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'queued')],
  },
  {
    name: 'task-waiting-no-jobs-ok',
    covers:
      'task が waiting だが結び付いた委譲が台帳に無い → 起こす（task の状態ではなく委譲で判定する）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1', 'waiting')],
  },
  {
    name: 'jobs-list-throws',
    covers: 'jobs.listJobs が例外（そのまま例外で返る。日誌は書かない）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1')],
    listJobsThrows: true,
  },
  // --- 添付
  {
    name: 'attach-empty-array',
    covers: 'attachments が空配列（start に attachments 欄を載せない・添付の注記なし）',
    args: { request: REQUEST, attachments: [] },
  },
  {
    name: 'attach-one-small',
    covers: '添付1件（中身を読んで base64 で渡す・日誌に注記）',
    args: { request: REQUEST, attachments: ['att-1'] },
    attachments: [file('att-1', 5, 'build.log')],
  },
  {
    name: 'attach-dup-ids',
    covers: '同じ id を2回渡す（重複を畳む。getMeta・get は1回）',
    args: { request: REQUEST, attachments: ['att-1', 'att-1'] },
    attachments: [file('att-1', 5, 'build.log')],
  },
  {
    name: 'attach-two-small',
    covers: '添付2件（注記は「, 」区切り）',
    args: { request: REQUEST, attachments: ['att-1', 'att-2'] },
    attachments: [file('att-1', 5, 'a.log'), file('att-2', 7, 'b.log')],
  },
  {
    name: 'attach-large-staged',
    covers: '大きい添付（maxFileBytes 超え・中身を読まず staged: true で渡す。get を呼ばない）',
    args: { request: REQUEST, attachments: ['att-big'] },
    attachments: [file('att-big', 200, 'big.bin')],
  },
  {
    name: 'attach-mixed-staged-and-small',
    covers: '大きい添付と小さい添付の混在（並びは渡した順・小さい方だけ get）',
    args: { request: REQUEST, attachments: ['att-big', 'att-1'] },
    attachments: [file('att-big', 200, 'big.bin'), file('att-1', 5, 'a.log')],
  },
  {
    name: 'attach-missing',
    covers: '添付が見つからない（ほかの id も getMeta まで読む・日誌も start も無し）',
    args: { request: REQUEST, attachments: ['att-1', 'att-gone', 'att-gone-2'] },
    attachments: [file('att-1', 5)],
  },
  {
    name: 'attach-missing-with-task',
    covers: '添付が見つからない・taskId も渡す（task の確かめは済んだ後に断る）',
    args: { request: REQUEST, attachments: ['att-gone'], taskId: 't-1' },
    tasks: [task('t-1')],
  },
  {
    name: 'attach-getmeta-throws',
    covers: '添付の控えの読みが失敗（ok: false の文。例外にはしない）',
    args: { request: REQUEST, attachments: ['att-1'] },
    attachments: [file('att-1', 5)],
    attachFail: { getMetaThrows: 'att-1' },
  },
  {
    name: 'attach-get-throws',
    covers: '添付の中身の読みが失敗',
    args: { request: REQUEST, attachments: ['att-1'] },
    attachments: [file('att-1', 5)],
    attachFail: { getThrows: 'att-1' },
  },
  {
    name: 'attach-vanishes-while-reading',
    covers: '控えは在るが中身を読む間に消えた',
    args: { request: REQUEST, attachments: ['att-1'] },
    attachments: [file('att-1', 5)],
    attachFail: { vanishes: 'att-1' },
  },
  {
    name: 'attach-too-many',
    covers: '個数の上限超え（maxPerMessage 3 に 4 件）',
    args: { request: REQUEST, attachments: ['a1', 'a2', 'a3', 'a4'] },
    attachments: [file('a1', 1), file('a2', 1), file('a3', 1), file('a4', 1)],
  },
  {
    name: 'attach-total-too-large',
    covers: '合計の上限超え（小さい添付 60 + 50 > maxTotalBytes 100。大きい添付は合計に数えない）',
    args: { request: REQUEST, attachments: ['a1', 'a2'] },
    attachments: [file('a1', 60), file('a2', 50)],
  },
  {
    name: 'attach-large-not-counted-in-total',
    covers: '大きい添付 200 は合計に数えない（小さい 60 と合わせても上限内）→ 渡せる',
    args: { request: REQUEST, attachments: ['a1', 'att-big'] },
    attachments: [file('a1', 60), file('att-big', 200)],
  },
  // --- 日誌が書けない
  {
    name: 'journal-fails-first',
    covers: '先の日誌が書けない（起こさない・JournalNotRecordedError で例外・note も呼ばない）',
    args: { request: REQUEST },
    journalFailsAt: [1],
  },
  {
    name: 'journal-fails-first-with-task-and-attach',
    covers: '先の日誌が書けない・taskId と添付も渡している（確かめと読みは済み、start は呼ばない）',
    args: { request: REQUEST, taskId: 't-1', attachments: ['att-1'], runnerId: 'runner-2' },
    tasks: [task('t-1')],
    attachments: [file('att-1', 5)],
    journalFailsAt: [1],
  },
  {
    name: 'journal-fails-started',
    covers:
      '起こした日誌が書けない（落とす・起こした事実は変わらず note も呼ぶ・出力は通常どおり）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1')],
    journalFailsAt: [2],
  },
  {
    name: 'journal-fails-started-with-saturation',
    covers: '起こした日誌が書けない・pids 飽和の注も通常どおり付く',
    args: { request: REQUEST },
    journalFailsAt: [2],
    saturation: { basis: [{ kind: 'at-limit', current: 100, max: 100 }], windowMs: 600_000 },
  },
  {
    name: 'journal-fails-both-appends',
    covers: '1 回目と 2 回目の追記がどちらも書けない（1 回目で止まる。2 回目は試みない）',
    args: { request: REQUEST },
    journalFailsAt: [1, 2],
  },
  {
    name: 'journal-fails-failure-entry-refused',
    covers:
      'start が ManagerAttachmentsRefusedError・失敗の日誌も書けない（落とす。断りの文は変わらない）',
    args: { request: REQUEST },
    start: { throws: new ManagerAttachmentsRefusedError('runner が添付を受け取れない') },
    journalFailsAt: [2],
  },
  {
    name: 'journal-fails-failure-entry-throws',
    covers: 'start がほかの例外・失敗の日誌も書けない（落とす。元の例外がそのまま投げられる）',
    args: { request: REQUEST },
    start: { throws: new Error('runner が落ちた') },
    journalFailsAt: [2],
  },
  // --- start の失敗
  {
    name: 'start-refused',
    covers:
      'start が ManagerAttachmentsRefusedError（失敗の日誌を書き、断りの文を返す。note は呼ばない）',
    args: { request: REQUEST, runnerId: 'runner-old', attachments: ['att-1'] },
    attachments: [file('att-1', 5, 'a.log')],
    start: {
      throws: new ManagerAttachmentsRefusedError('runner-old は添付の受け渡しを名乗っていない'),
    },
  },
  {
    name: 'start-throws-plain',
    covers: 'start がほかの例外（失敗の日誌を書き、例外がそのまま返る。note は呼ばない）',
    args: { request: REQUEST, runnerId: 'runner-x', taskId: 't-1' },
    tasks: [task('t-1')],
    start: { throws: new Error('runner-x は名簿に無い') },
  },
  {
    name: 'start-throws-string',
    covers: 'start が Error でない値（文字列）を投げる（失敗の日誌の理由は文字列・例外として返る）',
    args: { request: REQUEST },
    start: { throws: '文字列で投げた' },
  },
  // --- 引数の有無（start へ渡る）
  {
    name: 'args-minimal',
    covers:
      'request だけ（start の引数は request のみ・cwd・runnerId など無し・conversationId 無し）',
    args: { request: REQUEST },
  },
  {
    name: 'arg-cwd-confirmed',
    covers: 'cwd を渡す・確認済み（「cwd: …」）',
    args: { request: REQUEST, cwd: '/work/sub' },
    start: { returns: { cwd: '/work/sub', cwdConfirmed: true } },
  },
  {
    name: 'arg-cwd-unconfirmed',
    covers: '実際の cwd が未確認（cwdConfirmed が無い・「実際の cwd は未確認（頼んだ値: …）」）',
    args: { request: REQUEST, cwd: '/work/sub' },
    start: { returns: { cwd: '/work/sub', cwdConfirmed: undefined } },
  },
  {
    name: 'arg-cwd-unconfirmed-with-requested',
    covers: '未確認で requestedCwd も在る（未確認の文が先。「頼んだ cwd は無かった」とは言わない）',
    args: { request: REQUEST },
    start: { returns: { cwd: '/work', cwdConfirmed: undefined, requestedCwd: '/work/sub' } },
  },
  {
    name: 'arg-cwd-replaced',
    covers: '頼んだ cwd が器に無く別の cwd で開いた（requestedCwd あり・確認済み）',
    args: { request: REQUEST, cwd: '/work/ghost' },
    start: { returns: { cwd: '/work', cwdConfirmed: true, requestedCwd: '/work/ghost' } },
  },
  {
    name: 'arg-runner-id',
    covers: 'runnerId を渡す（先の日誌・起こした日誌・失敗の日誌の「指名」の注記）',
    args: { request: REQUEST, runnerId: 'runner-2' },
    start: { returns: { runnerId: 'runner-2' } },
  },
  {
    name: 'arg-supersedes',
    covers: 'supersedes を渡す（start へ渡す。日誌と出力には出ない）',
    args: { request: REQUEST, supersedes: 'mgr-old' },
  },
  {
    name: 'arg-conversation-id',
    covers: 'conversationId だけ（呼び出し文脈の会話 id を start へ渡す）',
    args: { request: REQUEST },
    conversationId: 'conv-reply',
  },
  {
    name: 'arg-work-conversation-id',
    covers: '返信先の会話と仕事の会話が違う（仕事の会話を渡す）',
    args: { request: REQUEST },
    conversationId: 'conv-reply',
    workConversationId: 'conv-work',
  },
  {
    name: 'args-all',
    covers:
      'cwd・runnerId・supersedes・会話・taskId・添付をすべて渡す（日誌の注記は「指名」の後ろに添付）。pids 飽和の注も付く',
    args: {
      request: REQUEST,
      cwd: '/work/sub',
      runnerId: 'runner-2',
      supersedes: 'mgr-old',
      taskId: 't-1',
      attachments: ['att-1', 'att-big'],
    },
    tasks: [task('t-1')],
    attachments: [file('att-1', 5, 'a.log'), file('att-big', 200, 'big.bin')],
    conversationId: 'conv-1',
    start: { returns: { cwd: '/work/sub', cwdConfirmed: true, runnerId: 'runner-2' } },
    saturation: {
      basis: [
        { kind: 'at-limit', current: 4096, max: 4096 },
        { kind: 'eagain', count: 3 },
        { kind: 'fork-denied', count: 2 },
      ],
      windowMs: 600_000,
    },
  },
  // --- noteDelegationStarted
  {
    name: 'note-missing',
    covers: 'noteDelegationStarted が無い（呼ばずに通常どおり返す）',
    args: { request: REQUEST, taskId: 't-1' },
    tasks: [task('t-1')],
    noNote: true,
  },
  {
    name: 'note-without-task',
    covers: 'taskId なしの起こし（noteDelegationStarted(undefined)）',
    args: { request: REQUEST },
  },
  // --- pids 飽和の注
  {
    name: 'saturation-at-limit',
    covers: '置き先が pids 飽和（上限に達している）→ 起こしたうえで注を付ける',
    args: { request: REQUEST },
    saturation: { basis: [{ kind: 'at-limit', current: 100, max: 100 }], windowMs: 600_000 },
  },
  {
    name: 'saturation-signs',
    covers: '飽和の材料が EAGAIN と fork 拒否（窓 15 分）',
    args: { request: REQUEST },
    saturation: {
      basis: [
        { kind: 'eagain', count: 2 },
        { kind: 'fork-denied', count: 1 },
      ],
      windowMs: 900_000,
    },
  },
  {
    name: 'saturation-none',
    covers: '問い合わせは undefined（注なし）',
    args: { request: REQUEST },
    saturation: 'none',
  },
  {
    name: 'saturation-no-method',
    covers: 'pool が runnerPidsSaturation を持たない（問い合わせず注なし）',
    args: { request: REQUEST },
    saturation: 'no-method',
  },
  {
    name: 'saturation-runner-unrecorded',
    covers:
      'start の結果に runnerId が記録されていない（「runner: 未記録」・飽和を問い合わせない）',
    args: { request: REQUEST },
    start: { returns: { runnerId: undefined } },
    saturation: { basis: [{ kind: 'at-limit', current: 1, max: 1 }], windowMs: 600_000 },
  },
];

const ALL_KEYS: string[] = SCENARIOS.map((scenario) => scenario.name);

interface PinnedOutput {
  length: number;
  isError: boolean;
  thrown: boolean;
  errorName: string | null;
  calls: string[];
  journal: Record<string, unknown>[];
  tasksUnchanged: boolean;
  jobsUnchanged: boolean;
  text: string;
}

interface PinFile {
  /** 場面ごとの字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
}

function fakeAttachmentStore(scenario: Scenario): AttachmentStore {
  const seeded = new Map((scenario.attachments ?? []).map((item) => [item.id, item]));
  const metaOf = (item: SeedAttachment): AttachmentMeta => ({
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    size: item.size,
    sha256: `sha-${item.id}`,
    createdAt: AT,
  });
  const fail = scenario.attachFail ?? {};
  return {
    async getMeta(id: string) {
      if (fail.getMetaThrows === id) throw new Error('控えのストアが落ちた');
      const item = seeded.get(id);
      return item === undefined ? undefined : metaOf(item);
    },
    async get(id: string) {
      if (fail.getThrows === id) throw new Error('中身のストアが落ちた');
      if (fail.vanishes === id) return undefined;
      const item = seeded.get(id);
      if (item === undefined) return undefined;
      return {
        meta: metaOf(item),
        bytes: new TextEncoder().encode(item.text ?? 'a'.repeat(item.size)),
      };
    },
  } as unknown as AttachmentStore;
}

function labelOf(storeName: string, method: string, args: unknown[]): string {
  const detail =
    (storeName === 'tasks' && method === 'get') ||
    (storeName === 'attachments' && (method === 'getMeta' || method === 'get'))
      ? JSON.stringify(args[0])
      : '';
  return `stores.${storeName}.${method}(${detail})`;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}

async function runScenario(scenario: Scenario): Promise<PinnedOutput> {
  const calls: string[] = [];
  const base = createMemoryStores();
  for (const seeded of scenario.tasks ?? []) await base.tasks.add(seeded);
  for (const seeded of scenario.jobs ?? []) await base.jobs.putJob(seeded);
  const tasksBefore = JSON.stringify(await base.tasks.list({ includeClosed: true }));
  const jobsBefore = JSON.stringify(await base.jobs.listJobs());
  const journalBefore = (await base.journal.list({ order: 'asc' })).length;

  let appendCount = 0;
  const failAt = scenario.journalFailsAt ?? [];
  const composed = {
    ...base,
    attachments: fakeAttachmentStore(scenario),
    tasks: {
      ...base.tasks,
      get: async (id: string) => {
        if (scenario.taskGetThrows === 'unreadable')
          throw new UnreadableTaskError('行が壊れている');
        if (scenario.taskGetThrows === 'plain') throw new Error('task のストアが落ちた');
        return base.tasks.get(id);
      },
    },
    jobs: {
      ...base.jobs,
      listJobs: async () => {
        if (scenario.listJobsThrows === true) throw new Error('委譲の台帳が読めない');
        return base.jobs.listJobs();
      },
    },
    journal: {
      ...base.journal,
      append: async (entry: Parameters<typeof base.journal.append>[0]) => {
        appendCount += 1;
        if (failAt.includes(appendCount)) throw new Error('日誌のストアが落ちた');
        return base.journal.append(entry);
      },
    },
  } as unknown as ReturnType<typeof createMemoryStores>;
  const stores = new Proxy(composed, {
    get(target, storeName) {
      const store = Reflect.get(target, storeName) as unknown;
      if (typeof store !== 'object' || store === null) return store;
      return new Proxy(store, {
        get(storeTarget, method) {
          const member = Reflect.get(storeTarget, method) as unknown;
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            if (storeName === 'tasks' || storeName === 'jobs' || storeName === 'attachments') {
              calls.push(labelOf(String(storeName), String(method), args));
            } else if (storeName === 'journal' && method === 'append') {
              calls.push('stores.journal.append()');
            }
            return (member as (...a: unknown[]) => unknown).apply(storeTarget, args);
          };
        },
      });
    },
  });

  const startFake: StartFake = scenario.start ?? { returns: {} };
  const saturation = scenario.saturation ?? 'none';
  const pool = {
    async start(input: unknown) {
      calls.push(`pool.start(${sortedJson(input)})`);
      if ('throws' in startFake) throw startFake.throws;
      return {
        managerId: 'mgr-001',
        status: 'running',
        live: true,
        cwd: '/work',
        cwdConfirmed: true,
        request: REQUEST,
        startedAt: AT,
        updatedAt: AT,
        waiting: [],
        runnerId: 'runner-1',
        ...startFake.returns,
      } as ManagerSummary;
    },
    ...(saturation === 'no-method'
      ? {}
      : {
          runnerPidsSaturation(runnerId: string) {
            calls.push(`pool.runnerPidsSaturation(${runnerId})`);
            return saturation === 'none' ? undefined : saturation;
          },
        }),
  } as unknown as ManagerPool;

  const tools = createCloneTools({
    stores,
    emit: () => {
      calls.push('emit');
    },
    memoryCause: () => 'clone',
    conversationId: () => scenario.conversationId,
    ...(scenario.workConversationId === undefined
      ? {}
      : { workConversationId: () => scenario.workConversationId }),
    attachmentLimits: { ...BASE_LIMITS, ...scenario.limits },
    ...(scenario.noNote === true
      ? {}
      : {
          noteDelegationStarted: (taskId: string | undefined) => {
            calls.push(`context.noteDelegationStarted(${String(taskId)})`);
          },
        }),
    ...(scenario.noPool === true ? {} : { managers: pool }),
  });
  const found = tools.find((entry) => entry.name === 'manager_start');
  if (!found) throw new Error('manager_start が無い');

  const finish = async (
    output: Pick<PinnedOutput, 'text' | 'isError' | 'thrown' | 'errorName'>,
  ): Promise<PinnedOutput> => {
    const journal = (await base.journal.list({ order: 'asc' })).slice(journalBefore);
    return {
      length: output.text.length,
      isError: output.isError,
      thrown: output.thrown,
      errorName: output.errorName,
      calls,
      journal: JSON.parse(JSON.stringify(journal)) as Record<string, unknown>[],
      tasksUnchanged:
        JSON.stringify(await base.tasks.list({ includeClosed: true })) === tasksBefore,
      jobsUnchanged: JSON.stringify(await base.jobs.listJobs()) === jobsBefore,
      text: output.text,
    };
  };
  try {
    const result = await found.handler(scenario.args as never, {} as never);
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    return await finish({ text, isError: result.isError === true, thrown: false, errorName: null });
  } catch (error) {
    return await finish({
      text: error instanceof Error ? error.message : String(error),
      isError: true,
      thrown: true,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function runAll(): Promise<Record<string, PinnedOutput>> {
  const out: Record<string, PinnedOutput> = {};
  for (const scenario of SCENARIOS) {
    out[scenario.name] = await runScenario(scenario);
  }
  return out;
}

describe('manager_start の出力の固定（場面ごとの全文・字数・日誌・呼びの並び）', () => {
  let actual: Record<string, PinnedOutput> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    actual = await runAll();
    if (UPDATE) {
      const out: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(out, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(new Set(ALL_KEYS).size, '場面の名前が重複している').toBe(ALL_KEYS.length);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1]));
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.length);
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    const key = scenario.name;
    it(`${key} の出力・日誌・呼びが固定値と同じ（${scenario.covers}）`, () => {
      const want = pinned.scenarios[key];
      const got = actual[key];
      expect(want, `${key} が固定値に無い`).toBeDefined();
      expect(got, `${key} が実際の出力に無い`).toBeDefined();
      // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
      expect(
        got?.text.length,
        `場面 ${key} の字数が変わった: 固定値 ${String(want?.length)} 字 → いま ${String(got?.text.length)} 字`,
      ).toBe(want?.length);
      expect(
        got?.text,
        `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.text.length)} 字で同じ）`,
      ).toBe(want?.text);
      expect(
        { isError: got?.isError, thrown: got?.thrown, errorName: got?.errorName },
        `場面 ${key} の isError／例外で返ったか／例外の名前が変わった`,
      ).toEqual({
        isError: want?.isError,
        thrown: want?.thrown,
        errorName: want?.errorName,
      });
      expect(
        got?.journal.length,
        `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
      ).toBe(want?.journal.length);
      expect(got?.journal, `場面 ${key} の日誌に足された行の中身がずれた`).toEqual(want?.journal);
      expect(got?.calls, `場面 ${key} のストア・pool・コールバックへの呼びの並びがずれた`).toEqual(
        want?.calls,
      );
      expect(
        { tasksUnchanged: got?.tasksUnchanged, jobsUnchanged: got?.jobsUnchanged },
        `場面 ${key} の task／委譲の台帳の書き込みの有無が変わった`,
      ).toEqual({ tasksUnchanged: want?.tasksUnchanged, jobsUnchanged: want?.jobsUnchanged });
    });
  });

  it('同じ入力で2回回すと、全場面で同じ出力・日誌・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('この道具は task・委譲の台帳へ書かない（全場面で呼ぶ前と同じ）', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.tasksUnchanged, `${key}: task の台帳が変わった`).toBe(true);
      expect(actual[key]?.jobsUnchanged, `${key}: 委譲の台帳が変わった`).toBe(true);
      expect(actual[key]?.calls, `${key}: emit した`).not.toContain('emit');
    }
  });

  it('start を呼ばない場面では、日誌は先の日誌の1回の試みまでで、note も飽和の問い合わせも無い（断る・先の日誌の失敗）', () => {
    const refusals = ALL_KEYS.filter(
      (key) => !(actual[key]?.calls ?? []).some((call) => call.startsWith('pool.start(')),
    );
    expect(refusals.length).toBeGreaterThanOrEqual(25);
    for (const key of refusals) {
      const calls = actual[key]?.calls ?? [];
      expect(actual[key]?.journal, `${key}: start を呼ばないのに日誌に行が足された`).toEqual([]);
      expect(
        calls.filter((call) => call === 'stores.journal.append()').length,
        `${key}: 先の日誌の試みが 1 回を超えた`,
      ).toBeLessThanOrEqual(1);
      expect(
        calls.some((call) => call.startsWith('context.') || call.startsWith('pool.runner')),
        `${key}: 起こしていないのに note／飽和の問い合わせを呼んだ`,
      ).toBe(false);
    }
  });

  it('start を呼ぶ場面では、先の日誌が start より前に試され、起こした日誌と note は start の後（日誌を先に書く順）', () => {
    for (const key of ALL_KEYS) {
      const calls = actual[key]?.calls ?? [];
      const startAt = calls.findIndex((call) => call.startsWith('pool.start('));
      if (startAt < 0) continue;
      expect(calls[startAt - 1], `${key}: start の直前が先の日誌の追記でない`).toBe(
        'stores.journal.append()',
      );
      expect(
        calls.slice(0, startAt).filter((call) => call === 'stores.journal.append()'),
        `${key}: start の前の日誌の追記が 1 回でない`,
      ).toHaveLength(1);
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    const calls = (key: string): string[] => actual[key]?.calls ?? [];
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const started = (key: string): boolean =>
      calls(key).some((call) => call.startsWith('pool.start('));
    const startCall = (key: string): string =>
      calls(key).find((call) => call.startsWith('pool.start(')) ?? '';
    const decisions = (key: string): string[] =>
      journal(key).map((entry) => String(entry.decision));
    // pool
    expect(text('no-pool')).toContain('いまは委譲できない場面');
    expect(calls('no-pool')).toEqual([]);
    expect(text('no-pool-empty-request')).toContain('いまは委譲できない場面');
    // request
    expect(text('request-empty')).toContain('起こしていない。');
    expect(text('request-nul-only')).toBe(text('request-empty'));
    expect(text('request-whitespace')).toContain('request が空白だけなので起こしていない');
    expect(text('request-fullwidth-space')).toContain('request が空白だけ');
    expect(text('request-whitespace-nul')).toContain('request が空白だけ');
    expect(calls('request-empty-with-task')).toEqual([]);
    expect(started('request-with-nul-inside')).toBe(true);
    expect(startCall('request-with-nul-inside')).toContain('前\\u0000後');
    // 日誌の側は NUL を落として記録する（道具は素の request を渡し、ストアが落とす）
    expect(decisions('request-with-nul-inside')[0]).toBe('マネージャーを起こそうとしている: 前後');
    // task
    expect(calls('task-missing')).toEqual(['stores.tasks.get("t-ghost")']);
    expect(text('task-missing')).toContain('task t-ghost は無い');
    expect(calls('task-empty-string')).toEqual(['stores.tasks.get("")']);
    expect(text('task-unreadable')).toContain('読めない形で入っている');
    expect(actual['task-get-throws-plain']?.thrown).toBe(true);
    expect(calls('task-done')).toEqual(['stores.tasks.get("t-1")']);
    expect(text('task-done')).toContain('閉じている（done）');
    expect(text('task-cancelled')).toContain('閉じている（cancelled）');
    expect(calls('task-done-with-running-job')).toEqual(['stores.tasks.get("t-1")']);
    expect(calls('task-running-one')).toEqual([
      'stores.tasks.get("t-1")',
      'stores.jobs.listJobs()',
    ]);
    expect(text('task-running-one')).toContain('走っている委譲がある（mgr-run: running）。');
    expect(text('task-running-one-waiting-human')).toContain('mgr-ask: waiting_human');
    expect(text('task-running-many')).toContain('mgr-run: running、mgr-ask: waiting_human');
    expect(text('task-running-many')).not.toContain('mgr-done');
    expect(text('task-running-many')).not.toContain('mgr-other');
    expect(started('task-only-settled-jobs')).toBe(true);
    expect(startCall('task-only-settled-jobs')).toContain('"taskId":"t-1"');
    expect(calls('task-only-settled-jobs')).toContain('context.noteDelegationStarted(t-1)');
    expect(started('task-queued-ok')).toBe(true);
    expect(started('task-waiting-no-jobs-ok')).toBe(true);
    expect(actual['jobs-list-throws']?.thrown).toBe(true);
    expect(journal('jobs-list-throws')).toEqual([]);
    // 添付
    expect(startCall('attach-empty-array')).not.toContain('attachments');
    expect(decisions('attach-empty-array')[0]).not.toContain('添付');
    expect(startCall('attach-one-small')).toContain('"data":"YWFhYWE="');
    expect(decisions('attach-one-small')[0]).toContain('（添付 1 件を渡す: att-1 build.log）');
    expect(
      calls('attach-dup-ids').filter((call) => call.startsWith('stores.attachments.')),
    ).toEqual(['stores.attachments.getMeta("att-1")', 'stores.attachments.get("att-1")']);
    expect(decisions('attach-two-small')[0]).toContain('att-1 a.log, att-2 b.log');
    expect(startCall('attach-large-staged')).toContain('"staged":true');
    expect(calls('attach-large-staged')).not.toContain('stores.attachments.get("att-big")');
    expect(calls('attach-mixed-staged-and-small')).toContain('stores.attachments.get("att-1")');
    expect(calls('attach-mixed-staged-and-small')).not.toContain(
      'stores.attachments.get("att-big")',
    );
    expect(text('attach-missing')).toContain('att-gone, att-gone-2');
    expect(calls('attach-missing')).toContain('stores.attachments.getMeta("att-gone-2")');
    expect(calls('attach-missing-with-task')[0]).toBe('stores.tasks.get("t-1")');
    expect(text('attach-getmeta-throws')).toContain('添付 att-1 の控えを読めなかった');
    expect(text('attach-get-throws')).toContain('添付 att-1 の中身を読めなかった');
    expect(text('attach-vanishes-while-reading')).toContain('読む間に消えた');
    expect(text('attach-too-many')).toContain('1 発言に添えられるのは 3 個まで');
    expect(text('attach-total-too-large')).toContain('合計');
    expect(started('attach-large-not-counted-in-total')).toBe(true);
    // 日誌が書けない
    expect(actual['journal-fails-first']?.errorName).toBe('JournalNotRecordedError');
    expect(started('journal-fails-first')).toBe(false);
    expect(started('journal-fails-first-with-task-and-attach')).toBe(false);
    expect(calls('journal-fails-first-with-task-and-attach')).toContain(
      'stores.attachments.get("att-1")',
    );
    expect(actual['journal-fails-started']?.thrown).toBe(false);
    expect(calls('journal-fails-started')).toContain('context.noteDelegationStarted(t-1)');
    expect(journal('journal-fails-started')).toHaveLength(1);
    expect(text('journal-fails-started-with-saturation')).toContain(
      '⚠ 置き先の runner は pids 飽和',
    );
    expect(
      calls('journal-fails-both-appends').filter((c) => c === 'stores.journal.append()'),
    ).toHaveLength(1);
    expect(text('journal-fails-failure-entry-refused')).toBe(
      'ManagerAttachmentsRefusedError: runner が添付を受け取れない。マネージャーは起こしていない。',
    );
    expect(actual['journal-fails-failure-entry-throws']?.text).toBe('runner が落ちた');
    expect(journal('journal-fails-failure-entry-throws')).toHaveLength(1);
    // start の失敗
    expect(text('start-refused')).toBe(
      'ManagerAttachmentsRefusedError: runner-old は添付の受け渡しを名乗っていない。マネージャーは起こしていない。',
    );
    expect(decisions('start-refused')[1]).toContain(
      'マネージャーを起こせなかった（指名: runnerId=runner-old）',
    );
    expect(journal('start-refused')[1]?.grounds).toBe(
      '委譲しようとしたが、状態の変更が失敗した: ManagerAttachmentsRefusedError: runner-old は添付の受け渡しを名乗っていない',
    );
    expect(calls('start-refused').some((call) => call.startsWith('context.'))).toBe(false);
    expect(actual['start-throws-plain']?.thrown).toBe(true);
    expect(journal('start-throws-plain')).toHaveLength(2);
    expect(calls('start-throws-plain').some((call) => call.startsWith('context.'))).toBe(false);
    expect(actual['start-throws-string']?.thrown).toBe(true);
    expect(actual['start-throws-string']?.errorName).toBe('string');
    expect(journal('start-throws-string')[1]?.grounds).toContain('文字列で投げた');
    // 引数
    expect(startCall('args-minimal')).toBe(`pool.start({"request":"${REQUEST}"})`);
    expect(startCall('arg-cwd-confirmed')).toContain('"cwd":"/work/sub"');
    expect(text('arg-cwd-confirmed')).toContain('（cwd: /work/sub、');
    expect(text('arg-cwd-unconfirmed')).toContain('実際の cwd は未確認（頼んだ値: /work/sub）');
    expect(text('arg-cwd-unconfirmed-with-requested')).toContain(
      '実際の cwd は未確認（頼んだ値: /work）',
    );
    expect(text('arg-cwd-replaced')).toContain(
      '頼んだ cwd（/work/ghost）はこの器に無かったので、/work で開いた',
    );
    expect(startCall('arg-runner-id')).toContain('"runnerId":"runner-2"');
    expect(decisions('arg-runner-id')[0]).toContain('（指名: runnerId=runner-2）');
    expect(decisions('arg-runner-id')[1]).toContain(', 指名: runnerId=runner-2）');
    expect(startCall('arg-supersedes')).toContain('"supersedes":"mgr-old"');
    expect(startCall('arg-conversation-id')).toContain('"conversationId":"conv-reply"');
    expect(startCall('arg-work-conversation-id')).toContain('"conversationId":"conv-work"');
    expect(startCall('args-all')).toContain('"conversationId":"conv-1"');
    expect(decisions('args-all')[0]).toContain('（指名: runnerId=runner-2）（添付 2 件を渡す:');
    // note
    expect(started('note-missing')).toBe(true);
    expect(calls('note-missing').some((call) => call.startsWith('context.'))).toBe(false);
    expect(calls('note-without-task')).toContain('context.noteDelegationStarted(undefined)');
    // 飽和
    expect(text('saturation-at-limit')).toContain('pids 100/100 で上限に達している');
    expect(text('saturation-signs')).toContain('直近15分に spawn が EAGAIN で失敗 2 回');
    expect(text('saturation-signs')).toContain('直近15分に fork が pids 上限で拒まれた委譲 1 本');
    expect(calls('saturation-none')).toContain('pool.runnerPidsSaturation(runner-1)');
    expect(text('saturation-none')).not.toContain('⚠');
    expect(calls('saturation-no-method').some((call) => call.startsWith('pool.runner'))).toBe(
      false,
    );
    expect(text('saturation-no-method')).not.toContain('⚠');
    expect(text('saturation-runner-unrecorded')).toContain('runner: 未記録');
    expect(
      calls('saturation-runner-unrecorded').some((call) => call.startsWith('pool.runner')),
    ).toBe(false);
  });
});
