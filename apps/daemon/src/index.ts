#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { serve } from '@hono/node-server';

import {
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  DEFAULT_PERMISSION_MODE,
  applyAppScopedEnvVars,
  migrateEnvBaseCredentialsOnce,
  seedDefaultEnvVars,
  createClone,
  createLocalRunner,
  createProfileApplier,
  createCredentialService,
  createMcpServerService,
  createPluginDistributionService,
  createProfileService,
  createProfileVessel,
  createRunnerRegistry,
  createScheduler,
  createTokenPoolService,
  createTokenPoolWriteLock,
  createTokenRotator,
  noteDroppedRecord,
  DAILY_REPORT_RETRY_DELAYS_MS,
  tokenRestoreEntry,
  tokenRotationEntry,
  probeTokenCandidate,
  runTokenTrial,
  installUncaughtNet,
  placedClonePermissionMode,
  placedManagerModels,
  reasonOf,
  redactErrorText,
  resolveCloneModel,
  resolveManagerModel,
  resolveWorkerModel,
  retiredLayerProviderNotices,
  staleObservedRecoveryForBlockedKey,
  staleObservedRecoveryNoticeEvent,
  WITHHELD_ENV_KEYS,
  writeStderrSync,
  type InboxEvent,
  type RunnerClient,
  type RunnerPlacementResources,
  type RunnerSource,
  type SelfFacts,
  type Stores,
  type TokenRotationEntry,
  type TokenRotationOutcome,
  readAttachmentLimits,
  attachmentCopiesDir,
} from '@alteroid/core';

import { createApp, parseAllowedOrigins } from './app.js';
import { startTokenRotationWatch, type TokenRotationWatch } from './token-watch.js';
import {
  isRejectionForTrialBackoff,
  startTokenTrialWatch,
  type TokenTrialWatch,
} from './token-trial-watch.js';
import { TokenRotationJournalFold } from './token-rotation-journal-fold.js';
import { startUsagePolling } from './usage-poller.js';
import { startManagerPolling } from './manager-poller.js';
import { readArchiveFoldConfig, startArchiveFolding } from './archive-folder.js';
import { readAttachmentPruneConfig, startAttachmentPruning } from './attachment-prune.js';
import { AUTH_WITHHELD_ENV_KEYS, planAuth } from './auth.js';
import { createJournalBus } from './journal-bus.js';
import { createWorkerToolBus } from './topology-activity.js';
import {
  createHttpRunner,
  describeRunnerDropped,
  describeRunnerUnknown,
  managerIdOfRunnerPath,
  RunnerHttpError,
  type RunnerDroppedEventReport,
  type RunnerUnknownReport,
} from './runner-client.js';
import { clearRuntimeInfo, writeRuntimeInfo } from './runtime.js';
import { noteRunnerSwap } from './runner-swap-notice.js';
import { buildSchedule, readScheduleConfig } from './schedule.js';
import { startDailyReportCatchup } from './report-catchup.js';
import type { DailyReportCatchup } from './report-catchup.js';
import {
  createAgentTokenHolder,
  createRunnerTokenSync,
  createTokenSpread,
} from './token-spread.js';
import { resolvePort } from './port.js';
import { pruneExtractedPluginsOnBoot } from './plugin-prune.js';
import { openStorage } from './storage.js';

export { createApp, parseAllowedOrigins, type AppDeps, type AppType } from './app.js';
export {
  AUTH_ENV,
  AUTH_WITHHELD_ENV_KEYS,
  GOOGLE_CLIENT_ID_ENV,
  GOOGLE_CLIENT_SECRET_ENV,
  PUBLIC_URL_ENV,
  TOKEN_TTL_ENV,
  planAuth,
  type AuthPlan,
  type Principal,
} from './auth.js';
export { buildOpenApiDocument } from './openapi.js';
export { createJournalBus, type JournalBus } from './journal-bus.js';
export { openStorage, DATABASE_URL_ENV, type Storage } from './storage.js';
export {
  createHttpRunner,
  describeRunnerDropped,
  describeRunnerUnknown,
  managerIdOfRunnerPath,
  RUNNER_CALL_DEADLINE_MS,
  RunnerHttpError,
  RunnerUnknownError,
  type HttpRunnerOptions,
  type RunnerDroppedEventReport,
  type RunnerUnknownReport,
} from './runner-client.js';
export {
  buildSchedule,
  readScheduleConfig,
  DEFAULT_DAILY_REPORT_AT,
  DEFAULT_INITIATIVE_EVERY_MINUTES,
  DEFAULT_REPORT_LOOKBACK_DAYS,
  type ScheduleConfig,
} from './schedule.js';
export {
  parseRuntimeInfo,
  readRuntimeInfo,
  runtimeFilePath,
  type DaemonRuntimeInfo,
} from './runtime.js';
export {
  ATTACHMENT_PRUNE_EVERY_ENV,
  DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES,
  readAttachmentPruneConfig,
  startAttachmentPruning,
  type AttachmentPruneConfig,
  type AttachmentPruner,
  type AttachmentPrunerOptions,
} from './attachment-prune.js';
export {
  ARCHIVE_FOLD_EVERY_ENV,
  ARCHIVE_FOLD_GRACE_MS,
  DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES,
  foldArchiveOnce,
  readArchiveFoldConfig,
  startArchiveFolding,
  type ArchiveFolder,
  type ArchiveFolderOptions,
  type ArchiveFoldConfig,
  type FoldArchiveOnceOptions,
  type FoldArchiveOnceResult,
} from './archive-folder.js';

const DEFAULT_BIND = '127.0.0.1';

const RUNNER_URLS_ENV = 'ALTEROID_RUNNER_URLS';
const RUNNER_URL_ENV = 'ALTEROID_RUNNER_URL';

// 環境変数で渡さず写しを持つ: 正本（`railway/daemon.json` の `drainingSeconds` と `compose.yaml` の `stop_grace_period`）は実行中のプロセスから読めないため。
const SHUTDOWN_GRACE_MS = 60_000;

// `SHUTDOWN_GRACE_MS` と同じ値にしない: 猶予が切れる時刻には器の SIGKILL が来るため、自分で `exit` する最後の口が負けて消える。
const FORCED_EXIT_MS = SHUTDOWN_GRACE_MS - 5_000;

// forced exit（`FORCED_EXIT_MS`）の内側に収める: 待ったあとに台帳への書き込みの完了待ち・runner の口を閉じる・`storage.close()` が残るため。
const RUNNER_FAREWELL_DEADLINE_MS = FORCED_EXIT_MS - 10_000;

