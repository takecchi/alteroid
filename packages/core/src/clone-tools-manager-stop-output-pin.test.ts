import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ManagerAbortResult, ManagerPool, ManagerSummary } from './manager.js';
import type { ManagerUnpushedWork } from './unpushed-work-observation.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_stop` の出力（全文・字数・エラーか・例外で返ったか）と、pool・ストア・emit への呼びの並びを、場面ごとにコミットした固定値
// （clone-tools-manager-stop-output-pin.json）と丸ごと比べる。
// `clone-tools-manager-stop.ts` の `managerStopTool`（ハンドラ約 159 行・入れ子 5 段の式）を小さな関数へ分けるとき、
// 出力と呼びが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MANAGER_STOP_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-manager-stop-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-manager-stop-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの場面が何字を出しているかを見る基準）。
// 各場面の `calls` は、道具が pool（list・unpushedWork・abort）・ストア・emit へ出した呼びの並び:
//   - `pool.list`: 一覧の読み（止める前・止めた後）
//   - `pool.unpushedWork(<id>,source=…,signal=…)`: 走行中を断るときの未 push の調べ（渡した source と signal の有無・開始時に中断済みでないか）
//   - `pool.abort(<id>,reason=…,by=…)`: 止める呼び。断る場面では現れない（走行中を既定で断る守りの歯）
//   - `stores.…`・`emit`: この道具が直接書くなら現れる（書かないことの固定。`abort` の中の書き込みは偽の pool の側なので対象外）
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 未 push の調べの「時間切れ」は、実際の 5 秒待ちを避け、偽の pool が `AbortSignal.timeout` が出す `TimeoutError` を投げて作る
// （道具の側の `.catch` が例外を「確かめられなかった」へ畳む分岐は同じ）。

type Args = Record<string, unknown>;

/** 一覧の1回の読み: 並び、または読めなかった（例外） */
type ListRead = ManagerSummary[] | Error;

/** 偽の pool の未 push の調べ: 結果、または投げる値 */
type UnpushedFake = { returns: ManagerUnpushedWork } | { throws: unknown };

/** 偽の pool の abort: 結果、または投げる例外 */
type AbortFake = { returns: ManagerAbortResult } | { throws: Error };

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  args: Args;
  /** 真なら pool を渡さない */
  noPool?: boolean;
  /** `pool.list` の呼び順に返す（足りない分は最後の値の繰り返し）。省略は [mgr()] 1本 */
  lists?: ListRead[];
  unpushed?: UnpushedFake;
  abort?: AbortFake;
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const PIN_URL = new URL('./clone-tools-manager-stop-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MANAGER_STOP_PIN === '1';

function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

function mgr(extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: 'mgr-001',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼文。短い依頼。',
    startedAt: iso(1),
    updatedAt: iso(60),
    waiting: [],
    runnerId: 'runner-1',
    lastReport: '報告。終わった。',
    lastReportAt: iso(60),
    lastReportStatus: 'done',
    ...extra,
  };
}

const other = (): ManagerSummary =>
  mgr({ managerId: 'mgr-002', status: 'running', live: true, request: '隣の依頼' });

const MGR = 'mgr-001';

const stopped = (detail = '停止した。セッションは閉じた。'): { returns: ManagerAbortResult } => ({
  returns: { outcome: 'stopped', detail },
});

const ok = (result: {
  worktrees?: Extract<ManagerUnpushedWork, { kind: 'ok' }>['result']['worktrees'];
  truncatedAtCount?: number;
  stoppedEarly?: true;
  scratchRootsUnknown?: string;
  unreadableDirCount?: number;
}): { returns: ManagerUnpushedWork } => ({
  returns: { kind: 'ok', result: { cwd: '/workspace/repo', worktrees: [], ...result } },
});

const worktreeFull = {
  relativePath: '.',
  branch: 'feat/example',
  unpushedCommitCount: 3,
  uncommittedChangeCount: 2,
};
const worktreeUnknown = {
  relativePath: 'sub',
  branch: null,
  unpushedCommitCountUnknown: 'git が起こせなかった',
  uncommittedChangeCountUnknown: '',
};
const worktreeNoReason = { relativePath: '/tmp/scratch-1', branch: 'wip' };

