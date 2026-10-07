import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import type {
  AgentContentBlock,
  AgentDelegationNotified,
  AgentDelegationStarted,
  AgentEvent,
  AgentPermissionDenial,
  AgentTurnEnded,
} from './agent-events.js';
import type {
  AgentContextOutcome,
  AgentPermissionDeniedDecision,
  AgentPermissionDeniedRecord,
  AgentPreCompactRecord,
  AgentPreToolDecision,
  AgentPreToolRecord,
  AgentPreToolRewrite,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import { DEFAULT_AGENT_PROVIDER_ID, type AgentProviderId } from './agent-ports.js';
import { describeBashToolTimeoutRaise, planBashToolTimeoutRaise } from './bash-tool-timeout.js';
import { resolveBashGuardMode, type BashGuardMode } from './bash-guard-mode.js';
import { inspectReleaseProdDispatch } from './bash-release-prod-guard.js';
import { inspectBashCommand } from './bash-wait-guard.js';
import { cgroupEventsDeltaOf } from './cgroup-events.js';
import { ClaudeManagerDriver, type ClaudeQueryFn } from './claude-manager-driver.js';
import { CodexManagerDriver, type CodexChatgptAuthHandle } from './codex-manager-driver.js';
import {
  CodexAuthMirror,
  type CodexAuthMirrorStatus,
  type CodexAuthPush,
  type CodexAuthWriteBack,
} from './codex-auth-mirror.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';
import { resolveCloneToolRelayChildEntry } from './clone-tools-transport.js';
import {
  createPeerBroker,
  PEER_MCP_SERVER_NAME,
  PEER_SYSTEM_PROMPT_APPEND,
  peerApprovalMark,
  type PeerApprovalSource,
  type PeerBroker,
} from './peer-broker.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import type {
  AgentChildProcess,
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentSessionLog,
  AgentSessionLogKey,
  AgentSpawnOptions,
  AgentInputImage,
  AgentUserInput,
} from './agent-session.js';
import { CONTEXT_USAGE_CATEGORY_LIMIT } from './context-usage.js';
import { denialInputShape, type DeniedRecord } from './denial-shape.js';
import { buildDenialInputHead, matchInputOf, redactErrorText } from './denial-input-head.js';
import {
  noteBackgroundFailure,
  noteMissingRecordSource,
  noteUnclassifiedFailure,
  noteUnclassifiedFailuresSummary,
  noteUnreadableRecord,
  reasonOf,
} from './dropped-record.js';
import { fingerprintOf, ROTATABLE_CREDENTIAL_KEYS } from './credentials.js';
import type { CredentialEntry, CredentialFingerprint, CredentialStore } from './credentials.js';
import { codePointBoundary, excerptLine } from './excerpt.js';
import { mcpServerNames, mcpServersFingerprintOf, parseMcpServers } from './mcp-servers.js';
import type { McpServers } from './mcp-servers.js';
import { placedModelTier, resolveModelTier } from './model-tier.js';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';
import { createProfileApplier, type ProfileApplier, type ProfileVessel } from './profile.js';
import { createRecentMap } from './recent.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import {
  RunnerCutOffWorkers,
  type CutOffBackgroundTaskSummary,
  type PendingBackgroundTaskOutput,
} from './runner-cut-off-workers.js';
import { readCgroupEventCounters, type CgroupEventCounters } from './runner-resources.js';
import { RunnerSdkSession } from './runner-sdk-session.js';
import {
  composeAttachmentInput,
  defaultRunnerAttachmentsRoot,
  placeRunnerAttachments,
  pruneStaleAttachmentDirs,
  removeManagerAttachments,
} from './runner-attachments.js';
import {
  BACKGROUND_TASK_OWNER_LIMIT,
  RunnerSubagentStopState,
  SUBAGENT_BACKGROUND_WAIT_MS,
} from './runner-subagent-stop-state.js';
import {
  recoverFromFailedResume,
  type ResumeRecoveryHost,
  type ResumeRecoveryOutcome,
} from './runner-resume-recovery.js';
import { RunnerResumeState } from './runner-resume-state.js';
import { RunnerTurnTally } from './runner-turn-tally.js';
import { RunnerWorkerWaitWindow } from './runner-worker-wait-window.js';
import { WorkerToolWatch, type WorkerToolWatchClock } from './runner-worker-tool-watch.js';
import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerEvent,
  RunnerLease,
  RunnerManagerState,
  RunnerMcpServersFingerprint,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerAttachment,
  RunnerStartCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';
import {
  deleteRescueRef,
  RescueMemory,
  type RescueRefDeleteResult,
  resolveRescueIntervalMs,
  runRescue,
} from './rescue-ref.js';
import {
  ScratchSweeper,
  resolveScratchSweepGraceMs,
  resolveScratchSweepIntervalMs,
  type ScratchSweeperOptions,
} from './scratch-sweep.js';
import { computeUnpushedWork } from './unpushed-work.js';
import type { ContextUsageObservation, JobStatus } from './schema.js';
// クローンと同じ判定を呼ぶ: 層ごとに書くと片方だけが印を見落として非対称になるため
import { assistantFailureOf, type SdkFailure } from './sdk-failure.js';
import { systemErrorFactsOf, type SystemErrorFacts } from './system-error.js';
import { classifyUsageNotice } from './usage-limits.js';
import { describeProbeError } from './usage-probe.js';

export { SUBAGENT_BACKGROUND_WAIT_MS };

// 既定を動かさない: 変更には人間の承認が要るため（AGENTS.md 地雷5）
export const MANAGER_MODEL = 'opus';

// 省略しない: SDK の既定はマネージャーの継承になるため
export const WORKER_MODEL = 'sonnet';

export const MANAGER_MODEL_ENV_KEY = 'ALTEROID_MANAGER_MODEL';
export const WORKER_MODEL_ENV_KEY = 'ALTEROID_WORKER_MODEL';

export function resolveManagerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, MANAGER_MODEL_ENV_KEY, MANAGER_MODEL);
}

export function resolveWorkerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, WORKER_MODEL_ENV_KEY, WORKER_MODEL);
}

// 既定と同じ値が置かれた場合も含める: 答えるのは差し替えの承認が置かれているかで、値の比較ではないため
export function placedManagerModels(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; value: string; fallback: string }[] {
  return (
    [
      { key: MANAGER_MODEL_ENV_KEY, fallback: MANAGER_MODEL },
      { key: WORKER_MODEL_ENV_KEY, fallback: WORKER_MODEL },
    ] as const
  ).flatMap(({ key, fallback }) => {
    const value = placedModelTier(env, key);
    return value === null ? [] : [{ key, value, fallback }];
  });
}

// 独自のワーカープールを作らない: 作業者層の本体はこの `agents` 定義1個だけ
export const WORKER_AGENT_NAME = 'worker';

export const TOOL_USE_FAILURE_NOTE_PREFIX = 'tool_use_failure:';

// 切らずに残さない: `error` は上限の無い自由文で、巨大な失敗メッセージが日誌の1行を埋め尽くしうるため
const TOOL_USE_FAILURE_ERROR_EXCERPT = 500;

// runner の制御面の鍵も落とす: マネージャーが runner の API を叩くと、自分宛の許可確認に自分で allow を返せるため
export const WITHHELD_ENV_KEYS = [
  'ALTEROID_HOME',
  'ALTEROID_PORT',
  'ALTEROID_DATABASE_URL',
  'ALTEROID_RUNNER_TOKEN',
  'ALTEROID_RUNNER_TOKEN_SHA256',
  'ALTEROID_RUNNER_SOCKET',
] as const;

// 同じ UID で走らせない: 子が runner の `/proc/1/environ` から制御面の鍵を読めるため。特権が無いのに設定されていたら黙って同じ UID で走らせず落とす
export interface RunnerChildUser {
  uid: number;
  gid: number;
  home?: string;
}

// 既定を `default` にしない: 層を下りた途端に `Read` や `grep` で止まるのはデグレードのため（north_star 禁止1）
export const MANAGER_PERMISSION_MODES = PERMISSION_MODES;

export type ManagerPermissionMode = PermissionModeName;

export { DEFAULT_PERMISSION_MODE };

export const PERMISSION_MODE_ENV_KEY = 'ALTEROID_MANAGER_PERMISSION_MODE';

export function resolvePermissionMode(env: NodeJS.ProcessEnv): ManagerPermissionMode {
  return resolvePermissionModeFor(env, PERMISSION_MODE_ENV_KEY);
}

// 既定で開けない: マネージャーは使い捨てで、書いた auto-memory がクローンにも次の器にも届かないため
// 固定値にしない: 人間が開きたいときに開けなくなるため（north_star 禁止2）
export const MANAGER_AUTO_MEMORY_ENV_KEY = 'ALTEROID_MANAGER_AUTO_MEMORY';

export function resolveManagerAutoMemoryEnabled(env: NodeJS.ProcessEnv): boolean {
  const given = env[MANAGER_AUTO_MEMORY_ENV_KEY]?.trim();
  if (given === undefined || given.length === 0) return false;
  if (given === 'true') return true;
  if (given === 'false') return false;
  throw new Error(
    `${MANAGER_AUTO_MEMORY_ENV_KEY} の値が不正: ${given}（使えるのは true / false。既定は false）`,
  );
}

// 環境変数の設定項目にしない: つまみとして外へ出すと実質の運用パラメータになるため
const LEASE_WATCH_INTERVAL_MS = 10_000;

export interface RunnerPeerOptions {
  readonly host: PeerSocketHost;
  readonly peers: readonly AgentProviderId[];
  // `agent-provider-selection.js` をここで import しない: バンドルのモジュール評価順が変わり、起動時に provider の表が未初期化になるため
  readonly reportsUsage: (provider: AgentProviderId) => boolean;
  readonly models?: Partial<Record<AgentProviderId, readonly string[]>>;
  readonly childEntry?: string;
}

export interface RunnerHostOptions {
  runnerId: string;
  emit: (event: RunnerEvent) => void;
  workspacePath: string;
  queryFn?: ClaudeQueryFn;
  env?: NodeJS.ProcessEnv;
  peer?: RunnerPeerOptions;
  withheldEnvKeys?: readonly string[];
  childUser?: RunnerChildUser;
  codexHome?: string;
  codexAuthCheckIntervalMs?: number;
  attachmentsRoot?: string;
  permissionMode?: ManagerPermissionMode;
  credentials?: CredentialStore;
  // runner が自分で記憶ストアを読みに行く形にしない: 読みに行けるということは鍵があるということのため
  profile?: ProfileVessel;
  rescueIntervalMs?: number;
  scratchSweep?:
    | false
    | (Partial<
        Omit<ScratchSweeperOptions, 'liveManagerIds' | 'knownManagerIds' | 'spawn' | 'env'>
      > & {
        intervalMs?: number;
      });
  // 既定で有効にしない: 同一プロセスの `runner-local` ではデーモンだけが消えることが無く、接触の無い構成のセッションを理由なく畳むため
  enforceLease?: boolean;
  spawnAgentProcessFn?: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
  cwdExistsFn?: (cwd: string) => boolean;
  workerToolWatchClock?: WorkerToolWatchClock;
}

export interface RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  credentials(): CredentialFingerprint[];
  // 指紋が同じなら畳まない: 再接続のたびに同じ値が降りるので、無条件に畳むと再接続のたびにセッションが畳まれるため
  setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  profile(): RunnerProfileFingerprint | undefined;
  setProfile(script: string): Promise<RunnerProfileResult>;
  mcpServers(): RunnerMcpServersFingerprint | undefined;
  // ファイルへ落とさない: 走行中のプロセスが読み直す経路が無く、効くのはセッションを組む瞬間だけのため
  setMcpServers(input: unknown): RunnerMcpServersFingerprint | undefined;
  codexAuth(): CodexAuthMirrorStatus;
  setCodexAuth(push: CodexAuthPush): Promise<CodexAuthMirrorStatus>;
  takeCodexAuthWriteBack(fingerprint: string): CodexAuthWriteBack | null;
  start(command: RunnerStartCommand): Promise<{ cwd: string; sessionGeneration: string }>;
  resume(command: RunnerResumeCommand): Promise<{
    cwd: string;
    reusedLiveSession: boolean;
    sessionGeneration: string;
  }>;
  send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean>;
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome>;
  stop(managerId: string): Promise<void>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  // origin remote は host/path までしか出さない: userinfo・クエリ・資格を出さないため
  unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined>;
  deleteRescueRef(
    request: { remote: string; ref: string; commit: string },
    options?: { signal?: AbortSignal },
  ): Promise<RescueRefDeleteResult>;
  shutdown(): Promise<void>;
  // 無認証の `/livez` から呼ばない: 誰でも貸し出し期限を延ばせてしまうため
  noteDaemonContact(): void;
  // プロセスの exit で knownTerminated にしない: 作業者の1回の呼び出しは委譲が生きていてもプロセスを終え、その孫（nohup のサーバ等）が撃たれるため
  delegationSessionPids(): { live: ReadonlySet<number>; knownTerminated: ReadonlySet<number> };
}

// 無限には覚えない: 長時間走る runner のメモリが際限なく育つため。忘れた分は所有者不明として knownTerminated に入れず、撃たない側へ倒れる
const PID_OWNER_MANAGER_ID_CAP = 4096;

// 裸のリテラルにしない（型で `ROTATABLE_CREDENTIAL_KEYS` に縛る）: 名前が変わると世代の照合が静かに効かなくなるため
const AGENT_TOKEN_CREDENTIAL_NAME: (typeof ROTATABLE_CREDENTIAL_KEYS)[number] =
  'CLAUDE_CODE_OAUTH_TOKEN';

function fingerprintsByName(
  fingerprints: readonly CredentialFingerprint[],
): ReadonlyMap<string, string> {
  return new Map(fingerprints.map((fingerprint) => [fingerprint.name, fingerprint.sha256]));
}

function sameFingerprints(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, sha256] of a) if (b.get(name) !== sha256) return false;
  return true;
}

function tokenFingerprintOf(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[AGENT_TOKEN_CREDENTIAL_NAME];
  return value === undefined || value === '' ? undefined : fingerprintOf(value);
}

function withSessionGeneration(event: RunnerEvent, sessionGeneration: string): RunnerEvent {
  switch (event.type) {
    case 'closed':
    case 'session':
    case 'report':
    case 'ask':
    case 'settled':
      return { ...event, sessionGeneration };
    default:
      return event;
  }
}

// `statSync` が投げる理由を見分けない: `chdir` できないかもしれないという1点だけが呼び出し側に意味を持つため
function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface GitSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  return new Host(options);
}