// `server.timeout` は入れず TCP keepalive にする: `write()` のたびにタイマーがリセットされ、イベントが来ないだけの健全な長時間接続を切ってしまうため。
const TCP_KEEPALIVE_DELAY_MS = 30_000;

// 単数形 `ALTEROID_RUNNER_URL` を落とさない: 既に動いている構成が、名簿を複数化しただけで委譲先を失うため。
export function parseRunnerUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = [...(env[RUNNER_URLS_ENV] ?? '').split(','), env[RUNNER_URL_ENV] ?? ''];
  const urls: string[] = [];
  for (const value of raw) {
    const url = value.trim();
    if (url.length === 0 || urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

// ここでは1台も開かない: 接続を返す形だと runner が上がるまで待ち受けを開けず、runner に依存しない経路まで止まるため。
function runnerSeeds(options: {
  workspace: string;
  env: NodeJS.ProcessEnv;
  withheldEnvKeys: string[];
  profilePath: string;
  onRunnerUnknown: (report: RunnerUnknownReport) => void;
  onRunnerDropped: (report: RunnerDroppedEventReport) => void;
}): RunnerSource[] {
  const urls = parseRunnerUrls(process.env);
  if (urls.length > 0) {
    const token = process.env.ALTEROID_RUNNER_TOKEN;
    if (token === undefined || token.length === 0) {
      throw new Error(
        `${RUNNER_URLS_ENV} / ${RUNNER_URL_ENV} があるのに ALTEROID_RUNNER_TOKEN が無い` +
          '（runner の制御面は鍵で守る。runner には sha256 を渡すこと）',
      );
    }
    return urls.map((url) => ({
      label: url,
      open: () => openHttpRunner(url, token, options.onRunnerUnknown, options.onRunnerDropped),
    }));
  }
  return [
    {
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-local',
          workspacePath: options.workspace,
          env: options.env,
          withheldEnvKeys: options.withheldEnvKeys,
          // クローン側とは別のファイルにする: こちらには伏せる鍵の `unset` が付くため。
          profile: createProfileVessel({
            path: options.profilePath,
            withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...options.withheldEnvKeys],
          }),
        }),
    },
  ];
}

// 鍵の拒否は素の `Error` に包み直さず恒久的な失敗のまま投げる: 名簿が「待てば直る」と読んで永久に叩き続けるため。
async function openHttpRunner(
  baseUrl: string,
  token: string,
  onUnknown: (report: RunnerUnknownReport) => void,
  onDroppedEvent: (report: RunnerDroppedEventReport) => void,
): Promise<RunnerClient> {
  try {
    return await createHttpRunner({ baseUrl, token, onUnknown, onDroppedEvent });
  } catch (error) {
    if (error instanceof RunnerHttpError && (error.status === 401 || error.status === 403)) {
      throw new RunnerHttpError(
        `runner (${baseUrl}) に鍵を拒まれた（${error.status}）。` +
          'ALTEROID_RUNNER_TOKEN と runner の ALTEROID_RUNNER_TOKEN_SHA256 が揃っているか確かめること。',
        error.status,
      );
    }
    throw error;
  }
}

// 同一プロセスであることを伏せない: ローカル構成には既知の穴（マネージャーが `/proc/1/environ` から記憶ストアの鍵に届く）が残っているため。
// 「繋がっている」とは言わない: 名簿は動的で、ここに並ぶのは宛先であって生死ではないため。
function describeRunner(): string {
  const urls = parseRunnerUrls(process.env);
  return urls.length > 0
    ? `別プロセスの manager-runner（${urls.join(', ')}）。マネージャーはそこで走り、記憶ストアの鍵を持たない。` +
        '繋ぐのは背景なので、上がっていなければ委譲だけが待たされる'
    : '同一プロセスの runner（ローカル構成）。マネージャーはデーモンと同じ器で走るので、記憶ストアへの経路が残っている';
}

export function tokenRotationStream(event: TokenRotationEntry['event']): NodeJS.WritableStream {
  switch (event) {
    case 'rotated':
    case 'not_rotated':
    case 'restored':
    case 'recovered':
    case 'reopened':
      return process.stdout;
    // `parked` は異常側に置く: 運ぶ事実が「いま通る鍵が1本も無い」で、正常な行に混ぜると最も重い状態が最も普通の状態と同じ場所へ出るため。
    case 'exhausted':
    case 'sweep_stopped':
    case 'restore_failed':
    case 'parked':
      return process.stderr;
    // 既定へは倒さない: 倒すと新しい event が黙っていずれかの標準ストリームへ流れるため。
    default:
      return assertTokenRotationEventHandled(event);
  }
}

export function reopenedTokenOf(
  outcome: TokenRotationOutcome,
): { tokenId: string; label: string; how: ReopenedHow } | undefined {
  if (outcome.kind === 'rotated') {
    return { tokenId: outcome.toTokenId, label: outcome.toLabel, how: '回した' };
  }
  // `parked` は戻ったことにしない: 撒いた鍵はまだ通らず、起こしても同じところで止まって保持していた合図を1件無駄に焼くため。
  if (outcome.kind === 'ignored' && outcome.recovered !== undefined) {
    // `source` は拾わない: 宣言した戻り値の型に無い欄を spread で紛れ込ませないため。
    return {
      tokenId: outcome.recovered.tokenId,
      label: outcome.recovered.label,
      how: 'また通るようになった',
    };
  }
  // `parked` の側（起こさない）へ倒さない: こちらは `cooldownUntil` を過ぎたときにしか立たない。
  if (outcome.kind === 'ignored' && outcome.reopened !== undefined) {
    return {
      tokenId: outcome.reopened.tokenId,
      label: outcome.reopened.label,
      how: '冷却が明けた',
    };
  }
  return undefined;
}

// 3値を潰さない: 根拠の強さが違い、読む側が次に確かめるものが違うため。
type ReopenedHow = '回した' | 'また通るようになった' | '冷却が明けた';

type ReopenedToken = { tokenId: string; label: string; how: ReopenedHow };

// 呼び手ごとに判定を書き写さない: 片方だけ直したときに黙ってずれるため。
export function worthDeliveringNow(blocked: boolean, releasePending: boolean): boolean {
  return blocked && !releasePending;
}

// 値の正本を core 側に置く: `packages/core` は `apps/daemon` に依存できないため。
export const TOKEN_POOL_REOPENED_SOURCE = DAEMON_TOKEN_POOL_REOPENED_SOURCE;

export function isTokenPoolReopenedNotice(event: InboxEvent): boolean {
  return event.type === 'external' && event.source === TOKEN_POOL_REOPENED_SOURCE;
}

