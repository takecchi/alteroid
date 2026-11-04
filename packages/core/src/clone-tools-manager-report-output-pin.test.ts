import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ManagerDenial } from './denial-key.js';
import type { ManagerPool, ManagerSummary, ManagerTranscript } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_report` の出力（全文と字数）と、pool・ストア・控えの口への呼びの並びを、場面ごとにコミットした固定値
// （clone-tools-manager-report-output-pin.json）と丸ごと比べる。
// `clone-tools-manager-report.ts` の `managerReportTool`（ハンドラ約 157 行・入れ子 5 段の式）を出力の部分ごとの小さな関数へ分けるとき、
// 出力と呼びが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MANAGER_REPORT_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-manager-report-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-manager-report-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの部分が何字を出しているかを見る基準）。
// 各場面の `calls` は、道具が pool・ストア・控えの口（managerReportShownAt）・サブエージェント判定・emit へ出した呼びの並び。
// この道具は読むだけなので、書き込みの呼び（ストアの put 系・emit）が出たらここに現れて差分になる。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。

type Args = Record<string, unknown>;

interface Step {
  args: Args;
  /** この呼びの前に委譲の一覧を差し替える */
  mutate?: (managers: ManagerSummary[]) => ManagerSummary[];
  /** この呼びの前に「本文は既に会話に載っている」控えを入れる／外す */
  shown?: boolean;
  /** この呼びの `_meta` に積む tool_use_id（サブエージェント判定の入力） */
  toolUseId?: string;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  managers: () => ManagerSummary[];
  steps: Step[];
  /** 真なら pool を渡さない */
  noPool?: boolean;
  unreadableJobs?: { id: string; reason: string }[];
  denials?: Record<string, ManagerDenial[]>;
  models?: Record<string, { manager?: string; worker?: string }>;
  /** 生ログの読み。例外は読めなかった回 */
  transcript?: () => ManagerTranscript | Error;
  /** 真なら `transcriptTail` を持たない pool（全文を読む口へ落ちる） */
  noTail?: boolean;
  /** 真なら `managerReportShownAt` の口を渡さない */
  noShownHook?: boolean;
  /** 真なら `isSubagentCall` の口を渡す（tool_use_id が `tu-sub` の呼びだけサブエージェント） */
  subagentHook?: boolean;
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const SHOWN_AT = new Date('2026-10-27T01:30:00.000Z');
const PIN_URL = new URL('./clone-tools-manager-report-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MANAGER_REPORT_PIN === '1';

function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

// 字数がちょうど n の本文。頁の境目を字数で作るため、10 字ごとに位置が読める形にする
function numbered(n: number): string {
  let out = '';
  for (let i = 0; out.length < n; i += 1)
    out += `${String(i % 1000).padStart(3, '0')}あいうえおかき`;
  return out.slice(0, n);
}

function mgr(extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: 'mgr-001',
    status: 'done',
    live: false,
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

function assistantLine(
  text: string,
  options: { timestamp?: string; stopReason?: string; sidechain?: boolean } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    ...(options.sidechain === true ? { isSidechain: true } : {}),
    message: {
      content: [{ type: 'text', text }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

const userLine = (text: string): string =>
  JSON.stringify({ type: 'user', message: { content: text } });

// 末尾 200,000 字の外へ押し出すための、アシスタントの本文を含まない行の山
function padLines(chars: number): string {
  const line = `${userLine('作業者の発言')}\n`;
  return line.repeat(Math.ceil(chars / line.length));
}

const body = (text: string): ManagerTranscript => ({ kind: 'body', body: text });

const REPORT_PAGE = 8_000;

const denialRows = (lastAt: string | undefined): ManagerDenial[] => [
  { tool: 'Bash', count: 3, actor: 'manager', ...(lastAt === undefined ? {} : { lastAt }) },
  { tool: 'Write', count: 1, actor: 'worker', ...(lastAt === undefined ? {} : { lastAt }) },
];

const worktreeFull = {
  relativePath: '.',
  branch: 'main',
  at: iso(40),
  pushed: { ref: 'refs/alteroid-rescue/m/root-1234abcd', commit: 'c'.repeat(40), at: iso(40) },
  notPushed: { reason: 'push-failed' as const, failureKind: 'auth' as const },
  untracked: { count: 8, paths: ['1', '2', '3', '4', '5', '6'], omitted: 2 },
  submoduleCount: 1,
};

const rescueManager = (): Partial<ManagerSummary> => ({
  lastRescue: {
    at: iso(41),
    worktrees: [
      worktreeFull,
      {
        relativePath: 'sub',
        branch: 'feat/x',
        at: iso(41),
        pushed: {
          ref: 'refs/alteroid-rescue/m/sub-5678',
          commit: 'd'.repeat(40),
          at: iso(41),
          removal: { at: iso(50), reason: 'landed' as const },
        },
      },
      { relativePath: 'empty', branch: 'y', at: iso(41), notPushed: { reason: 'nothing-tracked' } },
    ],
  } as ManagerSummary['lastRescue'],
  rescueStash: { count: 3, totalBytes: 2048, latestAt: iso(42) },
  externalOutputs: [{ at: iso(10), kind: 'mail', where: 'a@example.com', summary: '報告のメール' }],
  heldMessages: { count: 2, oldestHeldAt: iso(45) },
  lastUnpushedWorkObservation: {
    kind: 'observed',
    at: iso(30),
    cwd: '/workspace/repo',
    worktrees: [{ relativePath: '.', branch: 'feat/example' }],
  },
});

const SCENARIOS: Scenario[] = [
  // --- 引数・pool・居ない
  {
    name: 'args-offset-negative',
    covers: 'offset が負（早期リターン。pool に触れない）',
    managers: () => [mgr()],
    steps: [{ args: { managerId: 'mgr-001', offset: -1 } }],
  },
  {
    name: 'args-offset-fraction',
    covers: 'offset が小数（整数でない）',
    managers: () => [mgr()],
    steps: [{ args: { managerId: 'mgr-001', offset: 1.5 } }],
  },
  {
    name: 'no-pool',
    covers: 'pool が無い（NO_POOL。ストアにも触れない）',
    managers: () => [mgr()],
    noPool: true,
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'not-found',
    covers: '居ない id（台帳の読めない行にも無い）。台帳を読み直す',
    managers: () => [mgr()],
    steps: [{ args: { managerId: 'mgr-999' } }],
  },
  {
    name: 'unreadable-row',
    covers: '居ないが読めない行が在る id（台帳を読み直して言い分ける）',
    managers: () => [mgr()],
    unreadableJobs: [{ id: 'mgr-bad', reason: 'schema' }],
    steps: [{ args: { managerId: 'mgr-bad' } }],
  },
  {
    name: 'unreadable-row-other',
    covers: '読めない行は在るが id が違う（居ない側）',
    managers: () => [mgr()],
    unreadableJobs: [{ id: 'mgr-bad', reason: 'schema' }],
    steps: [{ args: { managerId: 'mgr-999' } }],
  },
  // --- 依頼文
  {
    name: 'request',
    covers: 'part=request・依頼文が在る。注記・drift・控えの口には触れない（控えが在っても本文）',
    managers: () => [
      mgr({
        status: 'failed',
        lastFailure: { code: 'x', via: 'live', at: iso(55) },
        usageStoppedAt: iso(54),
        runnerVanished: true,
        lastReport: undefined,
      }),
    ],
    denials: { 'mgr-001': denialRows(iso(50)) },
    steps: [{ args: { managerId: 'mgr-001', part: 'request' }, shown: true }],
  },
  {
    name: 'request-missing',
    covers: 'part=request・依頼文が空（生ログは見に行かない）',
    managers: () => [mgr({ request: '' })],
    steps: [{ args: { managerId: 'mgr-001', part: 'request' } }],
  },
  {
    name: 'request-paging',
    covers: 'part=request の頁（続きの案内に part=request が入る・最後の頁・refetch は影響しない）',
    managers: () => [mgr({ request: numbered(REPORT_PAGE * 2 + 500) })],
    steps: [
      { args: { managerId: 'mgr-001', part: 'request' } },
      { args: { managerId: 'mgr-001', part: 'request', offset: REPORT_PAGE } },
      { args: { managerId: 'mgr-001', part: 'request', offset: REPORT_PAGE * 2 } },
      { args: { managerId: 'mgr-001', part: 'request', refetch: true } },
    ],
  },
  // --- 報告が無い（生ログの言い分け）
  {
    name: 'missing-tail-found-end-turn',
    covers:
      '報告が無い・末尾を読む口・本文あり・end_turn（⚠ 配られていない・since 付き）。全注記なし',
    managers: () => [mgr({ status: 'done', lastReport: undefined, lastReportAt: undefined })],
    transcript: () =>
      body(
        [
          userLine('依頼'),
          assistantLine('途中の語り', { timestamp: iso(20), stopReason: 'tool_use' }),
          assistantLine('完了の報告', { timestamp: iso(30), stopReason: 'end_turn' }),
          '壊れた行',
          '',
        ].join('\n'),
      ),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-tail-tool-use',
    covers: '報告が無い・stop_reason が tool_use（まだ書き終えていない側）。モデルの名乗りあり',
    managers: () => [mgr({ status: 'running', live: true, lastReport: undefined })],
    models: { 'runner-1': { manager: 'opus', worker: 'sonnet' } },
    transcript: () =>
      body(
        [
          assistantLine('脇道の発言', {
            timestamp: iso(25),
            stopReason: 'end_turn',
            sidechain: true,
          }),
          assistantLine('道具の前の語り', { timestamp: iso(30), stopReason: 'tool_use' }),
        ].join('\n'),
      ),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-tail-no-stop-reason',
    covers:
      '報告が無い・stop_reason が無い（判定できなかった）・timestamp も無い（since を示せない）',
    managers: () => [mgr({ status: 'running', live: true, lastReport: undefined })],
    transcript: () => body(assistantLine('時刻の無い発言')),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-tail-no-stop-reason-with-time',
    covers: '報告が無い・stop_reason 無し・timestamp あり',
    managers: () => [mgr({ status: 'running', live: true, lastReport: undefined })],
    transcript: () => body(assistantLine('時刻つきの発言', { timestamp: iso(31) })),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-notail-found',
    covers: '報告が無い・末尾の口が無く全文を読む・本文が短い（offset=0）',
    managers: () => [mgr({ status: 'done', lastReport: undefined })],
    noTail: true,
    transcript: () => body(assistantLine('完了', { timestamp: iso(30), stopReason: 'end_turn' })),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-notail-long',
    covers: '報告が無い・全文を読む口・本文が長い（読み始めの offset が末尾寄り）',
    managers: () => [mgr({ status: 'done', lastReport: undefined })],
    noTail: true,
    transcript: () =>
      body(
        `${padLines(20_000)}${assistantLine('完了', { timestamp: iso(30), stopReason: 'end_turn' })}`,
      ),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-notail-no-time',
    covers: '報告が無い・全文を読む口・timestamp 無し・stop_reason 無し',
    managers: () => [mgr({ status: 'done', lastReport: undefined })],
    noTail: true,
    transcript: () => body(assistantLine('時刻無し')),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-throws',
    covers: '報告が無い・生ログの読みが例外（読めなかった）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () => new Error('ディスクが読めない'),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-removed',
    covers: '報告が無い・退避されたが本文が消されている',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () => ({
      kind: 'removed',
      archiveId: 'arch-1',
      removedAt: iso(100),
      bytes: 1234567,
    }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-unreadable',
    covers: '報告が無い・生ログへ読みに行けなかった',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () => ({ kind: 'unreadable', detail: '詳細: 権限が無い' }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-missing',
    covers: '報告が無い・生ログが無い（3段のどこにも）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () => ({ kind: 'missing' }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-empty-body',
    covers: '報告が無い・生ログの本文が空文字',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () => body(''),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-no-assistant',
    covers: '報告が無い・生ログ全体を見てもマネージャーの本文が無い（空の発言・脇道だけ）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () =>
      body(
        [
          userLine('依頼'),
          assistantLine('   '),
          assistantLine('脇道', { sidechain: true, stopReason: 'end_turn' }),
          JSON.stringify({ type: 'assistant', message: { content: 42 } }),
        ].join('\n'),
      ),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-string-content',
    covers: '報告が無い・content が文字列のアシスタント行（本文として数える）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () =>
      body(
        JSON.stringify({
          type: 'assistant',
          timestamp: iso(33),
          message: { content: 'ただの文字列', stop_reason: 'end_turn' },
        }),
      ),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-truncated',
    covers: '報告が無い・末尾 200,000 字の中に本文が見つからない（遡れていない）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () =>
      body(`${assistantLine('遠い昔の発言', { stopReason: 'end_turn' })}\n${padLines(210_000)}`),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-transcript-truncated-found',
    covers: '報告が無い・長い生ログの末尾に本文が在る（先頭の欠けた行を捨てる）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () =>
      body(
        `${padLines(210_000)}${assistantLine('末尾の完了', { timestamp: iso(35), stopReason: 'end_turn' })}`,
      ),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-all-notes',
    covers:
      '報告が無い回に出る注記を全部（枠・runner 消失・失敗の系統エラー・cgroup・拒否・観測できていない・未 push の全部（rescueAll）・配っていない報告）。順序の固定',
    managers: () => [
      mgr({
        status: 'failed',
        lastReport: undefined,
        lastReportAt: undefined,
        usageStoppedAt: iso(54),
        runnerVanished: true,
        lastSystemError: { code: 'ENOMEM', errno: -12, syscall: 'spawn', at: iso(55) },
        lastCgroupEvents: { oomKillDelta: 1, pidsMaxDelta: 2, at: iso(56) },
        awaitingBackground: { tasks: 2, withheldReports: 3, breakdown: 'bash×2', since: iso(20) },
        ...rescueManager(),
      }),
    ],
    denials: { 'mgr-001': denialRows(iso(50)) },
    transcript: () => ({ kind: 'missing' }),
    steps: [
      { args: { managerId: 'mgr-001' } },
      { args: { managerId: 'mgr-001', rescueAll: true } },
    ],
  },
  {
    name: 'missing-failed-unknown-system-error',
    covers: '報告が無い・failed で系統エラーも cgroup も無い（取れなかった側の注記）',
    managers: () => [mgr({ status: 'failed', lastReport: undefined })],
    transcript: () => ({ kind: 'missing' }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-withheld-zero',
    covers: '報告が無い・配っていない報告が 0 本（0 と測れた）・stopped の枠',
    managers: () => [
      mgr({
        status: 'stopped',
        lastReport: undefined,
        usageStoppedAt: iso(54),
        awaitingBackground: { tasks: 1, withheldReports: 0, breakdown: 'bash', since: iso(20) },
      }),
    ],
    transcript: () => ({ kind: 'missing' }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'missing-usage-unobserved',
    covers: '報告が無い・lost で枠（終端の枠）・観測できていない結果',
    managers: () => [mgr({ status: 'lost', lastReport: undefined, usageStoppedAt: iso(54) })],
    transcript: () => ({ kind: 'missing' }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  // --- 報告が在る
  {
    name: 'report-plain',
    covers: '報告が在る・注記なし・モデル名乗りなし・控えの口あり（載っていない）',
    managers: () => [mgr()],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'report-failure-wrapped',
    covers: '失敗で終わった回（done／stopped／failed・本文あり）。見出しは「直近のターンの中身」',
    managers: () => [
      mgr({
        lastFailure: { code: 'billing_error', via: 'assistant_error', at: iso(55) },
        lastReport: 'このターンは応答を返さずに終わった: 429',
      }),
    ],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, status: 'stopped' as const })),
      },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, status: 'failed' as const })),
      },
    ],
  },
  {
    name: 'report-failure-stale-token',
    covers: '失敗の回で認証トークンの世代が食い違う（staleToken を渡す）',
    managers: () => [
      mgr({
        status: 'running',
        live: true,
        lastFailure: { code: 'rate_limit', via: 'assistant_error', at: iso(55) },
        lastReport: 'このターンは応答を返さずに終わった: 429',
        tokenGeneration: 1,
        activeTokenGeneration: 3,
      }),
    ],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'report-usage-stopped',
    covers: '枠で止まった注記（走行中／stopped／lost）',
    managers: () => [mgr({ status: 'running', live: true, usageStoppedAt: iso(54) })],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, status: 'stopped' as const, live: false })),
      },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, status: 'lost' as const })),
      },
    ],
  },
  {
    name: 'report-runner-vanished',
    covers: 'runner が名簿から消えた注記',
    managers: () => [mgr({ status: 'running', runnerVanished: true })],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'report-system-error-cgroup',
    covers: 'failed の系統エラー・cgroup（あり／無し）。観測できていない結果（届いた本文）',
    managers: () => [
      mgr({
        status: 'failed',
        lastSystemError: { code: 'ENOMEM', errno: -12, syscall: 'spawn', at: iso(55) },
        lastCgroupEvents: { oomKillDelta: 1, pidsMaxDelta: 2, at: iso(56) },
      }),
    ],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) =>
          l.map((m) => ({ ...m, lastSystemError: undefined, lastCgroupEvents: undefined })),
      },
    ],
  },
  {
    name: 'report-unobserved-failure-wrapped',
    covers: '観測できていない結果（lost・失敗で包まれた本文）',
    managers: () => [
      mgr({
        status: 'lost',
        lastFailure: { code: 'x', via: 'live', at: iso(55) },
        lastReport: '包まれたエラー文',
      }),
    ],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'report-denials',
    covers:
      '拒否の注記（報告より前／後／時刻が取れない／13種超で畳む）。拒否は lastReportAt を基準に比べる',
    managers: () => [mgr()],
    denials: { 'mgr-001': denialRows(iso(70)) },
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, lastReportAt: iso(80) })),
      },
    ],
  },
  {
    name: 'report-denials-no-time',
    covers: '拒否の最後の時刻が取れない',
    managers: () => [mgr()],
    denials: { 'mgr-001': denialRows(undefined) },
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'report-denials-many',
    covers: '拒否の種類が多く「ほか N 種」へ畳まれる',
    managers: () => [mgr()],
    denials: {
      'mgr-001': Array.from({ length: 12 }, (_, i) => ({
        tool: `Tool${String(i)}`,
        count: i + 1,
        lastAt: iso(70 + i),
      })),
    },
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'report-unpushed',
    covers:
      '未 push の観測・退避 ref の畳み（既定）と rescueAll（作業ツリーごと）・外へ出した成果・預かり',
    managers: () => [mgr({ status: 'failed', ...rescueManager() })],
    steps: [
      { args: { managerId: 'mgr-001' } },
      { args: { managerId: 'mgr-001', rescueAll: true } },
    ],
  },
  {
    name: 'report-unpushed-only-observation',
    covers: '未 push の観測だけ（退避なし）',
    managers: () => [
      mgr({
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: iso(30),
          cwd: '/workspace/repo',
          worktrees: [{ relativePath: '.', branch: 'feat/only' }],
        },
      }),
    ],
    steps: [
      { args: { managerId: 'mgr-001' } },
      { args: { managerId: 'mgr-001', rescueAll: true } },
    ],
  },
  {
    name: 'report-withheld',
    covers: '配っていない報告の注記（N 本・0 本）。本文の後ろでなく前に出る',
    managers: () => [
      mgr({
        status: 'running',
        live: true,
        awaitingBackground: { tasks: 2, withheldReports: 3, breakdown: 'bash×2', since: iso(20) },
      }),
    ],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) =>
          l.map((m) => ({
            ...m,
            awaitingBackground: { tasks: 1, withheldReports: 0, breakdown: 'bash', since: iso(20) },
          })),
      },
    ],
  },
  {
    name: 'report-all-notes-order',
    covers:
      '注記を全部（drift・失敗・枠・runner 消失・系統エラー・cgroup・拒否・観測できていない・未 push・配っていない報告）。順序と区切りの固定',
    managers: () => [
      mgr({
        status: 'failed',
        lastReportStatus: 'running',
        lastFailure: { code: 'billing_error', via: 'assistant_error', at: iso(55) },
        lastReport: 'このターンは応答を返さずに終わった: 429',
        usageStoppedAt: iso(54),
        runnerVanished: true,
        lastSystemError: { code: 'ENOMEM', errno: -12, syscall: 'spawn', at: iso(55) },
        lastCgroupEvents: { oomKillDelta: 1, pidsMaxDelta: 2, at: iso(56) },
        awaitingBackground: { tasks: 2, withheldReports: 3, breakdown: 'bash×2', since: iso(20) },
        ...rescueManager(),
      }),
    ],
    denials: { 'mgr-001': denialRows(iso(50)) },
    models: { 'runner-1': { manager: 'opus' } },
    steps: [
      { args: { managerId: 'mgr-001' } },
      { args: { managerId: 'mgr-001', rescueAll: true } },
      { args: { managerId: 'mgr-001', part: 'request' } },
    ],
  },
  // --- 畳まれたターン・直近のターン
  {
    name: 'folded-turn',
    covers:
      'lastFoldedTurn が在れば lastReport より優先・見出しが「停止後に届いた…」・lastReportAt の欄を出さない・失敗の注記を出さない・拒否と drift は foldedTurn.at 基準',
    managers: () => [
      mgr({
        status: 'stopped',
        lastReportStatus: 'running',
        lastFoldedTurn: { text: '畳まれた本文。停止後に届いた。', at: iso(58) },
        lastFailure: { code: 'y', via: 'live', at: iso(50) },
        lastReport: '古い報告',
        lastReportAt: iso(10),
      }),
    ],
    denials: { 'mgr-001': denialRows(iso(57)) },
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, status: 'running' as const, live: true })),
      },
      { args: { managerId: 'mgr-001', part: 'request' } },
    ],
  },
  {
    name: 'folded-turn-denial-after',
    covers: 'foldedTurn.at が拒否より後（拒否の後にも報告が届いている側）',
    managers: () => [
      mgr({ lastFoldedTurn: { text: '畳まれた本文', at: iso(90) }, lastReportAt: iso(10) }),
    ],
    denials: { 'mgr-001': denialRows(iso(57)) },
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'folded-turn-empty-text',
    covers:
      'lastFoldedTurn の本文が空（無いと見て lastReport へ落ち、「直近の報告」として返す。拒否の基準も lastReportAt。#6387）',
    managers: () => [
      mgr({ lastFoldedTurn: { text: '', at: iso(58) }, lastReport: '落ちない報告' }),
    ],
    transcript: () => ({ kind: 'missing' }),
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'folded-turn-shown',
    covers: '畳まれたターンの本文が既に会話に載っている（注記だけ）',
    managers: () => [mgr({ lastFoldedTurn: { text: '畳まれた本文。', at: iso(58) } })],
    steps: [{ args: { managerId: 'mgr-001' }, shown: true }],
  },
  {
    name: 'latest-turn-unreported',
    covers:
      'lastUnreported（配られなかった）だけで見出しが「直近のターンの中身」。失敗の注記は無い',
    managers: () => [
      mgr({
        lastUnreported: { reason: 'closed', at: iso(59) },
        lastReport: '届かなかった途中経過',
      }),
    ],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  // --- 齢と drift
  {
    name: 'drift-changed',
    covers: '報告の時の status と今の status が違う（running → done）。報告から 120 分',
    managers: () => [mgr({ status: 'done', lastReportStatus: 'running', lastReportAt: iso(0) })],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'drift-recent',
    covers: 'drift が在り報告は直近（分の言い方の境目）',
    managers: () => [mgr({ status: 'done', lastReportStatus: 'running', lastReportAt: iso(119) })],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'drift-future',
    covers: 'drift が在るが lastReportAt が未来（齢を言わない）・日付が壊れている（NaN）',
    managers: () => [mgr({ status: 'done', lastReportStatus: 'running', lastReportAt: iso(180) })],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, lastReportAt: 'いつか' })),
      },
    ],
  },
  {
    name: 'drift-none',
    covers:
      'drift なし（status が同じ）・lastReportAt が無い（一度も届いていない）・lastReportStatus が無い',
    managers: () => [mgr({ lastReportStatus: 'done' })],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, lastReportAt: undefined })),
      },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, lastReportAt: iso(60), lastReportStatus: undefined })),
      },
    ],
  },
  // --- 頁
  {
    name: 'page-boundary',
    covers: '本文がちょうど 1 頁（続きなし）と 1 字超（続きが出る）',
    managers: () => [mgr({ lastReport: numbered(REPORT_PAGE) })],
    steps: [
      { args: { managerId: 'mgr-001' } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, lastReport: numbered(REPORT_PAGE + 1) })),
      },
      { args: { managerId: 'mgr-001', offset: REPORT_PAGE } },
    ],
  },
  {
    name: 'page-continue',
    covers: '3 頁にまたがる本文を offset でたどる・最後の頁・範囲外の offset・1 頁の途中から',
    managers: () => [mgr({ lastReport: numbered(REPORT_PAGE * 2 + 500) })],
    steps: [
      { args: { managerId: 'mgr-001' } },
      { args: { managerId: 'mgr-001', offset: REPORT_PAGE } },
      { args: { managerId: 'mgr-001', offset: REPORT_PAGE * 2 } },
      { args: { managerId: 'mgr-001', offset: REPORT_PAGE * 3 } },
      { args: { managerId: 'mgr-001', offset: 100 } },
    ],
  },
  {
    name: 'page-with-notes',
    covers: '頁の続きと注記が同居する（注記は本文の前・続きの案内は本文の後）',
    managers: () => [
      mgr({ lastReport: numbered(REPORT_PAGE + 10), usageStoppedAt: iso(54), status: 'running' }),
    ],
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  // --- 本文が既に会話に載っている
  {
    name: 'shown-note-only',
    covers:
      '本文が既に載っている（注記だけ・本文なし）。注記の状態は残す（drift・失敗・枠・拒否・未 push）。refetch・offset>0・part=request は本文',
    managers: () => [
      mgr({
        status: 'stopped',
        lastReportStatus: 'running',
        lastReport: numbered(REPORT_PAGE + 10),
        usageStoppedAt: iso(54),
        ...rescueManager(),
      }),
    ],
    denials: { 'mgr-001': denialRows(iso(50)) },
    steps: [
      { args: { managerId: 'mgr-001' }, shown: false },
      { args: { managerId: 'mgr-001' }, shown: true },
      { args: { managerId: 'mgr-001', refetch: true } },
      { args: { managerId: 'mgr-001', offset: 100 } },
      { args: { managerId: 'mgr-001', part: 'request' } },
      { args: { managerId: 'mgr-001', rescueAll: true } },
      {
        args: { managerId: 'mgr-001' },
        mutate: (l) => l.map((m) => ({ ...m, lastReport: '別の本文になった' })),
      },
    ],
  },
  {
    name: 'shown-empty-report',
    covers: '本文が無い回は控えを引かない（報告が無い側）',
    managers: () => [mgr({ lastReport: undefined })],
    transcript: () => ({ kind: 'missing' }),
    steps: [{ args: { managerId: 'mgr-001' }, shown: true }],
  },
  {
    name: 'shown-no-hook',
    covers: '控えの口が無い器（テスト・蒸留）は従来どおり全文',
    managers: () => [mgr()],
    noShownHook: true,
    steps: [{ args: { managerId: 'mgr-001' } }],
  },
  {
    name: 'shown-subagent',
    covers: 'サブエージェントの呼びは控えが在っても本文・控えを引かない。本体の呼びは注記だけ',
    managers: () => [mgr()],
    subagentHook: true,
    steps: [
      { args: { managerId: 'mgr-001' }, shown: true, toolUseId: 'tu-sub' },
      { args: { managerId: 'mgr-001' }, toolUseId: 'tu-main' },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

interface Observed {
  text: string;
  calls: string[];
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

async function runScenario(scenario: Scenario): Promise<Observed[]> {
  let managers = scenario.managers();
  const calls: string[] = [];
  const state = { shown: false };
  const unreadable = scenario.unreadableJobs ?? [];
  const stores = recordStores(calls);
  const notUsed = () => {
    throw new Error('この歯では使わない');
  };
  const transcriptOf = async (): Promise<ManagerTranscript> => {
    const got = scenario.transcript?.() ?? ({ kind: 'missing' } as const);
    if (got instanceof Error) throw got;
    return got;
  };
  const pool = {
    async list() {
      calls.push('pool.list');
      return managers.map((manager) => ({ ...manager }));
    },
    denials(managerId: string) {
      calls.push(`pool.denials(${managerId})`);
      return scenario.denials?.[managerId] ?? [];
    },
    async transcript(managerId: string) {
      calls.push(`pool.transcript(${managerId})`);
      return transcriptOf();
    },
    ...(scenario.noTail === true
      ? {}
      : {
          async transcriptTail(managerId: string, maxChars: number) {
            calls.push(`pool.transcriptTail(${managerId},${String(maxChars)})`);
            return transcriptOf();
          },
        }),
    runnerReportedModels(runnerId: string) {
      calls.push(`pool.runnerReportedModels(${runnerId})`);
      return scenario.models?.[runnerId];
    },
    start: notUsed,
    send: notUsed,
    abort: notUsed,
  } as unknown as ManagerPool;
  stores.jobs.listUnreadableJobs = async () => {
    calls.push('stores.jobs.listUnreadableJobs');
    return unreadable;
  };
  const latestReports = (): string[] =>
    managers.map((manager) => manager.lastFoldedTurn?.text ?? manager.lastReport ?? '');
  const tools = createCloneTools({
    stores,
    emit: () => {
      calls.push('emit');
    },
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.noPool === true ? {} : { managers: pool }),
    ...(scenario.noShownHook === true
      ? {}
      : {
          managerReportShownAt: (managerId: string, text: string) => {
            calls.push(`shownAt(${managerId},${String(text.length)})`);
            return state.shown && latestReports().includes(text) ? SHOWN_AT : null;
          },
        }),
    ...(scenario.subagentHook === true
      ? {
          isSubagentCall: (toolUseId: string | undefined) => {
            calls.push(`isSubagentCall(${String(toolUseId)})`);
            return toolUseId === 'tu-sub';
          },
        }
      : {}),
  });
  const found = tools.find((entry) => entry.name === 'manager_report');
  if (!found) throw new Error('manager_report が無い');
  const observed: Observed[] = [];
  for (const step of scenario.steps) {
    if (step.mutate !== undefined) managers = step.mutate(managers);
    if (step.shown !== undefined) state.shown = step.shown;
    calls.length = 0;
    const extra =
      step.toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': step.toolUseId } };
    const result = await found.handler(step.args as never, extra as never);
    observed.push({
      text: (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(''),
      calls: [...calls],
    });
  }
  return observed;
}

interface PinnedOutput {
  length: number;
  calls: string[];
  text: string;
}

interface PinFile {
  /** 場面ごとの字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
}

async function runAll(): Promise<Record<string, PinnedOutput>> {
  const out: Record<string, PinnedOutput> = {};
  for (const scenario of SCENARIOS) {
    const observed = await runScenario(scenario);
    for (const [index, one] of observed.entries()) {
      out[stepKey(scenario, index)] = { length: one.text.length, calls: one.calls, text: one.text };
    }
  }
  return out;
}

describe('manager_report の出力の固定（場面ごとの全文・字数・呼びの並び）', () => {
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
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);
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
        expect(got?.calls, `場面 ${key} の pool・ストア・控えへの呼びの並びがずれた`).toEqual(
          want?.calls,
        );
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びになる（時計・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('読むだけである（ストアの呼びは listUnreadableJobs だけ・emit は無い）', () => {
    for (const key of ALL_KEYS) {
      for (const call of actual[key]?.calls ?? []) {
        expect(
          call === 'stores.jobs.listUnreadableJobs' || !call.startsWith('stores.'),
          `${key}: ストアへ ${call} を呼んだ`,
        ).toBe(true);
        expect(call, `${key}: emit した`).not.toBe('emit');
      }
    }
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    const calls = (key: string): string[] => actual[key]?.calls ?? [];
    expect(text('args-offset-negative')).toContain('offset');
    expect(calls('args-offset-negative')).toEqual([]);
    expect(text('no-pool')).toContain('いまは委譲できない場面');
    expect(calls('not-found')).toContain('stores.jobs.listUnreadableJobs');
    expect(text('not-found')).toContain('は居ない');
    expect(text('unreadable-row')).toContain('mgr-bad');
    expect(text('unreadable-row')).not.toContain('は居ない');
    expect(text('request-missing')).toContain('依頼文が記録に無い');
    expect(calls('request-missing')).not.toContain('pool.transcriptTail(mgr-001,200000)');
    expect(text('request-paging#1')).toContain('part=request offset=8000');
    expect(calls('request')).not.toContain('shownAt(mgr-001,10)');
    expect(text('missing-tail-found-end-turn')).toContain('生成されたが配られていない（#323）');
    expect(text('missing-tail-tool-use')).toContain('stop_reason=tool_use');
    expect(text('missing-tail-no-stop-reason')).toContain('判定できなかった');
    expect(calls('missing-notail-found')).toContain('pool.transcript(mgr-001)');
    expect(text('missing-notail-long')).toMatch(/offset=\d+ で読める/);
    expect(text('missing-transcript-throws')).toContain('生ログは読めなかった');
    expect(text('missing-transcript-removed')).toContain('本文が消されている');
    expect(text('missing-transcript-unreadable')).toContain('読みに行けなかった');
    expect(text('missing-transcript-missing')).toContain('3段のどこにも');
    expect(text('missing-transcript-no-assistant')).toContain('生ログ全体を見た');
    expect(text('missing-transcript-truncated')).toContain('遡ったが');
    expect(text('missing-all-notes#1')).toContain('退避できていない作業ツリー');
    expect(text('missing-all-notes#1')).not.toContain('sub: refs/alteroid-rescue');
    expect(text('missing-all-notes#2')).toContain('sub: refs/alteroid-rescue');
    expect(text('report-failure-wrapped#1')).toContain(
      '直近のターンは報告ではなく失敗で終わっている',
    );
    expect(text('report-failure-wrapped#1')).toContain('直近のターンの中身');
    expect(text('report-denials#1')).toContain('確認へ上がらず止められた道具');
    expect(text('folded-turn#1')).toContain('停止後に届いた、畳まれたターンの中身');
    expect(text('folded-turn#1')).not.toContain('lastReportAt:');
    expect(text('latest-turn-unreported')).toContain('直近のターンの中身');
    expect(text('drift-changed')).toContain('いま走っているターンの中身ではない');
    expect(text('page-boundary#1')).not.toContain('ここで切れている');
    expect(text('page-boundary#2')).toContain(`offset=${String(REPORT_PAGE)}`);
    expect(text('page-continue#3')).not.toContain('ここで切れている');
    expect(text('shown-note-only#1')).not.toContain('の発言に載っている');
    expect(text('shown-note-only#2')).toContain('01:30Z の発言に載っている（会話の上）');
    expect(text('shown-note-only#3')).not.toContain('の発言に載っている');
    expect(text('shown-note-only#4')).not.toContain('の発言に載っている');
    expect(calls('shown-note-only#3')).not.toContain(
      `shownAt(mgr-001,${String(REPORT_PAGE + 10)})`,
    );
    expect(text('shown-no-hook')).toContain('報告。終わった。');
    expect(calls('shown-subagent#1')).not.toContain('shownAt(mgr-001,8)');
    expect(text('shown-subagent#2')).toContain('の発言に載っている');
  });
});