class Host implements RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  readonly #codexAuth: CodexAuthMirror;
  #codexAuthTimer: ReturnType<typeof setInterval> | null = null;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: ClaudeQueryFn | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  readonly #bashGuard: BashGuardMode;
  readonly #peer: RunnerPeerOptions | undefined;
  // 起こすたびに評価し直さない: 評価はプロセスを1本起こす操作で、人間のスクリプト次第で委譲そのものが遅くなるため
  readonly #profile: ProfileApplier | undefined;
  readonly #sessions = new Map<string, RunnerSession>();
  readonly #generations = new WeakMap<RunnerSession, string>();
  readonly #attachmentsRoot: string;
  readonly #attachmentRemovals = new Map<string, Promise<void>>();
  #mcpServers: { servers: McpServers; fingerprint: RunnerMcpServersFingerprint } | undefined;
  readonly #enforceLease: boolean;
  // 起動直後は「今」を起点にする: 知らない時刻を過去に見積もると、デーモンが1度も繋いでいない起動直後のセッションまで即座に自己失効するため
  #lastDaemonContact = Date.now();
  #leaseWatcher: ReturnType<typeof setInterval> | null = null;
  #rescueTimer: ReturnType<typeof setInterval> | null = null;
  #scratchTimer: ReturnType<typeof setInterval> | null = null;
  readonly #scratchAbort = new AbortController();
  #scratchRunning: Promise<void> | null = null;
  #attachmentPruning: Promise<void> | null = null;
  readonly #knownManagerIds = new Set<string>();
  // `knownTerminated` を固定の集合として持たない: resume で同じ `managerId` が戻っても古い pid が「終端済み」のままになるため
  readonly #liveDelegationPids = new Set<number>();
  readonly #pidOwnerManagerId = new Map<number, string>();
  readonly #spawnAgentProcessFn:
    ((options: SpawnAgentProcessOptions) => DelegationProcessHandle) | undefined;
  readonly #readCgroupEventCountersFn: (() => Promise<CgroupEventCounters>) | undefined;
  readonly #finishUnpushedWorkFn:
    ((options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>) | undefined;
  readonly #cwdExistsFn: (cwd: string) => boolean;
  readonly #workerToolWatchClock: WorkerToolWatchClock | undefined;

  constructor(options: RunnerHostOptions) {
    this.#workerToolWatchClock = options.workerToolWatchClock;
    this.runnerId = options.runnerId;
    this.workspacePath = options.workspacePath;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn;
    this.#env = options.env ?? process.env;
    this.#withheldEnvKeys = [...WITHHELD_ENV_KEYS, ...(options.withheldEnvKeys ?? [])];
    this.#childUser = options.childUser;
    this.#attachmentsRoot = options.attachmentsRoot ?? defaultRunnerAttachmentsRoot();
    this.#peer = options.peer;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode ?? resolvePermissionMode(this.#env);
    this.#bashGuard = resolveBashGuardMode(this.#env);
    this.#enforceLease = options.enforceLease ?? false;
    this.#spawnAgentProcessFn = options.spawnAgentProcessFn;
    this.#readCgroupEventCountersFn = options.readCgroupEventCountersFn;
    this.#finishUnpushedWorkFn = options.finishUnpushedWorkFn;
    this.#cwdExistsFn = options.cwdExistsFn ?? directoryExists;
    this.#codexAuth = new CodexAuthMirror({
      codexHome: options.codexHome ?? defaultCodexHome(options.childUser),
      ...(options.childUser === undefined
        ? {}
        : { owner: { uid: options.childUser.uid, gid: options.childUser.gid } }),
      onNotice: (notice) => this.#emit({ type: 'codex_auth', runnerId: this.runnerId, ...notice }),
    });
    const codexAuthTimer = setInterval(
      () => void this.#codexAuth.check().catch(() => undefined),
      options.codexAuthCheckIntervalMs ?? 60_000,
    );
    // unref する: 見張りでプロセスの終了を引き延ばさないため
    codexAuthTimer.unref?.();
    this.#codexAuthTimer = codexAuthTimer;
    const rescueTimer = setInterval(
      () => {
        for (const session of [...this.#sessions.values()]) void session.rescueRef();
      },
      options.rescueIntervalMs ?? resolveRescueIntervalMs(this.#env),
    );
    rescueTimer.unref?.();
    this.#rescueTimer = rescueTimer;
    if (options.scratchSweep !== false) {
      const { intervalMs, ...sweepOptions } = options.scratchSweep ?? {};
      const sweeper = new ScratchSweeper({
        tmpRoot: '/tmp',
        graceMs: resolveScratchSweepGraceMs(this.#env),
        startedAt: Date.now(),
        ...sweepOptions,
        spawn: (spawnOptions) =>
          this.#childUser === undefined
            ? spawn(spawnOptions.command, spawnOptions.args, {
                ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
                env: spawnOptions.env,
                signal: spawnOptions.signal,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
            : this.#spawnAsChildUser(spawnOptions),
        env: this.#baseChildEnv(),
        liveManagerIds: () => [...this.#sessions.keys()],
        knownManagerIds: () => [...this.#knownManagerIds],
      });
      const scratchTimer = setInterval(
        () => {
          if (this.#attachmentPruning === null) {
            const prune = pruneStaleAttachmentDirs(
              this.#attachmentsRoot,
              [...this.#sessions.keys()],
              Date.now(),
            )
              .catch(() => 0)
              .then(() => undefined)
              .finally(() => {
                this.#attachmentPruning = null;
              });
            this.#attachmentPruning = prune;
          }
          if (this.#scratchRunning !== null || this.#scratchAbort.signal.aborted) return;
          const run = sweeper
            .sweep(this.#scratchAbort.signal, this.runnerId)
            .then((event) => {
              if (event !== null && !this.#scratchAbort.signal.aborted) this.#emit(event);
            })
            .catch(() => {})
            .finally(() => {
              this.#scratchRunning = null;
            });
          this.#scratchRunning = run;
        },
        intervalMs ?? resolveScratchSweepIntervalMs(this.#env),
      );
      scratchTimer.unref?.();
      this.#scratchTimer = scratchTimer;
    }
    if (this.#enforceLease) {
      const watcher = setInterval(() => this.#checkLeaseExpiry(), LEASE_WATCH_INTERVAL_MS);
      watcher.unref?.();
      this.#leaseWatcher = watcher;
    }
    this.#profile =
      options.profile === undefined
        ? undefined
        : createProfileApplier({
            vessel: options.profile,
            baseEnv: () => this.#baseChildEnv(),
            // root で読まない: 降りた先では読めないプロファイルを「置けた」と報告することになるため
            ...(this.#childUser === undefined
              ? {}
              : { spawnFn: (spawnOptions) => this.#spawnAsChildUser(spawnOptions) }),
          });
  }

  credentials(): CredentialFingerprint[] {
    return this.#credentials?.fingerprints() ?? [];
  }

  noteDaemonContact(): void {
    this.#lastDaemonContact = Date.now();
  }

  delegationSessionPids(): { live: ReadonlySet<number>; knownTerminated: ReadonlySet<number> } {
    // 内部の集合への参照を渡さない: 渡した後に書き換えられないという前提が呼び出し側の実装に依存するため（写しを返す）
    const knownTerminated = new Set<number>();
    for (const [pid, managerId] of this.#pidOwnerManagerId) {
      if (this.#liveDelegationPids.has(pid)) continue;
      if (this.#sessions.has(managerId)) continue;
      knownTerminated.add(pid);
    }
    return {
      live: new Set(this.#liveDelegationPids),
      knownTerminated,
    };
  }

  #noteDelegationProcessSpawned(pid: number, managerId: string): void {
    this.#liveDelegationPids.add(pid);
    // `set` の前に `delete` する: 挿入順を今に更新するため（pid が再利用された場合の所有者の付け替えも兼ねる）
    this.#pidOwnerManagerId.delete(pid);
    this.#pidOwnerManagerId.set(pid, managerId);
    while (this.#pidOwnerManagerId.size > PID_OWNER_MANAGER_ID_CAP) {
      const oldestPid = this.#pidOwnerManagerId.keys().next().value;
      if (oldestPid === undefined) break;
      this.#pidOwnerManagerId.delete(oldestPid);
    }
  }

  #noteDelegationProcessExited(pid: number): void {
    this.#liveDelegationPids.delete(pid);
    // 所有者の記録（`#pidOwnerManagerId`）を消さない: 後で委譲が本当に終端したとき、この pid を `knownTerminated` へ回す手がかりが無くなるため
  }

  // `lease` を伴わないセッションは畳まない: 世代の約束をしていないセッションを理由なく畳むことになるため
  #checkLeaseExpiry(): void {
    const now = Date.now();
    for (const [managerId, session] of [...this.#sessions.entries()]) {
      const ttlMs = session.leaseTtlMs;
      if (ttlMs === undefined) continue;
      if (now - this.#lastDaemonContact < ttlMs) continue;
      void session
        .selfFence(
          'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）。' +
            `最後に接触があったのは ${new Date(this.#lastDaemonContact).toISOString()}、` +
            `約束していた貸し出し期限は ${ttlMs}ms。`,
        )
        // 黙って落とさない: 握らないと器のログにしか出ず、引き取る側は相手が自分で畳んだ前提で期限を数えているため
        .catch((error: unknown) => {
          this.#emit({
            type: 'note',
            managerId,
            text: `貸し出し期限の自己失効に失敗した（このセッションは畳まれていない可能性がある）: ${reasonOf(error)}`,
          });
        });
    }
  }

  async setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]> {
    if (this.#credentials === undefined) {
      throw new Error(
        '鍵の器が無い runner では差し替えられない（ALTEROID_CREDENTIAL_DIR を用意すること）',
      );
    }
    const before = fingerprintsByName(this.#credentials.fingerprints());
    const fingerprints = await this.#credentials.set(entries);
    const after = fingerprintsByName(fingerprints);
    // 値を読まず指紋だけで比べる。SDK 子プロセスの env は起動時に凍るので、畳まないと更新が次のセッション作り直しまで届かない
    if (!sameFingerprints(before, after)) {
      for (const session of this.#sessions.values()) session.recycleForToken();
    }
    return fingerprints;
  }

  profile(): RunnerProfileFingerprint | undefined {
    return this.#profile?.fingerprint();
  }

  // 評価せずに置かない: 構文を間違えたスクリプトが `BASH_ENV` に載り、以後すべてのコマンドが壊れた環境で走るため
  async setProfile(script: string): Promise<RunnerProfileResult> {
    if (this.#profile === undefined) {
      throw new Error(
        'プロファイルの器が無い runner では差し替えられない（ALTEROID_PROFILE_FILE を用意すること）',
      );
    }
    return this.#profile.apply(script);
  }

  mcpServers(): RunnerMcpServersFingerprint | undefined {
    return this.#mcpServers?.fingerprint;
  }

  setMcpServers(input: unknown): RunnerMcpServersFingerprint | undefined {
    // 届いたものを信じずにもう一度検査する: ここは制御面の入口のため
    const servers = parseMcpServers(input);
    if (Object.keys(servers).length === 0) {
      this.#mcpServers = undefined;
      return undefined;
    }
    this.#mcpServers = {
      servers,
      fingerprint: {
        sha256: mcpServersFingerprintOf(servers),
        names: mcpServerNames(servers),
        updatedAt: new Date().toISOString(),
      },
    };
    return this.#mcpServers.fingerprint;
  }

  codexAuth(): CodexAuthMirrorStatus {
    return this.#codexAuth.status();
  }

  async setCodexAuth(push: CodexAuthPush): Promise<CodexAuthMirrorStatus> {
    await this.#codexAuth.set(push);
    return this.#codexAuth.status();
  }

  takeCodexAuthWriteBack(fingerprint: string): CodexAuthWriteBack | null {
    return this.#codexAuth.takeWriteBack(fingerprint);
  }

  // 素の `process.env` で評価しない: プロファイル内で `gh` を叩く書き方が評価時だけ失敗するため
  #baseChildEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  // 実在しない `cwd` を `query()` へそのまま渡さない: 移送先の器に無いと SDK が `chdir` で `ENOENT` になり、libc 不一致に見える形でセッションが開けなくなるため
  #resolveCwd(cwd: string): string {
    if (cwd.length === 0) return this.workspacePath;
    if (!this.#cwdExistsFn(cwd)) return this.workspacePath;
    return cwd;
  }

  #create(managerId: string, request: string, cwd: string): RunnerSession {
    const sessionGeneration = randomUUID();
    const session = new RunnerSession({
      managerId,
      request,
      cwd: this.#resolveCwd(cwd),
      emit: (event) => this.#emit(withSessionGeneration(event, sessionGeneration)),
      ...(this.#queryFn === undefined ? {} : { queryFn: this.#queryFn }),
      env: this.#env,
      withheldEnvKeys: this.#withheldEnvKeys,
      ...(this.#childUser === undefined ? {} : { childUser: this.#childUser }),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      permissionMode: this.#permissionMode,
      bashGuard: this.#bashGuard,
      ...(this.#peer === undefined ? {} : { peer: this.#peer }),
      codexAuth: this.#codexAuth,
      profileEnv: () => this.#profile?.env() ?? {},
      mcpServers: () => this.#mcpServers?.servers,
      onClosed: () => {
        this.#sessions.delete(managerId);
        this.#removeAttachments(managerId);
      },
      onDelegationProcessSpawned: (pid) => this.#noteDelegationProcessSpawned(pid, managerId),
      onDelegationProcessExited: (pid) => this.#noteDelegationProcessExited(pid),
      ...(this.#spawnAgentProcessFn === undefined
        ? {}
        : { spawnAgentProcessFn: this.#spawnAgentProcessFn }),
      ...(this.#readCgroupEventCountersFn === undefined
        ? {}
        : { readCgroupEventCountersFn: this.#readCgroupEventCountersFn }),
      ...(this.#finishUnpushedWorkFn === undefined
        ? {}
        : { finishUnpushedWorkFn: this.#finishUnpushedWorkFn }),
      ...(this.#workerToolWatchClock === undefined
        ? {}
        : { workerToolWatchClock: this.#workerToolWatchClock }),
    });
    this.#generations.set(session, sessionGeneration);
    this.#sessions.set(managerId, session);
    this.#knownManagerIds.add(managerId);
    return session;
  }

  async start(command: RunnerStartCommand): Promise<{ cwd: string; sessionGeneration: string }> {
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    // 添付をセッションを作った後に置かない: 置けなければセッションを作らずに断るため、ファイルが置かれる前に担い手が読む競りも避ける
    const placing = this.#attachmentInput(command.managerId, command.request, command.attachments);
    const input = placing instanceof Promise ? await placing : placing;
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    try {
      session.checkFence(command.lease);
      session.begin(input.text, input.images);
    } catch (error) {
      this.#sessions.delete(command.managerId);
      this.#removeAttachments(command.managerId);
      throw error;
    }
    return { cwd: session.cwd, ...this.#generationOf(session) };
  }

  // 畳み中の alive へ合流しない（畳み終わるのを待ってから作り直す）: push は黙って捨てられ、待たずに作ると古い畳みの `#onClosed()` が新しいセッションを名簿から消すため
  async resume(command: RunnerResumeCommand): Promise<{
    cwd: string;
    reusedLiveSession: boolean;
    sessionGeneration: string;
  }> {
    let alive = this.#sessions.get(command.managerId);
    for (;;) {
      if (alive) {
        alive.checkFence(command.lease);
        let current: RunnerSession | undefined = alive;
        while (current !== undefined) {
          if (!current.stopping) {
            if (command.message === undefined) {
              return { cwd: current.cwd, reusedLiveSession: true, ...this.#generationOf(current) };
            }
            const placing = this.#attachmentInput(
              command.managerId,
              command.message,
              command.attachments,
            );
            const input = placing instanceof Promise ? await placing : placing;
            // 置いている間に畳まれたら積まずに畳み待ちへ落ちる: `push()` は畳み済みなら黙って捨てるので、成功と答えると追加の一言が誰にも届かないため
            if (!current.stopping && this.#sessions.get(command.managerId) === current) {
              current.push(input.text, input.images);
              return { cwd: current.cwd, reusedLiveSession: true, ...this.#generationOf(current) };
            }
          }
          try {
            await current.stop('resume 待ちのため、畳み中のセッションの完了を待った。');
          } catch {
            // 投げ直さない: 待ちたいのは畳みの完了で、投げ直すと resume 自体が失敗したように見えるため
          }
          const next = this.#sessions.get(command.managerId);
          if (next === current) {
            this.#sessions.delete(command.managerId);
            current = undefined;
          } else {
            // 別のセッションが居れば作り直さず合流する: 同じ managerId のセッションが2本開くため
            current = next;
          }
        }
      }
      const resumePlacing =
        command.message === undefined
          ? undefined
          : this.#attachmentInput(command.managerId, command.message, command.attachments);
      const resumeInput = resumePlacing instanceof Promise ? await resumePlacing : resumePlacing;
      // 見直さずに作らない: 同じ managerId のセッションが2本開き、先の1本が名簿から外れて孤児になるため
      // 置いた添付は消さない: 置き場は managerId 単位で、`#removeAttachments` を呼ぶと合流先の分まで消えるため
      const raced = this.#sessions.get(command.managerId);
      if (raced !== undefined) {
        alive = raced;
        continue;
      }
      const session = this.#create(command.managerId, command.request, command.cwd);
      session.checkFence(command.lease);
      session.resume(command.sessionId, command.entries, resumeInput?.text, resumeInput?.images);
      return { cwd: session.cwd, reusedLiveSession: false, ...this.#generationOf(session) };
    }
  }

  #generationOf(session: RunnerSession): { sessionGeneration: string } {
    return { sessionGeneration: this.#generations.get(session) ?? '' };
  }

  async send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    // 畳み中は積まず `false` を返す: `push()` は黙って捨てるので、`true` を返すと誰にも読まれない本文が 200 で返るため
    if (!session || session.stopping) return false;
    const placing = this.#attachmentInput(managerId, text, attachments);
    const input = placing instanceof Promise ? await placing : placing;
    if (session.stopping || this.#sessions.get(managerId) !== session) return false;
    session.push(input.text, input.images);
    return true;
  }

  #attachmentInput(
    managerId: string,
    text: string,
    attachments: readonly RunnerAttachment[] | undefined,
  ): AgentUserInput | Promise<AgentUserInput> {
    // 添付が無ければ `await` を挟まない: 余計な yield が並行した resume との競りの順序を変えるため
    if (attachments === undefined || attachments.length === 0) return { text };
    return this.#placeAttachmentInput(managerId, text, attachments);
  }

  // Promise を握る: 握らないと畳みの `onClosed` が投げた削除が遅れて走り、resume が置き直した添付を消すため
  #removeAttachments(managerId: string): void {
    const removal: Promise<void> = removeManagerAttachments(this.#attachmentsRoot, managerId)
      .catch(() => undefined)
      .finally(() => {
        if (this.#attachmentRemovals.get(managerId) === removal) {
          this.#attachmentRemovals.delete(managerId);
        }
      });
    this.#attachmentRemovals.set(managerId, removal);
  }

  async #placeAttachmentInput(
    managerId: string,
    text: string,
    attachments: readonly RunnerAttachment[],
  ): Promise<AgentUserInput> {
    for (let removal = this.#attachmentRemovals.get(managerId); removal !== undefined;) {
      await removal;
      removal = this.#attachmentRemovals.get(managerId);
    }
    void pruneStaleAttachmentDirs(
      this.#attachmentsRoot,
      [...this.#sessions.keys(), managerId],
      Date.now(),
    ).catch(() => undefined);
    const placed = await placeRunnerAttachments({
      root: this.#attachmentsRoot,
      managerId,
      attachments,
      ...(this.#childUser === undefined ? {} : { childGid: this.#childUser.gid }),
    });
    return composeAttachmentInput(text, placed);
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    const session = this.#sessions.get(managerId);
    if (!session) return { delivered: false };
    return session.answer(answer);
  }

  async stop(managerId: string): Promise<void> {
    await this.#sessions.get(managerId)?.stop('デーモンから停止を指示された。');
  }

  list(): RunnerManagerState[] {
    return [...this.#sessions.values()].map((session) => session.state());
  }

  async transcript(managerId: string): Promise<string | null> {
    return (await this.#sessions.get(managerId)?.transcript()) ?? null;
  }

  async unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined> {
    const session = this.#sessions.get(managerId);
    if (session === undefined) return undefined;
    return session.unpushedWork(options);
  }

  async deleteRescueRef(
    request: { remote: string; ref: string; commit: string },
    options?: { signal?: AbortSignal },
  ): Promise<RescueRefDeleteResult> {
    const env: NodeJS.ProcessEnv = { ...this.#env };
    for (const name of ROTATABLE_CREDENTIAL_KEYS) delete env[name];
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    Object.assign(env, this.#profile?.env() ?? {});
    for (const key of this.#withheldEnvKeys) delete env[key];
    const spawnFn =
      this.#childUser === undefined
        ? (spawnOptions: GitSpawnOptions) =>
            spawn(spawnOptions.command, spawnOptions.args, {
              ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
              env: spawnOptions.env,
              signal: spawnOptions.signal,
              stdio: ['ignore', 'pipe', 'pipe'] as const,
            })
        : (spawnOptions: GitSpawnOptions) => this.#spawnAsChildUser(spawnOptions);
    return deleteRescueRef({
      spawn: spawnFn,
      env,
      remote: request.remote,
      ref: request.ref,
      commit: request.commit,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async shutdown(): Promise<void> {
    // 畳み始めの名乗りを入口ごとに任せない: 積み忘れる形を作らないため
    this.#emit({ type: 'shutting_down', runnerId: this.runnerId });
    // 見張りを先に畳む: 畳み残すと止まったはずの見張りが空の名簿を叩き続け、テストではタイマーが残ってハングするため
    if (this.#leaseWatcher !== null) clearInterval(this.#leaseWatcher);
    this.#leaseWatcher = null;
    if (this.#rescueTimer !== null) clearInterval(this.#rescueTimer);
    this.#rescueTimer = null;
    if (this.#scratchTimer !== null) clearInterval(this.#scratchTimer);
    this.#scratchTimer = null;
    if (this.#codexAuthTimer !== null) clearInterval(this.#codexAuthTimer);
    this.#codexAuthTimer = null;
    this.#scratchAbort.abort();
    await Promise.all(
      [...this.#sessions.values()].map((session) =>
        session.stop('runner が停止した。', { captureUnpushedWork: true }),
      ),
    );
    this.#sessions.clear();
  }
}

const RESOLVED_MEMORY_LIMIT = 512;

const DENIED_MEMORY_LIMIT = 512;

// `onForget` の日誌行に控えていた本文を書かない（`tool_use_id` だけ）: 上限に達した回にだけ入力の先頭が日誌へ滲み出るため
const PRE_TOOL_INPUT_HEAD_MEMORY_LIMIT = 512;

const ONE_SHOT_ALLOW_MEMORY_LIMIT = 512;

const ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT = 512;

// 10分: 短すぎると許可が間に合わず失効し、長すぎると状況が変わった後に古い許可が生きる。フックの持ち時間の既定（600000ms）と同じ桁に揃えた経験的な値
export const ONE_SHOT_ALLOW_TTL_MS = 10 * 60 * 1000;

// 超えた分を黙って落とさない: 切ったこと自体を末尾に書く（AGENTS.md「静かに失敗する道具」）
const SUBAGENT_STOP_NOTE_TEXT_LIMIT = 1_500;

// `SUBAGENT_STOP_NOTE_TEXT_LIMIT` と共有しない: 片方を動かしたときに黙って一緒に動かないため。超えた分を黙って落とさない
const STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * [sdk-verbatim BackgroundTaskSummary.type]
 * > Friendly task-type label (e.g. 'shell', 'subagent', 'monitor', 'workflow'). Falls back to the raw discriminant for unknown types.
 *
 * [sdk-verbatim BashOutput.backgroundTaskId]
 * > ID of the background task if command is running in background
 *
 * [sdk-verbatim MonitorOutput.taskId]
 * > ID of the background monitor task.
 *
 * [sdk-verbatim WorkflowOutput.taskType]
 * > TaskType of the registered background task — 'local_workflow' for in-process runs, 'remote_agent' when remote:true dispatches to CCR. Set on all new writes; absent only on transcripts written before this field existed.
 */
// `type !== 'subagent'` で除外しない: 所有者を引けないのが正常かは出力が `backgroundTaskId` を持つかという性質で決まり、monitor / workflow を起こしただけで誤診断が出るため
// 「引けなかった種類」を足さない: これは引ける側の名簿で、増えるのは `#recordBackgroundTaskOwner` が読むキーを増やしたときだけのため
export const OWNER_RECORDABLE_TASK_TYPES: ReadonlySet<string> = new Set(['shell']);

// `#noteOwnerLookupFailure` と `#stopTaskOwnerKind` の両方から引く: 片方だけ直すと同じ問いに2つの答えが出るため
function isOwnerRecordableTaskType(type: unknown): boolean {
  return typeof type === 'string' && OWNER_RECORDABLE_TASK_TYPES.has(type);
}

// 知らない値を数えない: 数えると SDK が新しい種類（`local_workflow` 等）を増やすたびに作業者の過大計上が黙って再発するため
// `OWNER_RECORDABLE_TASK_TYPES` と混ぜない: 背景処理の種類と委譲の種類は別の id 空間のため
function isWorkerTaskType(taskType: string | undefined): boolean {
  return taskType === undefined || taskType === 'local_agent';
}

/**
 * [sdk-verbatim SDKTaskUpdatedMessage.patch.status]
 * > status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
 */
const SETTLED_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
]);

// `paused` を settled に入れない: 止まっているだけで、畳めば置き去りになるため
const LIVE_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
]);

// 分からない status を `'settled'` へ倒さない: 起こし直しが黙って効かなくなるため
function classifyBackgroundTaskStatus(status: unknown): 'live' | 'settled' | 'unknown' {
  if (typeof status !== 'string') return 'unknown';
  if (SETTLED_BACKGROUND_TASK_STATUSES.has(status)) return 'settled';
  if (LIVE_BACKGROUND_TASK_STATUSES.has(status)) return 'live';
  return 'unknown';
}

interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
  // 取り直さない: 引き取りのたびに取り直すと、待っている時間の長さが消えるため
  askedAt: string;
  // `message` の文言を嗅がない（`withdrawn` / `aborted` で判定する）: AGENTS.md「文字列で本文を嗅がない」
  // `aborted` を `settled` イベントに載せない: 中断は `withdrawn` が言う「CLI へ届いていない」とは別の事実のため
  settle: (answer: {
    message: string;
    decision?: 'allow' | 'deny';
    withdrawn?: true;
    aborted?: true;
  }) => void;
  result: Promise<AgentPermissionDecision>;
}

type SpawnAgentProcessOptions = AgentSpawnOptions;

type DelegationProcessHandle = AgentChildProcess;

interface RunnerSessionOptions {
  workerToolWatchClock?: WorkerToolWatchClock;
  managerId: string;
  request: string;
  cwd: string;
  emit: (event: RunnerEvent) => void;
  queryFn?: ClaudeQueryFn;
  driver?: AgentManagerDriver;
  env: NodeJS.ProcessEnv;
  withheldEnvKeys: readonly string[];
  childUser?: RunnerChildUser;
  credentials?: CredentialStore;
  permissionMode: ManagerPermissionMode;
  bashGuard: BashGuardMode;
  codexAuth?: CodexChatgptAuthHandle;
  // 値で渡さない（関数で受ける）: 走行中に差し替わるので、後から起こしたマネージャーだけが古い環境で走るため
  profileEnv: () => Record<string, string>;
  // 値で渡さない（関数で受ける）: セッションを作った後に降りた登録が resume・開き直しに届かないため
  mcpServers: () => McpServers | undefined;
  peer?: RunnerPeerOptions;
  onClosed: () => void;
  onDelegationProcessSpawned?: (pid: number) => void;
  onDelegationProcessExited?: (pid: number) => void;
  spawnAgentProcessFn?: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
}

// `manager.ts` の定数と共有しない: `runner.ts` → `manager.ts` の逆向き import を増やさないため
const FINISH_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

// `FORCED_EXIT_MS`（SIGTERM から55秒）の内側に収める: 全セッションを並行に畳むので、この観測1本ぶんだけが畳みの合計時間に上乗せされる
const STOP_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

const STOP_RESCUE_TIMEOUT_MS = 20_000;

// `manager.ts` の型を import しない: `runner.ts` → `manager.ts` の逆向き import を増やさないため
type FinishUnpushedWorkOutcome =
  | { readonly kind: 'ok'; readonly result: UnpushedWorkResult }
  | { readonly kind: 'unavailable'; readonly reason: string };

class RunnerSession {
  readonly #id: string;
  readonly #request: string;
  readonly #cwd: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #workerTools: WorkerToolWatch;
  readonly #driver: AgentManagerDriver;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  readonly #bashGuard: BashGuardMode;
  readonly #peer: RunnerPeerOptions | undefined;
  readonly #codexAuth: CodexChatgptAuthHandle | undefined;
  readonly #queryFn: ClaudeQueryFn | undefined;
  #peerBroker: PeerBroker | undefined;
  readonly #profileEnv: () => Record<string, string>;
  readonly #mcpServers: () => McpServers | undefined;
  readonly #onClosed: () => void;
  readonly #onDelegationProcessSpawned: (pid: number) => void;
  readonly #onDelegationProcessExited: (pid: number) => void;
  readonly #spawnAgentProcessFn: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  readonly #readCgroupEventCountersFn: () => Promise<CgroupEventCounters>;
  readonly #rescueMemory = new RescueMemory();
  #rescueRunning: Promise<void> | null = null;
  readonly #finishUnpushedWorkFn: (options?: {
    signal?: AbortSignal;
  }) => Promise<UnpushedWorkResult>;
  // `Promise` のまま持つ: コンストラクタは同期で、fs 読み取りを待たずに構築を終えるため
  readonly #openedCgroupEvents: Promise<CgroupEventCounters>;

  readonly #pending: PendingRequest[] = [];
  // 解けた確認を覚える: `#pending` だけで重複を判定すると、解決後の再送が新しい確認になりクローンへ二度目が届くため
  readonly #resolved = createRecentMap<AgentPermissionDecision>({
    limit: RESOLVED_MEMORY_LIMIT,
    // 忘れたことを黙らない: 忘れた id の再送はもう一度クローンへ出るので、記録が無いと「なぜ二度届いたのか」を辿れないため
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `解決済みの確認の記憶が上限（${RESOLVED_MEMORY_LIMIT}件）に達したので、` +
          `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
          'この id の確認が SDK から再送されると、新しい確認としてもう一度回る。',
      }),
  });
  // `true` だけを置かない: 入力を持たない `via: 'live'` が先に鍵を立てると、入力を持つ `via: 'result'` を区別できず捨てるため
  readonly #denied = createRecentMap<DeniedRecord>({
    limit: DENIED_MEMORY_LIMIT,
    // 忘れたことを黙らない: 忘れた id が `result` に再度載ると、同じ拒否が新しい拒否として上がるため
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `上へ降ろした拒否の記憶が上限（${DENIED_MEMORY_LIMIT}件）に達したので、` +
          `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
          'この tool_use_id が result に残っていれば、同じ拒否がもう一度上がる。',
      }),
  });
  // 生の入力を保持しない: 伏せ字済み・160字以内の文字列だけを控える
  readonly #preToolInputHeads = createRecentMap<string>({
    limit: PRE_TOOL_INPUT_HEAD_MEMORY_LIMIT,
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `PreToolUse で控えた入力の先頭の記憶が上限（${PRE_TOOL_INPUT_HEAD_MEMORY_LIMIT}件）に` +
          `達したので、古い ${ids.length} 件（tool_use_id のみ。本文は書かない）を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id の拒否が後から届いても、inputHead は付かない。`,
      }),
  });
  // 生の入力を保持しない: 復元できないダイジェストだけを鍵にするため
  readonly #oneShotAllows = createRecentMap<{
    readonly expiresAt: number;
    readonly actor: string;
    readonly tool: string;
  }>({
    limit: ONE_SHOT_ALLOW_MEMORY_LIMIT,
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否への1回だけの許可の記憶が上限（${ONE_SHOT_ALLOW_MEMORY_LIMIT}件）に` +
          `達したので、古い ${ids.length} 件（鍵のみ。中身は書かない）を忘れた: ${ids.join(', ')}。` +
          `使われないまま忘れたので実害は無い（issue #1105 P1）。`,
      }),
  });
  readonly #oneShotAllowedToolUses = createRecentMap<{
    readonly actor: string;
    readonly tool: string;
  }>({
    limit: ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT,
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `1回だけの許可で allow を返した呼び出しの記憶が上限` +
          `（${ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を` +
          `忘れた: ${ids.join(', ')}。この tool_use_id への拒否が後から届いても、` +
          `「許可を追い越した」とは検出できない（issue #1105 P1）。`,
      }),
  });
  readonly #resumeState = new RunnerResumeState();
  #tokenFingerprint: string | undefined;
  readonly #workerWaitWindow = new RunnerWorkerWaitWindow();
  readonly #nonWorkerTaskIds = new Set<string>();

  readonly #cutOffWorkers = new RunnerCutOffWorkers();
  readonly #stopState = new RunnerSubagentStopState();
  readonly #turnTally = new RunnerTurnTally();
  readonly #sdkSession = new RunnerSdkSession();

  constructor(options: RunnerSessionOptions) {
    this.#id = options.managerId;
    this.#request = options.request;
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#workerTools = new WorkerToolWatch(
      options.managerId,
      options.emit,
      options.workerToolWatchClock,
    );
    this.#driver =
      options.driver ??
      new ClaudeManagerDriver(options.queryFn === undefined ? {} : { queryFn: options.queryFn });
    this.#env = options.env;
    this.#withheldEnvKeys = options.withheldEnvKeys;
    this.#childUser = options.childUser;
    this.#peer = options.peer;
    this.#codexAuth = options.codexAuth;
    this.#queryFn = options.queryFn;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode;
    this.#bashGuard = options.bashGuard;
    this.#profileEnv = options.profileEnv;
    this.#mcpServers = options.mcpServers;
    this.#onClosed = options.onClosed;
    this.#onDelegationProcessSpawned = options.onDelegationProcessSpawned ?? (() => undefined);
    this.#onDelegationProcessExited = options.onDelegationProcessExited ?? (() => undefined);
    this.#spawnAgentProcessFn =
      options.spawnAgentProcessFn ??
      ((spawnOptions) =>
        spawnAsUser(this.#childUser as RunnerChildUser, { ...spawnOptions, detached: true }));
    this.#readCgroupEventCountersFn =
      options.readCgroupEventCountersFn ?? (() => readCgroupEventCounters());
    this.#finishUnpushedWorkFn =
      options.finishUnpushedWorkFn ??
      ((unpushedWorkOptions) => this.unpushedWork(unpushedWorkOptions));
    // `#finish()` で読み直さない: 畳んだときの値になり、開いたときとの差分が取れないため
    this.#openedCgroupEvents = this.#readCgroupEventCountersFn();
  }

  get leaseTtlMs(): number | undefined {
    return this.#sdkSession.leaseTtlMs;
  }

  get cwd(): string {
    return this.#cwd;
  }

  // `lease` が無ければ何もしない: 名乗らない古いデーモンの命令は素通しするため
  checkFence(lease: RunnerLease | undefined): void {
    this.#sdkSession.checkFence(lease, this.#id);
  }

  begin(request: string, images?: readonly AgentInputImage[]): void {
    this.push(request, images);
    this.#open();
  }

  // `message` を必ず流す: resume が開き直すだけでは仕事が進まず、器が落ちたことを理由に止まったままにしないため
  resume(
    sessionId: string,
    entries: unknown[] | undefined,
    message: string | undefined,
    images?: readonly AgentInputImage[],
  ): void {
    this.#resumeState.beginResume(sessionId, entries);
    if (message !== undefined) this.push(message, images);
    this.#open(sessionId);
  }

  state(): RunnerManagerState {
    return {
      managerId: this.#id,
      status: this.#sdkSession.status,
      cwd: this.#cwd,
      request: this.#request,
      // `askedAt` を取り直さない: デーモン再起動のたびに待ち始めた時刻が「いま」に書き換わるため
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
        kind: request.kind,
        askedAt: request.askedAt,
      })),
      ...(this.#resumeState.sessionId === undefined
        ? {}
        : { sessionId: this.#resumeState.sessionId }),
      liveBackgroundTasks: this.#sdkSession.liveBackgroundTasks.length,
      ...(this.#tokenFingerprint === undefined ? {} : { tokenFingerprint: this.#tokenFingerprint }),
    };
  }

  get stopping(): boolean {
    return this.#sdkSession.stopped;
  }

  // 作業者の完了を契機に呼ばない: 同一の query ストリームで完了が現れるので、呼ぶと SDK の自己継続と二重にターンが回り `worker_wait` の `byCause` も壊れるため
  push(text: string, images?: readonly AgentInputImage[]): void {
    if (this.#sdkSession.stopped) return;
    this.#sdkSession.enqueueInput(
      images === undefined || images.length === 0 ? { text } : { text, images },
    );
    this.#sdkSession.setStatus('running');
    this.#sdkSession.wakeInput();
  }

  // 返事の宛先を推測しない（`requestId` で指す）: 取り違えは拒否を承認に変えるため
  // `decideAnswer` を `#onPermission` と共有する: 2箇所に式を書くと黙ってずれるため
  // `decision` 欄に `unreadable` をそのまま出す: `deny` に畳むと本当に拒否された回と区別できないため
  answer(answer: RunnerAnswerCommand): RunnerAnswerOutcome {
    const pending = this.#pending.find((request) => request.id === answer.requestId);
    if (!pending) return { delivered: false };
    const { decision, unreadable } = decideAnswer(pending.kind, answer.decision, answer.message);
    pending.settle({
      message: answer.message,
      ...(answer.decision === undefined ? {} : { decision: answer.decision }),
    });
    return { delivered: true, decision: unreadable ? 'unreadable' : decision };
  }

  // 戻り値を3状態にしない: 他パッケージからも見える公開面へ波及するため（3状態は `#readTranscript` が持つ）
  async transcript(): Promise<string | null> {
    const result = await this.#readTranscript();
    return result.status === 'ok' ? result.body : null;
  }

  async unpushedWork(options?: { signal?: AbortSignal }): Promise<UnpushedWorkResult> {
    const spawnFn = this.#gitSpawnFn();
    // `options.signal` で始めた git 呼び出しを止めない: `computeUnpushedWork` 自身のタイムアウトまで走らせ、止めるのは次の作業ツリーへ進む前だけ
    return computeUnpushedWork(this.#cwd, {
      spawn: spawnFn,
      env: this.#childEnv(),
      managerId: this.#id,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  #gitSpawnFn(): (spawnOptions: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => ChildProcess {
    return this.#childUser === undefined
      ? (spawnOptions) =>
          spawn(spawnOptions.command, spawnOptions.args, {
            ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
      : (spawnOptions) => this.#spawnAsChildUser(spawnOptions);
  }

  async rescueRef(options: { signal?: AbortSignal; waitForRunning?: boolean } = {}): Promise<void> {
    if (this.#rescueRunning !== null) {
      // 畳む直前の回は見送らず走行中の回の終わりを待つ: 見送ると畳む直前の変更が退避されないまま器が消えるため
      if (options.waitForRunning !== true) return;
      const running = this.#rescueRunning;
      const aborted = new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([running, aborted]);
      if (this.#rescueRunning !== null || options.signal?.aborted === true) return;
    }
    const run = (async (): Promise<void> => {
      try {
        const worktrees = await runRescue(this.#cwd, {
          managerId: this.#id,
          spawn: this.#gitSpawnFn(),
          env: this.#childEnv(),
          memory: this.#rescueMemory,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (worktrees.length > 0) {
          this.#emit({ type: 'rescue_ref', managerId: this.#id, worktrees });
        }
      } catch {
        // 退避は best-effort。この1回の失敗でセッションを巻き込まない。
      } finally {
        this.#rescueRunning = null;
      }
    })();
    this.#rescueRunning = run;
    await run;
  }

  // 「無い」の種類を潰さない（`no-path` はフックの配線、`unreadable` はディスク・権限を疑う別の次の一手）
  async #readTranscript(): Promise<
    | { status: 'no-path' }
    | { status: 'unreadable'; error: unknown }
    | { status: 'ok'; body: string }
  > {
    const path = this.#sdkSession.transcriptPath;
    if (path === undefined) return { status: 'no-path' };
    try {
      return { status: 'ok', body: await readFile(path, 'utf8') };
    } catch (error) {
      return { status: 'unreadable', error };
    }
  }

  async stop(reason: string, options: { captureUnpushedWork?: boolean } = {}): Promise<void> {
    if (this.#sdkSession.stopped) {
      // 畳み中のものがあれば待ってから返る（2本目は自分では畳まない）: 即座に返すと `stop()` を await した呼び出し元が畳み終わったと思って先へ進むため
      // 例外を飲み込まない: 呼び出し元は既に `stop()` が投げうる前提で受けているため
      const closing = this.#sdkSession.closing;
      if (closing) await closing;
      return;
    }
    await this.#sdkSession.trackClosing(() => this.#stopBody(reason, options));
  }

  async #stopBody(reason: string, options: { captureUnpushedWork?: boolean } = {}): Promise<void> {
    this.#sdkSession.markStopped();

    // `#settleAll` より前に状態を控える: 控えずに `#status` を読むと確認が解放された後の `running` を報告が名乗ってしまうため
    const statusAtStop = this.#sdkSession.status;

    // `result` を待たずに渡す: この経路で畳まれたぶんは台帳に1行も残らず、渡し損ねたら二度と取れないため
    await this.#flushUsage();

    // `worker_wait` をここで閉じる: この経路は `#finish` を通らず、閉じないと開いたままの区間が黙って消えるため
    this.#closeWorkerWaitWindow();

    // 分類できなかった失敗の件数もここで出す: `#finish` にだけ置くと、器の入れ替えと `manager_stop` で畳まれたぶんの量が失われるため
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);

    this.#settleAll(reason);
    this.#workerTools.settleAll();
    this.#sdkSession.wakeInput();
    this.#peerBroker?.closeAll();
    this.#sdkSession.closeQuery();
    // 生ログの送り出しと報告を `#reader` が終わるまで待つ: `query.close()` の前に読むと CLI が EOF を受けてから書く最後の数行を取りこぼすため
    await this.#sdkSession.reader?.catch(() => undefined);
    // 止まる前に全文を返す: runner のディスクは器と一緒に消え、渡し損ねると manager_id から生ログへ降りる経路が切れるため
    await this.#shipArchive();
    // `this.#status` ではなく `statusAtStop` を渡す: `#settleAll` が確認を解いた後の `#status` は報告の意味が変わるため
    this.#flushUnreported(reason, statusAtStop);
    // 例外を投げない（`.catch()` を添える）: 観測1回の失敗で畳みそのものを巻き添えにしないため
    // 期限を切る（`STOP_UNPUSHED_WORK_TIMEOUT_MS`）: SIGTERM から `exit(0)` するまでの猶予 `FORCED_EXIT_MS` を大きく食わないため
    if (options.captureUnpushedWork === true) {
      // 観測の emit は退避を待たない: 待たせると #2749 の競走の窓が広がるため
      const rescued = this.rescueRef({
        signal: AbortSignal.timeout(STOP_RESCUE_TIMEOUT_MS),
        waitForRunning: true,
      });
      const unpushedWork = await this.#finishUnpushedWorkFn({
        signal: AbortSignal.timeout(STOP_UNPUSHED_WORK_TIMEOUT_MS),
      })
        .then((result): FinishUnpushedWorkOutcome => ({ kind: 'ok', result }))
        .catch((error: unknown): FinishUnpushedWorkOutcome => ({
          kind: 'unavailable',
          reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
        }));
      this.#emit({ type: 'shutdown_unpushed_work', managerId: this.#id, unpushedWork });
      await rescued;
    }
    this.#onClosed();
  }

  // `stop()` ではなく `#finish()` を通す: 自己失効はランナー自身の判断で、デーモンが知る手段が `closed` イベントしかないため
  // 文言（`reason`）で自己失効を判定させない: `lost` だけでは resume 不能と区別できず、構造化された印 `selfFenced: true` だけを台帳が見る
  async selfFence(reason: string): Promise<void> {
    if (this.#sdkSession.stopped) return;
    await this.#finish('lost', reason, { selfFenced: true });
  }

  // セッションが無ければ印を立てない: 次に `#open()` するのはもう新しい鍵のもとのため
  recycleForToken(): void {
    if (this.#sdkSession.query === null) return;
    this.#sdkSession.requestTokenRecycle();
    this.#sdkSession.wakeInput();
  }

  #open(resume?: string): void {
    if (this.#sdkSession.query) return;
    // 「whenever the session's CLI process (re)starts」[sdk-verbatim SDKBackgroundTasksChangedMessage] に対応するのはここで、`init` ではない: `init` はターンの頭ごとに来るだけのため
    this.#sdkSession.resetLiveBackgroundTasks();
    this.#nonWorkerTaskIds.clear();
    const generation = this.#sdkSession.generation;
    const session = this.#driver.open(this.#buildSpec(resume));
    this.#sdkSession.open(session, this.#read(session, generation));
  }

  #peerMcpEntry(): McpServers[string] | undefined {
    const peer = this.#peer;
    if (peer === undefined) return undefined;
    const allowed = peer.peers.filter((provider) => provider !== DEFAULT_AGENT_PROVIDER_ID);
    if (allowed.length === 0) return undefined;
    let childEntry: string;
    try {
      childEntry = peer.childEntry ?? resolveCloneToolRelayChildEntry(import.meta.url);
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `MCP peer を出せなかった（中継の子が見つからない）: ${reasonOf(error)}`,
      });
      return undefined;
    }
    const broker = (this.#peerBroker ??= this.#createPeerBroker(allowed));
    const token = peer.host.register(() => broker.mcpServer().instance);
    return {
      type: 'stdio',
      command: process.execPath,
      args: [childEntry],
      env: {
        [CLONE_TOOL_RELAY_SOCKET_ENV]: peer.host.socketPath,
        [CLONE_TOOL_RELAY_TOKEN_ENV]: token,
      },
    };
  }

  #createPeerBroker(allowed: readonly AgentProviderId[]): PeerBroker {
    return createPeerBroker({
      allowed,
      ...(this.#peer?.models === undefined ? {} : { models: this.#peer.models }),
      askApproval: (source, request) => this.#onPermission(request, source),
      driverOf: (provider) =>
        provider === 'codex'
          ? new CodexManagerDriver(
              this.#codexAuth === undefined ? {} : { chatgptAuth: this.#codexAuth },
            )
          : new ClaudeManagerDriver(this.#queryFn === undefined ? {} : { queryFn: this.#queryFn }),
      reportsUsage: (provider) => this.#peer?.reportsUsage(provider) ?? true,
      onNote: (text) => this.#emit({ type: 'note', managerId: this.#id, text }),
      onUsage: (report) =>
        this.#emit({
          type: 'peer_usage',
          managerId: this.#id,
          provider: report.provider,
          ...(report.sessionId === undefined ? {} : { sessionId: report.sessionId }),
          models: report.models,
          ...(report.unmetered ? { unmetered: true } : {}),
        }),
      makeSpec: (provider, parts) => ({
        ...this.#buildSpec(undefined, true),
        input: parts.input,
        // 置かれたモデルを peer に効かせない: ホストの provider のものなので、名指しが無ければ各 provider の既定に任せるため
        model: parts.model ?? resolveManagerModel({}),
        modelPlaced: parts.model !== undefined,
        workerModel: resolveWorkerModel({}),
        // `strictApprovals` を載せない: 載せると構えが `default` / `untrusted` に締まるため
        permissionMode: this.#permissionMode,
        systemPromptAppend: PEER_SYSTEM_PROMPT_APPEND,
        // peer の生ログを預けない: マネージャーの生ログと混ぜないため
        sessionLog: { append: async () => undefined, load: async () => null },
        onPermission: parts.onPermission,
        onNote: parts.onNote,
        onPreToolUse: () => ({ kind: 'continue' }),
        onPermissionDenied: async () => ({ kind: 'no-retry' }),
        onPostToolUse: (record) => {
          this.#emit({
            type: 'tool_use',
            managerId: this.#id,
            actor: `peer:${provider}`,
            tool: record.toolName ?? '(不明)',
            input: record.toolInput,
          });
          return { kind: 'continue' };
        },
        onPostToolUseFailure: (record) => this.#notePeerToolUseFailure(provider, record),
        onPreCompact: () => undefined,
        onUserPromptSubmit: () => undefined,
        onSubagentStop: () => ({ kind: 'continue' }),
        onStop: () => undefined,
      }),
    });
  }

  // `tool_use` にしない: 旧 daemon が未知の欄を落とすため
  #notePeerToolUseFailure(provider: AgentProviderId, record: AgentToolAuditFailureRecord): void {
    const error =
      typeof record.error === 'string'
        ? excerptLine(redactErrorText(record.error, process.env), TOOL_USE_FAILURE_ERROR_EXCERPT)
        : '(不明)';
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${TOOL_USE_FAILURE_NOTE_PREFIX} 道具=${record.toolName ?? '(不明)'}・actor=peer:${provider}・error=${error}`,
    });
  }

  #buildSpec(resume?: string, forPeer = false): AgentManagerSessionSpec {
    // プロファイルが上書きした後の値から指紋を控える: 子が実際に掴む鍵を見るため（peer のセッションは別物なので控えない）
    const childEnv = this.#childEnv();
    if (!forPeer) this.#tokenFingerprint = tokenFingerprintOf(childEnv);
    return {
      input: this.#inputStream(),
      model: resolveManagerModel(this.#env),
      modelPlaced: placedModelTier(this.#env, MANAGER_MODEL_ENV_KEY) !== null,
      permissionMode: this.#permissionMode,
      systemPromptAppend: buildManagerSystemPrompt({
        managerId: this.#id,
        workerName: WORKER_AGENT_NAME,
      }),
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: buildWorkerPrompt(),
      // 省略しない: SDK の既定は親の継承で、省くとマネージャーを差し替えた人が作業者まで巻き添えで動かすため
      workerModel: resolveWorkerModel(this.#env),
      cwd: this.#cwd,
      env: childEnv,
      managerAutoMemoryEnabled: resolveManagerAutoMemoryEnabled(this.#env),
      ...(() => {
        const human = this.#mcpServers();
        const peerEntry = forPeer ? undefined : this.#peerMcpEntry();
        if (peerEntry === undefined) return human === undefined ? {} : { mcpServers: human };
        return { mcpServers: { ...human, [PEER_MCP_SERVER_NAME]: peerEntry } };
      })(),
      // runner に永続化の器を置かない: 記憶ストアの鍵を runner に置かないため
      sessionLog: this.#sessionLog(),
      ...(resume === undefined ? {} : { resume }),
      // 道具も preset も削らない: 変えるのは実行する主体だけのため
      ...(this.#childUser === undefined
        ? {}
        : { spawnProcess: (options) => this.#spawnDelegationProcess(options) }),
      onPermission: (request) => this.#onPermission(request),
      onNote: (text) => this.#emit({ type: 'note', managerId: this.#id, text }),
      onPreToolUse: (record) => this.#onPreToolUse(record),
      onPermissionDenied: (record) => this.#onPermissionDenied(record),
      onPostToolUse: (record) => this.#onPostToolUse(record),
      onPostToolUseFailure: (input) => this.#onPostToolUseFailure(input),
      onPreCompact: (record) => this.#onPreCompact(record),
      onUserPromptSubmit: (record) => this.#onUserPromptSubmit(record),
      onSubagentStop: (record) => this.#onSubagentStop(record),
      onStop: (record) => this.#onStop(record),
    };
  }

  // runner のディスクに前回の生ログが残っている前提を置かない: 器は作り直されるため
  #sessionLog(): AgentSessionLog {
    return {
      append: async (key: AgentSessionLogKey, entries: unknown[]) => {
        this.#emit({
          type: 'mirror',
          managerId: this.#id,
          key: {
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
          },
          entries,
        });
        this.#emit({ type: 'project_key', managerId: this.#id, projectKey: key.projectKey });
      },
      load: async (key: AgentSessionLogKey) => {
        if (key.subpath !== undefined) return null;
        return this.#resumeState.seed ?? null;
      },
    };
  }

  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  // `#spawnAsChildUser` と共有しない: `detached: true` と pid 追跡を委譲そのものの起動経路にだけ効かせるため
  #spawnDelegationProcess(options: SpawnAgentProcessOptions): DelegationProcessHandle {
    const child = this.#spawnAgentProcessFn(options);
    const pid = child.pid;
    if (pid !== undefined) {
      this.#onDelegationProcessSpawned(pid);
      const noteExited = (): void => this.#onDelegationProcessExited(pid);
      // `exit` だけに頼らない: `error` のときに `exit` が来るかは環境依存のため
      child.once('exit', noteExited);
      child.once('error', noteExited);
    }
    return child;
  }

  // 記憶ストアの所在を子プロセスへ渡さない: 渡さなければ構造的に触れないため
  // 鍵を `this.#env` のスナップショットのまま配らない: 人間が後から差し替えた鍵が永久に届かないため
  #childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    // 鍵の名前をまず自分の env から落とす: 器の env に残った現役でない鍵（週次上限で冷却中のトークン）で走り、クローンが撒いたものとの食い違いが見えなくなるため。重ねる前に消す（後だと降ろした鍵まで落ちる）
    for (const name of ROTATABLE_CREDENTIAL_KEYS) delete env[name];
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    // **プロファイルは鍵より後。** 人間が明示的に書いたほうが勝つ（`credentials`
    // は1つの鍵を回すための細い口で、こちらは実行環境そのものの宣言である）。
    Object.assign(env, this.#profileEnv());
    // 伏せるのは最後: 先に消してから鍵を重ねると、鍵の名前に `ALTEROID_DATABASE_URL` を渡すだけで伏せたはずの値を注入し直せるため
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  // 待っているストリームを1本だけ覚えない: 世代が重なるため
  async *#inputStream(): AsyncGenerator<AgentUserInput> {
    const generation = this.#sdkSession.generation;
    for (;;) {
      // 世代の確認を `shift` より先にする: 逆にすると畳まれる直前の死んだストリームが新しいセッション宛の1通を引き抜くため
      if (generation !== this.#sdkSession.generation) return;
      const next = this.#sdkSession.dequeueInput();
      if (next !== undefined) {
        this.#turnTally.incrementInputsSinceResult();
        yield next;
        continue;
      }
      if (this.#sdkSession.stopped) return;
      // `#stopped` に相乗りしない: runner セッション全体の停止で、混ぜるとトークンを回したらマネージャーが止まるため
      // `#read` は `#endedInputForTokenRotation` だけを見る: 意図（`#recycleForToken`）と混ぜると、SDK 自身の閉じを畳み直しと誤認して嘘の `note` を出すため
      if (this.#sdkSession.wantsTokenRecycle && this.#atTokenRecycleBoundary()) {
        this.#sdkSession.consumeTokenRecycleAtBoundary();
        return;
      }
      await this.#sdkSession.waitForInput();
    }
  }

  #atTokenRecycleBoundary(): boolean {
    return (
      this.#sdkSession.status !== 'running' &&
      this.#pending.length === 0 &&
      this.#sdkSession.liveBackgroundTasks.length === 0 &&
      this.#resumeState.sessionId !== undefined
    );
  }

  // `generation` で古い読み手を止める: 作り直しの後に、畳まれた古いストリームの `for await` が失敗でも完了でもないのに `#finish` するのを防ぐため
  async #read(session: AgentManagerSession, generation: number): Promise<void> {
    try {
      // 畳まれた世代の出来事を新しい世代へ通さない: 古い `result` の累積が新しい世代の累積の後ろに届くと、台帳で逆順になり過大に数えるため
      await session.readEvents((event) =>
        generation !== this.#sdkSession.generation ? Promise.resolve() : this.#apply(event),
      );
      if (this.#sdkSession.stopped || generation !== this.#sdkSession.generation) return;
      // `#recycleForToken` で判定しない: あれは意図でしかなく、SDK 自身の閉じを畳み直しと誤認して嘘の `note` を出し、答えていない確認を道連れに開き直すため
      // この分岐を `#finish('done', …)` より前に置く: 畳み直しの正常な閉じが `done` の報告に化けるため
      if (this.#sdkSession.takeEndedForTokenRotation()) {
        const sessionId = this.#resumeState.sessionId;
        if (sessionId === undefined) {
          // 放置しない: `#query` が死んだまま誰も開き直さないので、通常の「セッションが閉じた」経路へ委ねる
          await this.#finish('done', 'マネージャーのセッションが閉じた。');
          return;
        }
        this.#reopenForTokenRotation(sessionId);
        return;
      }
      const closed = 'セッションが開かないまま閉じた';
      switch (this.#recoverFromFailedResume(closed)) {
        case 'recovered':
          return;
        case 'unresumable':
          await this.#finish('lost', closed);
          return;
        default:
          await this.#finish('done', 'マネージャーのセッションが閉じた。');
          return;
      }
    } catch (error) {
      if (generation !== this.#sdkSession.generation) return;
      // `String(error)` の手前で分類を取る: 文字列になった後で解釈し始めると `reasonType` の doc が禁じる形になるため
      // `reasonOf` を使わず `String(error)` に伏せ字だけ通す: 構造化の欄を足すと `reason` の一文が変わるため。素のままだと値を運ぶ例外が日誌と受信箱へ出る
      const systemError = systemErrorFactsOf(error);
      const reason = redactErrorText(String(error), process.env);
      // `#stopped` ならここから下は何もしない: `#finish('failed', …)` を呼ぶと `stop()` の畳みと二重に走り、人間が止めたセッションが `failed` として記録されるため
      if (!this.#sdkSession.stopped) {
        switch (this.#recoverFromFailedResume(reason)) {
          case 'recovered':
            return;
          // `failed` にしない: 話しかければ直るかもしれない失敗に見えるが、戻れなかったことは確定しているため
          case 'unresumable':
            // `lost` にも同じ分類を付ける: 片方にだけ付けると同じ例外が経路によって見えたり見えなかったりするため
            await this.#finish('lost', reason, { systemError });
            return;
          default:
            break;
        }
        await this.#finish('failed', `マネージャーのセッションが落ちた: ${reason}`, {
          systemError,
        });
      }
    }
  }

  // `#resumeAttempt` も立てる: 無いと、まだ一度も進んでいないセッションで開き直しの resume が効かなかったとき `done` に化けるため
  // 会話を切らない: 畳むのは SDK の子プロセスで、会話でも記憶でもないため
  // プロトコルへ新しい `type` を足さず `note` に載せる: 旧いデーモンも `note` は解釈できるため
  #reopenForTokenRotation(sessionId: string): void {
    this.#sdkSession.teardownForRecreate();
    this.#resumeState.armResumeAttempt(sessionId);
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        '鍵・環境変数（認証トークンを含む）が差し替わったので、ターンの境界でセッションを畳んで' +
        '開き直した（会話は resume で続く）。',
      // `text` の言い回しで判定させない: 構造化した旗でデーモンに伝える
      tokenRotation: true,
    });
    this.#open(sessionId);
  }

  #markProgressed(): void {
    this.#resumeState.markProgressed();
  }

  // `unresumable` を `not-a-resume-failure` と同じ戻り値にしない: 戻れなかった resume が `done` として残り、腐った session_id しか無いマネージャーが「まだ続けられるもの」に見え続けるため
  #recoverFromFailedResume(reason: string): ResumeRecoveryOutcome {
    return recoverFromFailedResume(this.#resumeRecoveryHost, reason);
  }

  // `class … implements` にしない: 手順の断片が `RunnerSession` の公開面に生え、順序を無視して呼べてしまうため
  readonly #resumeRecoveryHost: ResumeRecoveryHost = {
    takeResumeAttempt: () => this.#resumeState.takeAttempt(),
    hasProgressed: () => this.#resumeState.progressed,
    renderSeedRecord: () => renderSessionLog(this.#resumeState.seed),
    closeWorkerWaitWindow: () => this.#closeWorkerWaitWindow(),
    discardCarriedOverWork: () => {
      // 委譲の区間を持ち越さない: 二度と来ない `task_notification` を待ち続けて区間が永久に閉じないため（`closeWorkerWaitWindow` の後に呼ぶ）
      this.#workerWaitWindow.clear();
      this.#nonWorkerTaskIds.clear();
      // **このターンで開いた作業者の数（#1373）も、同じ理由で持ち越さない。**
      // この経路は `turn_ended` を通らないので、捨てないと前のセッションの作業者が次のセッションの最初のターンの数に入る。
      this.#turnTally.discardOpenedWorkersAndRejections();
    },
    emitResumeFailed: (input) => {
      this.#emit({
        type: 'resume_failed',
        managerId: this.#id,
        sessionId: input.sessionId,
        reason: input.reason,
        recovered: input.recovered,
      });
    },
    teardownForRecreate: () => {
      // 世代を進めてから畳む: 進めないと死んだ `#inputStream` が引き継ぎの一言を横取りするため
      this.#sdkSession.teardownForRecreate();
      this.#resumeState.discardForRecreate();
      // 前の器へ向けた入力を捨てない: 人間やクローンがちょうど送った指示だけが消えるため
      return this.#sdkSession
        .drainInput()
        .map((message) => message.text)
        .filter((text) => text.length > 0);
    },
    pushHandoff: (input) => {
      this.push(handoffPrompt(input));
    },
    openSession: () => {
      this.#open();
    },
  };

  async #apply(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started': {
        // `init` そのものをリセットの契機にしない: ターンの頭ごとに来るだけで、無条件にリセットすると在り高が0へ落ち、`awaitingBackground` が付かず報告が畳まれずクローンを起こすため
        // [sdk-verbatim SDKSystemMessage]
        // > Session metadata the CLI emits at the start of each turn, normally ahead of every other message of that turn: session_id, model, working directory, tools, MCP servers, slash commands, permission mode, and the capabilities list for feature detection.
        // [sdk-verbatim SDKBackgroundTasksChangedMessage]
        // > The level is per-process: nothing is emitted at startup, so consumers must reset to the empty set whenever the session's CLI process (re)starts and let the next membership change repopulate it.
        if (this.#resumeState.observeSessionStarted(event.sessionId)) {
          this.#sdkSession.resetLiveBackgroundTasks();
        }
        this.#emit({ type: 'session', managerId: this.#id, sessionId: event.sessionId });
        return;
      }

      case 'rate_limit': {
        this.#emit({ type: 'rate_limit', managerId: this.#id, facts: event.facts });
        return;
      }

      case 'permission_denied': {
        // 両方読む: `auto` ではこの合図が唯一の生の合図で、SDK 曰く best-effort のため authoritative な `result.permission_denials` と併読する
        this.#noteDenial(event.denial, 'live');
        return;
      }

      case 'delegation_started': {
        this.#onTaskStarted(event);
        return;
      }

      case 'delegation_notified': {
        this.#onTaskNotification(event);
        return;
      }

      case 'usage_notice': {
        // 上限の文言は API エラーとしては来ない: 通知・情報メッセージの本文を見ないと止まる一歩前を捉えられないため
        this.#emit({ type: 'usage_notice', managerId: this.#id, notice: event.notice });
        return;
      }

      case 'assistant_message': {
        // 作業者の本文を混ぜない: `parentToolUseId` が付いたものは Task の中の別の層の発言のため
        if (event.parentToolUseId === null) {
          const said = assistantText(event.blocks);
          // 「応答ではない」と印の付いたメッセージを報告に混ぜない: 上限の英語文言がそのまま「マネージャーの報告」として台帳・日誌・受信箱へ流れるため
          const rejected = assistantFailureOf(event.errorCode, said);
          if (rejected !== undefined) {
            this.#turnTally.setRejected(rejected);
            return;
          }
          if (said.length > 0) {
            this.#turnTally.recordSaid(said, event.id);
          }
        } else {
          // 作業者の発言に付いた拒否の印をターンの失敗にしない: 数えるだけ
          const rejected = assistantFailureOf(event.errorCode, '');
          if (rejected !== undefined) this.#turnTally.pushWorkerRejection(rejected.code);
        }
        return;
      }

      case 'background_tasks': {
        // 差分計算をしない（REPLACE 意味論）
        this.#sdkSession.replaceLiveBackgroundTasks(event.tasks);
        // 起こしを `'result'` の枝だけに任せない: 背景処理の完了は新しい入力を伴わない単独のイベントとしてターンの外で届きうるため
        //    [sdk-verbatim SDKBackgroundTasksChangedMessage]
        //    > emitted whenever membership changes (start, completion, kill, a foreground agent being backgrounded)
        if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
        return;
      }

      case 'text_delta':
      case 'tool_result':
        return;

      case 'compaction':
        return;

      case 'turn_ended': {
        // `clone.ts` の `#apply` の `case 'turn_ended'` と同じ位置（成否分岐より前）に置く——成否で絞ると、失敗したターン
        // の文脈占有が測れなくなる。
        const contextUsage = await this.#observeContextUsage();

        // 成否分岐の外で無条件に emit する: `usage` に相乗りさせるだけだと失敗したターンの文脈占有がどこにも残らないため
        if (contextUsage !== undefined) {
          this.#emit({
            type: 'context_usage',
            managerId: this.#id,
            sessionId: this.#resumeState.sessionId,
            turnSucceeded: event.succeeded,
            contextUsage,
          });
        }

        // ターンの区切りで必ず畳む: 持ち越すと前のターンの本文が次の報告に混ざり、言っていないことを言ったことになるため
        const {
          said,
          rejected,
          inputsThisTurn,
          notificationsThisTurn,
          toolsThisTurn,
          submitsThisTurn,
          sourcesThisTurn,
          openedWorkersThisTurn,
          workerRejectionsThisTurn,
          failedWorkerNotificationsThisTurn,
          failedWorkerNotificationsNamingLimitThisTurn,
        } = this.#turnTally.takeAtResult();

        const closedWindow = this.#workerWaitWindow.foldTurn({
          inputsThisTurn,
          notificationsThisTurn,
          toolsThisTurn,
          submitsThisTurn,
          sourcesThisTurn,
        });
        if (closedWindow !== null) {
          this.#emit({ type: 'worker_wait', managerId: this.#id, ...closedWindow });
        }

        // 成否で絞らない: 拒否は成功したターンにも失敗したターンにも載り、ゼロ埋めで害が出る値でもないため
        for (const denial of event.denials) this.#noteDenial(denial, 'result');

        // `succeeded` で兼ねない: あちらは台帳の問いで `subtype === 'success'` だけを見るので `is_error: true` の result を成功として通すため
        const failure = event.failure ?? rejected ?? undefined;

        // `init` を「戻れた」と見ない: 手が動く前の結果なし終了は、この resume が効かなかったということのため
        if (event.succeeded) {
          this.#markProgressed();
          // 成功した result だけを通す: SDK は
          // 「Crash/startup-error results may carry zeroed values」と言っている。 [sdk-verbatim SDKResultSuccess.total_cost_usd]
          // ゼロを通すと受け取った側の基準が下がり、次の本物の累積が丸ごと増分になって記録済みの分がもう一度積まれるため
          if (event.usage !== undefined) {
            this.#emit({
              type: 'usage',
              managerId: this.#id,
              sessionId: this.#resumeState.sessionId,
              models: event.usage.models,
              // 応答として返ったかを別の欄で運ぶ: `succeeded` は台帳の問いで、枠で落ちた `is_error: true` のターンもここへ来て、成功と読まれると回し手が `recovered` と枠を往復し続けるため
              answered: failure === undefined,
              ...(contextUsage === undefined ? {} : { contextUsage }),
            });
          }
        }

        // なぜ終わったのかを落とさない: 上限で止まったのか失敗したのかが区別できないと、待つ／人間に頼むと挑み直すで手が正反対になるため
        // 成否の分岐の外に出す: `assistant.error` で止まった回は `result` が成功で返ることがあるため
        // マネージャーの本文 `said` を分類に通さない: `classifyUsageNotice` は部分一致で、報告に「上限に当たった」と書いただけで誤判定するため
        if (failure !== undefined) {
          let classified = false;
          for (const candidate of [failure.text, resultTextOf(event).text, ...event.errorLines]) {
            const notice = classifyUsageNotice(candidate);
            if (notice !== undefined) {
              this.#emit({ type: 'usage_notice', managerId: this.#id, notice });
              classified = true;
              break;
            }
          }
          // 1件も分類できなかった回に跡を残す: 黙って抜けると、回し手が原理的に聞けない失敗（資格が1つも無い器）が何回起きているかがどこにも残らないため
          if (!classified) {
            noteUnclassifiedFailure(
              this.#sdkSession.unclassifiedFailures,
              this.#id,
              failure.via,
              failure.code,
            );
          }
        }

        if (!event.succeeded) {
          const outcome = this.#recoverFromFailedResume(
            `結果なしで終了: ${resultTextOf(event).text}`,
          );
          if (outcome === 'recovered') return;
          // 戻れなかった resume を「1ターン終わった」として報告しない: `done` が書かれ、腐った session_id しか無いのにクローンが「まだ続けられるもの」を見せられ、話しかけるたびに失敗するため
          if (outcome === 'unresumable') {
            // `await` へ揃えない: 揃えると直列化点が増え、`stop()` との競合を含めて影響を測っていないため
            // `#stopped` ならここで `#finish` を呼ばない: `stop()` が `host.list()` から消した後に `closed(status=lost)` が遅れて出るため
            if (!this.#sdkSession.stopped) {
              void this.#finish('lost', `結果なしで終了: ${resultTextOf(event).text}`).catch(
                (error: unknown) => {
                  noteBackgroundFailure(
                    'セッションの片付け',
                    `managerId=${this.#id} outcome=lost`,
                    error,
                  );
                  throw error;
                },
              );
            }
            return;
          }
        }

        // 失敗した回の報告に失敗であることを載せる: 上限の英語文言が「マネージャーの報告」として流れ、「報告が来た」と「エラーで死んだ」が区別できなくなるため
        // 本文（`text`）の側でも包む: 構造化した `failure` を見ていない読み手にはエラー文が報告として見えるため
        // 失敗で終わった回は `contentless` に含めない: 上限に当たった事実をクローンが知る必要があるため
        const outcome =
          failure === undefined
            ? reportText(said, resultTextOf(event))
            : {
                text: failedReportText(
                  said,
                  failure,
                  resultTextOf(event).text,
                  openedWorkersThisTurn,
                  workerRejectionsThisTurn,
                  failedWorkerNotificationsThisTurn,
                  failedWorkerNotificationsNamingLimitThisTurn,
                ),
                contentless: false,
              };
        this.#sdkSession.setStatus(this.#pending.length > 0 ? 'waiting_human' : 'done');
        if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
        // 3条件（失敗でない・`done`・背景処理が在る）が揃うときだけ載せる、欠けたら配る側へ倒す: 上限・拒否や確認待ちを黙って畳むと人間の判断が止まるため
        const awaitingBackground =
          failure === undefined &&
          this.#sdkSession.status === 'done' &&
          this.#sdkSession.liveBackgroundTasks.length > 0
            ? {
                count: this.#sdkSession.liveBackgroundTasks.length,
                breakdown: summarizeBackgroundTasks(this.#sdkSession.liveBackgroundTasks),
              }
            : undefined;
        this.#emit({
          type: 'report',
          managerId: this.#id,
          reportId: event.id,
          text: outcome.text,
          status: this.#sdkSession.status,
          ...(failure === undefined ? {} : { failure: { code: failure.code, via: failure.via } }),
          ...(outcome.contentless ? { contentless: true } : {}),
          ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
          ...(failure === undefined ? {} : { synthesized: 'turn_failed' }),
        });
        // `report` を出した後に呼ぶ: `push()` が状態を `running` へ戻すので、先に呼ぶと `report.status` / `awaitingBackground` が嘘になるため
        this.#wakeForFinishedBackgroundTaskOutputs();
        return;
      }

      // 既定で無視へ倒さない（枝が増えたら型で落とす）: provider が名乗り始めた事実が黙って網の外へ出るため
      default: {
        const unread: never = event;
        void unread;
        return;
      }
    }
  }

  // 作業者（`local_agent`）のタスクだけを数える: SDK は作業者以外のタスクでも `task_started` を出し、一律に数えると委譲していないターンでも `openedWorkers` が増え `worker_wait` の区間まで開くため
  #onTaskStarted(event: AgentDelegationStarted): void {
    // id を名乗らなければ偽の id で数える: 取りこぼすより多く数える方を選ぶため
    const taskId = event.taskId ?? randomUUID();
    if (!isWorkerTaskType(event.taskType)) {
      if (event.taskId !== undefined) this.#nonWorkerTaskIds.add(event.taskId);
      return;
    }
    this.#turnTally.addOpenedWorker(taskId);
    this.#workerWaitWindow.taskStarted(taskId);
  }

  // `status` を `=== 'failed'` の一致だけで見る: SDK が値を増やしても知らない値は「失敗ではない」側へ落ちるため。枠(429)は手書きの文言一致にせず `classifyUsageNotice` を通す
  // `output_file` が読めなければ `null` を渡す: 作り物のパスを主張しないため
  #onTaskNotification(event: AgentDelegationNotified): void {
    const taskId = event.taskId;
    this.#workerWaitWindow.notified(taskId);
    if (taskId !== undefined) {
      this.#sdkSession.backgroundWaiters.noteFinished(
        taskId,
        typeof event.outputFile === 'string' ? event.outputFile : null,
      );
    }
    // 作業者ではないタスクの通知を `notifications`・failed 通知に入れない: `task_started` 側だけを直すと Bash の失敗が「作業者の failed 通知」に積まれ、枠を名乗れば枠の件数まで立つため
    const nonWorker = taskId !== undefined && this.#nonWorkerTaskIds.delete(taskId);
    if (!nonWorker) this.#turnTally.incrementNotificationsSinceResult();

    if (!nonWorker && event.status === 'failed') {
      const limitNamed =
        event.summary !== undefined && classifyUsageNotice(event.summary) !== undefined;
      this.#turnTally.recordFailedWorkerNotification(taskId, limitNamed);
    }

    if (taskId !== undefined && this.#cutOffWorkers.consumeCutOff(taskId)) {
      this.#cutOffWorkers.recordPendingNotification(taskId);
    }

    if (taskId !== undefined) {
      const owner = this.#stopState.backgroundTaskOwner(taskId);
      if (owner !== undefined && owner !== '' && this.#cutOffWorkers.isCutOff(owner)) {
        this.#cutOffWorkers.recordPendingBackgroundTaskOutput({
          agentId: owner,
          taskId,
          command: this.#stopState.backgroundTaskCommand(taskId),
          outputFile: typeof event.outputFile === 'string' ? event.outputFile : null,
        });
        this.#wakeForFinishedBackgroundTaskOutputs();
      }
    }
  }

  // `waiting_human` では起こさない（`done` のときだけ）: `push()` が状態を `running` へ戻し、確認待ちが残ったまま「確認待ちではない」と名乗って `answer()` の宛先との対応が崩れるため
  #wakeForFinishedBackgroundTaskOutputs(): void {
    if (this.#sdkSession.stopped || this.#sdkSession.status !== 'done') return;
    const body = this.#drainFinishedBackgroundTaskOutputs();
    if (body === null) return;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: '打ち切った作業者の背景処理の完了で、止まっていたマネージャーを起こした（#1554）',
    });
    this.push(
      'alteroid が自動で送った知らせである（#1554）。作業者は打ち切られていて、' +
        `自分では再開しない。\n\n${body}`,
    );
  }

  // `settled` を引数で受けない: 呼び出し側に持たせると3経路が固定で `false` を渡し、受け切った直後に畳まれた場合まで偽の印が付くため
  #closeWorkerWaitWindow(): void {
    const closedWindow = this.#workerWaitWindow.close();
    if (closedWindow === null) return;
    this.#emit({ type: 'worker_wait', managerId: this.#id, ...closedWindow });
  }

  // `#progressed` を立てない: 拒否は手が動いた印ではなく、立てると resume が効かず終わった回を「もう作業した」と誤認して生ログからの作り直しを止めるため
  #noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): void {
    const tool = denial.tool ?? '(不明な道具)';
    const input = denial.input;
    if (typeof denial.toolUseId === 'string') this.#settleWorkerTool(denial.toolUseId);

    // SDK が付けてきた `denial.toolUseId` で引く: 下で組む代用の `toolUseId` は実在の id ではなく、無関係な一致が起きうるため
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#oneShotAllowedToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#oneShotAllowedToolUses.delete(denial.toolUseId);
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `1回だけの許可（issue #1105 P1、${funneled.actor}・${funneled.tool}）で allow を` +
            `返した呼び出しが、それでも拒否された（合図の出所: ${via}）。分類器がこの allow を` +
            `分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか` +
            `（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いて` +
            `いない可能性がある。`,
        });
      }
    }

    // 道具名だけで束ねない: 「同じ拒否の2度目」と「live を見逃した初出」が潰れるため（`tool_use_id` は SDK の型で必須なのでこの経路はいま踏まれない）
    // 入力そのものを鍵に混ぜない: 鍵は `onForget` が日誌へそのまま並べ、道具の入力にはトークンが入りうるため
    const toolUseId = denial.toolUseId ?? `${tool}:${digestOf(brief(input, 120))}`;
    // 引いたら消す: 生の入力を持ち回っていないので、同じ tool_use_id の拒否がもう一度来ても作り直せないため
    const inputHead = this.#preToolInputHeads.get(toolUseId);
    if (inputHead !== undefined) this.#preToolInputHeads.delete(toolUseId);
    // `has` だけで弾かない: 入力を持つのは `via: 'result'` だけで、弾くと入力を持つ authoritative な記録が捨てられ日誌に「何を実行しようとしたか」が残らないため
    // `permission_denied` をもう一度降ろさず既存の `note` で足す: デーモンは拒否を1件ずつ数えており二重計上で escalation が段を跨いで飛ぶため。新しい種別を足すとまだ知らないデーモンの `safeParse` が落ちる
    const seen = this.#denied.get(toolUseId);
    if (seen !== undefined) {
      if (seen.input || input === undefined) return;
      this.#denied.set(toolUseId, { input: true });
      const shape = denialInputShape(input);
      if (shape !== undefined) {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `先に降ろした ${tool} の拒否について、ターン終わりの記録（via: result）に` +
            `入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: ${shape}`,
        });
      }
      return;
    }
    this.#denied.set(toolUseId, { input: input !== undefined });
    // 文字列であることを確かめてからしか載せない: 型を保証しないまま `z.string().optional()` へ渡すと、SDK の型変化で数値や null が黙って通るため。無いものは作り物を出さずキーごと省く
    // `actor` は `via: 'live'` のときだけ載せる: `result` 側の SDK 型には `agent_id` が無く、「マネージャーだった」と決めつけないため
    // `agent_type` を作り物で埋めない: SDK の型に無い情報のため
    const agentId = denial.agentId;
    const agentType = denial.agentType;
    const actor =
      via === 'live'
        ? agentId === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${agentType ?? WORKER_AGENT_NAME}`
        : undefined;
    this.#emit({
      type: 'permission_denied',
      managerId: this.#id,
      toolUseId,
      tool,
      input,
      via,
      ...(actor === undefined ? {} : { actor }),
      ...(denial.reason === undefined ? {} : { reason: denial.reason }),
      ...(denial.reasonType === undefined ? {} : { reasonType: denial.reasonType }),
      ...(denial.message === undefined ? {} : { message: denial.message }),
      // `input` の欄には詰めない: `runner-protocol.ts` の `input` の doc が禁じているため（別の任意欄に載せる）
      ...(inputHead === undefined ? {} : { inputHead }),
    });
  }

  // 分類ロジックを複製しない: SDK の値をそのまま写し、集計は読む側（`context-usage.ts`）が1箇所で持つため
  // `this.#query` が無ければ聞かない: セッションが終わる窓で `getContextUsage` を持たない値を呼ぶことになるため（「まだ観測していない」側）
  // 例外の理由は `describeProbeError` でしか運ばない: 秘密を漏らさないため
  async #observeContextUsage(): Promise<ContextUsageObservation | undefined> {
    const session = this.#sdkSession.query;
    if (session === null) return undefined;
    const startedAt = Date.now();
    try {
      const usage = await session.contextUsage();
      const categories = (usage.categories ?? []).map((category) => ({
        name: category.name,
        tokens: category.tokens,
        kind: category.kind,
      }));
      const shownCategories = categories.slice(0, CONTEXT_USAGE_CATEGORY_LIMIT);
      const omittedCategories = categories.length - shownCategories.length;
      const sumTokens = (items: readonly { tokens: number }[]): number =>
        items.reduce((total, item) => total + item.tokens, 0);
      const mcpTools = usage.mcpTools ?? [];
      const memoryFiles = usage.memoryFiles ?? [];
      const systemPromptSections = usage.systemPromptSections ?? [];
      return {
        durationMs: Date.now() - startedAt,
        totalTokens: usage.totalTokens,
        rawMaxTokens: usage.rawMaxTokens,
        percentage: usage.percentage,
        ...(usage.autoCompactThreshold === undefined
          ? {}
          : { autoCompactThreshold: usage.autoCompactThreshold }),
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
        // 空の配列のときは欄そのものを作らない: 取れない軸に 0 の行を作らないため（AGENTS.md の地雷）
        ...(shownCategories.length === 0 ? {} : { categories: shownCategories }),
        ...(omittedCategories > 0 ? { categoriesOmitted: omittedCategories } : {}),
        ...(mcpTools.length === 0
          ? {}
          : { mcpToolTokens: sumTokens(mcpTools), mcpToolCount: mcpTools.length }),
        ...(memoryFiles.length === 0
          ? {}
          : { memoryFileTokens: sumTokens(memoryFiles), memoryFileCount: memoryFiles.length }),
        ...(systemPromptSections.length === 0
          ? {}
          : {
              systemPromptTokens: sumTokens(systemPromptSections),
              systemPromptSectionCount: systemPromptSections.length,
            }),
      };
    } catch (error) {
      return {
        durationMs: Date.now() - startedAt,
        error: describeProbeError(error, process.env),
      };
    }
  }

  // 畳む経路をこれに縛らない（投げない）: ターン中の control 要求は失敗が通常の枝のため
  // 全部ゼロなら降ろさない: ゼロは「読めなかった」で、降ろすと台帳に基準ができて「記録が無い」が「$0.00 使った」に化けるため
  // 層ごとに書き分けない: 片方だけ直っていると、直っていない側の欠落を「使っていない」と読ませるため
  async #flushUsage(): Promise<void> {
    const models = await this.#sdkSession.query?.sessionModelUsage();
    if (models === undefined) return;
    this.#emit({
      type: 'usage',
      managerId: this.#id,
      sessionId: this.#resumeState.sessionId,
      models,
    });
  }

  // 空なら1件も出さない: 中身の無い報告はクローンのターンを1本焼くため
  // 畳んでから出す: `stop()` の後に `#read` の catch から `#finish` が来る経路があり、二度は出さないため
  // `#rejected` を読まない: `result` が来ていないこの経路では「失敗として終わった」と名乗れないため
  #flushUnreported(reason: string, status: JobStatus): void {
    if (!this.#turnTally.hasSaid) return;
    const { said, reportId } = this.#turnTally.takeSaid();
    this.#emit({
      type: 'report',
      managerId: this.#id,
      ...(reportId === undefined ? {} : { reportId }),
      text: unreportedText(said, reason),
      status,
      unreported: { reason },
    });
  }

  // `selfFenced` を他の呼び出し元（resume 不能・クラッシュ）から渡さない: 自己失効以外にもデーモン側の判定（lease だけ返す）が効いてしまうため
  // ここで例外を握り潰さない: 呼び出し元は元から例外の伝播を前提にしており、新しく飲み込むと片方の前提を壊すため
  async #finish(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    await this.#sdkSession.trackClosing(() => this.#finishBody(status, reason, options));
  }

  async #finishBody(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    this.#sdkSession.markStopped();
    // 量をここでも1行にまとめる: `stop()` は `#finish` を通らず、片方だけにすると存在は残るが量だけが失われ、落ちていることに気づく手がかりが出力に無いため
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);
    // `close()` より先に読む: 閉じた後の control channel からは何も取れないため
    await this.#flushUsage();
    this.#closeWorkerWaitWindow();
    this.#settleAll(reason);
    this.#workerTools.settleAll();
    // 読み取りが終わっても入力側を起こして本体を閉じる。怠ると閉じられない
    // Query と起きない `#inputStream` が残る。
    this.#sdkSession.wakeInput();
    this.#peerBroker?.closeAll();
    this.#sdkSession.closeQuery();
    this.#sdkSession.setStatus(status);
    await this.#shipArchive();
    // `#shipArchive()` の後に置く: この報告を読んだクローンがすぐ `manager_transcript` で裏を取れるようにするため
    this.#flushUnreported(reason, status);
    // `closed` を emit する前に runner が自分で取って運ぶ: デーモンが `closed` を受けてから問い合わせると `#onClosed()` でセッションが消えていて空振りするため
    // `.catch()` を添える: 設計が将来守られなくなっても、この1回の観測の失敗が `#finish()` を巻き添えにしないため。取れなかったときは `kind: 'unavailable'` と理由を載せ、欄を省く（古い runner）のと混ぜない
    const unpushedWork = await this.#finishUnpushedWorkFn({
      signal: AbortSignal.timeout(FINISH_UNPUSHED_WORK_TIMEOUT_MS),
    })
      .then((result): FinishUnpushedWorkOutcome => ({ kind: 'ok', result }))
      .catch((error: unknown): FinishUnpushedWorkOutcome => ({
        kind: 'unavailable',
        reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
      }));
    const cgroupEvents = cgroupEventsDeltaOf(
      await this.#openedCgroupEvents,
      await this.#readCgroupEventCountersFn(),
    );
    this.#emit({
      type: 'closed',
      managerId: this.#id,
      status,
      reason,
      ...(options.selfFenced === undefined ? {} : { selfFenced: options.selfFenced }),
      ...(options.systemError === undefined ? {} : { systemError: options.systemError }),
      ...(cgroupEvents === undefined ? {} : { cgroupEvents }),
      unpushedWork,
    });
    this.#onClosed();
  }

  // 待ち時間に上限を置かない: 止まるのはこの1件だけで他は走り続けるため
  // `permissionMode` が `auto` でもこの配線を外さない: SDK が確認を降ろしてきたときの行き先はここ1本のため
  async #onPermission(
    permission: AgentPermissionRequest,
    source?: PeerApprovalSource,
  ): Promise<AgentPermissionDecision> {
    const { toolName, input, kind, signal, reason } = permission;
    this.#markProgressed();
    // 再送では新しい待ちを積まず同じ結果を返す: 二重に消費されると片方が永久に返らないため
    // peer の確認は id に出所を前置する: マネージャー自身の確認の id と混ざらないため
    const rawId = permission.requestId ?? randomUUID();
    const id =
      source === undefined ? rawId : `peer:${source.provider}:${source.sessionId}:${rawId}`;
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;
    // 解けた後の再送も同じ扱いにする: `#pending` だけで見ると「答えたのに待っていないと言われる」ため
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) return resolved;

    // `kind` の判定のコピーを作らない: `classifyManagerActivity` も同じ分け方を使うため
    const baseSummary =
      kind === 'question'
        ? describeQuestions(input)
        : `${toolName} の実行許可: ${brief(input)}${reason === undefined ? '' : `\n理由: ${reason}`}`;
    // 出所の印を要約の先頭に必ず付ける: 旧いデーモンが `source` 欄を落としても印が本文に残るため
    const summary =
      source === undefined ? baseSummary : `${peerApprovalMark(source.provider)}${baseSummary}`;
    // ここで1度だけ取る: 経路ごとに取り直すと、同じ確認が経路によって違う「待ち始めた時刻」を名乗るため
    const askedAt = new Date().toISOString();

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{
      message: string;
      decision?: 'allow' | 'deny';
      withdrawn?: true;
      aborted?: true;
    }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // `decideAnswer` の呼び出しを変えない: `Session#answer()` が同じ関数を呼んでおり、クローンへ返す値と SDK へ返る `behavior` の一致が壊れるため
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      // 畳む・中断の経路では `question` も deny で返す: `decideAnswer` は `question` なら常に allow を返すので、`decision` だけで判定すると人間が答えていない問いに畳む・中断の理由の文言が「答え」として乗るため（`message` の文字列は嗅がない）
      const teardown = answer.withdrawn === true || answer.aborted === true;
      // teardown 側を `unreadable` の対象外にする: クローンの回答そのものではないため
      const denyMessage =
        !teardown && unreadable ? unreadableDenyMessage(answer.message) : answer.message;
      const outcome: AgentPermissionDecision =
        teardown || decision === 'deny'
          ? { behavior: 'deny', message: denyMessage }
          : kind === 'question'
            ? { behavior: 'allow', updatedInput: withAnswers(input, answer.message) }
            : { behavior: 'allow' };
      // 解けたことを覚えるのはここ1箇所: 経路ごとに覚え忘れる隙を作らないため
      this.#resolved.set(id, outcome);
      return outcome;
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
      askedAt,
      result,
      // 待ち行列から自分を外すのは settle の責任: 呼び出し側任せにすると中断で解けた1件が行列に残り、次に届いた言葉を食い潰すため
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#sdkSession.status === 'waiting_human' && this.#pending.length === 0) {
          this.#sdkSession.setStatus('running');
        }
        this.#emit({
          type: 'settled',
          managerId: this.#id,
          requestId: id,
          ...(value.withdrawn === true ? { withdrawn: { reason: value.message } } : {}),
        });
        settle(value);
      },
    };

    this.#pending.push(request);
    this.#sdkSession.setStatus('waiting_human');

    const onAbort = () =>
      request.settle({
        message: 'マネージャー側で中断された。',
        decision: 'deny',
        aborted: true,
      });
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => signal.removeEventListener('abort', onAbort);
    }

    this.#emit({
      type: 'ask',
      managerId: this.#id,
      requestId: id,
      kind,
      summary,
      askedAt,
      ...(source === undefined ? {} : { source: { type: 'peer', provider: source.provider } }),
    });

    return result;
  }

  // `#onPermission` の実装を直接再利用しない: あちらは `PermissionResult` を組み立てる関数で、両方に手を入れると再送や `withdrawn`/`aborted` の挙動を壊しかねないため
  // 鍵が作れない入力はクローンへ確認を上げず `no-retry` で終える: 一致させる鍵が無いと撃ち直しを安全に特定できないため
  // 鍵は入力全体（`matchInputOf`）で作る: `command` だけだと `run_in_background` 等だけが違う撃ち直しにまで許可が及ぶため
  // フックの持ち時間切れは安全側（`no-retry`）で確定し `#pending` から外す: 遅れて届いた `allow` を構造的に捨てるため。`settled.withdrawn` を使い回さない: 「CLI に一度も届かなかった」と区別できなくなるため
  async #onPermissionDenied(
    record: AgentPermissionDeniedRecord,
  ): Promise<AgentPermissionDeniedDecision> {
    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const toolName = record.toolName;

    // `tool_input` を載せない（理由は先頭だけ）
    const reasonHead = Array.from((record.reason ?? '').replace(/\s+/g, ' ').trim());
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `分類器の拒否のフックが届いた（${actor}・${toolName ?? '道具名なし'}・` +
        `tool_use_id=${record.toolUseId ?? '無し'}）。理由の先頭: ` +
        `${reasonHead.length === 0 ? '(無し)' : reasonHead.slice(0, 80).join('')}` +
        `${reasonHead.length > 80 ? '…' : ''}（issue #1766）`,
    });

    if (toolName === undefined) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否（${actor}）が道具名を持たない合図で届いたので、クローンへは確認を上げず、` +
          `1回だけの許可も出さない（issue #1105 P1）。`,
      });
      return { kind: 'no-retry' };
    }

    const matchInput = matchInputOf(record.toolInput);
    if (matchInput === undefined) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器が ${actor} の ${toolName} 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳め` +
          `なかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。`,
      });
      return { kind: 'no-retry' };
    }

    const inputHead = buildDenialInputHead(record.toolInput, this.#env);
    const permitKey = oneShotAllowKey(
      oneShotActorOf(this.#id, record),
      toolName,
      digestOf(matchInput),
    );
    const id = record.toolUseId ?? randomUUID();

    const already = this.#pending.find((request) => request.id === id);
    if (already) {
      const outcome = await already.result;
      return outcome.behavior === 'allow' ? { kind: 'retry' } : { kind: 'no-retry' };
    }
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) {
      return resolved.behavior === 'allow' ? { kind: 'retry' } : { kind: 'no-retry' };
    }

    const kind = 'permission';
    const summary =
      `分類器が ${actor} の ${toolName} 呼び出しを拒否した。この1回だけ許可しますか。\n` +
      `（allow は「同じ入力での撃ち直しを1回だけ通す」許可で、撃ち直すかは担い手が決める。` +
      `拒否文が再試行を禁じていると撃ち直されないことがある。その場合は allow の後で担い手へ` +
      `manager_send で伝える必要がある。効くかは確かめていない）\n` +
      `理由: ${record.reason ?? '(無し)'}\n` +
      `入力の先頭（伏せ字・最大160字。issue #1105 P0）: ${inputHead ?? '(取れなかった)'}`;
    const askedAt = new Date().toISOString();

    // `withdrawn` を型から落とさない: 落とすと畳みで解けた確認が取り下げとして日誌に残らず、下の deny の note がクローンの判断として書かれるため
    let settle!: PendingRequest['settle'];
    const answered = new Promise<{
      message: string;
      decision?: 'allow' | 'deny';
      withdrawn?: true;
      aborted?: true;
    }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // `decideAnswer` を `#onPermission` と共有する: 別々に判定を書くと黙ってずれるため
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      const teardown = answer.aborted === true || answer.withdrawn === true;
      const denyMessage =
        !teardown && unreadable ? unreadableDenyMessage(answer.message) : answer.message;
      const outcome: AgentPermissionDecision =
        teardown || decision === 'deny'
          ? { behavior: 'deny', message: denyMessage }
          : { behavior: 'allow' };
      this.#resolved.set(id, outcome);
      return outcome;
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
      askedAt,
      result,
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#sdkSession.status === 'waiting_human' && this.#pending.length === 0) {
          this.#sdkSession.setStatus('running');
        }
        this.#emit({
          type: 'settled',
          managerId: this.#id,
          requestId: id,
          ...(value.withdrawn === true ? { withdrawn: { reason: value.message } } : {}),
        });
        settle(value);
      },
    };

    this.#pending.push(request);
    this.#sdkSession.setStatus('waiting_human');

    let timedOut = false;
    const onTimeout = () => {
      timedOut = true;
      request.settle({
        message: 'フックの持ち時間が尽きたので、安全側でこの1回だけの許可は出さない。',
        decision: 'deny',
        aborted: true,
      });
    };
    const signal = record.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onTimeout();
      } else {
        signal.addEventListener('abort', onTimeout, { once: true });
        unlisten = () => signal.removeEventListener('abort', onTimeout);
      }
    }

    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary, askedAt });

    const answer = await answered;
    const outcome = await result;

    if (timedOut) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否（${actor}・${toolName}）への1回だけの許可の確認が、フックの持ち時間切れで` +
          `終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので` +
          `反映しない（issue #1105 P1）。`,
      });
      return { kind: 'no-retry' };
    }

    // 畳みで解けた確認をクローンの判断として書かない（deny の分岐より前に置く）: クローンは答えておらず、取り下げの事実は `settled.withdrawn` が運ぶため
    if (answer.withdrawn === true) {
      return { kind: 'no-retry' };
    }

    if (outcome.behavior === 'deny') {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `クローンが分類器の拒否（${actor}・${toolName}）への1回だけの許可を出さなかった: ${outcome.message}`,
      });
      return { kind: 'no-retry' };
    }

    this.#noteUnusedExpiredOneShotAllows(undefined);
    this.#oneShotAllows.set(permitKey, {
      expiresAt: Date.now() + ONE_SHOT_ALLOW_TTL_MS,
      actor,
      tool: toolName,
    });
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `クローンが分類器の拒否（${actor}・${toolName}）を1回だけ許可した。同じ入力で撃ち直された` +
        `ときにだけ、${Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000)}分以内なら1回通す（issue #1105 P1）。` +
        `撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない。` +
        `分類器の拒否文が再試行や別の手段を禁じていると、担い手は撃ち直さないことがある` +
        `（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。` +
        `その場合は許可を出したクローンが、担い手へ manager_send で同じ入力で撃ち直してよいこと` +
        `（1回だけの許可が有効なこと）を明示して伝える。これで撃ち直されるかは確かめていない。`,
    });
    return { kind: 'retry' };
  }

  // 「もっと強く書く」側へ倒さず機械の門へ倒す: システムプロンプトへ逐語で書いても守られないことを #894 が実測したため
  // 既定を deny にしない（`ask` を既定にする）: 誰も開けられず、方針は設定で開けられなければならないため（north_star 禁止2）
  // `Bash` 以外を弾かない: 他のツールまで巻き込むと「何でも弾きうる門」になり、確認が要る行為の一覧を作ることに近づくため
  // `decision: 'block'`（セッション全体を止める口）を使わない: この呼び出し1件だけを拒否する
  // `escalate` を立てない: 作業者が動けなくなったような危険の通知ではなく、ツール呼び出し1件が拒否に置き換わっただけの経過のため
  // 冒頭で全道具の入力の先頭を控える（`Bash` に絞らない）: 分類器はどの道具でも拒否しうるため
  // 1回だけの許可の消費は deny の後に置く: `deny` の設定ではクローンの許可で門を上書きしないため
  // 判定の周りの例外で deny を消さない: フックが例外で終わると CLI は「ブロックしない」として通常の許可の流れへ戻し、ガードが素通りになるため（観測の副作用は失敗しても判定を止めず、判定そのものが投げたら確認へ倒す）
  async #onPreToolUse(record: AgentPreToolRecord): Promise<AgentPreToolDecision> {
    this.#tryObservation('PreToolUse の入力の頭の控え', () => {
      this.#capturePreToolInputHead(record);
    });

    let guardAsk: { reason: string } | undefined;
    if (record.toolName === 'Bash') {
      const toolInput = record.toolInput as
        { command?: unknown; run_in_background?: unknown } | null | undefined;
      const command = toolInput?.command;
      if (typeof command === 'string') {
        // `run_in_background` を `=== true` で受ける: 欠けていても形が崩れていても前景になり、通す側へ倒れるため
        let verdict:
          ReturnType<typeof inspectBashCommand> | { blocked: true; form: string; reason: string };
        try {
          // 本番デプロイの起動（release-prod）は `off` でも確認に残す
          const releaseProd = inspectReleaseProdDispatch(command);
          verdict = releaseProd.matched
            ? { blocked: true, form: releaseProd.form, reason: releaseProd.reason }
            : this.#bashGuard === 'off'
              ? { blocked: false }
              : inspectBashCommand(command, {
                  backgrounded: toolInput?.run_in_background === true,
                });
        } catch (error) {
          // 判定できなかった呼び出しを素通しにしない: 倒れる先は確認で、上がらずに止めて誰も開けられない形にしない（`deny` を選んだ人にだけ止める）
          const message = reasonOf(error);
          const reason = `Bash のガードの判定が例外で終わったので、安全側で確認に上げた（${message}）。形を変えずに打ち直さず、依頼者へ報告すること。`;
          if (this.#bashGuard === 'deny') {
            return {
              kind: 'deny',
              reason: `Bash のガードの判定が例外で終わったので、安全側で拒否した（${message}）。形を変えずに打ち直さず、依頼者へ報告すること。`,
            };
          }
          return { kind: 'ask', reason };
        }
        if (verdict.blocked) {
          const actor =
            record.agentId === undefined
              ? `manager:${this.#id}`
              : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
          const asked = this.#bashGuard !== 'deny';

          this.#tryObservation('ガードの note の送り出し', () => {
            this.#emit({
              type: 'note',
              managerId: this.#id,
              text: asked
                ? `Bash の呼び出しを確認に上げた（${actor}・形=${verdict.form}）。${verdict.reason}`
                : `Bash の呼び出しを弾いた（${actor}・形=${verdict.form}）。${verdict.reason}`,
            });
          });

          if (!asked) return { kind: 'deny', reason: verdict.reason };
          guardAsk = { reason: verdict.reason };
        }
      }
    }

    // ガードの deny より後に置く: 弾いた呼び出しは Post も拒否の合図も来ないので、置くと片付かないため
    this.#tryObservation('作業者の道具の見張り', () => {
      if (record.agentId === undefined || record.toolUseId === undefined) return;
      this.#workerTools.begin({
        agentId: record.agentId,
        actor: `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`,
        tool: record.toolName ?? '(不明)',
        toolUseId: record.toolUseId,
      });
    });

    // `deny` の守りを書かない: `#consumeOneShotAllow` は戻り値の型で `deny` を返さず、将来返すようになれば `tsc` がここで落ちるため
    const decision = this.#consumeOneShotAllow(record);
    const rewrite = this.#planBashToolTimeoutRewrite(record);
    // 門の確認（`ask`）はクローンの1回だけの許可が開ける: 許可は同じ呼び出しに明示して出されたもので、確認に上げた答えと同じ重さのため
    const resolved: Exclude<AgentPreToolDecision, { kind: 'deny' }> =
      guardAsk !== undefined && decision.kind === 'continue'
        ? { kind: 'ask', reason: guardAsk.reason }
        : decision;
    if (rewrite === undefined) return resolved;
    return { ...resolved, rewrite };
  }

  // 弾かず `timeout` の欄だけを引き上げる。判定が投げても呼び出しを止めない: 書き換えは安全弁ではなく便宜なので、倒れる先は「書き換えない」
  #planBashToolTimeoutRewrite(record: AgentPreToolRecord): AgentPreToolRewrite | undefined {
    if (record.toolName !== 'Bash') return undefined;
    const toolInput = record.toolInput;
    if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
      return undefined;
    }
    const input = toolInput as Record<string, unknown>;
    let raise: ReturnType<typeof planBashToolTimeoutRaise>;
    try {
      raise = planBashToolTimeoutRaise(input);
    } catch (error) {
      process.stderr.write(
        `alteroid: Bash の timeout 引数の判定が失敗した（書き換えない）: ${reasonOf(error)}\n`,
      );
      return undefined;
    }
    if (raise === undefined) return undefined;

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const from = raise.fromMs === undefined ? '未指定' : `${raise.fromMs}ms`;
    this.#tryObservation('timeout 引数の引き上げの note の送り出し', () => {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `Bash の呼び出しの timeout 引数を引き上げた（${actor}・形=bash-tool-timeout-raised・${from}→${raise.toMs}ms）。`,
      });
    });
    return { input: { ...input, timeout: raise.toMs }, note: describeBashToolTimeoutRaise(raise) };
  }

  #settleWorkerTool(toolUseId: string): void {
    this.#tryObservation('作業者の道具の見張りの片付け', () => {
      this.#workerTools.settle(toolUseId);
    });
  }

  // 投げ直さない: `#onPreToolUse` が例外で終わり、ガードの deny が CLI へ届かなくなるため
  #tryObservation(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      process.stderr.write(`alteroid: ${label}が失敗した（判定は続ける）: ${reasonOf(error)}\n`);
    }
  }

  // `Bash` に絞らない: 分類器は `Edit` / `Write` 等にも掛かり、絞ると撃ち直しのほとんどが通せなくなるため
  // 鍵は表示用の伏せ字済みの値（`buildDenialInputHead`）にしない: 先頭160字が同じで残りが違う別の入力が誤って一致しうるため
  // `rawLineOf` を鍵にしない: `command` が同じでほかの欄（`run_in_background` / `timeout` 等）だけが違う撃ち直しにまで許可が及ぶため
  // 一致してもしなくても使い切る（`delete` する）。寿命ちょうどのミリ秒も「過ぎた」側に含める: 「まだ有効」に倒れると許しすぎるため
  #consumeOneShotAllow(
    record: AgentPreToolRecord,
  ): Extract<AgentPreToolDecision, { kind: 'continue' | 'allow' }> {
    const toolName = record.toolName;
    if (toolName === undefined) return { kind: 'continue' };
    const matchInput = matchInputOf(record.toolInput);
    if (matchInput === undefined) return { kind: 'continue' };

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const key = oneShotAllowKey(oneShotActorOf(this.#id, record), toolName, digestOf(matchInput));
    this.#noteUnusedExpiredOneShotAllows(key);
    const grant = this.#oneShotAllows.get(key);
    if (grant === undefined) return { kind: 'continue' };
    this.#oneShotAllows.delete(key);

    if (grant.expiresAt <= Date.now()) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否への1回だけの許可（${actor}・${toolName}）は期限切れだったので使わなかった` +
          `（issue #1105 P1）。分類器の判定へそのまま委ねる。`,
      });
      return { kind: 'continue' };
    }

    if (typeof record.toolUseId === 'string') {
      this.#oneShotAllowedToolUses.set(record.toolUseId, { actor, tool: toolName });
    }

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `クローンの1回だけの許可（issue #1105 P1）で、分類器の拒否（${actor}・${toolName}）を上書きした。`,
    });

    return {
      kind: 'allow',
      reason: 'クローンが分類器の拒否をこの1回だけ上書きした（issue #1105 P1）。',
    };
  }

  // タイマーを置かない（遅延評価）: セッションの終了・畳みで片付け漏れる物が無いため
  #noteUnusedExpiredOneShotAllows(except: string | undefined): void {
    const now = Date.now();
    for (const [key, grant] of this.#oneShotAllows.entries()) {
      if (key === except || grant.expiresAt > now) continue;
      this.#oneShotAllows.delete(key);
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `クローンが出した1回だけの許可（${grant.actor}・${grant.tool}）は、撃ち直されないまま` +
          `${Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000)}分の期限が切れた（使われていない。issue #1105 P1）。` +
          `撃ち直すかどうかは担い手のモデルが決めることで、retry は助言でしかない。` +
          `manager_send で伝える案が効くかは確かめていない。` +
          `この note は期限後の次の道具呼び出しか次の拒否の時点で出る（それまで何も呼ばれなければ出ない）。`,
      });
    }
  }

  // 生の入力を保持しない（伏せ字済みの先頭だけ）: 忘れるまでの間ずっと鍵が入りうる文字列を抱え、`onForget` の日誌行へ滲み出る経路も増えるため
  #capturePreToolInputHead(record: AgentPreToolRecord): void {
    if (record.toolUseId === undefined) return;
    const preview = buildDenialInputHead(record.toolInput, this.#env);
    if (preview === undefined) return;
    this.#preToolInputHeads.set(record.toolUseId, preview);
  }

  // 背景タスクの所有者をここで控える: `SubagentStop` の `background_tasks[]` に所有者の欄が無く、生ログにも構造化された形では出ないため
  // 成功で決着した呼び出しの控え（`#preToolInputHeads` / `#oneShotAllowedToolUses`）を消す: 控えっぱなしにしない（成功後に拒否は届かない）
  async #onPostToolUse(record: AgentToolAuditRecord): Promise<AgentContextOutcome> {
    if (typeof record.toolUseId === 'string') {
      this.#preToolInputHeads.delete(record.toolUseId);
      this.#oneShotAllowedToolUses.delete(record.toolUseId);
      this.#settleWorkerTool(record.toolUseId);
    }
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    this.#markProgressed();

    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

    this.#emit({
      type: 'tool_use',
      managerId: this.#id,
      actor:
        record.agentId === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`,
      tool: record.toolName ?? '(不明)',
      input: record.toolInput,
    });

    this.#recordBackgroundTaskOwner(record.toolResponse, record.agentId, record.toolInput);

    // 道具の種類を問わない: `#pendingCutOffNotifications` はどの道具の呼び出しにも相乗りし、先に届いた別の完了通知を配達するだけのため
    const additionalContext =
      record.agentId === undefined ? this.#annotateCutOffWorkers(record.toolResponse) : null;
    if (additionalContext === null) return { kind: 'continue' };
    return { kind: 'addContext', text: additionalContext };
  }

  #annotateCutOffWorkers(toolResponse: unknown): string | null {
    const parts: string[] = [];
    const sync = this.#annotateCutOffWorker(toolResponse);
    if (sync !== null) parts.push(sync);
    const pending = this.#drainPendingCutOffNotifications();
    if (pending !== null) parts.push(pending);
    const finished = this.#drainFinishedBackgroundTaskOutputs();
    if (finished !== null) parts.push(finished);
    return parts.length === 0 ? null : parts.join('\n\n');
  }

  // `#renderSubagentStopTaskLines` を使い回さない: 型も出所も違うため
  #renderCutOffTaskLines(agentId: string): string[] {
    return this.#cutOffWorkers
      .cutOffTasks(agentId)
      .map(
        (task) => `- id=${task.id}${task.command === undefined ? '' : ` command=${task.command}`}`,
      );
  }

  // 案内の文面を場所ごとに変えない: 読む場所によって変わると、どこで読んでも同じ手を思い出せるという利点が消えるため
  // 即時に届くとは書かない: 届くのは作業者の次の道具の区切りで、作業者は読む前に動くことがあるため
  #resumeGuidance(agentId: string): string {
    return (
      `続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから ` +
      `agentId=${agentId} へ送ること——同じ文脈のまま再開できる。` +
      '届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。'
    );
  }

  #drainFinishedBackgroundTaskOutputs(): string | null {
    const items = this.#cutOffWorkers.drainPendingBackgroundTaskOutputs();
    if (items.length === 0) return null;
    const describe = (item: PendingBackgroundTaskOutput): string =>
      `agent_id=${item.agentId} が残した背景処理（id=${item.taskId}` +
      `${item.command === undefined ? '' : `・command=${item.command}`}）`;
    for (const item of items) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `打ち切った作業者の背景処理が終わった（#1554）: ${describe(item)}が完了した。` +
          `出力は${item.outputFile === null ? '取れなかった' : ` ${item.outputFile}`}`,
      });
    }
    return items
      .map(
        (item) =>
          `⚠️ ${describe(item)}が終わった。出力は` +
          `${item.outputFile === null ? '取れなかった' : ` ${item.outputFile}`}。 ` +
          this.#resumeGuidance(item.agentId),
      )
      .join('\n\n');
  }

  // フックの `agent_id` どうしで結ばない: `Task` の `PostToolUse` はマネージャー側で発火するので `agent_id` が付かないため（`tool_response.agentId` と `SubagentStop` の `agent_id` で結ぶ）
  #annotateCutOffWorker(toolResponse: unknown): string | null {
    if (typeof toolResponse !== 'object' || toolResponse === null) return null;
    const response = toolResponse as { status?: unknown; agentId?: unknown };
    if (response.status !== 'completed' || typeof response.agentId !== 'string') return null;
    if (!this.#cutOffWorkers.consumeCutOff(response.agentId)) return null;
    const agentId = response.agentId;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `Task の結果に注記した（#901）: agent_id=${agentId} は背景処理の待ちの上限（30分）で打ち切られていた`,
    });
    return [
      `⚠️ この作業者（agent_id=${agentId}）は、自分で起こした背景処理を残したまま` +
        '畳もうとした後、背景処理の完了を待つ上限（30分）に達したため、alteroid が打ち切った。' +
        '**上の報告は完結していない可能性がある**（最後の発言が「待っています」の類でも、' +
        'その待ちはもう誰も続けない）。成果（commit / push / 検証）が実際に在るかを確かめてから次を決めること。',
      ...this.#renderCutOffTaskLines(agentId),
      '出力の置き場所は、処理が終わったら知らせる（#1554）。',
      this.#resumeGuidance(agentId),
    ].join('\n');
  }

  // note は配達時点で出す（控えた時点では出さない）: 控えただけの段階で同じ文言を出すと「もう注記した」と読めてしまうため
  #drainPendingCutOffNotifications(): string | null {
    const agentIds = this.#cutOffWorkers.drainPendingNotifications();
    if (agentIds.length === 0) return null;
    for (const agentId of agentIds) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `Task の結果に注記した（#901・task_notification 経由）: ` +
          `agent_id=${agentId} は背景処理の待ちの上限（30分）で打ち切られていた`,
      });
    }
    return agentIds
      .map((agentId) =>
        [
          `⚠️ 作業者（agent_id=${agentId}）は、自分で起こした背景処理を残したまま` +
            '畳もうとした後、背景処理の完了を待つ上限（30分）に達したため、alteroid が打ち切った。' +
            '**先に届いたその完了通知（task-notification）の報告は完結していない可能性がある**' +
            '（最後の発言が「待っています」の類でも、その待ちはもう誰も続けない）。' +
            '成果（commit / push / 検証）が実際に在るかを確かめてから次を決めること。',
          ...this.#renderCutOffTaskLines(agentId),
          '出力の置き場所は、処理が終わったら知らせる（#1554）。',
          this.#resumeGuidance(agentId),
        ].join('\n'),
      )
      .join('\n\n');
  }

  // `tool_use` に `outcome` を足さず `note` で出す: 旧 daemon の `runnerEventSchema` は未知の欄を黙って落とし、失敗が成功の顔で日誌に残る（1件も記録しないより悪い）ため
  // `#recordBackgroundTaskOwner` を呼ばない: `PostToolUseFailureHookInput` には `tool_response` も `backgroundTaskId` を運べる欄も無いため
  // 自作ツールの除外を失敗側にだけ新設しない: 成功側と揃えるため
  // `#preToolInputHeads` / `#oneShotAllowedToolUses` を消す: 失敗は `#noteDenial` を経由せず、消さないと上限による `onForget` まで残るため
  async #onPostToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    if (typeof record.toolUseId === 'string') {
      this.#preToolInputHeads.delete(record.toolUseId);
      this.#oneShotAllowedToolUses.delete(record.toolUseId);
      this.#settleWorkerTool(record.toolUseId);
    }
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    this.#markProgressed();

    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const tool = record.toolName ?? '(不明)';
    const error =
      typeof record.error === 'string'
        ? // 道具の出力（トークン・資格付き URL）を運びうる自由文なので、伏せてから切る
          excerptLine(redactErrorText(record.error, process.env), TOOL_USE_FAILURE_ERROR_EXCERPT)
        : '(不明)';

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${TOOL_USE_FAILURE_NOTE_PREFIX} 道具=${tool}・actor=${actor}・error=${error}`,
    });
  }

  // 入力を防御的に読む: `tool_response` の形は SDK 側の都合で変わりうるため。道具名で絞らない（このキーを返す道具は `Bash` だけなので、他の道具での早期 return は正常な経路）
  // 「読めなかった」`command` を空文字と混ぜない
  #recordBackgroundTaskOwner(
    toolResponse: unknown,
    agentId: string | undefined,
    toolInput?: unknown,
  ): void {
    if (typeof toolResponse !== 'object' || toolResponse === null) return;
    const taskId = (toolResponse as { backgroundTaskId?: unknown }).backgroundTaskId;
    if (typeof taskId !== 'string' || taskId.length === 0) return;

    const command =
      typeof toolInput === 'object' && toolInput !== null
        ? (toolInput as { command?: unknown }).command
        : undefined;

    // マネージャー自身の分は空文字で控える: 「引けなかった」と混ぜないため
    this.#stopState.setBackgroundTaskOwner(
      taskId,
      agentId ?? '',
      typeof command === 'string' ? command : undefined,
    );
  }

  // `{ continue: true }` を返すだけでブロックしない: ブロックすれば能力の削除になるため
  async #onUserPromptSubmit(record: AgentUserPromptSubmitRecord): Promise<void> {
    if (record.agentId === undefined) {
      this.#turnTally.incrementSubmitsSinceResult();
      // 取れない回に `'unknown': 1` のような行を作らない（AGENTS.md 地雷「取れない軸に0の行を作る」）
      if (typeof record.source === 'string') {
        this.#turnTally.recordSubmitSource(record.source);
      }
    }
  }

  /**
   * [sdk-verbatim SubagentStopHookSpecificOutput]
   * > Hook-specific output for the SubagentStop event. additionalContext is non-error feedback delivered to the subagent; the subagent continues so it can act on it.
   */
  // `decision: 'block'` を使わず `additionalContext` だけを返す: `block` は止める側の口で、地雷「ターン数上限・実行回数上限で暴走を止める」（能力の削除）に当たるため
  // `runner-protocol.ts` の欄を増やさず `note` に乗せる: runner が新しく名乗る値を足すと古い runner が居る窓が開くため
  // `background_tasks` が非空であることを空転の署名にしない: 畳もうとしている当人と兄弟の作業者も配列に入り、件数では「この作業者が待っている」が言えないため（所有者で絞る）
  // `mine` を「まだ走っているもの」と見ない（`status` で言い分ける）: 畳み終えた背景処理の完了を待たせる形で作業者を起こし直し、進まないまま上限に達して委譲が止まるため
  // 回数の上限で暴走を止めない: 回数で止める形は地雷に当たり、各回は背景処理が終わった後の1ターンで空転ではなく仕事のため（終わらない背景処理は30分で切れる）
  // 待ちの途中で畳まれたら起こし直さず返す: 畳まれつつある世代で作業者にモデルを1ターン回させても結果は誰にも届かない。打ち切りではないので `recordCutOff` は通さない
  // この `note` が出ないことを「空転が無かった」と読ませない: フックの発火は親のターンが開いていたかで割れ、拾えるのは一部のため
  // 例外が出ても起こし直さず `{ continue: true }` へ倒す。`#markProgressed()` を呼ばない: 挙動を変えるのは継続の合図だけのため
  async #onSubagentStop(record: AgentSubagentStopRecord): Promise<AgentContextOutcome> {
    if (typeof record.agentId === 'string') {
      const agentId = record.agentId;
      this.#tryObservation('作業者の道具の見張りの片付け', () => {
        this.#workerTools.settleAgent(agentId);
      });
    }
    try {
      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const agentId = record.agentId;
      const stopHookActive = record.stopHookActive;

      const mine = tasks.filter((task) => {
        const id = (task as { id?: unknown }).id;
        if (typeof id !== 'string' || agentId === undefined) return false;
        return this.#stopState.backgroundTaskOwner(id) === agentId;
      });

      if (mine.length === 0) {
        this.#noteOwnerLookupFailure(tasks);
        return { kind: 'continue' };
      }
      if (agentId === undefined) return { kind: 'continue' };

      // `'unknown'` は「走っている」側へ倒す: 倒す先を間違えると起こし直しが黙って効かなくなるため（分からなかったことは下の `note` に書く）
      const remaining: unknown[] = [];
      const settled: unknown[] = [];
      let unknownStatusCount = 0;
      for (const task of mine) {
        const kind = classifyBackgroundTaskStatus((task as { status?: unknown }).status);
        if (kind === 'settled') {
          settled.push(task);
          continue;
        }
        remaining.push(task);
        if (kind === 'unknown') unknownStatusCount += 1;
      }

      // 当人のものが全部終わっていたら起こし直さないが、黙らない: 1セッションに1回だけ日誌へ出す（`#noteSettledOnly`）
      if (remaining.length === 0) {
        this.#noteSettledOnly(settled);
        return { kind: 'continue' };
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;
      const disclaimer =
        '⚠️ この行が出ないことは「空転が無かった」を意味しない — ' +
        'このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。';

      // 数に入れなかったものを黙って落とさない: 「残っている」の件数だけを出すと `status` で言い分けたこと自体が消えるため（AGENTS.md「静かに失敗する道具」）
      const settledText =
        settled.length === 0
          ? ''
          : `（当人が起こしたもののうち ${settled.length}件 は status が「終わった」側だったので数に入れていない）`;
      const unknownText =
        unknownStatusCount === 0
          ? ''
          : `⚠️ 上のうち ${unknownStatusCount}件 は status が既知の語彙のどちらでもない —— ` +
            '「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。' +
            'この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。';
      // `id` を防御的にもう一度 `typeof` で絞る: 前提が崩れても例外で落ちない側へ倒すため
      const remainingIds = remaining
        .map((task) => (task as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      const waitOutcome = await this.#waitForBackgroundTasks(remainingIds);

      // 待ちの途中で畳まれたら起こし直さず返す: 結果が誰にも届かず、`recordCutOff` を通すと新しい世代で「打ち切った作業者」の注記を誤って出すため
      if (waitOutcome === 'released') {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: this.#truncateSubagentStopText(
            `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
              `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした** ` +
              '— 完了を待っている途中でセッションが畳まれた（stop / 畳み直し / 世代交代）ので、' +
              `起こし直さずに返した。${stopHookActiveText}`,
          ),
        });
        return { kind: 'continue' };
      }

      if (waitOutcome === 'settled') {
        const newTotal = this.#stopState.recordSubagentWakeup(agentId);
        const taskLines = this.#renderSubagentStopTaskLines(remaining);

        const noteLines = [
          `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
            `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
            `**完了を待ってから起こし直した**（この作業者の通算 ${newTotal}回目）。${stopHookActiveText}`,
          ...taskLines,
          ...(unknownText === '' ? [] : [unknownText]),
          disclaimer,
        ];
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: this.#truncateSubagentStopText(noteLines.join('\n')),
          stall: {
            agentId,
            ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
            ownedTaskCount: remaining.length,
            sessionTaskCount: tasks.length,
            wakeupCount: newTotal,
            outcome: 'woken',
          },
        });

        // 出力の置き場所が取れなければ「取れなかった」と書く: 作り物のパスを主張しないため
        const snapshotCommands = new Map<string, string>();
        for (const task of remaining) {
          const t = task as { id?: unknown; command?: unknown };
          if (typeof t.id === 'string' && typeof t.command === 'string') {
            snapshotCommands.set(t.id, t.command);
          }
        }
        const finishedLines = remainingIds.map((id) => {
          const command = snapshotCommands.get(id) ?? this.#stopState.backgroundTaskCommand(id);
          const outputFile = this.#sdkSession.backgroundWaiters.outputFileOf(id);
          return (
            `- id=${id}${command === undefined ? '' : ` command=${command}`} ` +
            `出力: ${outputFile === null ? '取れなかった（完了通知の output_file が無い）' : outputFile}`
          );
        });
        const contextLines = [
          `あなたが自分で起こした背景処理が ${remaining.length}件、残ったまま畳もうとしたので、` +
            '**終わるまで待ってから**起こし直した。**背景処理は終わった。**' +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。`,
          ...finishedLines,
          ...(unknownText === '' ? [] : [unknownText]),
          '**結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。' +
            'まだ続きの背景処理を起こすなら、畳む前にまた最大 ' +
            `${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分は完了を待つ（それを超えると打ち切られる）。`,
          `これはこの作業者の通算 ${newTotal}回目の起こし直し。`,
        ];
        return {
          kind: 'addContext',
          text: this.#truncateSubagentStopText(contextLines.join('\n')),
        };
      }

      // `escalate` を毎回立てない: 同じ agentId が `SubagentStop` を送るたびに同じ report がクローンの受信箱へ積まれ続けるため（間引くのは知らせであって実行の制限ではない）
      const total = this.#stopState.subagentWakeupTotal(agentId);
      const { count: limitNoteCount, shouldEscalate: shouldEscalateLimitNote } =
        this.#stopState.recordSubagentLimitReachedNote(agentId);

      const taskLines = this.#renderSubagentStopTaskLines(remaining);
      const limitReasonText =
        `**背景処理の完了を ${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分（待ちの上限）まで待ったが、` +
        `終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 ${total}回 起こし直し済み）。`;
      const limitNoteCountText =
        `打ち切ってから ${limitNoteCount}回目（1・3・9…回目だけクローンへ上げる）。` +
        (shouldEscalateLimitNote ? '' : ' この回はクローンの受信箱へは上げない — 日誌には残る。');
      const noteLines = [
        `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
          `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
          settledText +
          `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
          limitReasonText +
          stopHookActiveText,
        limitNoteCountText,
        ...taskLines,
        ...(unknownText === '' ? [] : [unknownText]),
        disclaimer,
        // `taskLines` より後ろに置く: `#truncateSubagentStopText` は末尾から切るので、読み手がいちばん要る id / command を残すため
        '出力の置き場所は、処理が終わったら知らせる（#1554）。',
        this.#resumeGuidance(agentId),
      ];
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: this.#truncateSubagentStopText(noteLines.join('\n')),
        ...(shouldEscalateLimitNote ? { escalate: true } : {}),
        stall: {
          agentId,
          ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
          ownedTaskCount: remaining.length,
          sessionTaskCount: tasks.length,
          // 間引きの回数 `limitNoteCount` を運ばない: スキーマの doc の意味を変えないため
          wakeupCount: total,
          outcome: 'limit_reached',
        },
      });
      const cutOffTasks: CutOffBackgroundTaskSummary[] = remaining.flatMap((task) => {
        const t = task as { id?: unknown; command?: unknown };
        if (typeof t.id !== 'string') return [];
        return [{ id: t.id, ...(typeof t.command === 'string' ? { command: t.command } : {}) }];
      });
      this.#cutOffWorkers.recordCutOff(agentId, cutOffTasks);

      return { kind: 'continue' };
    } catch (error: unknown) {
      // フックが例外でセッションを止めない: 起こし直しよりも必ず `continue: true` を返すことを優先する
      try {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: `SubagentStop の観測に失敗した: ${reasonOf(error)}`,
        });
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
      return { kind: 'continue' };
    }
  }

  /**
   * 作業者が起こした背景処理 `ids` が**全部終わる**まで待つ（Issue #3008。
   * `#onSubagentStop` の「待つ」の本体）。結末は `'settled'`（終わった）／ `'timeout'`
   * （`SUBAGENT_BACKGROUND_WAIT_MS` を超えた）／ `'released'`（待ちの途中で、または待つ前に、
   * セッションが stop / 畳み / 世代交代した）。
   *
   * **「終わった」の判定**（`RunnerBackgroundWaiters` の doc が根拠を持つ）: 各 id が、
   * (1) `task_notification` が届いた、または (2) `liveBackgroundTasks`（`background_tasks_changed`）
   * に**載っているのを見たあとで載らなくなった**。⚠️ 載ったことの無い id を「載っていない」だけで
   * 終わりとはしない（id 空間が違えば常に真になり、待たずに毎回起こし直す＝空転が無限になる）。
   * **別の作業者の背景処理は `ids` に入らない**（`mine` の絞り込みが先にある）ので、待ちの条件にならない。
   *
   * **`stopped` / 世代は、待つ前にも待った後にも見る。** 待っている者は
   * `RunnerSdkSession#markStopped` / `teardownForRecreate` が解く（`'released'`）が、その解きより
   * 後に始まった待ちは誰も解かないので、始める前に `stopped` を見て待たない。待った後に
   * 世代が替わっていれば、`'settled'` でも `'released'` に倒す（古い世代の作業者を起こさない）。
   */
  async #waitForBackgroundTasks(
    ids: readonly string[],
  ): Promise<'settled' | 'timeout' | 'released'> {
    if (this.#sdkSession.stopped) return 'released';
    const generation = this.#sdkSession.generation;
    const waiters = this.#sdkSession.backgroundWaiters;
    const seenLive = new Set<string>();
    const outcome = await waiters.wait(() => {
      const live = new Set(this.#sdkSession.liveBackgroundTasks.map((task) => task.id));
      return ids.every((id) => {
        if (waiters.isFinished(id)) return true;
        if (live.has(id)) {
          seenLive.add(id);
          return false;
        }
        return seenLive.has(id);
      });
    }, SUBAGENT_BACKGROUND_WAIT_MS);
    if (
      outcome === 'settled' &&
      (this.#sdkSession.stopped || generation !== this.#sdkSession.generation)
    ) {
      return 'released';
    }
    return outcome;
  }

  /**
   * `remaining`（当人が起こした背景処理のうち、まだ終わっていないもの）の
   * 各要素を、人間が読める1行へ変換する（`#onSubagentStop`）。
   *
   * **先頭に `id=` を付け、`command` も先頭寄りへ動かす（Issue #1554）。**
   * 打ち切った後、この背景処理の完了（`task_notification`）をマネージャー
   * へ配達するとき、この `id` が結び目になる——note に出ていなければ、
   * 読んだ人間はどの行がどの完了に対応するかを確かめる手段が無い。
   * `command` も同じ理由で先頭寄りに置く——**`description` は長さの上限が
   * 無い任意欄**（`type=shell` 以外では空、`shell` でも SDK 側で長さを
   * 切っていない）のに対し、`id` / `command` は結び目として要る具体的な
   * 材料である。`#truncateSubagentStopText` は末尾から切るので、
   * `description` より**前**に置けば、切られるのは
   * `description` の側になる（AGENTS.md「stall の note は長さの上限で
   * 切られる。id と command が切られて消えないようにする」）。
   */
  #renderSubagentStopTaskLines(tasks: readonly unknown[]): string[] {
    return tasks.map((task) => {
      const t = task as {
        id?: unknown;
        type?: unknown;
        status?: unknown;
        description?: unknown;
        // `command` は shell タスクにしか付かない任意欄で、SDK 側で既に
        // 1000文字に切ってある（`BackgroundTaskSummary.command` の doc）。
        // ここで載せるのは「作業者が待っていた背景処理の中身」を突き合わせる
        // のに command が最も効くためで、全体の上限（呼び出し側）で二重に守る。
        command?: unknown;
      };
      const id = typeof t.id === 'string' ? t.id : '(不明)';
      const type = typeof t.type === 'string' ? t.type : '(不明)';
      const status = typeof t.status === 'string' ? t.status : '(不明)';
      const description = typeof t.description === 'string' ? t.description : '(不明)';
      const command = typeof t.command === 'string' ? ` command=${t.command}` : '';
      // **`id` と `command` を `description` より前に置く**（直上の doc）。
      return `- id=${id}${command} type=${type} status=${status} description=${description}`;
    });
  }

  /**
   * `#onSubagentStop` が `note` / `additionalContext` へ積む文字列を
   * `SUBAGENT_STOP_NOTE_TEXT_LIMIT` で切る。**黙って落とさない**
   * （AGENTS.md「静かに失敗する道具」）。超えたら切り、切ったこと自体を
   * 末尾に書く。
   */
  #truncateSubagentStopText(text: string): string {
    if (text.length <= SUBAGENT_STOP_NOTE_TEXT_LIMIT) return text;
    return (
      text.slice(0, codePointBoundary(text, SUBAGENT_STOP_NOTE_TEXT_LIMIT)) +
      `…（上限 ${SUBAGENT_STOP_NOTE_TEXT_LIMIT} 文字で切った）`
    );
  }

  /**
   * 「当人が起こした背景処理は在ったが、`status` は全部『終わった』側だった」
   * ことを、1セッションに1回だけ日誌へ出す（#570 の追跡）。**観測専用。**
   *
   * **これが要る理由 —— この枝は「起こし直さない」側なので、黙ると計器が消える。**
   * SDK 自身が `background_tasks` を次のように名乗っている（逐語）:
   *
   * [sdk-verbatim SubagentStopHookInput.background_tasks]
   * > In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
   *
   * ⟹ **畳み終えた分がここへ載るのは契約どおりではない。** だから起こし直しを
   * やめるだけにして黙ると、「作業者はきれいに畳んだ」（`mine.length === 0`）と
   * 日誌の上で同じ顔になる。その2つを分けるためだけの1行である。
   *
   * **`stall` は載せない。** `runner-protocol.ts` の `note.stall.outcome` は
   * `'woken' | 'limit_reached'` の2語で、ここは**どちらでもない** —— 欄を
   * 増やすとデーモンと runner が別々にデプロイされる窓で古い側が黙って落とすので、
   * `#noteOwnerLookupFailure` と同じく `stall` 無しの素の `note` にする
   * （`manager.ts` の `case 'note'` は `stall === undefined` を日誌の
   * `exchange` として通す）。
   */
  #noteSettledOnly(settled: readonly unknown[]): void {
    if (this.#stopState.settledOnlyNoted) return;
    this.#stopState.markSettledOnlyNoted();

    const listed = settled
      .map((task) => {
        const t = task as { type?: unknown; status?: unknown };
        const type = typeof t.type === 'string' ? t.type : '(不明)';
        const status = typeof t.status === 'string' ? t.status : '(不明)';
        return `type=${type} status=${status}`;
      })
      .join(' / ');

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: this.#truncateSubagentStopText(
        `SubagentStop: 当人が起こした背景処理が ${settled.length}件 配列に載っていたが、` +
          `**status は全部「終わった」側だった**（${listed}）。起こし直していない。` +
          'SDK は `background_tasks` を「in-flight」と名乗っているので、この行が出たら' +
          '計器のほうを疑う — 畳み終えた分が配列に残っているか、status の語彙が変わった' +
          'かである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
          '（雑音にしないため、この診断はセッションに1回だけ出す。）',
      ),
    });
  }

  /**
   * 「所有者を引く経路が壊れた」ことだけを、1セッションに1回だけ日誌へ出す
   * （#570）。**観測専用。**
   *
   * **これが要る理由 — 直した観測口は、壊れると *無音* になるからである。**
   * `#onSubagentStop` は「当人が起こした背景処理」が1件も無ければ何も出さない。
   * ⟹ 表が引けなくなった状態（SDK が `backgroundTaskId` を改名した・上限で
   * 捨てた・経路が変わった）と、「作業者はきれいに畳んだ」が、日誌の上で同じ
   * 顔になる。**その2つを分けるためだけの1行である。**
   *
   * 出す条件は「**所有者を控えられる種類**（`OWNER_RECORDABLE_TASK_TYPES`）の
   * エントリのうち、id が表に**1件も**無いものが在る」。
   *
   * **⚠️ ここは `type !== 'subagent'` だった（PR #594）。** 委譲そのもの（当人・兄弟）は
   * `PostToolUse` の `backgroundTaskId` を持たないので表に無いのが正常、という理由は
   * 正しいが、**同じ理由が当てはまる種類は `subagent` だけではない** ——
   * `Monitor` / `Workflow` / 遠隔の `Task` はどれも `taskId` で返すので表に載らない。
   * ⟹ 条件が「性質」ではなく「実例の1つ」を測っており、設計どおりに動いているのに
   * この診断が出る形になっていた。名簿と実測は `OWNER_RECORDABLE_TASK_TYPES` の doc。
   */
  #noteOwnerLookupFailure(tasks: readonly unknown[]): void {
    if (this.#stopState.ownerLookupFailureNoted) return;

    const orphans = tasks.filter((task) => {
      const t = task as { id?: unknown; type?: unknown };
      // **控えられない種類は、表に無いのが正常である**（診断の対象にしない）。
      if (!isOwnerRecordableTaskType(t.type)) return false;
      return typeof t.id !== 'string' || !this.#stopState.hasBackgroundTaskOwner(t.id);
    });
    if (orphans.length === 0) return;

    this.#stopState.markOwnerLookupFailureNoted();
    const listed = orphans
      .map((task) => {
        const t = task as { id?: unknown; type?: unknown };
        const id = typeof t.id === 'string' ? t.id : '(不明)';
        const type = typeof t.type === 'string' ? t.type : '(不明)';
        return `id=${id} type=${type}`;
      })
      .join(' / ');

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `SubagentStop: 背景処理の**所有者を引けなかった**（${orphans.length}件。${listed}）。` +
        'この行が出たら計器のほうを疑う — ' +
        '`PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
        `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
        '⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
        'そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。' +
        '（雑音にしないため、この診断はセッションに1回だけ出す。）',
    });
  }

  /**
   * **マネージャー自身のターンが閉じる瞬間**に、セッションに残っている背景処理の
   * 在り高を記録する（#861）。
   *
   * ## ⭐ これは観測だけである —— 何も判断せず、何も抑制しない
   *
   * 返すのは `{ continue: true }` ちょうどで、`decision` も `hookSpecificOutput`
   * （`additionalContext`）も**一度も返さない。** 直上の `#onSubagentStop` は #570 の
   * 追跡で「起こし直す」側へ変わっているが、**こちらは記録だけである** —— まず
   * `background_tasks` に何が入るかを実測し、**その実データを見てから**機構を足すか
   * どうかを決める、という順序が #861 の本文に書いてある。
   *
   * ⛔ **この関数が在ることをもって #861 を閉じないこと。** 観測口を足して「対処済み」に
   * し、残件を別の Issue のコメントへ流して住所を失うのは、この repo が #570 → #357 で
   * 実際に踏んだ道である（経緯は #861 に書いてある）。**続きの住所は #861 である。**
   *
   * ## なぜ `Stop` が要るのか —— `SubagentStop` とちょうど裏返しだからである
   *
   * `#onSubagentStop` の doc の最後の節が逐語でこう名乗っている:「この `note`（および
   * `additionalContext`）が出ないことは『空転が無かった』を意味しない」。**発火条件
   * そのものが条件付きだからである** —— `SubagentStop` は「作業者が畳んだ瞬間に
   * **親のターンが開いていた**」ときにしか来ない（#570 の実測で、作業者の完了8件が
   * 発火4件／不発火4件に、この条件ちょうどで割れた）。そして委譲は既定で
   * `is_backgrounded: true` なので、**親が先に閉じる形が本番では普通である。**
   *
   * ⟹ `Stop` は**マネージャーのターンが閉じる瞬間**に来る ＝ `SubagentStop` が発火
   * しない側の条件そのものである。SDK 自身がこの欄をまさにこの用途だと説明している
   * （逐語。SDK 0.3.268 同梱の `sdk.d.ts`）:
   *
   * [sdk-verbatim StopHookInput.background_tasks]
   * > In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
   *
   * ## ⛔ この観測が覆わないもの（覆えるように見せないために書く）
   *
   * **`Stop` はマネージャーが起きているときにしか来ない。** ⟹ 「**マネージャーが二度と
   * 起きない**」回 —— 器が落ちた・入れ替わった・そもそも起こされなかった —— は
   * **この観測でも覆えない。** 完全な形には器の外（デーモン側）に時計が要る。
   * ⟹ **ここが覆うのは「マネージャーが起きたのに、残っている背景処理に気づかずに
   * 閉じる」回までである。** 同じ断りを `note` の本文にも書いてある（片方だけ読んだ
   * 人が誤らないため）。
   *
   * ## 所有者の引き方（⛔ `owned_by_subagent` に依存しない）
   *
   * `BackgroundTaskSummary` に所有者の欄は無い。#570 が SDK 0.3.247 のライブ JSON で
   * `owned_by_subagent` を観測しているが、**0.3.259 / 0.3.261 / 0.3.268 のどの型定義にも
   * 存在しない**（0.3.268 は手元で確かめた）。⟹ **所有者は既存の
   * `#backgroundTaskOwners`（`#recordBackgroundTaskOwner` が `tool_response` の
   * `backgroundTaskId` と `agent_id` から作っている表）からしか引かない。**
   *
   * ## 乗ってよい id の等式と、乗らない等式
   *
   * `StopHookInput.background_tasks[]` は `SubagentStopHookInput.background_tasks[]` と
   * **同じ `BackgroundTaskSummary` 型**であり、後者の `id` が
   * `tool_response.backgroundTaskId` と同じ値であることは #570 が生 JSON で実測して
   * いる。**この等式にだけ乗る**（同じ型であること自体は `runner-stop.test.ts` が型で
   * 固定してあるので、SDK が2つを分岐させたら `typecheck` が落ちる）。
   *
   * ⛔ **`background_tasks_changed.tasks[].task_id` が同じ id 空間かは、誰もライブで
   * 確かめていない。** ⟹ ここはその等式に乗らない（`#liveBackgroundTasks` を引きに
   * 行かない）。
   *
   * ## 雑音の抑え方（そして、それが落とすもの）
   *
   * **在り高が非0の回（背景処理か `session_crons` のどちらかが在る）は、毎回出す。**
   * 同じ在り高で何度も閉じていること自体が #861 の探している署名なので、内容が同じ
   * だからといって畳まない。**在り高が 0 の回だけ1セッションに1回へ間引く**
   * （`#noteStopIdle`。間引きが落とすものはそちらの doc）。
   *
   * **入力は防御的に読む**（既存フックと同じく `as` で受けて型を仮定しない）。例外は
   * すべて握って `{ continue: true }` へ倒す —— フックが例外でセッションを止めては
   * いけない。`#markProgressed()` などの既存の副作用は呼ばない（この PR は観測を
   * 足すだけで、既存の挙動を1つも変えない）。
   */
  async #onStop(record: AgentStopRecord): Promise<void> {
    try {
      // **数えるのは何より先。** 下のどの枝を通っても（間引かれても）通算は進む ——
      // この数そのものが #861 の問い「`Stop` はいつ来て、いつ来ないか」への材料である。
      const stopFirings = this.#stopState.incrementStopFirings();

      // 生入力の読み取りの失敗は、中立化する前と同じくこの時点で投げ、下の
      // `catch` の note へ倒す（`AgentStopRecord.readError` の doc）。
      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const stopHookActive = record.stopHookActive;

      // **在庫も予約も無い ＝ SDK の言う「session is done」の側。**
      if (tasks.length === 0 && crons.length === 0) {
        this.#noteStopIdle();
        return;
      }

      // 所有者と `status` で数え上げる。**どちらの内訳も合計が `tasks.length` に
      // 一致する**ので、0 の行も残す —— これは「取れなかった軸」ではなく、**数えた
      // 結果の 0** である（AGENTS.md 地雷「取れない軸に0の行を作る」が禁じているのは
      // 前者で、内訳から項目が消えると合計との突き合わせができなくなる）。
      const owners = { manager: 0, worker: 0, delegation: 0, unrecordable: 0, unresolved: 0 };
      const statuses = { live: 0, settled: 0, unknown: 0 };
      for (const task of tasks) {
        owners[this.#stopTaskOwnerKind(task)] += 1;
        statuses[classifyBackgroundTaskStatus((task as { status?: unknown }).status)] += 1;
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;

      const noteLines = [
        `Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 ${stopFirings}回目）: ` +
          `**背景処理 ${tasks.length}件 / session_crons ${crons.length}件 を残したまま閉じようとしている。**` +
          stopHookActiveText,
        `所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 ${owners.manager}件 / ` +
          `作業者 ${owners.worker}件 / 委譲そのもの ${owners.delegation}件 / ` +
          `控えられない種類 ${owners.unrecordable}件 / 引けなかった ${owners.unresolved}件。`,
        `status の内訳: 走っている ${statuses.live}件 / 終わった ${statuses.settled}件 / ` +
          `分からない ${statuses.unknown}件。`,
        ...tasks.map((task) => this.#renderStopTaskLine(task)),
        ...(owners.unresolved === 0
          ? []
          : [
              `⚠️ 上のうち ${owners.unresolved}件 は**所有者を引けなかった**（\`type\` が` +
                '**所有者を控えられる種類**なのに、表に無い）。この行が出たら計器の' +
                'ほうを疑う —— `PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
                `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
                '（`monitor` / `workflow` / 遠隔の `Task` は元から控えられないので、この数には入らない' +
                '—— それらは「控えられない種類」に数えてある。）',
            ]),
        ...(statuses.unknown === 0
          ? []
          : [
              `⚠️ 上のうち ${statuses.unknown}件 は status が既知の語彙のどちらでもない。` +
                'この行が出たら計器のほうを疑う —— SDK が status の語彙を変えた見込みが高い。',
            ]),
        '⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。',
        '⚠️ この行が出ないことは「空転が無かった」を意味しない —— `Stop` は**マネージャーが起きて' +
          'いるときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、' +
          'この観測にも現れない（#861）。',
      ];

      this.#emit({
        type: 'note',
        managerId: this.#id,
        // **`stall` は載せない。** `runner-protocol.ts` の `note.stall.outcome` は
        // `'woken' | 'limit_reached'` の2語で、ここは**どちらでもない**（起こし直しても
        // 諦めてもいない。ただ記録している）。欄を増やすとデーモンと runner が別々に
        // デプロイされる窓で古い側が黙って落とすので、`#noteSettledOnly` /
        // `#noteOwnerLookupFailure` と同じく `stall` 無しの素の `note` にする
        // （`manager.ts` の `case 'note'` は `stall === undefined` を日誌の `exchange`
        // として通す）。
        //
        // **`escalate` も立てない。** 観測だけなので、クローンの受信箱へ割り込む理由が
        // まだ無い（割り込むかどうかは実データを見てから決める。#861 の段2）。
        text: this.#truncateStopNoteText(noteLines.join('\n')),
      });
    } catch (error: unknown) {
      // フックが例外でセッションを止めてはいけない。記録そのものが失敗したことだけを、
      // 握れる範囲でもう一度 note として上げる（`#onSubagentStop` の `catch` と同じ
      // 形・同じ理由）。
      try {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: `Stop の観測に失敗した: ${reasonOf(error)}`,
        });
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
    }
  }

  /**
   * 背景処理1件の**所有者の種類**を、既存の `#backgroundTaskOwners` だけから言い分ける
   * （`#onStop`。#861）。
   *
   * - `manager` —— 表の値が空文字（マネージャー自身が起こした。
   *   `#recordBackgroundTaskOwner` の取り決め）
   * - `worker` —— 表の値が非空（その `agent_id` の作業者が起こした）
   * - `delegation` —— 表に無く、`type` が `subagent`。**これは正常である** —— 委譲
   *   そのもの（当人・兄弟）は `PostToolUse` の `backgroundTaskId` を持たないので、
   *   表に無いのが当たり前である
   * - `unrecordable` —— 表に無く、`type` が**所有者を控えられる種類でもない**
   *   （`OWNER_RECORDABLE_TASK_TYPES`）。**これも正常である** —— `Monitor` /
   *   `Workflow` / 遠隔の `Task` はどれも `backgroundTaskId` を返さないので、
   *   表に無いのが当たり前である（`#noteOwnerLookupFailure` と同じ判定）
   * - `unresolved` —— 表に無く、`type` は**控えられる種類である**。
   *   **ここだけが「計器を疑う」側である。**
   *
   * **最後の1つを他へ混ぜないことが本題である。** 混ぜると、経路が壊れて表が空に
   * なった状態が「全部が委譲そのものだった」に化ける。
   *
   * **⚠️ `unrecordable` はこの PR で足した**（それまでは `subagent` 以外がすべて
   * `unresolved` へ倒れていた）。`delegation` と分けたままにしてあるのは、#570 の実測が
   * `subagent` について具体に取れている一方、他の3種は型定義から読んだだけだからである
   * —— **測れている区別を、名前を1つにして消さない。**
   */
  #stopTaskOwnerKind(
    task: unknown,
  ): 'manager' | 'worker' | 'delegation' | 'unrecordable' | 'unresolved' {
    const t = task as { id?: unknown; type?: unknown };
    const owner = typeof t.id === 'string' ? this.#stopState.backgroundTaskOwner(t.id) : undefined;
    if (owner !== undefined) return owner === '' ? 'manager' : 'worker';
    if (t.type === 'subagent') return 'delegation';
    return isOwnerRecordableTaskType(t.type) ? 'unresolved' : 'unrecordable';
  }

  /**
   * 背景処理1件を、人間が読める1行へ変換する（`#onStop`。#861）。
   *
   * **`#renderSubagentStopTaskLines` を使い回さない。** あちらは各行の末尾に「この背景
   * 処理では何回目か」（起こし直しの回数）を付けるが、こちらは**一度も起こし直して
   * いない** —— 付ければ `0回目` が並び、読んだ人は「起こし直しの枠がまだ在る」と
   * 読む。観測だけの行に、判定の軸を載せない。
   */
  #renderStopTaskLine(task: unknown): string {
    const t = task as {
      id?: unknown;
      type?: unknown;
      status?: unknown;
      description?: unknown;
      // `command` は shell タスクにしか付かない任意欄で、SDK 側で既に1000文字に
      // 切ってある（`BackgroundTaskSummary.command` の doc）。全体の上限
      // （`#truncateStopNoteText`）で二重に守る。
      command?: unknown;
    };
    const id = typeof t.id === 'string' ? t.id : '(不明)';
    const type = typeof t.type === 'string' ? t.type : '(不明)';
    const status = typeof t.status === 'string' ? t.status : '(不明)';
    const description = typeof t.description === 'string' ? t.description : '(不明)';
    const command = typeof t.command === 'string' ? ` command=${t.command}` : '';
    const kind = this.#stopTaskOwnerKind(task);
    const owner =
      kind === 'worker' && typeof t.id === 'string'
        ? `worker:${this.#stopState.backgroundTaskOwner(t.id) ?? ''}`
        : kind;
    return `- id=${id} owner=${owner} type=${type} status=${status} description=${description}${command}`;
  }

  /**
   * 「`Stop` は発火したが、背景処理も `session_crons` も 0件 だった」ことを、
   * **1セッションに1回だけ**日誌へ出す（#861）。**観測専用。**
   *
   * **これが要る理由 —— この1行が「`Stop` はこの器で発火する」の実測そのものだから
   * である。** 在り高が最後まで 0 だったセッションでこれを黙ると、「`Stop` が一度も
   * 発火しなかった」と「発火したが毎回きれいに閉じた」が日誌の上で同じ顔（無音）に
   * なる —— #861 が問うているのはまさにその区別である。
   *
   * ⚠️ **この間引きが落とすもの（#861 へ残す）。** 2回目以降の「0件で閉じた」回は
   * 個別には残らない。通算（`#stopFirings`）は在り高が非0の回の `note` にしか載らない
   * ので、**在り高が最後まで 0 のままだったセッションでは、発火が1回だったのか
   * 200回だったのかをこの観測からは言えない。** 毎回出す形にしなかったのは、`Stop` が
   * **マネージャーのターンが閉じるたび**に来るからで、毎回出せば日誌がターン数ぶんの
   * 同じ行で埋まる（`#noteSettledOnly` と同じ作法）。**どちらが正しいかは実データを
   * 見てから決まる。**
   */
  #noteStopIdle(): void {
    if (this.#stopState.stopIdleNoted) return;
    this.#stopState.markStopIdleNoted();

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: this.#truncateStopNoteText(
        'Stop: マネージャーのターンが閉じたが、**背景処理も session_crons も 0件 だった**' +
          `（このセッションで通算 ${this.#stopState.stopFirings}回目の発火）。` +
          '⟹ SDK の言う「session is done」の側である。' +
          '**この行が出たこと自体が「`Stop` はこの器で発火する」の実測である**（#861 の段1）。' +
          '（雑音にしないため、この「0件で閉じた」診断はセッションに1回だけ出す —— `Stop` は' +
          'ターンが閉じるたびに来るので、毎回出せば日誌がターン数ぶんの同じ行で埋まる。' +
          '⟹ **2回目以降の「0件で閉じた」回は個別には残らない。** 続きは #861。）',
      ),
    });
  }

  /**
   * `#onStop` が `note` の `text` へ積む文字列を `STOP_NOTE_TEXT_LIMIT` で切る。
   * **黙って落とさない**（AGENTS.md「静かに失敗する道具」）。超えたら切り、切ったこと
   * 自体を末尾に書く。
   */
  #truncateStopNoteText(text: string): string {
    if (text.length <= STOP_NOTE_TEXT_LIMIT) return text;
    return (
      text.slice(0, codePointBoundary(text, STOP_NOTE_TEXT_LIMIT)) +
      `…（上限 ${STOP_NOTE_TEXT_LIMIT} 文字で切った）`
    );
  }

  /** 要約に潰される前に全文を上げる（監査は日誌＋アーカイブで担保する）。 */
  async #onPreCompact(record: AgentPreCompactRecord): Promise<void> {
    const path = record.transcriptPath;
    if (typeof path === 'string' && path.length > 0) this.#sdkSession.setTranscriptPath(path);
    await this.#shipArchive();
  }

  /**
   * **「無い」を3つに言い分ける**（`#readTranscript` の doc）。`archive` を
   * emit しないのは3状態とも同じ（`runner-archive-leg.test.ts` の「#shipArchive()
   * は本文が空のとき何も emit しない」が固定している——この歯は残す）。
   *
   * **⚠️ ここで `#emit` を通す形にはしない。** `stop()` 経路は器ごと畳まれる
   * 最中で、この outbox（`RunnerHost` から先）は失われうる（#629 が示した
   * とおり）。加えて `runner-archive-leg.test.ts` は「`transcript_path` を
   * 一度も渡さない ⟹ `archive` が emit されない」を固定しており、ここで
   * `archive` を出す形に変えるとその歯を割る。stderr（`dropped-record.ts`）へ
   * 出す。
   *
   * **本文が0文字（`ok` かつ空文字列）は正常として扱い、跡を出さない。**
   * 「何も書かれていないセッション」は次の一手が要らない状態であって、
   * 計器やディスクを疑わせる2状態（`no-path` / `unreadable`）と同列に鳴らすと
   * 雑音になる（PR 本文にこの判断の理由を書く）。
   */
  async #shipArchive(): Promise<void> {
    const result = await this.#readTranscript();
    if (result.status === 'no-path') {
      noteMissingRecordSource('生ログ', `managerId=${this.#id} transcript_path`);
      return;
    }
    if (result.status === 'unreadable') {
      noteUnreadableRecord('生ログ', `managerId=${this.#id}`, result.error);
      return;
    }
    if (result.body.length === 0) return;
    this.#emit({ type: 'archive', managerId: this.#id, body: result.body });
  }

  /**
   * 待たせたまま消えない。止まっている確認は理由付きで全部解く。
   *
   * **`withdrawn: true` を渡すのはここだけである（Issue #1586）。** `stop()` /
   * `#finish()` はこの直後、await を挟まずに `query.close()` を呼ぶ——SDK が
   * `canUseTool` の答え（ここで `decision:'deny'` として解いたもの）を CLI へ
   * 書き込む前に `cleanupPerformed` が立ち、答えは CLI に一度も届かない
   * （`settled` イベントの `withdrawn` の doc、`runner-protocol.ts`）。
   * `answer()`（クローンの回答）はこの関数を経由しないので `withdrawn` は
   * 付かない——あちらは `close()` を伴わず、答えは普通に CLI へ届く。
   */
  #settleAll(reason: string): void {
    for (const request of [...this.#pending]) {
      request.settle({ message: reason, decision: 'deny', withdrawn: true });
    }
    this.#pending.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 引き継ぎに載せる生ログの上限（文字）。溢れたら**古い側**を落とす。 */
const HANDOFF_LOG_LIMIT = 12_000;

/**
 * 預かった生ログを、新しいセッションへ渡せる文章に均す。
 *
 * SDK の生ログの形（`{ type, message: { role, content } }`）に強く依存しない。
 * 読めた分だけ返し、1行も読めなければ `null`（＝引き継ぎの材料が無い）と答える。
 */
export function renderSessionLog(
  entries: readonly unknown[] | undefined,
  limit = HANDOFF_LOG_LIMIT,
): string | null {
  if (entries === undefined || entries.length === 0) return null;
  const lines = entries
    .map((entry) => renderLogEntry(entry))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  const text = lines.join('\n');
  // 溢れたら**末尾を残す**。直前に何をしていたかのほうが、続きには効く。
  return text.length > limit ? `（前略）\n${text.slice(text.length - limit)}` : text;
}

function renderLogEntry(entry: unknown): string | null {
  const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  const role =
    typeof record.message?.role === 'string'
      ? record.message.role
      : typeof record.type === 'string'
        ? record.type
        : null;
  if (role === null) return null;

  const content = record.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => renderContentPart(part))
            .filter((part) => part.length > 0)
            .join('\n')
        : '';
  return text.length === 0 ? null : `${role}: ${text}`;
}