// 時間の窓や件数の上限で畳まず、最後に配った合図の身元を状態として持つ: 恣意的な定数は本物の合図を黙って失わせるため。
// `restore()` / `resumeStoppedByUsage()` はこの門に通さない: マネージャーはクローンと独立に枠で止まりうるため。
export interface CloneWakeGate {
  decide(
    reopened: ReopenedToken,
    cloneBlocked: boolean,
    releasePending: boolean,
    staleSameKeyRecovery?: boolean,
  ): { kind: 'wake'; folded: number } | { kind: 'fold' };
  observeUnusable(): void;
}

// 区切りに制御文字を使わず長さを前置きする: エスケープのつもりの NUL が実バイトで保存され、CI の `check-tracked-nul-bytes` が落ちたため。
function deliveredIdentity(reopened: ReopenedToken): string {
  return `${String(reopened.tokenId.length)}:${reopened.tokenId}${reopened.how}`;
}

export function createCloneWakeGate(): CloneWakeGate {
  const folded = new Map<string, number>();
  // トークン id ごとの Map にする: 単一の変数だと別トークンの配達で上書きされ、畳むべき合図が配られるため。
  // 全消去は `observeUnusable()` のときだけにする: `cloneBlocked` が偽の回に消すと、鍵が通らなくなっていないのに同じ合図がもう一度配られるため。
  const told = new Map<string, string>();
  return {
    decide(reopened, cloneBlocked, releasePending, staleSameKeyRecovery = false) {
      const tokenId = reopened.tokenId;
      // `回した` はこのトークンの印を先に捨てる: `rotated` は `observeUnusable()` を経ないため、A→B→A→B の2回目の起こし直しが畳まれる。
      // 身元に世代を入れない: 身元は受信箱の畳み込み鍵（`payload.identity`）にも使われ、同じ鍵へ回した未読が畳まれなくなるため。
      if (reopened.how === '回した') told.delete(tokenId);
      if (!worthDeliveringNow(cloneBlocked, releasePending)) {
        // ここでは `told` に触らない: 止まっていない／もう起こしてある、はどちらもこのトークンの鍵が通る・通らないを意味しないため。
        folded.set(tokenId, (folded.get(tokenId) ?? 0) + 1);
        return { kind: 'fold' };
      }
      // 3つ目の条件（`told` の一致）より前に見る: `observeUnusable()` が `told` を全消去した直後こそ、この輪が踏まれるため。
      // `told` は更新しない: 本物の配達が起きたわけではないため。
      if (staleSameKeyRecovery) {
        folded.set(tokenId, (folded.get(tokenId) ?? 0) + 1);
        return { kind: 'fold' };
      }
      const identity = deliveredIdentity(reopened);
      if (told.get(tokenId) === identity) {
        folded.set(tokenId, (folded.get(tokenId) ?? 0) + 1);
        return { kind: 'fold' };
      }
      const count = folded.get(tokenId) ?? 0;
      folded.delete(tokenId);
      told.set(tokenId, identity);
      return { kind: 'wake', folded: count };
    },
    observeUnusable() {
      told.clear();
    },
  };
}

export function describeReopenedTokenNotice(
  reopened: ReopenedToken,
  folded: number,
  observedAt: string,
): string {
  const base =
    `認証トークンが通る状態に戻った（${reopened.how}）: ` +
    `「${reopened.label}」（id ${reopened.tokenId}）。` +
    '枠で止まっていた仕事は、ここから再開できる。';
  if (folded <= 0) return base;
  return (
    `${base}（この間に同じ合図が ${String(folded + 1)} 件届き、1件にまとめた。` +
    `本文は ${observedAt} の観測である）`
  );
}

// `console.warn` で倒さず例外にする: `entry.event` はこのプロセスが直前に組み立てた値で、別デプロイを跨いで読み直した値ではないため。
function assertTokenRotationEventHandled(event: never): never {
  throw new Error(`alteroidd: 認証トークンの日誌で未知の event: ${String(event)}`);
}

/**
 * もう読まない層の provider の変数（`ALTEROID_CLONE_PROVIDER` / `ALTEROID_MANAGER_PROVIDER` /
 * `ALTEROID_CLONE_PEERS`。2026-10-07 の決定）が器に残っていれば、名前だけを1行ずつ stderr へ出す
 * （起動は止めない）。黙って無視すると、置いた人間は効いていると思ったままになる。
 */
export function reportRetiredLayerProviderEnv(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void = writeStderrSync,
): void {
  for (const notice of retiredLayerProviderNotices(env, 'alteroidd')) write(`${notice}\n`);
}