const SCENARIOS: Scenario[] = [
  // --- pool が無い
  {
    name: 'no-pool',
    covers: 'pool が無い（NO_POOL。pool にもストアにも触れない）',
    args: { managerId: MGR },
    noPool: true,
  },
  {
    name: 'no-pool-force',
    covers: 'pool が無い・force:true でも同じ',
    args: { managerId: MGR, force: true, reason: '要らない' },
    noPool: true,
  },
  // --- 止める前の一覧が読めない
  {
    name: 'list-unreadable-refuse',
    covers: '止める前の一覧が読めない・force なし → 断る（abort を呼ばない）',
    args: { managerId: MGR },
    lists: [new Error('台帳が読めない: ENOENT')],
  },
  {
    name: 'list-unreadable-refuse-force-false',
    covers:
      '止める前の一覧が読めない・force:false を明示 → 断る（reason が在っても abort を呼ばない）',
    args: { managerId: MGR, force: false, reason: '暴走' },
    lists: [new Error('台帳が読めない: EIO')],
  },
  {
    name: 'list-unreadable-force-stopped',
    covers: '止める前の一覧が読めない・force あり → 止めに進む。止めた後の一覧は読めた',
    args: { managerId: MGR, force: true, reason: '暴走' },
    lists: [new Error('台帳が読めない'), [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
  {
    name: 'list-unreadable-force-stopped-after-unreadable',
    covers: '止める前も止めた後も一覧が読めない・force あり・止まった',
    args: { managerId: MGR, force: true },
    lists: [new Error('前に読めない'), new Error('後も読めない')],
    abort: stopped(),
  },
  {
    name: 'list-unreadable-force-absent',
    covers: '止める前の一覧が読めない・force あり・abort が absent（居ないと言い切らない）',
    args: { managerId: MGR, force: true },
    lists: [new Error('台帳が読めない')],
    abort: { returns: { outcome: 'absent', detail: `${MGR} というマネージャーは居ない。` } },
  },
  {
    name: 'list-unreadable-force-unreadable',
    covers: '止める前の一覧が読めない・force あり・abort が unreadable',
    args: { managerId: MGR, force: true },
    lists: [new Error('台帳が読めない')],
    abort: { returns: { outcome: 'unreadable', detail: '台帳の行が壊れている。送っていない。' } },
  },
  {
    name: 'list-unreadable-force-not-stopped',
    covers: '止める前の一覧が読めない・force あり・not_stopped・止めた後は一覧に居る',
    args: { managerId: MGR, force: true },
    lists: [new Error('台帳が読めない'), [mgr({ status: 'running', live: true })]],
    abort: { returns: { outcome: 'not_stopped', detail: 'stop の応答が無かった。' } },
  },
  // --- 居ない id
  {
    name: 'absent-id-abort-absent',
    covers: '一覧に居ない id（隣は居る）・abort が absent → 「居ない」',
    args: { managerId: MGR },
    lists: [[other()]],
    abort: { returns: { outcome: 'absent', detail: `${MGR} というマネージャーは居ない。` } },
  },
  {
    name: 'absent-id-abort-stopped',
    covers:
      '一覧に居ない id・abort は止めたと言う・止めた後も一覧に居ない（done の言い分けは出ない）',
    args: { managerId: MGR, reason: '掃除' },
    lists: [[other()]],
    abort: stopped('止めた（台帳の行だけ）。'),
  },
  {
    name: 'absent-ledger-done',
    covers: '一覧に居るが live でない（done）・abort が absent → 「台帳では done で…live: false」',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done', live: false })]],
    abort: { returns: { outcome: 'absent', detail: '器が見つからない。' } },
  },
  {
    name: 'absent-ledger-failed-force',
    covers: '一覧に居るが live でない（failed）・force:true・abort が absent',
    args: { managerId: MGR, force: true },
    lists: [[mgr({ status: 'failed', live: false })]],
    abort: { returns: { outcome: 'absent', detail: '器が見つからない。' } },
  },
  // --- running を force なしで断る（直近の報告・未 push の調べ）
  {
    name: 'refuse-running-empty-observed',
    covers:
      'running・force なし・直近の報告あり・未 push の調べが ok で作業ツリーが空（git の文を出さない）。隣のマネージャーが一覧に居る',
    args: { managerId: MGR },
    lists: [[other(), mgr({ lastReportAt: iso(30) })]],
    unpushed: ok({}),
  },
  {
    name: 'refuse-running-no-report-empty-observed',
    covers: 'running・force なし・直近の報告が一度も届いていない・調べは空',
    args: { managerId: MGR },
    lists: [[mgr({ lastReport: undefined, lastReportAt: undefined })]],
    unpushed: ok({}),
  },
  {
    name: 'refuse-running-force-false',
    covers:
      'running・force:false を明示・reason が在る（断る・abort を呼ばない・reason は使わない）',
    args: { managerId: MGR, force: false, reason: '暴走している' },
    lists: [[mgr()]],
    unpushed: ok({}),
  },
  {
    name: 'refuse-observed-worktrees',
    covers:
      'running・未 push の調べに作業ツリーが3本（全部取れた・全部取れず枝 null・理由が空/枝だけ）。末尾の安全側の注意のみ',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({ worktrees: [worktreeFull, worktreeUnknown, worktreeNoReason] }),
  },
  {
    name: 'refuse-observed-all-notes',
    covers:
      'running・作業ツリーあり・件数打ち切り・期限切れ・/tmp 起点不明・子ディレクトリ読み失敗の注記を全部（順序の固定）',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({
      worktrees: [worktreeFull],
      truncatedAtCount: 50,
      stoppedEarly: true,
      scratchRootsUnknown: 'EACCES: /tmp',
      unreadableDirCount: 4,
    }),
  },
  {
    name: 'refuse-observed-empty-scratch-unknown',
    covers:
      'running・作業ツリーが空だが /tmp 起点が確かめられていない（空でも git の文を出す・確認できていない）',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({ scratchRootsUnknown: 'EACCES: /tmp' }),
  },
  {
    name: 'refuse-observed-empty-unreadable-dirs',
    covers: 'running・作業ツリーが空だが子ディレクトリの読み失敗が在る',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({ unreadableDirCount: 2 }),
  },
  {
    name: 'refuse-observed-empty-both-unknown',
    covers: 'running・作業ツリーが空・/tmp 起点不明と子ディレクトリ読み失敗の両方',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({ scratchRootsUnknown: 'EACCES: /tmp', unreadableDirCount: 2 }),
  },
  {
    name: 'refuse-observed-empty-truncated',
    covers:
      'running・作業ツリーが空で truncatedAtCount だけ（不完全と判定されるので git の文は出るが、describe は「見つからなかった」と言い切る）',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({ truncatedAtCount: 10 }),
  },
  {
    name: 'refuse-observed-empty-stopped-early',
    covers: 'running・作業ツリーが空で stoppedEarly だけ（同上）',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: ok({ stoppedEarly: true }),
  },
  {
    name: 'refuse-unavailable',
    covers: 'running・未 push の調べが unavailable（確かめられなかった・git の文を出す）',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: { returns: { kind: 'unavailable', reason: '宛先の runner がいま開いていない。' } },
  },
  {
    name: 'refuse-unpushed-throws-error',
    covers: 'running・未 push の調べが Error で reject（捕まえて unavailable に畳む）',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: { throws: new Error('runner との往復が切れた') },
  },
  {
    name: 'refuse-unpushed-timeout',
    covers: 'running・未 push の調べが時間切れ（TimeoutError）で reject',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: {
      throws: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    },
  },
  {
    name: 'refuse-unpushed-throws-string',
    covers: 'running・未 push の調べが Error でない値（文字列）で reject',
    args: { managerId: MGR },
    lists: [[mgr()]],
    unpushed: { throws: '文字列で投げた' },
  },
  // --- running を force で止める
  {
    name: 'force-running-stopped',
    covers:
      'running・force:true・reason あり → 未 push の調べに行かず止める。止まった・止めた後は stopped・畳んだターンの本文なし',
    args: { managerId: MGR, force: true, reason: '依頼が要らなくなった' },
    lists: [[mgr()], [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
  {
    name: 'force-running-stopped-reasonless-folded',
    covers:
      'running・force:true・reason なし・止まった・止めた後に畳んだターンの本文が届いている（空白を畳み 240 字で切る）',
    args: { managerId: MGR, force: true },
    lists: [
      [mgr()],
      [
        mgr({
          status: 'stopped',
          live: false,
          lastFoldedTurn: {
            text: `畳んだ\n本文。   ${'長い文章です。'.repeat(60)}`,
            at: iso(70),
          },
        }),
      ],
    ],
    abort: stopped('止めた。'),
  },
  {
    name: 'force-running-absent',
    covers: 'running・force:true・abort が absent（台帳では running だが live: false の言い分け）',
    args: { managerId: MGR, force: true },
    lists: [[mgr({ live: false })]],
    abort: { returns: { outcome: 'absent', detail: '器が消えた。' } },
  },
  {
    name: 'force-running-not-stopped-still-running',
    covers:
      'running・force:true・not_stopped・止めた後も running で背景処理待ち（describeManagerState の awaitingBackground）',
    args: { managerId: MGR, force: true },
    lists: [
      [mgr()],
      [
        mgr({
          awaitingBackground: { tasks: 2, withheldReports: 1, breakdown: 'bash×2', since: iso(20) },
        }),
      ],
    ],
    abort: { returns: { outcome: 'not_stopped', detail: 'セッションが残った。' } },
  },
  {
    name: 'force-running-unknown',
    covers: 'running・force:true・abort が unknown（止めた後の一覧は読むが、文には使わない）',
    args: { managerId: MGR, force: true },
    lists: [[mgr()]],
    abort: { returns: { outcome: 'unknown', detail: 'runner の応答が無かった。' } },
  },
  {
    name: 'force-running-unreadable',
    covers: 'running・force:true・abort が unreadable',
    args: { managerId: MGR, force: true, reason: 'x' },
    lists: [[mgr()]],
    abort: { returns: { outcome: 'unreadable', detail: '台帳の行が読めない。送っていない。' } },
  },
  {
    name: 'force-running-abort-throws',
    covers: 'running・force:true・abort が例外（道具は握り潰さず、そのまま例外で返る）',
    args: { managerId: MGR, force: true },
    lists: [[mgr()]],
    abort: { throws: new Error('runner が落ちた') },
  },
  // --- running 以外の状態（force なしでも abort へ進む）
  {
    name: 'waiting-human-no-force',
    covers: 'waiting_human・force なし → 断らず止める（クローン自身が立てた問いのため）',
    args: { managerId: MGR, reason: '問いが要らない' },
    lists: [[mgr({ status: 'waiting_human' })], [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
  {
    name: 'done-no-force-stopped',
    covers:
      'done・force なし・止まった → 「もともと待機中（done）」の言い分け・止めた後は stopped・畳んだターン無し',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done', live: true })], [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
  {
    name: 'done-force-stopped-after-unreadable',
    covers:
      'done・force:true・止まった・止めた後の一覧が読めない（done の言い分けと読めなかった注記）',
    args: { managerId: MGR, force: true },
    lists: [[mgr({ status: 'done' })], new Error('後で読めない')],
    abort: stopped(),
  },
  {
    name: 'done-stopped-after-vanished',
    covers: 'done・止まった・止めた後の一覧から消えている',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })], [other()]],
    abort: stopped(),
  },
  {
    name: 'failed-no-force-stopped',
    covers: 'failed・force なし・止まった（done の言い分けは出ない）',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'failed', live: false })], [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
  {
    name: 'lost-no-force-stopped',
    covers: 'lost・force なし・止まった・止めた後に畳んだターンの本文あり',
    args: { managerId: MGR, reason: '行方不明' },
    lists: [
      [mgr({ status: 'lost', live: false })],
      [
        mgr({
          status: 'stopped',
          live: false,
          lastFoldedTurn: { text: '最後の発言。', at: iso(61) },
        }),
      ],
    ],
    abort: stopped(),
  },
  {
    name: 'stopped-no-force-stopped',
    covers: 'stopped（すでに止まっている）・force なし・止まった',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'stopped', live: false })]],
    abort: stopped('すでに止まっていた。'),
  },
  // --- abort の各結果
  {
    name: 'abort-unreadable-done',
    covers: 'abort が unreadable（読めない行を「居ない」と言わない）。止めた後の一覧は読まない',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })]],
    abort: { returns: { outcome: 'unreadable', detail: '台帳の行が壊れている。送っていない。' } },
  },
  {
    name: 'abort-unknown-done',
    covers: 'abort が unknown（止まったかは未確認）。止めた後の一覧は読むが文には使わない',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })]],
    abort: { returns: { outcome: 'unknown', detail: 'runner が開いていない。' } },
  },
  {
    name: 'abort-not-stopped-after-found-live',
    covers: 'not_stopped・止めた後も居る（live: true・背景処理待ちなし）',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })], [mgr({ status: 'done', live: true })]],
    abort: { returns: { outcome: 'not_stopped', detail: 'セッションが残った。' } },
  },
  {
    name: 'abort-not-stopped-after-found-disconnected',
    covers: 'not_stopped・止めた後は居るが live: false（セッション切断）',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })], [mgr({ status: 'stopped', live: false })]],
    abort: { returns: { outcome: 'not_stopped', detail: 'セッションが残った。' } },
  },
  {
    name: 'abort-not-stopped-after-vanished',
    covers: 'not_stopped・止めた後の一覧から消えている',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })], [other()]],
    abort: { returns: { outcome: 'not_stopped', detail: 'セッションが残った。' } },
  },
  {
    name: 'abort-not-stopped-after-unreadable',
    covers: 'not_stopped・止めた後の一覧が読めない（消えているとは言わない）',
    args: { managerId: MGR },
    lists: [[mgr({ status: 'done' })], new Error('止めた後に読めない')],
    abort: { returns: { outcome: 'not_stopped', detail: 'セッションが残った。' } },
  },
  {
    name: 'stopped-after-folded-turn-short',
    covers:
      '止まった・止めた後に畳んだターンの本文が短く在る（抜粋の切り詰めなし）・背景処理待ちで since なし相当',
    args: { managerId: MGR, reason: '終わり' },
    lists: [
      [mgr({ status: 'done' })],
      [
        mgr({
          status: 'stopped',
          live: true,
          lastFoldedTurn: { text: '短い本文。', at: iso(75) },
          awaitingBackground: { tasks: 1, withheldReports: 0, breakdown: 'bash', since: iso(20) },
        }),
      ],
    ],
    abort: stopped('止めた。日誌に残した。'),
  },
  {
    name: 'stopped-after-unreadable-running-before',
    covers: '止まった・force:true の running・止めた後の一覧が読めない（done の言い分けは出ない）',
    args: { managerId: MGR, force: true },
    lists: [[mgr()], new Error('後で読めない')],
    abort: stopped(),
  },
  {
    name: 'stopped-after-vanished-running-before',
    covers: '止まった・force:true の running・止めた後の一覧から消えている',
    args: { managerId: MGR, force: true },
    lists: [[mgr()], [other()]],
    abort: stopped(),
  },
  {
    name: 'reason-empty-string',
    covers: 'reason が空文字（そのまま abort へ渡る。undefined と区別される）',
    args: { managerId: MGR, reason: '', force: true },
    lists: [[mgr()], [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
  {
    name: 'reason-multiline',
    covers: 'reason が改行・長文（そのまま abort へ渡る）',
    args: { managerId: MGR, reason: `一行目\n二行目 ${'あ'.repeat(30)}` },
    lists: [[mgr({ status: 'waiting_human' })], [mgr({ status: 'stopped', live: false })]],
    abort: stopped(),
  },
];

const ALL_KEYS: string[] = SCENARIOS.map((scenario) => scenario.name);

interface PinnedOutput {
  length: number;
  isError: boolean;
  thrown: boolean;
  errorName: string | null;
  calls: string[];
  text: string;
}

interface PinFile {
  /** 場面ごとの字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
}

// ストアは丸ごと包み、呼ばれた口をすべて記録する（この道具が書き込まないことの固定）
function recordStores(calls: string[]): ReturnType<typeof createMemoryStores> {
  const stores = createMemoryStores();
  return new Proxy(stores, {
    get(target, storeName) {
      const store = Reflect.get(target, storeName) as unknown;
      if (typeof store !== 'object' || store === null) return store;
      return new Proxy(store, {
        get(storeTarget, method) {
          const member = Reflect.get(storeTarget, method) as unknown;
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            calls.push(`stores.${String(storeName)}.${String(method)}`);
            return (member as (...a: unknown[]) => unknown).apply(storeTarget, args);
          };
        },
      });
    },
  });
}

async function runScenario(scenario: Scenario): Promise<PinnedOutput> {
  const calls: string[] = [];
  const stores = recordStores(calls);
  const lists = scenario.lists ?? [[mgr()]];
  let listCount = 0;
  const pool = {
    async list() {
      calls.push('pool.list');
      const read = lists[Math.min(listCount, lists.length - 1)];
      listCount += 1;
      if (read instanceof Error) throw read;
      return (read ?? []).map((manager) => ({ ...manager }));
    },
    async unpushedWork(
      managerId: string,
      options?: { signal?: AbortSignal; source?: string },
    ): Promise<ManagerUnpushedWork> {
      const signal = options?.signal;
      calls.push(
        `pool.unpushedWork(${managerId},source=${String(options?.source)},signal=${
          signal instanceof AbortSignal ? `AbortSignal(aborted=${String(signal.aborted)})` : 'none'
        })`,
      );
      const fake = scenario.unpushed;
      if (fake === undefined) throw new Error('この場面では未 push の調べは呼ばれないはず');
      if ('throws' in fake) throw fake.throws;
      return fake.returns;
    },
    async abort(managerId: string, reason?: string, by?: string): Promise<ManagerAbortResult> {
      calls.push(`pool.abort(${managerId},reason=${JSON.stringify(reason)},by=${String(by)})`);
      const fake = scenario.abort;
      if (fake === undefined) throw new Error('この場面では abort は呼ばれないはず');
      if ('throws' in fake) throw fake.throws;
      return fake.returns;
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores,
    emit: () => {
      calls.push('emit');
    },
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.noPool === true ? {} : { managers: pool }),
  });
  const found = tools.find((entry) => entry.name === 'manager_stop');
  if (!found) throw new Error('manager_stop が無い');
  try {
    const result = await found.handler(scenario.args as never, {} as never);
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    return {
      length: text.length,
      isError: result.isError === true,
      thrown: false,
      errorName: null,
      calls,
      text,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      length: text.length,
      isError: true,
      thrown: true,
      errorName: error instanceof Error ? error.name : 'unknown',
      calls,
      text,
    };
  }
}

async function runAll(): Promise<Record<string, PinnedOutput>> {
  const out: Record<string, PinnedOutput> = {};
  for (const scenario of SCENARIOS) {
    out[scenario.name] = await runScenario(scenario);
  }
  return out;
}

describe('manager_stop の出力の固定（場面ごとの全文・字数・呼びの並び）', () => {
  let actual: Record<string, PinnedOutput> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
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
    it(`${key} の出力と呼びが固定値と同じ（${scenario.covers}）`, () => {
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
      expect(got?.calls, `場面 ${key} の pool・ストア・emit への呼びの並びがずれた`).toEqual(
        want?.calls,
      );
    });
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('この道具は直接書かない（ストアの呼び・emit は全場面で無い）', () => {
    for (const key of ALL_KEYS) {
      for (const call of actual[key]?.calls ?? []) {
        expect(call.startsWith('stores.'), `${key}: ストアへ ${call} を呼んだ`).toBe(false);
        expect(call, `${key}: emit した`).not.toBe('emit');
      }
    }
  });

  it('断る場面では abort が呼ばれない（走行中を既定で断る守り・一覧が読めない回も同じ）', () => {
    const refusals = ALL_KEYS.filter((key) => key.startsWith('refuse-') || key.includes('-refuse'));
    expect(refusals.length).toBeGreaterThanOrEqual(14);
    for (const key of refusals) {
      expect(
        (actual[key]?.calls ?? []).some((call) => call.startsWith('pool.abort(')),
        `${key}: 断る場面なのに abort を呼んだ`,
      ).toBe(false);
      expect(actual[key]?.text, `${key}: 断りの文でない`).toContain('止めていない');
    }
    // 断らない場面は abort を1回だけ呼ぶ（pool が無い場面を除く）
    for (const key of ALL_KEYS) {
      if (refusals.includes(key) || key.startsWith('no-pool')) continue;
      expect(
        (actual[key]?.calls ?? []).filter((call) => call.startsWith('pool.abort(')).length,
        `${key}: abort の呼びが1回でない`,
      ).toBe(1);
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    const calls = (key: string): string[] => actual[key]?.calls ?? [];
    // pool
    expect(text('no-pool')).toContain('いまは委譲できない場面');
    expect(calls('no-pool')).toEqual([]);
    expect(text('no-pool-force')).toContain('いまは委譲できない場面');
    // 一覧が読めない
    expect(calls('list-unreadable-refuse')).toEqual(['pool.list']);
    expect(text('list-unreadable-refuse')).toContain('一覧から読めなかった');
    expect(text('list-unreadable-refuse')).toContain('台帳が読めない: ENOENT');
    expect(calls('list-unreadable-refuse-force-false')).toEqual(['pool.list']);
    expect(calls('list-unreadable-force-stopped')).toEqual([
      'pool.list',
      `pool.abort(${MGR},reason="暴走",by=clone)`,
      'pool.list',
    ]);
    expect(calls('list-unreadable-force-stopped')).not.toContainEqual(
      expect.stringMatching(/^pool\.unpushedWork/u),
    );
    expect(text('list-unreadable-force-stopped-after-unreadable')).toContain(
      '止めた後の状態を一覧から読めなかった（Error: 後も読めない）',
    );
    expect(text('list-unreadable-force-absent')).toContain('台帳にあるかどうかは分からない');
    expect(text('list-unreadable-force-absent')).not.toContain('は居ない（id が違う');
    expect(calls('list-unreadable-force-unreadable')).toEqual([
      'pool.list',
      `pool.abort(${MGR},reason=undefined,by=clone)`,
    ]);
    expect(text('list-unreadable-force-not-stopped')).toContain('**止まっていない。**');
    // 居ない id
    expect(text('absent-id-abort-absent')).toContain('は居ない（id が違うか');
    expect(text('absent-id-abort-stopped')).toContain('一覧からも消えている。');
    expect(text('absent-id-abort-stopped')).not.toContain('もともと待機中');
    expect(text('absent-ledger-done')).toContain('台帳では done で');
    expect(text('absent-ledger-failed-force')).toContain('台帳では failed で');
    // 断り
    expect(calls('refuse-running-empty-observed')).toEqual([
      'pool.list',
      `pool.unpushedWork(${MGR},source=stop-refusal,signal=AbortSignal(aborted=false))`,
    ]);
    expect(text('refuse-running-empty-observed')).toContain('（起こした作業者など）');
    expect(text('refuse-running-empty-observed')).not.toContain('未 push の実装・未コミットの変更');
    expect(text('refuse-running-empty-observed')).toContain(
      '直近の報告は 2026-10-27T00:30:00.000Z',
    );
    expect(text('refuse-running-no-report-empty-observed')).toContain(
      '直近の報告は一度も届いていない。',
    );
    expect(calls('refuse-running-force-false')).toHaveLength(2);
    expect(text('refuse-observed-worktrees')).toContain('3本の作業ツリー');
    expect(text('refuse-observed-worktrees')).toContain('未 push 3本 / 未コミット 2件');
    expect(text('refuse-observed-worktrees')).toContain(
      '(枝を指していない、または確かめられなかった)',
    );
    expect(text('refuse-observed-worktrees')).toContain('確かめられなかった（理由不明）');
    expect(text('refuse-observed-all-notes')).toContain('作業ツリーの探索は50件で打ち切った');
    expect(text('refuse-observed-all-notes')).toContain('呼び出し元の期限切れ');
    expect(text('refuse-observed-all-notes')).toContain(
      'スクラッチディレクトリの有無を確かめられなかった',
    );
    expect(text('refuse-observed-all-notes')).toContain('子ディレクトリの読み取りに4件');
    expect(text('refuse-observed-empty-scratch-unknown')).toContain('**確認できていない。**');
    expect(text('refuse-observed-empty-unreadable-dirs')).toContain('**確認できていない。**');
    expect(text('refuse-observed-empty-both-unknown')).toContain('、');
    expect(text('refuse-observed-empty-truncated')).toContain('作業ツリーが見つからなかった');
    expect(text('refuse-observed-empty-truncated')).toContain('（未 push の実装・起こした作業者');
    expect(text('refuse-observed-empty-stopped-early')).toContain('作業ツリーが見つからなかった');
    expect(text('refuse-unavailable')).toContain(
      '**確かめられなかった**（宛先の runner がいま開いていない。）',
    );
    expect(text('refuse-unpushed-throws-error')).toContain('確かめようとして例外が飛んだ');
    expect(text('refuse-unpushed-timeout')).toContain('確かめようとして例外が飛んだ');
    expect(text('refuse-unpushed-throws-string')).toContain('文字列で投げた');
    // force で止める
    expect(calls('force-running-stopped')).toEqual([
      'pool.list',
      `pool.abort(${MGR},reason="依頼が要らなくなった",by=clone)`,
      'pool.list',
    ]);
    expect(text('force-running-stopped')).toContain('畳んだターンの本文はまだ台帳に届いていない');
    expect(text('force-running-stopped-reasonless-folded')).toContain('畳んだターンの本文（');
    expect(text('force-running-stopped-reasonless-folded')).toContain('…');
    expect(calls('force-running-stopped-reasonless-folded')[1]).toBe(
      `pool.abort(${MGR},reason=undefined,by=clone)`,
    );
    expect(text('force-running-absent')).toContain('台帳では running で');
    expect(text('force-running-not-stopped-still-running')).toContain('背景処理待ち×2');
    expect(text('force-running-unknown')).toContain('未確認');
    // unknown でも止めた後の一覧は読む（文には使わない）。unreadable・absent だけが読まずに返る
    expect(calls('force-running-unknown')).toHaveLength(3);
    expect(text('force-running-unreadable')).toContain('は止められなかった: 台帳の行が読めない');
    expect(actual['force-running-abort-throws']?.thrown).toBe(true);
    // running 以外
    expect(calls('waiting-human-no-force')).toEqual([
      'pool.list',
      `pool.abort(${MGR},reason="問いが要らない",by=clone)`,
      'pool.list',
    ]);
    expect(text('done-no-force-stopped')).toContain('もともと待機中（done）だった仕事である');
    expect(text('done-force-stopped-after-unreadable')).toContain('もともと待機中（done）');
    expect(text('done-force-stopped-after-unreadable')).toContain(
      '止めた後の状態を一覧から読めなかった',
    );
    expect(text('failed-no-force-stopped')).not.toContain('もともと待機中');
    expect(text('lost-no-force-stopped')).toContain('最後の発言。');
    expect(text('stopped-no-force-stopped')).toContain('いまの状態: stopped/セッション切断');
    // abort の結果
    expect(calls('abort-unreadable-done')).toHaveLength(2);
    expect(text('abort-unreadable-done')).toContain('は止められなかった: 台帳の行が壊れている');
    expect(text('abort-not-stopped-after-found-live')).toContain('いまの状態: done。');
    expect(text('abort-not-stopped-after-found-disconnected')).toContain('stopped/セッション切断');
    expect(text('abort-not-stopped-after-vanished')).toContain('一覧から消えている。');
    expect(text('abort-not-stopped-after-unreadable')).toContain(
      '止めた後の状態を一覧から読めなかった',
    );
    expect(text('stopped-after-folded-turn-short')).toContain('畳んだターンの本文（');
    expect(text('stopped-after-folded-turn-short')).toContain('背景処理待ち×1');
    expect(text('stopped-after-unreadable-running-before')).not.toContain('もともと待機中');
    expect(text('stopped-after-vanished-running-before')).toContain('一覧からも消えている。');
    expect(calls('reason-empty-string')[1]).toBe(`pool.abort(${MGR},reason="",by=clone)`);
    expect(calls('reason-multiline')[1]).toContain('reason="一行目\\n二行目 ');
  });
});