function renderContentPart(part: unknown): string {
  const block = part as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'tool_use') return `[${String(block.name ?? '道具')} ${brief(block.input)}]`;
  return '';
}

/**
 * 生ログから作り直すときに、新しいセッションの先頭へ置く一言。
 *
 * **失敗を伏せない。** 「前のセッションには戻れていない」ことをマネージャー自身に
 * 伝えないと、記憶にあるはずの文脈を前提に話し始めて、噛み合わないまま進む。
 */
function handoffPrompt(input: {
  sessionId: string;
  reason: string;
  record: string;
  carried: readonly string[];
}): string {
  return [
    `[system] 前のセッション（${input.sessionId}）を開き直せなかった: ${input.reason}`,
    'このセッションは前の続きではない。以下は失われたセッションの記録である。' +
      'ここから状況を組み立て直して、作業の続きを進めよ。',
    '作業ディレクトリの状態は記録と食い違っているかもしれない。' +
      '同じ結果を期待せず、手元を確かめてから動くこと。',
    '--- 失われたセッションの記録（ここから） ---',
    input.record,
    '--- 失われたセッションの記録（ここまで） ---',
    ...input.carried,
  ].join('\n');
}

/**
 * 応答の本文ブロックを、出た順につないで取り出す。
 *
 * **`clone.ts` の同名の写しとは繋ぎ方が違う**（あちらはそのまま繋ぐだけで trim も
 * しない）。揃えていないのは、繋ぎ方が報告と表示の作法＝層の側の判断だからである。
 */