export async function main(): Promise<void> {
  // 読めない port は黙って既定やランダムな port へ倒さず断る: 設定の誤りが成功に見えるため。
  const resolvedPort = resolvePort(process.env);
  if (!resolvedPort.ok) throw new Error(resolvedPort.message);
  const port = resolvedPort.port;

  const storage = await openStorage();
  const { paths } = storage;

  // 日誌の書き手は `journalBus` を通す: 通さない書き手の追記は `GET /journal/stream` に流れないため。
  const journalBus = createJournalBus(storage.stores.journal);
  // 口だけ先に作り、地図が後から購読する: プールが `createApp` より先に作られるため。
  const workerToolBus = createWorkerToolBus();
  const stores: Stores = { ...storage.stores, journal: journalBus.journal };

  await seedDefaultEnvVars(stores);
  // 子へ渡す env の土台は書き写す前のスナップショットにする: 書き写した後の `process.env` だと、正本から外した名前の古い値が子に残り続けるため。
  const bootEnvSnapshot: NodeJS.ProcessEnv = { ...process.env };
  await migrateEnvBaseCredentialsOnce(stores, bootEnvSnapshot);
  const localRunnerEnv: NodeJS.ProcessEnv = { ...bootEnvSnapshot };
  await applyAppScopedEnvVars(stores, process.env, localRunnerEnv);
  await pruneExtractedPluginsOnBoot({ root: paths.root, store: stores.plugins });

  const workspace = process.env.ALTEROID_WORKSPACE || process.cwd();

  // 器の生死や設定の押し込みの不明は日誌へ載せない: 黙って死んだ器へ挑み直すたびに1行増え、`journal_read` の窓が同じ行で埋まって本物の記録が押し出されるため。
  const reportRunnerUnknown = (report: RunnerUnknownReport): void => {
    if (managerIdOfRunnerPath(report.path) === undefined) {
      process.stderr.write(`alteroidd: ${describeRunnerUnknown(report)}\n`);
      return;
    }
    void stores.journal
      .append({ type: 'external_event', source: 'runner', summary: describeRunnerUnknown(report) })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: runner の期限切れを日誌へ残せませんでした: ${reasonOf(error)}\n` +
            `  ${describeRunnerUnknown(report)}\n`,
        );
      });
  };

  const reportRunnerDropped = (report: RunnerDroppedEventReport): void => {
    const summary = describeRunnerDropped(report);
    void stores.journal
      .append({ type: 'external_event', source: 'runner', summary })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: runner の捨てた出来事を日誌へ残せませんでした: ${reasonOf(error)}\n` +
            `  ${summary}\n`,
        );
      });
  };

  const reportRunnerLost = (report: { label: string; runnerId?: string; error: string }): void => {
    const summary =
      `runner (${report.label}${report.runnerId === undefined ? '' : ` / ${report.runnerId}`}) を` +
      `失いました（onLost）: ${report.error}`;
    void stores.journal
      .append({ type: 'external_event', source: 'runner', summary })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: runner を失ったことを日誌へ残せませんでした: ${reasonOf(error)}\n` +
            `  ${summary}\n`,
        );
      });
  };

  const seeds = runnerSeeds({
    workspace,
    env: localRunnerEnv,
    withheldEnvKeys: storage.withheldEnvKeys,
    profilePath: join(paths.state, 'runner-profile.sh'),
    onRunnerUnknown: reportRunnerUnknown,
    onRunnerDropped: reportRunnerDropped,
  });

  // 宛先は後から差し替える: クローンが立ち上がるより先に名簿が動きうるため（`takeOverOnSwap` / `relocateOnLost` / `autoFoldOnPlacementResources` も同じ）。
  // 直に呼ばない: まだ初期化されていない `const` を触る経路が残るため。
  let postToClone: ((text: string) => void) | undefined = undefined;
  const announce = (text: string): void => {
    process.stderr.write(`alteroidd: ${text}\n`);
    postToClone?.(text);
  };
  let takeOverOnSwap: (runnerId?: string) => void = () => {};
  let relocateOnLost: (runnerId?: string) => void = () => {};
  let autoFoldOnPlacementResources: (
    reports: readonly {
      readonly runnerId: string;
      readonly resources: RunnerPlacementResources | undefined;
    }[],
  ) => void = () => {};
  const runners = createRunnerRegistry([], {
    notify: ({ label, error }) => {
      announce(
        `runner (${label}) を開けず、挑み直しても直らない失敗だったので諦めました: ${redactErrorText(error, process.env)}`,
      );
    },
    onLost: ({ label, runnerId, error }) => {
      announce(
        `runner (${label}${runnerId === undefined ? '' : ` / ${runnerId}`}) が` +
          `名乗らなくなりました。新しい委譲の宛先からは外し、` +
          `そこで走っていた委譲の移送を試みます` +
          `（貸し出し期限が切れていない委譲は、切れてから自動で移します）: ${redactErrorText(error, process.env)}`,
      );
      reportRunnerLost({ label, runnerId, error });
      relocateOnLost(runnerId);
    },
    // 起こす口は `reattachRunner` と `takeOver()` の両方を繋ぐ: `restore()` だけに繋いだ版は1本も拾えなかったため。
    // 数えられない・読めないときは必ずクローンを起こす: 起こさないのは対象が0本と数え切れたときだけ。
    // 起こさなかった回は `external_event` ではなく `decision` で残す: 起こしたかどうかが日誌から区別できなくなるため。
    onSwap: ({ label, runnerId, before, after }) => {
      const text =
        `runner (${label}${runnerId === undefined ? '' : ` / ${runnerId}`}) に` +
        `別のプロセスが応え始めました（器の入れ替え）。` +
        `そこで走っていた委譲の引き取りを試みます` +
        `（貸し出し期限が切れていない委譲は、切れてから自動で引き取ります）: ` +
        `${before} → ${after}`;
      process.stderr.write(`alteroidd: ${text}\n`);
      void noteRunnerSwap({
        notice: text,
        runnerId,
        listJobs: () => stores.jobs.listJobs(),
        aliveRunnerIds: () =>
          new Set(
            runners
              .entries()
              .flatMap((entry) =>
                entry.state === 'connected' && entry.runnerId !== undefined ? [entry.runnerId] : [],
              ),
          ),
        journal: (entry) => stores.journal.append(entry),
        wake: postToClone,
        warn: (message) => process.stderr.write(`alteroidd: ${message}\n`),
      });
      takeOverOnSwap(runnerId);
    },
    // `await` しない: `select()`（延いては `manager_start` の応答）を待たせないため。
    onPlacementResources: (reports) => {
      autoFoldOnPlacementResources(reports);
    },
  });
  const runnerDescription = describeRunner();

  // 差し替えられたモデル帯は黙って通さない: 上位帯から降りたことが起動ログに出ていなければ誰も気づけないため。
  const cloneModel = resolveCloneModel();
  if (cloneModel !== CLONE_MODEL) {
    process.stdout.write(
      `alteroidd: クローンのモデル帯を ${CLONE_MODEL} から ${cloneModel} へ差し替えています` +
        `（${CLONE_MODEL_ENV_KEY}）。既定へ戻すにはこの環境変数を外してください\n`,
    );
  }

  // 値が読めない綴りでもそのまま出す: 直後の `createClone` が落ちた後のログだけでは、置いた本人が綴りを疑えないため。
  const placedClonePermission = placedClonePermissionMode();
  if (placedClonePermission !== null) {
    process.stdout.write(
      `alteroidd: ${CLONE_PERMISSION_MODE_ENV_KEY} が置かれています` +
        `（既定 ${DEFAULT_PERMISSION_MODE} → ${placedClonePermission}）。` +
        `これは実行環境の設定であって、クローンの道具を減らすものではありません\n`,
    );
  }

  // 正本はここではない: 実際に SDK へ渡すのは runner で、ここが読むのは自己認識に載せる宣言のため。
  const placedManagerTiers = placedManagerModels();
  for (const { key, value, fallback } of placedManagerTiers) {
    process.stdout.write(
      `alteroidd: ${key} が置かれています（既定 ${fallback} → ${value}）。` +
        `実際にセッションへ渡すのは runner なので、効いているかは runner の起動ログで確かめてください\n`,
    );
  }

  reportRetiredLayerProviderEnv(process.env);

  // プロファイルからは伏せる名前を置かせない: 開けると、保存の入口を通ったものがそのまま runner へ降り、下の層の境界を上書きできてしまうため。
  const profile = createProfileApplier({
    vessel: createProfileVessel({
      path: join(paths.state, 'profile.sh'),
      withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...storage.withheldEnvKeys],
    }),
    baseEnv: () => process.env,
  });

  // インスタンスは1つだけ作って全経路へ渡す: 別インスタンスを持つと直列化の意味が消え、層ごとに違う本文が残る（`mcpServerService` / `credentialService` も同じ）。
  const profileService = createProfileService({ stores, applier: profile, runners });

  const mcpServerService = createMcpServerService({ stores, runners });

  const pluginDistributionService = createPluginDistributionService({ stores, runners });

  const credentialService = createCredentialService({
    stores,
    runners,
    // 伏せる鍵の名前を渡す: 渡し忘れると、伏せたはずの環境変数を鍵の名前として注入し直せる穴が開くため。
    withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...storage.withheldEnvKeys],
    // 再開の合図は入れない: 鍵の枠切れと違い、止まっていた層を起こす理由が無いため。
    onApplied: () => {
      clone.recycleSessionForToken();
    },
  });

  // 1つだけ作って `tokenPoolService` と `tokenRotator` の両方へ渡す: 別々だと互いの `serial()` が待たず、`PUT /tokens` 直後の `observe()` が古い一覧で書き戻して足した鍵が消える。
  const tokenPoolWriteLock = createTokenPoolWriteLock();

  const tokenPoolService = createTokenPoolService({
    stores,
    writeLock: tokenPoolWriteLock,
    onChanged: (change) => {
      tokenWatch?.poke(change === 'settings' ? 'settings_changed' : 'pool_changed');
    },
  });

  {
    // 保存はし直さない: 書くとデーモンを起こしただけで `updatedAt` が動き、本文を最後に変えた時刻の意味が消えるため。
    const applied = await profileService
      .restore()
      .catch((error: unknown) => ({ ok: false, error: reasonOf(error), output: undefined }));
    if (applied !== null && !applied.ok) {
      // 黙って古い環境で走らせない: 何が効いていないかが見えないと、鍵が届いていないのか権限が足りないのかを切り分けられないため。
      process.stderr.write(
        `alteroidd: 実行環境プロファイルを読めませんでした（クローンには効きません）: ${applied.error ?? '理由不明'}\n`,
      );
    }
  }

  const hostname = process.env.ALTEROID_BIND || DEFAULT_BIND;

  const authPlan = planAuth(process.env, { port });
  process.stdout.write(`alteroidd: ${authPlan.description}\n`);

  // 鍵は入れない: そのままシステムプロンプトへ載るため。
  const self: SelfFacts = {
    storage: storage.description,
    // パスだけを渡さない: pg 構成でここに残るのは state だけで記憶ではなく、「記憶: PostgreSQL」と並べたときに矛盾して見えるため。
    local:
      storage.kind === 'pg'
        ? `${paths.root}（デーモンのローカル状態だけ。記憶は上の器にあり、ここには無い）`
        : `${paths.root}（記憶もここにある。人間が直接開いて書き換える）`,
    workspace,
    // `createClone` へ渡す `cwd` と同じ値にする: 違うと自己認識が嘘になるため。
    cwd: paths.root,
    runner: runnerDescription,
    // 待ち受けアドレスではなく人間が叩く先を渡す: `ALTEROID_BIND=0.0.0.0` は入口ではなく、TLS を手前で終端すれば scheme も違うため。
    entrypoint: authPlan.publicBaseUrl,
    auth: authPlan.description,
    // 固定値を載せない: 人間が帯を動かしたのに、クローンは既定を自分の帯だと思ったまま判断するため。
    models: {
      clone: cloneModel,
      manager: resolveManagerModel(),
      worker: resolveWorkerModel(),
    },
  };

  // 箱を先に作る: probe が現役の env でアカウントを測るために要り、渡さないと回した後は降りたトークンのアカウントを測り続けるため。
  const agentTokenHolder = createAgentTokenHolder();

  // `= undefined` を明示する: `let` だけだと `prefer-const` が `const` を勧めるが、上の closure がこの束縛を参照するため `const` にできない。
  let tokenWatch: TokenRotationWatch | undefined = undefined;
  let tokenTrialWatch: TokenTrialWatch | undefined = undefined;

  // 高々1つしか持たない: 畳むより先に2回回ったら、前の回の合図は古い鍵の話で、入れても同じ結論を2回焼くだけのため。
  // 畳まれるまで入れない: ターンの最中に入れると古い鍵のターンに消費されて、そのターンが死ぬため。
  let pendingTokenWake: (() => void) | undefined = undefined;

  const cloneWakeGate = createCloneWakeGate();

  const tokenRotationJournalFold = new TokenRotationJournalFold();

  // 実セッションに相乗りしない: ターンを回した直後のセッションへ usage 要求を出すと `ProcessTransport is not ready for writing` で失敗するため。
  const usagePoller = startUsagePolling({
    queryFn: query,
    cwd: paths.root,
    env: () => agentTokenHolder.values(),
    identity: () => agentTokenHolder.identity(),
    onState: (state, measuredBy) => {
      tokenWatch?.observeAccount(state, measuredBy);
    },
    withheldEnvKeys: storage.withheldEnvKeys,
  });

  // 器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）へフォールバックしない: トークンプールは DB 駆動のみで、通る行が無い状態を環境変数で埋め合わせる経路を残さないため。
  const tokenRotator = createTokenRotator({
    stores,
    writeLock: tokenPoolWriteLock,
    probe: {
      probe: (token) =>
        probeTokenCandidate(query, {
          token: token.value,
          cwd: paths.root,
          withheldEnvKeys: storage.withheldEnvKeys,
        }),
    },
    spread: createTokenSpread({
      runners,
      clone: agentTokenHolder,
      profileEnvNames: () => Promise.resolve(Object.keys(profile.env())),
      onShadowed: (names) => {
        process.stderr.write(
          `alteroidd: 実行環境プロファイルが認証の鍵と同じ名前を宣言しています。` +
            `回した鍵はこれで上書きされます: ${names.join(', ')}\n`,
        );
      },
    }),
  });

  // クローンを作る前に撒き直す: `createClone` は構築の中でループを回し始めるので、後にすると最初のターンが撒く前の状態で走る窓ができるため。
  {
    const restored = await tokenRotator
      .restore()
      .catch((error: unknown) => ({ kind: 'failed' as const, why: reasonOf(error) }));
    // `restore()` が投げた場合は `tokenRestoreEntry` を通さない: `TokenRestoreOutcome` ではなく型が受けないため。
    const entry =
      restored.kind === 'failed'
        ? ({
            type: 'token_rotation' as const,
            event: 'restore_failed' as const,
            text: `認証トークン: 起動時の撒き直しが落ちた。${restored.why}`,
          } satisfies TokenRotationEntry)
        : tokenRestoreEntry(restored);
    if (entry !== null) {
      tokenRotationStream(entry.event).write(
        `alteroidd: ${entry.text.split('\n')[0] ?? entry.text}\n`,
      );
      await stores.journal.append(entry).catch((error: unknown) => {
        noteDroppedRecord('認証トークンの撒き直し', 'journal', error);
      });
    }
  }

  const clone = createClone({
    childEnvBase: bootEnvSnapshot,
    stores,
    accountUsage: () => usagePoller.state(),
    scheduler: () => scheduler.list(),
    onScheduledRunNotStarted: (kind, delayMs) => scheduler.retrySoon(kind, delayMs),
    cwd: paths.root,
    runners,
    profile,
    profileService,
    credentialService,
    // `storage.withheldEnvKeys` は使わない: pg 構成では `ALTEROID_DATABASE_URL` を含み、それはクローンが記憶ストアへ到達するために要る鍵のため。
    withheldEnvKeys: [...AUTH_WITHHELD_ENV_KEYS],
    mcpServerService,
    pluginDistributionService,
    self,
    credentials: () => agentTokenHolder.values(),
    tokenIdentity: () => agentTokenHolder.identity(),
    syncRunnerToken: createRunnerTokenSync(agentTokenHolder),
    // 取り出してから呼ぶ: 呼んだ後に消すと、合図の中で例外が出た回だけ残り、次に畳まれたときにもう一度入るため。
    onTokenSessionRecycled: () => {
      const wake = pendingTokenWake;
      pendingTokenWake = undefined;
      wake?.();
    },
    onWorkerToolEvent: (event) => workerToolBus.emit(event),
    onUsageObservation: async (observation) => {
      // 成功の観測は `observe` へ渡さない: あちらは枠の観測しか扱わず、成功は別の生産者（`reconsider` の `turn_success`）へ振るため。
      if (observation.succeeded === true) {
        tokenWatch?.observeTurnSuccess(observation.observedBy);
        return;
      }
      if (isRejectionForTrialBackoff(observation)) {
        tokenTrialWatch?.noteRejection(observation.observedBy.tokenId);
      }
      const outcome = await tokenRotator.observe(observation);
      // 当たった文言は言い換えずそのまま添える: 人間が claude.ai と突き合わせられ、回復の見込みの分類も効くため。
      await settleTokenOutcome(outcome, {
        ...(observation.notice === undefined ? {} : { noticeText: observation.notice.text }),
      });
    },
    ...(storage.sessionStore === undefined ? {} : { sessionStore: storage.sessionStore }),
    // `wake()` と同じ関数を呼ぶ: `#restoreUnread` は `post()` を通らず、同じ鍵・同じ resetsAt への使い回しを畳む条件が自動では掛からないため。
    redeliveryGate: (
      event,
      { usageBlocked, releasePending, usageBlockedResetsAt, usageBlockedTokenId },
    ) =>
      isTokenPoolReopenedNotice(event)
        ? worthDeliveringNow(usageBlocked, releasePending) &&
          !staleObservedRecoveryNoticeEvent(event, usageBlockedResetsAt, usageBlockedTokenId)
        : true,
  });

  const managerPoller = startManagerPolling({
    managers: clone.managers,
  });

  const archiveFoldConfig = readArchiveFoldConfig();
  for (const note of archiveFoldConfig.notes) process.stderr.write(`alteroidd: ${note}\n`);
  const archiveFolder = startArchiveFolding({
    stores,
    managers: clone.managers,
    everyMinutes: archiveFoldConfig.everyMinutes,
  });

  const attachmentPruneConfig = readAttachmentPruneConfig();
  for (const note of [...readAttachmentLimits().notes, ...attachmentPruneConfig.notes]) {
    process.stderr.write(`alteroidd: ${note}\n`);
  }
  const attachmentPruner = startAttachmentPruning({
    stores,
    copiesDir: attachmentCopiesDir(paths.root),
    everyMinutes: attachmentPruneConfig.everyMinutes,
  });

  // 観測から来た回と状態から来た回で同じここを通す: 別々に書くと、片方だけが `parked` を知らない・セッションを作り直す、という食い違いが静かに生まれるため。
  async function settleTokenOutcome(
    outcome: TokenRotationOutcome,
    observed?: { noticeText?: string },
  ): Promise<void> {
    const entry = tokenRotationEntry(outcome, observed);

    // `parked` でもセッションを作り直す: 冷却が明けた後に古い鍵のまま挑むのが最悪の形のため。
    // 返り値を捨てない: `'deferred'` のときに再開の合図を先に入れると、古い鍵のターンに消費されてそのターンが死ぬため。
    const recycled =
      outcome.kind === 'rotated' || outcome.kind === 'parked'
        ? clone.recycleSessionForToken()
        : 'now';

    // `parked` では起こさない: 撒いた鍵は `cooldownUntil` まで通らず、起こしても同じところで止まって保持していた合図を1件無駄に焼くため。
    // マネージャーの `restore()` はクローンの門と無関係に呼ぶ: マネージャーはクローンと独立に枠で止まりうるため。
    // `reopenedTokenOf` より前に呼ぶ: 鍵が通らなくなったことを観測した後の「また通るようになった」は新しい知らせとして配る必要があるため。
    if (outcome.kind === 'parked' || outcome.kind === 'exhausted') {
      cloneWakeGate.observeUnusable();
    }

    const reopened = reopenedTokenOf(outcome);
    if (reopened !== undefined) {
      // 合図は新しい鍵で受け取れるようになってから入れる: 走行中のターンは古い鍵のままで、そこへ入れると合図がそのターンに消費されるため。
      const wake = () => {
        // 判定は `staleObservedRecoveryForBlockedKey` と同じ関数を呼び、コピーしない: 片方だけ直したときに黙ってずれるため。
        const observedRecovery = reopened.how === 'また通るようになった';
        const staleSameKeyRecovery = staleObservedRecoveryForBlockedKey({
          observedRecovery,
          reopenedTokenId: reopened.tokenId,
          blockedResetsAt: clone.usageBlockedResetsAt,
          blockedTokenId: clone.usageBlockedTokenId,
        });
        const decision = cloneWakeGate.decide(
          reopened,
          clone.usageBlocked,
          clone.usageReleasePending,
          staleSameKeyRecovery,
        );
        if (decision.kind === 'fold') {
          // 畳んだ理由は4つを言い分ける: 潰すと、往復・ターンを跨いだ反復・同じ鍵の使い回し・本当に静かな場合が跡から読めなくなるため。
          const why = !clone.usageBlocked
            ? 'クローンは枠で止まっていないので起こさない'
            : clone.usageReleasePending
              ? 'クローンは枠で止まっているが、再開の印が既に立っている（もう起こしてあるので重ねない）'
              : staleSameKeyRecovery
                ? '同じ鍵・同じ回復予定時刻（resetsAt）に対する観測ベースの使い回しで、プールの構成は変わっていない'
                : '前に同じ合図（同じ鍵・同じ根拠）を配ってあり、そのあいだ鍵が通らなくなったことを観測していない';
          process.stdout.write(
            `alteroidd: 認証トークンが通る状態に戻った合図を畳んだ（${why}）: ` +
              `「${reopened.label}」（id ${reopened.tokenId}）\n`,
          );
        } else {
          // 本文の観測時刻と合図の `at` は同じ値にする: `new Date()` を2回呼ぶと本文の内側と外側でズレた時刻を名乗るため。
          const observedAt = new Date().toISOString();
          clone.post({
            type: 'external',
            id: randomUUID(),
            at: observedAt,
            source: TOKEN_POOL_REOPENED_SOURCE,
            payload: {
              text: describeReopenedTokenNotice(reopened, decision.folded, observedAt),
              tokenId: reopened.tokenId,
              observedRecovery,
            },
            // 畳み込みの鍵を `payload.text` から取らない: 畳んだ件数を含むため、件数が違うだけで別の鍵になり受信箱側の畳み込みが効かない。
            identity: deliveredIdentity(reopened),
          });
        }
        // クローンの門に巻き込まず常に呼ぶ: マネージャーはクローンと独立に枠で止まりうるため。
        // 待たない: 引き取りは runner への問い合わせで落ちうる・遅いため、回した結果の記録を縛らない。
        // `restore()` → `resumeStoppedByUsage()` の順を逆にも並行にもしない: 同じ委譲へ一言が2つ入る窓ができるため。
        void clone.managers
          .restore()
          .then(() => clone.managers.resumeStoppedByUsage())
          .then((nudged) => {
            if (nudged.length === 0) return;
            process.stdout.write(
              `alteroidd: 認証トークンが戻ったので、枠で止まっていた委譲へ続きを促しました: ${nudged.join(', ')}\n`,
            );
          })
          .catch((error: unknown) => {
            process.stderr.write(
              `alteroidd: 認証トークンが戻った後のマネージャーの引き継ぎに失敗しました: ${reasonOf(error)}\n`,
            );
          });
      };
      if (recycled === 'now') wake();
      else pendingTokenWake = wake;
    }

    if (entry === null) return;
    // 畳みの外で常に書く: 畳むのは日誌への追記だけのため。
    tokenRotationStream(entry.event).write(
      `alteroidd: ${entry.text.split('\n')[0] ?? entry.text}\n`,
    );

    // 要約を先に書く: 日誌は時系列で読まれ、要約より後に次の1件目が来る必要があるため。
    const folded = tokenRotationJournalFold.observe(entry, Date.now());
    if (folded.summary !== undefined) {
      await stores.journal.append(folded.summary).catch((error: unknown) => {
        noteDroppedRecord('認証トークンの切替（畳んだ要約）', 'journal', error);
      });
    }
    if (!folded.write) return;
    // 追記の失敗を投げ直さない: 回せたのに「回し手が落ちた」として報告されるため。
    await stores.journal.append(entry).catch((error: unknown) => {
      noteDroppedRecord('認証トークンの切替', 'journal', error);
    });
  }

  tokenWatch = startTokenRotationWatch({
    rotator: tokenRotator,
    onOutcome: (outcome) => settleTokenOutcome(outcome),
  });

  tokenTrialWatch = startTokenTrialWatch({
    stores,
    trial: {
      trial: (token) =>
        runTokenTrial(query, {
          token: token.value,
          cwd: paths.root,
          // クローンの層と同じモデルを渡す: 枠がモデル別のことがあり、層とモデルが違うと試しが通っても層は通らない偽陽性になるため。
          model: cloneModel,
          withheldEnvKeys: storage.withheldEnvKeys,
        }),
    },
    reconsider: (input) => tokenRotator.reconsider(input),
    recordTrialVerdict: (input) => tokenRotator.recordTrialVerdict(input),
    onOutcome: (outcome) => settleTokenOutcome(outcome),
  });

  // 撒き直しの後に見直す: 先に記録どおりの状態を作らないと、撒き直せていない状態を見て判定することになるため。
  tokenWatch.poke('startup');

  // 起動ごとに作り直す: 状態ファイルが残っていても、PID の再利用で別プロセスを自分だと誤認させないため。
  const token = randomUUID();

  const schedule = readScheduleConfig();
  for (const note of schedule.notes) process.stderr.write(`alteroidd: ${note}\n`);
  const scheduler = createScheduler({
    entries: buildSchedule(schedule),
    post: (event) => clone.post(event),
    schedules: stores.schedules,
    inbox: stores.inbox,
    // 位相の読み書きの失敗を黙らせない: 時計は止まらないので、ここが唯一「効いていない」に気づける場所のため。
    onError: (message) => {
      process.stderr.write(`alteroidd: ${message}\n`);
    },
  });

  postToClone = (text: string): void => {
    clone.post({
      type: 'external',
      id: randomUUID(),
      at: new Date().toISOString(),
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: { text },
    });
  };

  // 起動時に1度きりにしない: runner を待たずに立ち上がる構成では、誰も繋がっていない名簿を見て「引き取るものは無い」と結論してしまうため。
  const takeOver = async (): Promise<void> => {
    const restored = await clone.managers.restore().catch((error: unknown) => {
      process.stderr.write(`alteroidd: マネージャーの引き継ぎに失敗しました: ${reasonOf(error)}\n`);
      return [];
    });
    if (restored.length > 0) {
      process.stdout.write(
        `alteroidd: 再起動前のマネージャーを引き継ぎました: ${restored
          .map((manager) => manager.managerId)
          .join(', ')}\n`,
      );
    }
  };
  runners.subscribe(() => {
    void takeOver();
    tokenWatch?.poke('runner_connected');
  });
  // 起こす数をこちらで絞らない: 絞った回に現れた委譲が拾われないため。
  takeOverOnSwap = (runnerId) => {
    if (runnerId !== undefined) {
      void clone.managers.reattachRunner(runnerId).catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: 入れ替わった runner (${runnerId}) の取り直しに失敗しました: ${reasonOf(error)}\n`,
        );
      });
    }
    void takeOver();
    tokenWatch?.poke('runner_connected');
  };
  relocateOnLost = (runnerId) => {
    if (runnerId !== undefined) clone.managers.relocateFrom(runnerId);
  };
  autoFoldOnPlacementResources = (reports) => {
    for (const report of reports) {
      // `pids` が取れなかった器は渡さない: 「聞けなかった」を「逼迫していない」に倒さないため。
      if (report.resources?.pids === undefined) continue;
      clone.managers.autoFoldOnPlacementPressure?.(report.runnerId, report.resources.pids);
    }
  };

  // 捨てた値は黙って飲み込まない: 許可したつもりとの差が境界の穴になるため。
  const { origins: allowedOrigins, rejected } = parseAllowedOrigins(
    process.env.ALTEROID_ALLOWED_ORIGINS,
  );
  for (const value of rejected) {
    process.stderr.write(
      `alteroidd: ALTEROID_ALLOWED_ORIGINS の "${value}" を無視しました` +
        '（scheme://host[:port] の形だけを受け付けます。* と経路付きは不可）\n',
    );
  }
  if (allowedOrigins.length > 0) {
    process.stdout.write(
      `alteroidd: 次のオリジンからのブラウザ呼び出しを許可します: ${allowedOrigins.join(', ')}\n`,
    );
  }

  const app = createApp({
    clone,
    stores,
    token,
    shutdown: () => void shutdown(),
    scheduler,
    storage: storage.description,
    runners,
    journalEvents: journalBus,
    workerToolEvents: workerToolBus,
    storageProbe: storage.probe,
    accountUsage: () => usagePoller.state(),
    allowedOrigins,
    auth: { plan: authPlan },
    profile: profileService,
    credentials: credentialService,
    mcpServers: mcpServerService,
    tokens: tokenPoolService,
    clearSessionLog: storage.clearSessionLog,
  });
  // 黙って外へ出さない: ここは叩けばクローンのターンが起きる実行の口のため。
  if (hostname !== DEFAULT_BIND && hostname !== 'localhost' && hostname !== '::1') {
    process.stderr.write(
      authPlan.enabled
        ? `alteroidd: ${hostname} で待ち受けます。認証は有効ですが、` +
            'TLS は手前の層（リバースプロキシ・トンネル）で終端してください' +
            '（トークンが平文で流れます）。\n'
        : `alteroidd: ${hostname} で待ち受けます。この API に認証はありません。` +
            '手前に境界（リバースプロキシ・トンネル・認証）を置いてください。\n',
    );
  }

  const server = serve({ fetch: app.fetch, port, hostname });

  server.on('connection', (socket) => {
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
  });

  server.on('error', (error: unknown) => {
    // `process.stderr.write` は使わない: fd がパイプだと非同期で、直後の exit に巻き込まれて書いた行が失われることがあるため。
    writeStderrSync(`alteroidd: 待ち受けに失敗しました (port ${port}): ${reasonOf(error)}\n`);
    process.exit(1);
  });

  // 待ち受けを開けてから runner へ繋ぐ: 逆にすると、runner に依存しない chat・日誌・日報・承認への回答が runner が上がるまで受け付けられない。
  for (const seed of seeds) {
    void runners.register(seed).catch((error: unknown) => {
      process.stderr.write(
        `alteroidd: runner (${seed.label}) を名簿に載せられません: ${reasonOf(error)}\n`,
      );
    });
  }

  let dailyReportCatchup: DailyReportCatchup | undefined;
  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    // 締切の起点は SIGTERM（この関数に入った瞬間）にする: 最後の蒸留が長引いたぶんは待ちから引かれ、強制 exit を超えないため。
    const farewellDeadlineAt = Date.now() + RUNNER_FAREWELL_DEADLINE_MS;

    scheduler.stop();
    dailyReportCatchup?.stop();
    usagePoller.stop();
    managerPoller.stop();
    archiveFolder.stop();
    attachmentPruner.stop();
    tokenWatch?.stop();
    tokenTrialWatch?.stop();
    const foldedAtShutdown = tokenRotationJournalFold.flush();
    if (foldedAtShutdown !== undefined) {
      await stores.journal.append(foldedAtShutdown).catch((error: unknown) => {
        noteDroppedRecord('認証トークンの切替（畳んだ要約、停止時）', 'journal', error);
      });
    }
    server.close();
    await runners.stop().catch(() => undefined);
    await clearRuntimeInfo(paths.state).catch(() => undefined);

    const forced = setTimeout(() => process.exit(0), FORCED_EXIT_MS);
    forced.unref();
    try {
      await clone.stop({ farewellDeadlineAt });
    } catch {
      // 片付けに失敗しても落ちる
    }
    await storage.close().catch(() => undefined);
    process.exit(0);
  }

  await writeRuntimeInfo(paths.state, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    token,
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await scheduler.refresh().catch((error: unknown) => {
    process.stderr.write(`alteroidd: 継続中の依頼を読み込めませんでした: ${reasonOf(error)}\n`);
  });
  scheduler.start();

  const standing = scheduler.list().filter((entry) => entry.request !== undefined);
  if (standing.length > 0) {
    process.stdout.write(
      `alteroidd: 継続中の依頼: ${standing.map((entry) => entry.kind).join(', ')}\n`,
    );
  }

  if (schedule.dailyReportAt !== null) {
    dailyReportCatchup = startDailyReportCatchup({
      journal: stores.journal,
      at: schedule.dailyReportAt,
      lookbackDays: schedule.reportLookbackDays,
      post: (event) => clone.post(event),
      retryDelaysMs: DAILY_REPORT_RETRY_DELAYS_MS,
    });
  }

  process.stdout.write(
    `alteroidd: http://${hostname}:${port} （記憶: ${storage.description} / 作業: ${workspace}）\n`,
  );
}

// argv[1] を素の文字列と比べない: `import.meta.url` は realpath 済み・パーセントエンコード済みで、空白入りパスや symlink で誤判定するため。
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // module のトップレベルにも `main()` の中にも置かない: 前者は `main` を import するテストにまで網が張られ、後者は `main()` の頭までの窓が開く。
  // `uncaughtException` へ上げない: 既定の終了が止まり、器が「壊れた」と判定できる唯一の材料（プロセスの終了）が消えるため。
  installUncaughtNet('alteroidd');

  main().catch((error: unknown) => {
    writeStderrSync(`alteroidd: 起動に失敗しました: ${reasonOf(error)}\n`);
    process.exit(1);
  });
}