function assistantText(blocks: readonly AgentContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * `awaitingBackground.breakdown`（`taskType` ごとの内訳）を組み立てる。
 *
 * **診断用の写しであって判定には使わない**（`runner-protocol.ts` の
 * `report.awaitingBackground` の doc）。`Map` の挿入順（＝最初に現れた順）で
 * 並べる——ソートし直さないのは、届いた `tasks` の並び自体に意味を持たせない
 * ため（不変な基準を作らない。ソートすれば「同じ内訳なのに順序が変わる」を
 * 心配する必要が無くなる、という程度の理由でしかない）。
 */
function summarizeBackgroundTasks(tasks: readonly { id: string; taskType: string }[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.taskType, (counts.get(task.taskType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([taskType, count]) => `${taskType}×${String(count)}`)
    .join(', ');
}

/**
 * 1ターン分の報告を組み立てる。
 *
 * 出た順につなぐ（人間が画面で読んだ順である）。`result` は多くの場合その
 * 最後の一片なので既に含まれるが、**含まれていないなら落とさずに足す** —
 * エラー終了の `（結果なしで終了: …）` のように、本文には出ないまま結果だけが
 * 来ることがあり、そこを黙って捨てると終わり方が分からなくなる。
 *
 * **`contentless` は「クローンを起こしてよいか」を運ぶ構造化された印であって、
 * 文言の判定ではない。** `result.empty` は `resultText()` が「SDK 自身の
 * `result` にも文字が無かった」と確定させた事実で、ここではそれに
 * `said`（そのターンでマネージャーが実際に喋った本文）が空だったかどうかを
 * 掛け合わせるだけである。**`（報告なし）` という文字列に一致させていない** —
 * だからマネージャーが本文として本当に `（報告なし）` と書いた回は、
 * `body` が非空になるので `contentless: false` のまま素通りする
 * （`sdk-failure.ts` の「文言で検知しない」を報告の畳み込みにも揃えた形）。
 */
function reportText(
  said: readonly string[],
  result: { text: string; empty: boolean },
): { text: string; contentless: boolean } {
  const body = said.join('\n\n').trim();
  if (body.length === 0) return { text: result.text, contentless: result.empty };
  if (body.includes(result.text.trim())) return { text: body, contentless: false };
  return { text: `${body}\n\n${result.text}`, contentless: false };
}

/**
 * `result` を受け取らないまま畳まれた回の報告本文（#323）。
 *
 * **先頭で「畳まれた」と言い切る。** `failedReportText` と同じ作法である
 * ——これを付けないと、読み手（クローン・台帳・日誌）には通常の報告と
 * 区別が付かず、**ターンの途中で切られた本文を「マネージャーの結論」として
 * 読むことになる。**
 *
 * **本文は言い換えず、そのまま全部載せる。** 途中まででも、マネージャーが
 * 何を書いていたかは次に何を頼み直すかを決める材料である
 * （`failedReportText` の「途中まで出ていた本文も捨てない」と同じ理由）。
 */
function unreportedText(said: readonly string[], reason: string): string {
  const body = said.join('\n\n').trim();
  return (
    `（このターンは結果を受け取らないまま畳まれた: ${reason}）\n` +
    `（以下は畳まれる前にマネージャーが書いていた本文である。ターンの途中の発言が混ざっていることがある）\n\n` +
    body
  );
}

/**
 * 失敗で終わったターンの報告本文。
 *
 * **本文の先頭で「応答ではない」と言い切る。** 直す前は成否によらず
 * `reportText` を通していたので、支出上限の英語文言が「マネージャーの報告」
 * としてそのまま台帳と日誌とクローンの受信箱へ入った。
 *
 * **SDK の文言は言い換えず、そのまま残す**（`usage-limits.ts` の約束と同じ。
 * 人間が検索できる形で残す）。**途中まで出ていた本文も捨てない** — 上限に
 * 当たるまでに何をやったかは、次に何を頼み直すかを決める材料である。
 *
 * **`openedWorkers` が1以上のときだけ、状況証拠の1行を足す（Issue #1373）。**
 * 委譲の下で動く作業者が枠（429）に当たったとき、デーモンはそれを委譲本体
 * （マネージャー）のターンの失敗として名乗る——本体が枠に当たった場合と
 * 文言が同じなので、クローンからはどちらの層が塞がっているか区別できない。
 * SDK の `result` は「誰の言葉が最後だったか」を運べる形をしていないので、
 * ここで判定はしない（`describeManagerFailure` へ文言からの読み取りを足す
 * のではなく、runner が持っている「このターンで何体開いたか」をそのまま
 * 添えるだけである）。**0のときは1文字も足さない**（`AGENTS.md`「取れない
 * 軸に0の行を作らない」と同じ理由——委譲と無関係なターンにまでこの行が
 * 付くと、無関係な失敗まで作業者絡みに見える）。
 *
 * **`workerRejections` が1件以上なら、状況証拠の行を直接の証拠の行へ差し替える**
 * （`RunnerTurnTally` の `#workerRejectionsThisTurn` の doc）。作業者自身の発言に拒否の印が付いて
 * いたので「作業者が当たった」とは言える。「本体は当たっていない」とは言わない。
 * 印は種類ごとに件数で畳む（同じ `rate_limit` が何件も並ぶと本文が太る）。
 *
 * **`workerRejections` が0件でも `failedWorkerNotifications` が1件以上なら、
 * さらに別の行へ差し替える（Issue #1373 続き）。** こちらは `task_notification`
 * が `status: 'failed'` で終わった件数——`workerRejections`（作業者自身の
 * assistant メッセージに付いた拒否の印）とは別の経路の証拠である。CLI の中の
 * 扱いを静的に読むと、作業者が枠で打ち切られても部分的な出力が在れば「失敗
 * ではなく部分的な完了」として扱われ、そのとき作業者のエラーの assistant
 * メッセージは親へ返す履歴から除かれる——`workerRejections` 側では拾えない
 * 可能性がある（Issue #1373 の最新コメント）。**優先順位は`workerRejections`
 * （作業者自身の発言に付いた直接の印）が最優先、次にこちら、最後に
 * `openedWorkers`（開いた数だけ）という並びを保つ**——情報の具体さの順であって、
 * 3つを足し合わせて全部載せることはしない（本文が太るだけで、いちばん確かな
 * 証拠が埋もれる）。
 *
 * **`failure.via === 'assistant_error'` のときは、3行とも「本体も当たったかは
 * 分からない」を「本体も当たっている」へ言い切る（Issue #1373 続きのコメント）。**
 * この via は、本体自身の assistant メッセージ（`parentToolUseId === null`）に
 * SDK の拒否の印が付いてターンが失敗した回にしか立たない——`#apply` の
 * `case 'assistant_message'` が `parentToolUseId === null` のときだけ
 * `this.#turnTally.setRejected(rejected)` を呼び、`case 'turn_ended'` の
 * `const failure = event.failure ?? rejected` は `result` 側の印
 * （`event.failure`）を `rejected` より優先するので、`via` が `'assistant_error'`
 * のまま残るのは `result` 側に印が無かった回だけである。つまりこの回は
 * 「作業者が当たったかは分からない」ではなく「本体自身が当たったことは
 * 分かっている」——`result_subtype` / `result_is_error`（`result` 側にしか印が
 * 無い回）は従来どおり「分からない」のまま変えない。`openedWorkers` の行だけは
 * 意味が逆になる点に注意——「作業者が当たったかは分からないが、本体は
 * 当たっている」という言い方にする（他の2行は「作業者が当たったことは確か」を
 * 保ったまま「本体も当たっている」を足す）。
 */
function failedReportText(
  said: readonly string[],
  failure: SdkFailure,
  result: string,
  openedWorkers: number,
  workerRejections: readonly string[] = [],
  failedWorkerNotifications = 0,
  failedWorkerNotificationsNamingLimit = 0,
): string {
  const body = failure.text.length > 0 ? failure.text : result;
  // **本体自身の assistant メッセージに拒否の印が付いてターンが失敗した回だけ、
  // 「本体も当たったかは分からない」を「本体も当たっている」へ言い切れる**
  // （このすぐ上の doc の「`via === 'assistant_error'`」節）。
  const bodyHit = failure.via === 'assistant_error';
  const workerNote =
    workerRejections.length > 0
      ? bodyHit
        ? `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かで、本体の発言にも拒否の印が付いていたので、本体も当たっている）`
        : `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`
      : failedWorkerNotifications > 0
        ? `\n（このターンでは作業者 ${String(failedWorkerNotifications)} 体が失敗で終わった${
            failedWorkerNotificationsNamingLimit > 0
              ? `（うち ${String(failedWorkerNotificationsNamingLimit)} 体は枠(429)を名乗った）`
              : ''
          }。${
            bodyHit
              ? '本体の発言にも拒否の印が付いていたので、本体も当たっている'
              : '本体も当たったかは SDK からは分からない'
          }）`
        : openedWorkers > 0
          ? `\n（このターンでは作業者が ${String(openedWorkers)} 体開いていた。${
              bodyHit
                ? '作業者が当たったかは SDK からは分からないが、本体の発言には拒否の印が付いていたので、本体は当たっている'
                : 'どちらが当たったかは SDK からは分からない'
            }）`
          : '';
  const head = `（このターンは応答を返さずに終わった: ${failure.code} / ${failure.via}）\n${body}${workerNote}`;
  const partial = said.join('\n\n').trim();
  return partial.length === 0 ? head : `${head}\n\n（失敗する前に出ていた本文）\n${partial}`;
}

/** 拒否の印を種類ごとに件数で畳む（現れた順。`rate_limit ×2 / billing_error ×1`）。 */
function describeRejectionCodes(codes: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, n]) => `${code} ×${String(n)}`).join(' / ');
}

/**
 * SDK の `result` から本文を取り出す。
 *
 * **`empty` は「文字が1つも無かった」という構造的な事実であって、
 * 返す文字列（`（報告なし）` 等）そのものではない。** `reportText()` が
 * `contentless` を組み立てるときに見るのはこの `empty` だけで、返り値の
 * `text` は出力にそのまま使われる従来どおりの文言である
 * （`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」への対応 —
 * 文字列を変えずに構造だけを添える）。
 */
function resultTextOf(event: AgentTurnEnded): { text: string; empty: boolean } {
  if (event.body.length > 0) return { text: event.body, empty: false };
  if (event.outcome !== undefined)
    return { text: `（結果なしで終了: ${event.outcome}）`, empty: false };
  return { text: '（報告なし）', empty: true };
}

/** `AskUserQuestion` の回答は「質問文 → 回答」の対応で返す（SDK の入力形）。 */
function withAnswers(input: Record<string, unknown>, message: string): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const text = (question as { question?: unknown }).question;
    if (typeof text === 'string') answers[text] = message;
  }
  return { ...input, answers };
}

/**
 * `AskUserQuestion` をクローンへ渡す1本の文章にする。
 *
 * **選択肢（`options`）まで載せる。** かつてここは `question` だけを
 * `join(' / ')` で連ね、`options` の `label` / `description` を1文字も運んで
 * いなかった。⟹ **クローンは「選べ」と言われながら、選択肢の中身を読めない。**
 * 実測（2026-09-08、クローン自身の報告）: 2問・各3択の確認を送ったところ、
 * クローンへ届いたのは質問文2つを `' / '` で繋いだ **117 文字だけ**で、
 * 選択肢の本文は全部落ちていた。クローンは推測で答えることを拒み、
 * 「選択肢の中身を見出しの中に入れて送り直せ」と返した ＝ **確認の往復が
 * 1回まるごと無駄になり、その分だけターンが焼かれた。**
 *
 * **これは north_star の「デグレード禁止」に当たる。** 人間が PC の前で
 * Claude Code から同じ確認を受け取れば、選択肢は画面に出る。この階層でだけ
 * 見えないのは仕様ではなくバグである。
 *
 * **一覧が伸びる心配は要らない。** `manager_list` 側は `LIST_WAITING_EXCERPT`
 * を通してから積むので（`tools.ts` の「待ちの要約も抜粋を通す」）、ここが
 * 長くなっても一覧の予算は動かない。**受信箱へ配る本文だけが厚くなる**——
 * そちらは1件ずつ配るもので、件数で溢れる側ではない。
 *
 * **選択肢が無い質問の見え方は変えていない**（`options` が空なら質問文そのもの）。
 */
function describeQuestions(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const blocks = questions
    .map((question) => describeQuestion(question))
    .filter((block): block is string => block !== undefined);
  return blocks.length > 0 ? blocks.join('\n\n') : brief(input);
}

/**
 * 質問1件を「質問文 ＋ 選択肢の箇条書き」にする。質問文が無ければ `undefined`
 * （＝この1件は落とす。呼び出し側が全滅を `brief(input)` で受ける）。
 *
 * **`description` が空の選択肢でも `label` は必ず出す。** 説明が無いことと
 * 選択肢が無いことは別で、潰すと「選べる数」そのものが読めなくなる。
 */
function describeQuestion(question: unknown): string | undefined {
  const text = (question as { question?: unknown }).question;
  if (typeof text !== 'string') return undefined;
  const rawOptions = (question as { options?: unknown }).options;
  const options = Array.isArray(rawOptions) ? rawOptions : [];
  const lines = options
    .map((option) => {
      const label = (option as { label?: unknown }).label;
      if (typeof label !== 'string') return undefined;
      const description = (option as { description?: unknown }).description;
      return typeof description === 'string' && description.length > 0
        ? `- **${label}**: ${description}`
        : `- **${label}**`;
    })
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? [text, ...lines].join('\n') : text;
}

/**
 * 否定として読み取る語。日本語は語境界が無いので素直に部分一致で見る。
 *
 * **一覧に無い否定はここでは deny にならない**（下の `inferDecision` の
 * 3値目 `unreadable` へ落ちるだけで、allow へは化けない——2026-09-28 の
 * 反転（issue #1827/#1837、次のブロックの doc）で既定が閉じる側になった
 * ため）。「拒否」「無理」「お断り」のような普通の言い方が漏れていた
 * （issue #1827）。部分一致なので、足す語は他の語の一部になりにくい形に
 * する（`断` 1字だと「判断」に当たるので `断る` / `お断り` にする）。逆に、
 * 否定の語を含む承認（「拒否しなくてよい」など）は deny に倒れるが、それは
 * 止める側であって許しすぎる側ではない。
 */
const DENIAL_PHRASES = [
  'やめ',
  'だめ',
  // カタカナの形（issue #1923。「はい、ダメです」が承認の語に負けて allow になっていた）
  'ダメ',
  '駄目',
  '不可',
  '中止',
  '却下',
  '拒否',
  '無理',
  '断る',
  'お断り',
  'しないで',
  '止めて',
  '待って',
  '許可しない',
  '許可できな',
  '許可できません',
  '承認しない',
  '承認できな',
  '承認できません',
  '認めない',
  '認められない',
];

/**
 * 英語側は語境界で見る（`nothing` の `no` を否定と読まないため）。
 *
 * **issue #1837 で拡張**: `reject` / `refuse` / `decline` は語幹＋任意の
 * 語尾（`\w*`）にして -ing / -s 等の活用形も拾う（元は `\breject\b` で、
 * `rejecting` の途中に語境界が無く一致しなかった）。`won't` / `will not` /
 * `cannot` / `can not` も追加した——`don't` はあったが `won't` が漏れていた。
 *
 * **issue #1923 で `abort\w*` を追加した**（「Sure — abort」が承認の語に負けて
 * allow になっていた）。
 */
const DENIAL_WORDS =
  /\b(deny|denied|denying|no|nope|don't|do not|won't|will not|cannot|can not|stop|stopping|cancel\w*|reject\w*|refus\w*|declin\w*|abort\w*)\b/i;

/**
 * 承認としてはっきり読める語句（`inferDecision` の3値目 `unreadable` を
 * 避けて `allow` に倒すための、狭い許可リスト）。
 *
 * **2026-09-28（issue #1827/#1837、オーナーの判断）で新設。** 反転前は
 * 「否定が読めなければ allow」だったので承認の語を数える必要が無かったが、
 * 反転後は「承認が読めて、かつ否定の印（下の `hasNegationMarker`）が
 * 無いときだけ allow」になった——ここに無い言い方は `allow` にならない
 * （狭いリストのぶん `unreadable` 側へ寄る。過剰に拒否と読む側であって
 * 許しすぎる側ではないので、それでよいという判断）。
 *
 * **同日、PR #1866 のレビューで `はい` / `yes` / `sure` / `承認します`
 * を足した。** この4つは初版の一覧に無かったが、`どうぞ` / `go ahead` /
 * `approved` と同じ強さのはっきりした承認で、`DENIAL_PHRASES` /
 * `DENIAL_WORDS` の語彙拡張（issue #1837）と同じ形の抜け（普通の言い方が
 * 一覧に無い）だった——このリスト自体が本 PR で新設したものなので、抜けは
 * この PR が作った穴として塞ぐ（`AGENTS.md`「範囲外でも気づいたことは
 * 上げる」の問い1・問い2）。**`進めて`（`よい` を伴わない単独形）は
 * 意図して足していない**——`よい、そのまま進めて` は本 PR の複数のテスト
 * （`manager.test.ts` / `runner-client.test.ts` / この下の describe）が
 * 一貫して `unreadable` の代表例として使っており、単独の `進めて` を
 * 承認語に足すとそれらの歯を反転させてしまう。ここは PR 本文に書いて
 * 依頼者・オーナーの判断に委ねる。
 */
const APPROVAL_PHRASES = [
  'どうぞ',
  '進めてよい',
  '許可する',
  // issue #1926 で足した（`許可する` の丁寧形。allow を承認だけの回答に絞るので、
  // 丁寧形が一覧に無いと普通の承認が答え直しになる）
  '許可します',
  '承認する',
  'はい',
  '承認します',
];
/** 英語側は語境界で見る。`ok` は大文字小文字を問わず拾う（`/i`）。 */
const APPROVAL_WORDS = /\b(go ahead|approved|approve|ok|okay|yes|sure)\b/i;

/**
 * 否定の印。`DENIAL_PHRASES` / `DENIAL_WORDS` より広く見る一覧だが、
 * **これ単体では `deny` を返さない**——承認の語（`APPROVAL_PHRASES` /
 * `APPROVAL_WORDS`）と同じ回答に見つかったときにだけ、その回答を `allow`
 * と読むのを止める（`unreadable` へ落とす）ためだけに使う。
 *
 * 例: `won't approve` は `approve`（承認の語）を含むが、`won't` は
 * `DENIAL_WORDS` に既に在るので `inferDecision` はそこで `deny` を返し、
 * ここには来ない。ここが実際に効くのは、`DENIAL_PHRASES`/`DENIAL_WORDS`
 * の狭いリストには無いが承認の語と矛盾する印がある回——例:
 * `問題ない`（`ない` を含む）——を `allow` にしないためである。
 *
 * 英語は `not` / `n't` / `never` / `cannot`、日本語は `ない` / `ません` /
 * `ず`（依頼で明示された一覧のまま採用）。
 *
 * **issue #1923 で、保留・一時停止の言い方を足した**（英語の `wait` /
 * `hold off` / `hold on` / `pause`、日本語の `保留` / `見送` / `不要`）。
 * 「OK、保留で」「Sure, hold off for now」のように承認の語と同居すると、
 * 否定の印に当たらず allow になっていた。これらは `DENIAL_*` へは足さない
 * ——「確認は不要です、どうぞ」「Don't wait, go ahead」のように承認の文にも
 * 現れうるので、deny と言い切らず、allow を止めて `unreadable`（答え直しの
 * 案内）へ落とすだけにする。
 *
 * ⚠️ **部分一致なので誤検出がありうる**（例: 日本語の `ず` は「水」
 * 「はず」のような無関係な語の中にも現れる）。誤検出の向きは常に
 * 「承認と読まない」側——`allow` を `unreadable` に倒すだけで、
 * `unreadable` は SDK 側では deny として扱われるので、許しすぎる側には
 * 化けない（`decideAnswer` の doc）。
 */
// `n't` は語境界の組の外に置く（issue #1932）。`\b(…|n't|…)\b` の形では、
// `isn't` の `s` と `n` のあいだに `\b` が立たず、縮約の中で1回も当たらなかった。
// `n't\b` なら `isn't` / `shouldn't` / `can't` の語尾に当たる。
const NEGATION_MARKERS_EN = /\b(not|never|cannot|wait|hold off|hold on|pause\w*)\b|n't\b/i;
const NEGATION_MARKERS_JA = ['ない', 'ません', 'ず', '保留', '見送', '不要'];

/**
 * **テストのためだけに export している**（issue #1932。`packages/core/src/index.ts`
 * からは再エクスポートしていない）。#1926 の後は、否定の印を含む文は
 * `isApprovalOnly` の時点で「承認だけ」から外れるので、`inferDecision` の
 * 戻り値からはこの関数が当たったかどうかが見えない。印が実際に当たることを
 * 直接測る歯（`runner-infer-decision.test.ts` の #1932 の describe）のために
 * 外へ出した。挙動は変えていない。
 */
export function hasNegationMarker(message: string): boolean {
  return (
    NEGATION_MARKERS_EN.test(message) ||
    NEGATION_MARKERS_JA.some((marker) => message.includes(marker))
  );
}

/**
 * 回答が**承認の言い方だけ**でできているか（issue #1926、クローン teto の判断）。
 *
 * 承認の語（`APPROVAL_PHRASES` / `APPROVAL_WORDS`）と、下の付け足し
 * （`APPROVAL_ONLY_FILLERS_*`。敬語・please 程度）を取り除いた残りが、
 * 句読点と空白だけなら「承認だけ」と数える。承認の語が1つも無ければ数えない。
 *
 * **なぜ形で絞るか** —— 以前の allow は「承認の語が在り、既知の否定の印が
 * 無い」だったので、承認の語と一覧に無い否定・条件が同居すると allow に
 * なっていた（#1837 / #1907 / #1923 で語を足して塞いできた）。語を足す形では
 * 漏れが残り続ける。#1827 / #1837 の線（判定できないときは閉じる側に倒す）の
 * 延長として、承認以外の語が1つでも残れば `unreadable`（答え直しの案内）に
 * する。答え直しが増えるのは、この線の代償として受け入れると決めてある。
 *
 * 付け足しの一覧を広げると、そのぶん allow の線が緩む。足すときは
 * `runner-infer-decision.test.ts` の #1926 の一覧（allow になる文の固定）を
 * 先に動かすこと。
 */
const APPROVAL_ONLY_FILLERS_JA = [
  'よろしくお願いします',
  'お願いします',
  'お願い',
  'ください',
  'です',
];
const APPROVAL_ONLY_FILLERS_EN = /\b(please|thanks|thank you)\b/gi;
/** 承認の語と付け足しを取り除いた後に残ってよい文字（句読点・記号・空白）。 */
const APPROVAL_ONLY_REMAINDER = /^[\s、。，．,.!！・…~〜ー—–-]*$/u;

function isApprovalOnly(message: string): boolean {
  if (!hasApprovalMarker(message)) return false;
  let rest = message;
  // 長い語から取り除く（`承認します` を `承認する` より先に等、部分の食い違いを避ける）
  for (const phrase of [...APPROVAL_PHRASES, ...APPROVAL_ONLY_FILLERS_JA].sort(
    (a, b) => b.length - a.length,
  )) {
    rest = rest.split(phrase).join(' ');
  }
  rest = rest.replace(new RegExp(APPROVAL_WORDS.source, 'gi'), ' ');
  rest = rest.replace(APPROVAL_ONLY_FILLERS_EN, ' ');
  return APPROVAL_ONLY_REMAINDER.test(rest);
}

function hasApprovalMarker(message: string): boolean {
  return (
    APPROVAL_PHRASES.some((phrase) => message.includes(phrase)) || APPROVAL_WORDS.test(message)
  );
}

/**
 * アポストロフィの変種を素の `'`（U+0027）へ揃える（issue #1907）。
 *
 * `DENIAL_WORDS` の `don't` / `won't`、`NEGATION_MARKERS_EN` の `n't`、
 * `NEGATED_APPROVAL_PHRASES` の `don't hesitate` 等はいずれも U+0027 だけを
 * 逐語で書いている。スマートフォンや macOS の入力・Slack 等の自動整形は
 * 曲がった引用符（U+2019 `’` RIGHT SINGLE QUOTATION MARK）を使うことが
 * 多く、見た目が近い U+2018 `‘`（LEFT SINGLE QUOTATION MARK）・U+02BC `ʼ`
 * （MODIFIER LETTER APOSTROPHE）も同じ形で紛れうる——素の `'` を要求する
 * 一覧はどれにも当たらず、`Don’t go ahead.`（曲がった引用符）が
 * `APPROVAL_WORDS` の `go ahead` にだけ当たって `allow` へ化けていた
 * （#1827/#1837 で「読めなければ allow にしない」へ反転した方針の抜け）。
 *
 * **`inferDecision` の入口1箇所でだけ呼ぶ。** 元の文言そのものは書き換え
 * ない——`unreadableDenyMessage` やクローンへの表示・台帳への保存は、
 * 呼び出し元が持つ元の `message` をそのまま使う（この関数は判定用の
 * ローカルな複製を作るだけ）。`hasNegatedApprovalPhrase` /
 * `hasNegatedApprovalDenial` / `hasApprovalMarker` / `hasNegationMarker` は
 * いずれも `inferDecision` の中でしか呼ばれていない（`packages/core/src/
 * runner.ts` を `grep -Fn` した実測は PR 本文にある）ので、入口1箇所の
 * 正規化で全ての一覧に効く。
 */
function normalizeApostrophes(message: string): string {
  return message.replace(/[‘’ʼ]/g, "'");
}

/**
 * 判定のために回答の表記を揃える（issue #1907 / #1923）。
 *
 * NFKC で全角の英数字・記号・空白を半角へ揃えてから（#1923。`はい、ＳＴＯＰ`
 * / `ＮＯ、go ahead` が半角だけの `DENIAL_WORDS` に当たらず、承認の語に
 * 負けて allow になっていた）、アポストロフィの変種を揃える（#1907）。
 * `normalizeApostrophes` と同じく判定にだけ使い、元の `message` は
 * 書き換えない。
 */
function normalizeForDecision(message: string): string {
  return normalizeApostrophes(message.normalize('NFKC'));
}

/**
 * 否定の語を含む、はっきりした承認の言い方（issue #1877）。
 *
 * `no problem` / `no objection(s)` / `don't hesitate` / `don't mind` は
 * 意味としては承認だが、`DENIAL_WORDS` が `no` / `don't` を語境界で拾う
 * ため、`inferDecision` の1段目（`DENIAL_PHRASES`/`DENIAL_WORDS`）で
 * `deny` が確定してしまい、3値目の `unreadable`（PR #1866）にすら
 * 届いていなかった。日本語の `問題ない` は `ない` が `NEGATION_MARKERS_JA`
 * に在り `hasApprovalMarker`/`hasNegationMarker` の組み合わせで自然に
 * `unreadable` へ落ちるが、英語のこの4つは `DENIAL_PHRASES`/
 * `DENIAL_WORDS` のほうが先に走るので、同じ扱いにならなかった。
 *
 * ここに当たったら `allow` ではなく `unreadable` に倒す——SDK から見える
 * 結果はどちらの分岐でも `deny` のままで、許しすぎる側へは1文字も動かない
 * （`decideAnswer` の doc）。ただし同じ回答に、ここで一致した部分を
 * 除いた**残り**に本物の否定（`DENIAL_PHRASES`/`DENIAL_WORDS`）が
 * まだ在れば、そちらを優先して今までどおり `deny` にする（例:
 * `no problem, but stop` / `don't hesitate to cancel`。
 * `hasNegatedApprovalDenial` を見よ）。
 *
 * 一覧はもともと issue #1877 が名指した4つ（`no problem` / `no objection` /
 * `don't hesitate` / `don't mind`）だった。issue #1890 で `don't worry` /
 * `no worries` の2つを足し、計6つになった——`don't hesitate` / `don't mind`
 * と同格の「心配しないで＝進めてよい」という言い回しが、この一覧に無い
 * ままだったので `DENIAL_WORDS` の `\bdon't\b` / `\bno\b` に先に捕まり、
 * #1877 の救済（`unreadable`）にすら届かず案内の無い `deny` になっていた
 * （#1890 の再現テストで確認）。狭いリストのぶん `unreadable` 側へ寄る。
 * 一覧に無い否定込みの承認は、今までどおり `DENIAL_WORDS` が `deny` に
 * する——この方針そのものは #1890 でも変えていない。大文字小文字は問わない。
 */
const NEGATED_APPROVAL_PHRASES = [
  'no problem',
  'no objection',
  "don't hesitate",
  "don't mind",
  "don't worry",
  'no worries',
];

/** 正規表現の特殊文字をエスケープする（`NEGATED_APPROVAL_PHRASES` の素の文字列を安全に埋め込むため）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasNegatedApprovalPhrase(message: string): boolean {
  const lower = message.toLowerCase();
  return NEGATED_APPROVAL_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * `NEGATED_APPROVAL_PHRASES` に当たった回答から、一致した句を取り除いた
 * 残りを返す（大文字小文字を問わず、複数回の出現もすべて取り除く）。
 */
function stripNegatedApprovalPhrases(message: string): string {
  return NEGATED_APPROVAL_PHRASES.reduce(
    (remainder, phrase) => remainder.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' '),
    message,
  );
}

/**
 * `NEGATED_APPROVAL_PHRASES` に当たった回答が、それでも `deny` であるべきか
 * ——一致した句を取り除いた**残り**に、本物の否定（`DENIAL_PHRASES`/
 * `DENIAL_WORDS`）がまだ見つかるかで判定する。見つからなければ
 * `unreadable`（呼び出し元）に任せる。
 */
function hasNegatedApprovalDenial(message: string): boolean {
  const remainder = stripNegatedApprovalPhrases(message);
  return (
    DENIAL_PHRASES.some((phrase) => remainder.includes(phrase)) || DENIAL_WORDS.test(remainder)
  );
}

/**
 * `decision` を付け忘れた回答の読み取り。3値である——`allow` / `deny` /
 * `unreadable`。
 *
 * **2026-09-28（issue #1827/#1837、オーナーの判断）に既定を反転した。**
 * 直前までの設計は「迷ったら通さない — ではなく、否定が読み取れたときだけ
 * 拒否する」で、これは意図した判断だった（このブロックにその逐語が残って
 * いた）。だが `DENIAL_PHRASES` / `DENIAL_WORDS` の一覧に無い否定
 * ——「拒否」「無理」のような普通の言い方（#1827）、英語の -ing 形や
 * `won't` / `cannot`（#1837）——が実際に `allow` へ化ける実害が2件連続で
 * 見つかり、**語を足すだけでは漏れが終わらない**ことが分かった。オーナーは
 * ここで既定そのものを閉じる側へ倒す判断をした——ただし「許可の確認では
 * 常に `decision` 必須」までは広げていない:
 *
 * 0. **否定の語を含む、はっきりした承認の言い方（issue #1877、新設）は
 *    `NEGATED_APPROVAL_PHRASES` を見る。** 残りに本物の否定が無ければ
 *    `unreadable`。在れば 1. と同じ `deny` に合流する
 *    （`hasNegatedApprovalDenial`）。**この判定は 1. より先に走る**
 *    ——そうしないと `no problem` の `no` が 1. で先に `deny` を確定させ、
 *    ここへ来る前に終わってしまう。
 * 1. 否定が読み取れた回（`DENIAL_PHRASES` / `DENIAL_WORDS`）は、今までどおり
 *    `deny`。**否定は承認より先に見る**——`won't approve` は `approve` を
 *    含むが `won't` がここで先に `deny` を確定させる。
 * 2. 承認がはっきり読めて（`hasApprovalMarker`）、かつ否定の印
 *    （`hasNegationMarker`。1. より広い一覧）が無い回は、今までどおり
 *    `allow`。
 * 3. **それ以外（新設）は `unreadable`。** 承認とも拒否とも機械的に読み
 *    取れなかった回——`問題ない` のような、意味としては承認寄りの言い方も、
 *    否定の印（`ない`）を含むためここに落ちる。過剰に拒否と読む側であって
 *    許しすぎる側ではないので、それでよい、という判断（依頼の設計要点）。
 *
 * 呼び出し側（`decideAnswer`）は `unreadable` を SDK へは `deny` として
 * 返しつつ、クローンへは「答え直せ」と伝える
 * （`Session#answer()` / `ManagerPool#send()` の doc を見よ）。
 *
 * 日本語を語境界（`\s` や `\b`）で探してはいけない。「それはやめて」の
 * 「やめ」の前に区切りは無く、探せていないことが**承認**として表に出る
 * ——この事実は反転の前後で変わっていない。
 */
export function inferDecision(message: string): 'allow' | 'deny' | 'unreadable' {
  // issue #1907: 曲がった引用符（U+2019 等）の apostrophe を素の `'` へ
  // 揃えてから各一覧に当てる。判定にだけ使い、元の message は書き換えない。
  // issue #1923: 全角の英数字も NFKC で半角へ揃える（`normalizeForDecision`）。
  const normalized = normalizeForDecision(message);
  if (hasNegatedApprovalPhrase(normalized)) {
    return hasNegatedApprovalDenial(normalized) ? 'deny' : 'unreadable';
  }
  if (DENIAL_PHRASES.some((phrase) => normalized.includes(phrase))) return 'deny';
  if (DENIAL_WORDS.test(normalized)) return 'deny';
  // issue #1926: allow は承認の言い方だけでできた回答に限る（`isApprovalOnly`）。
  // 否定の印の検査（#1923 まで allow の唯一の歯止めだった）も重ねて残す。
  if (isApprovalOnly(normalized) && !hasNegationMarker(normalized)) return 'allow';
  return 'unreadable';
}

/**
 * `unreadable`（decision が無く、承認とも拒否とも読み取れなかった）ときに
 * SDK へ返す拒否文。**元の文言を1文字も消さない**——読み取れなかったので
 * 安全側で拒否したことと、答え直し方を前置きとして足すだけである
 * （`decideAnswer` の doc の3.）。
 */
function unreadableDenyMessage(original: string): string {
  return (
    '[decision が無く、承認とも拒否とも読み取れなかったので安全側で拒否した] ' +
    `${original}\n\n許可するときは decision: 'allow' を明示して答え直すこと。`
  );
}

/**
 * 確認の最終的な決定を計算する、**唯一の実装**（#322）。
 *
 * `Session#answer()`（クローンへ即座に返す値）と `#onPermission` /
 * `#onPermissionDenied` の `answered.then()`（SDK へ実際に返す
 * `PermissionResult` を組み立てる側）の**全員がこの関数を呼ぶ。** 式を
 * 複数箇所に書くと、Issue #322 が候補2（`manager.ts` で `inferDecision` を
 * 呼び直す）を却下した理由と同じ形の穴になる——場所を `runner.ts` の中に
 * 留めても、実装が2つあれば「runner.ts 側が変わったときに黙ってずれる」は
 * 再現する。
 *
 * - `AskUserQuestion`（`kind === 'question'`）は **decision を一切見ず常に
 *   allow**（既存の挙動そのまま。質問への回答に allow/deny という概念が無い）
 * - それ以外（`kind === 'permission'`）は明示の `decision` を優先し、
 *   無ければ `inferDecision(message)` に倒す
 *
 * **戻り値は `decision`（SDK へ実際に返す2値）と `unreadable`
 * （`inferDecision` が3値目を返したかどうか）の組。** `unreadable` が
 * true のときも `decision` は `'deny'` に畳んである——SDK 側は常に2値
 * （`PermissionResult.behavior` は `'allow' | 'deny'`）だからである
 * （2026-09-28、issue #1827/#1837）。呼び出し側は `unreadable` を見て、
 * クローンへ返す文言・`RunnerAnswerOutcome.decision`（`'unreadable'` を
 * 運べる。`runner-protocol.ts` の doc）を組み立てる。
 */
export function decideAnswer(
  kind: 'question' | 'permission',
  decision: 'allow' | 'deny' | undefined,
  message: string,
): { decision: 'allow' | 'deny'; unreadable: boolean } {
  if (kind === 'question') return { decision: 'allow', unreadable: false };
  if (decision !== undefined) return { decision, unreadable: false };
  const inferred = inferDecision(message);
  return inferred === 'unreadable'
    ? { decision: 'deny', unreadable: true }
    : { decision: inferred, unreadable: false };
}

/**
 * 文字列を短い16進へ畳む。**中身を復元できない形にするためだけに使う。**
 *
 * 暗号としての強度が要る場所ではない（署名でも認証でもない）。要るのは
 * 「同じ文字列は同じ鍵になる」ことと、「鍵を見ても元の文字列が読めない」ことの
 * 2つだけである。前者が重複排除を保ち、後者が `onForget` の日誌行から本文を
 * 締め出す（`#noteDenial` の `toolUseId` の doc）。
 */
function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * 1回だけの許可（issue #1105 P1）の帳面（`#oneShotAllows`）の鍵を組む。
 *
 * **3つ揃って初めて一致する。** `actor` が違えば別の担い手、`tool` が違えば
 * 別の道具、`digest` が違えば1文字でも違う入力——issue #1105 本文の要求
 * 「同じ入力で撃ち直したら…」「別の担い手なら返さない」をこの鍵の作りその
 * ものが担保する。区切りに `\u0000` を使うのは、`actor` / `tool` の値には
 * 現れない制御文字であることが分かっているため（`actor` は
 * `manager:<id>`/`worker:<id>:<type>` の固定書式、`tool` は SDK の道具名）。
 */
/**
 * 1回だけの許可（issue #1105 P1）の鍵に入れる担い手。**表示用の `actor`
 * （`worker:<マネージャー>:<agentType>`）を使わない**——あれは型までしか
 * 区別しないので、同じ型の作業者が並行に2体いると、片方への許可をもう片方が
 * 使えてしまう。作業者は `agentId`（SDK が作業者ごとに振る id）で区別する。
 */
function oneShotActorOf(
  managerId: string,
  record: { readonly agentId?: string | undefined },
): string {
  return record.agentId === undefined
    ? `manager:${managerId}`
    : `worker:${managerId}:agent=${record.agentId}`;
}

function oneShotAllowKey(actor: string, tool: string, digest: string): string {
  return `${actor}\u0000${tool}\u0000${digest}`;
}

/**
 * 値を `limit` コード単位（UTF-16）までに縮めた1行の要約。文字列はそのまま、
 * それ以外は `JSON.stringify` で文字列にしてから切る。
 *
 * **切り口は補助面の文字（絵文字の多く）の途中に置かない（issue #2449）。**
 * `limit` コード単位目を2コード単位の文字がまたぐときは、`codePointBoundary`
 * で1つ手前へ寄せる——素の `slice` のままだと高サロゲートだけが残り、許可確認の
 * 要約（`#onPermission`）がクローンの受信箱・`manager_list` へ UTF-8 で届いた
 * ところで U+FFFD に化ける（#1606 と同じ症状）。長さの数え方と、割らないときの
 * 切り口は変えていない。
 *
 * `#noteDenial` の代用鍵（`digestOf(brief(input, 120))`）もこの関数を通る。
 * そちらの切り口も同じく寄せる判断をした理由は、その呼び出し箇所の注釈に在る。
 */
export function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, codePointBoundary(text, limit))}…` : text;
}

/**
 * 子プロセスを別 UID で起こす。
 *
 * `HOME` を差し替えるのは、root の home のまま降ろすと設定を書けずに落ちるから
 * である。**能力を削るのではなく、走らせる主体を変えているだけ**であることに注意。
 *
 * SDK の子プロセスとプロファイルの評価で共有している。評価だけ root で走らせると、
 * **降りた先では読めないプロファイルを「置けた」と報告する**ことになる。
 */
/**
 * peer の Codex の `CODEX_HOME` の既定（#3939）。子の UID の home があれば Codex の既定と同じ
 * `<home>/.codex`。無ければ（手元の構成）`os.tmpdir()` 配下 —— 人間自身の `~/.codex` を
 * 正本のログインで上書きしない。
 */
function defaultCodexHome(childUser: RunnerChildUser | undefined): string {
  if (childUser?.home !== undefined) return joinPath(childUser.home, '.codex');
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return joinPath(tmpdir(), `alteroid-runner-codex-home-${uid}`);
}

function spawnAsUser(
  user: RunnerChildUser,
  options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
    /**
     * **新しいセッション（と process group）の長にして起こす（`setsid` 相当。
     * #1334）。既定は `false`（従来どおり）。**
     *
     * 立てると、この子プロセス自身の pid がそのままセッション ID になる。
     * 子孫が自分から `setsid` しない限り、`ppid` が `1`（tini）へ付け替わっても
     * セッション ID はこの起源プロセスの pid のまま残る——孤児の回収（段1）が
     * 「どの委譲の残骸か」を、名前やパスを読まずに突き合わせられるのはこれが
     * 理由である（`apps/runner/src/tasks.ts` の `ReclaimReapOptions` の doc）。
     *
     * **既定を `false` にしたまま呼び出し側で選べるようにしてあるのは、
     * 影響を委譲プロセスの起動経路だけに絞るため**——`Host#spawnAsChildUser`
     * （実行環境プロファイルの評価）や `RunnerSession#unpushedWork`（`git` の
     * 起動）は、この器の同じ低レベル関数を共有しているが、どちらも「委譲の
     * セッション」ではないので、対象を広げない。
     */
    detached?: boolean;
  },
) {
  return spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...options.env,
      ...(user.home === undefined ? {} : { HOME: user.home }),
    },
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    uid: user.uid,
    gid: user.gid,
    ...(options.detached === true ? { detached: true } : {}),
  });
}
