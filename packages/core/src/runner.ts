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
  /**
   * **作業者を待つ窓の状態3フィールド**（`#openTasks` / `#window` /
   * `#windowClosing`）の器（Issue #1190 案X で `runner-worker-wait-window.ts`
   * へ切り出した。前例は PR #1565 / #1551 / #1550 / #1523）。**`worker_wait` を
   * 出すかどうかの判断・`#emit` するかどうかは、これまでどおりここ
   * （`RunnerSession`）が持ち、この器は状態だけを持つ。** 何を持っているか・
   * 切り出しの理由と限界は `RunnerWorkerWaitWindow` 自身の doc を見よ。
   */
  readonly #workerWaitWindow = new RunnerWorkerWaitWindow();
  /**
   * `task_started` で「作業者ではない」と見たタスク（`local_bash` 等）の
   * `taskId`（Issue #2113 の続き）。`task_notification` に `task_type` は無い
   * ので、通知を作業者の分として数えないための控えである
   * （`#onTaskNotification`）。**通知が来たら消す**。器が開き直されるとき・
   * 前のセッションの作業を捨てるとき（`discardCarriedOverWork`）にも空にする
   * ——前の器のタスクの通知はもう来ないので、残すと溜まるだけである。
   */
  readonly #nonWorkerTaskIds = new Set<string>();

  /**
   * **背景処理の待ちの上限（30分）で打ち切った作業者を追う2フィールドの器**（Issue #1190
   * 段0で `runner-cut-off-workers.ts` へ切り出した。前例は PR #1523 / #1433 /
   * #1532）。`#cutOffWorkers`（同期の `Task` 経路）と
   * `#pendingCutOffNotifications`（`task_notification` 経路）を持つ。**注記の
   * 文面組み立て・note を出すかどうかの判断はこれまでどおりここ
   * （`RunnerSession`）が持ち、この器は状態だけを持つ。** 何を持っているか・
   * SDK 側の相関の根拠・切り出しの理由と限界は `RunnerCutOffWorkers` 自身の
   * doc を見よ。
   */
  readonly #cutOffWorkers = new RunnerCutOffWorkers();
  /**
   * `SubagentStop` / `Stop` の観測が使う8フィールドの器（Issue #1190 段1で
   * `runner-subagent-stop-state.ts` へ切り出した。前例は PR #1359
   * `clone-notices.ts`）。**日誌へ出すかどうか・`escalate` を立てるかどうかの
   * 判断はこれまでどおりここ（`RunnerSession`）が持ち、この器は状態だけを
   * 持つ。** 何を持っているか・切り出しの理由と限界は
   * `RunnerSubagentStopState` 自身の doc を見よ。
   */
  readonly #stopState = new RunnerSubagentStopState();
  /**
   * **ターン区切りで畳む集計10フィールドの器**（Issue #1190の続きで
   * `runner-turn-tally.ts` へ切り出した。前例は PR #1433 / #1359）。喋った本文
   * （`said` / `saidUuid`）・SDK の拒否の印（`rejected`）・`worker_wait` の
   * 契機カウンタ4本（入力・通知・道具・submit）・`source` 別内訳・#1373の
   * 状況証拠2本（開いた作業者数・作業者の拒否の印）を持つ。**畳む場所は3つ
   * あり、それぞれ畳む範囲が違う**（`RunnerTurnTally.takeAtResult` /
   * `.takeSaid` / `.discardOpenedWorkersAndRejections`）——何を持っているか・
   * 切り出しの理由と限界・3箇所の差の詳細は `RunnerTurnTally` 自身の doc を
   * 見よ。
   */
  readonly #turnTally = new RunnerTurnTally();
  /**
   * **「SDK セッションの生存」の状態15フィールドの器**（Issue #1190 案X で
   * `runner-sdk-session.ts` へ切り出した。前例は PR #1565 / #1551 / #1550 /
   * #1523 / #1433 / #1359）。`#query` / `#reader` / `#generation`・`#status` /
   * `#stopped`・`#transcriptPath`・`#liveBackgroundTasks`・
   * `#unclassifiedFailures`・`#fence` / `#leaseTtlMs`・`#recycleForToken` /
   * `#endedInputForTokenRotation`・`#input` / `#inputWaiters`・`#closing` を
   * 持つ。**SDK セッションをいつ開く／畳むか・畳みの順序・`#emit` するかどうかの
   * 判断はこれまでどおりここ（`RunnerSession`）が持ち、この器は状態と、局所的な
   * 遷移だけを持つ。** 何を持っているか・切り出しの理由と限界は
   * `RunnerSdkSession` 自身の doc を見よ。
   */
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
    // **いま読み始める。** 「開いたとき」を指すのはこの瞬間でなければならない
    // ——`#finish()` の時点で読み直すと、それは「畳んだとき」の値でしかなく
    // 差分が取れない。`.catch` は付けない——`readCgroupEventCounters` は
    // 例外を投げない（`readText` が内側で catch 済み）実装なので、ここで
    // 握る例外は本来無い。
    this.#openedCgroupEvents = this.#readCgroupEventCountersFn();
  }

  /** 見張り（`Host#checkLeaseExpiry`）が読む、いまの貸し出し期限。 */
  get leaseTtlMs(): number | undefined {
    return this.#sdkSession.leaseTtlMs;
  }

  /**
   * このセッションが実際に開いた作業ディレクトリ（Issue #1814）。
   *
   * `#create()` の時点で `Host#resolveCwd()` を通した後の値——**渡された
   * `cwd` そのものとは限らない**（省略・実在しない場合は `workspacePath` へ
   * 倒れている）。`Host#start` / `Host#resume` が呼び出し元へ返す実際の値の
   * 出どころはここ1箇所である。
   */
  get cwd(): string {
    return this.#cwd;
  }

  /**
   * 世代番号（fencing token）を検査し、覚える（roadmap M5 PR4）。
   *
   * **`lease` が無ければ何もしない。** 任意フィールドなので、名乗らない古い
   * デーモンから来た命令は今までどおり素通しする。
   *
   * まだ世代を覚えていない（`#fence === undefined`）なら、これは `start` か、
   * この `Host` インスタンスにとって初めて見る `resume`（器の入れ替え・デーモンの
   * 再起動後）である。比べる前の世代が無いので、拒む判定は起きず**覚えるだけ**
   * になる。
   *
   * 既に覚えている世代より**古ければ** `RunnerFenceError` を投げる。**投げる前に
   * 何も書き換えない**ので、走っているセッションはこの呼び出しで1文字も影響を
   * 受けない。**同じ値は再送として受ける**（更新も拒否もしない）。**新しい値**は
   * ここで覚え直すだけで、セッションを作り直す判断はここには無い
   * （`Host#resume` が呼び出し元で、既にセッションを作り直さない短絡を持っている）。
   *
   * **中身（比べる・投げる・覚える）は `RunnerSdkSession#checkFence` へ切り
   * 出した**（Issue #1190 案X）。ここは薄い口である。
   */
  checkFence(lease: RunnerLease | undefined): void {
    this.#sdkSession.checkFence(lease, this.#id);
  }

  begin(request: string, images?: readonly AgentInputImage[]): void {
    this.push(request, images);
    this.#open();
  }

  /**
   * 前のセッションの続きから開く。
   *
   * `message` を必ず流すのは、**resume が「開き直す」だけでは仕事が進まない**
   * からである。人間の不在で止まってよいのは承認待ちの仕事だけで（PRD「自律」）、
   * 器が落ちたことを理由に止まったままにはしない。
   */
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
      // **`kind` も運ぶ（#334）。** `#pending` の要素（`PendingRequest`）は
      // 既に `kind` を持っている（`#onPermission` が組み立てる）。ここで
      // 落とすと、デーモン再起動後の引き取り（`manager.ts` の
      // `#restoreJobs`、`state()` を経由する）だけ種別が消える——`ask`
      // イベント経由（`#emit`）は既に運んでいたので、非対称だった。
      //
      // **`askedAt` は `request.askedAt` をそのまま運ぶ（取り直さない）。**
      // ここで `new Date().toISOString()` を新しく呼ぶと、デーモン再起動の
      // たびに「待ち始めた時刻」が「いま」へ書き換わり、この値を持たせた
      // 理由（どれだけ待っているかが分かる）が消える。
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
        kind: request.kind,
        askedAt: request.askedAt,
      })),
      ...(this.#resumeState.sessionId === undefined
        ? {}
        : { sessionId: this.#resumeState.sessionId }),
      // **背景処理の本数を運ぶ**（Issue #2851。`runnerManagerStateSchema.
      // liveBackgroundTasks` の doc）。デーモンが「畳んで新しい鍵で起こし直して
      // よいか」を決める材料で、畳むと道連れになるものの本数である
      // （`#atTokenRecycleBoundary` と同じ数え方）。
      liveBackgroundTasks: this.#sdkSession.liveBackgroundTasks.length,
      // **起動時に掴んだ鍵の指紋**（Issue #2877 PR2。`runnerManagerStateSchema.tokenFingerprint` の doc）。
      ...(this.#tokenFingerprint === undefined ? {} : { tokenFingerprint: this.#tokenFingerprint }),
    };
  }

  /**
   * 畳み中・畳み済みか（`stop()` / `#finish()` が `markStopped()` を呼んだ
   * 後）を、内部状態を覗かずに読める形で外へ出す。
   *
   * **`stop()` / `#stopBody` / `#finish` の中身（畳みの順序）はここでは変えて
   * いない。** `Host#send` / `Host#resume` が「積んでも `push()` が黙って
   * 捨てるだけの窓」を避けるために読む（`push()` の `if (this.#sdkSession.stopped) return;`
   * と同じ条件を、判定できる形で公開しているだけである）。
   */
  get stopping(): boolean {
    return this.#sdkSession.stopped;
  }

  /**
   * クローン・人間からの一言をマネージャーへ押し込む。
   *
   * **ここは作業者（Task サブエージェント）の完了を契機に呼ばない。** 作業者は
   * マネージャーと**同一の query ストリーム**の中で動くので、完了は
   * `tool_result` として同じ `#read` ループに現れる — 新しい入力を押し込む
   * 必要がない（呼ぶと SDK 側の自己継続と二重にターンが回り、`worker_wait` の
   * `byCause` の切り分けも壊れる。`input` と `continuation` の両方が同じ完了を
   * 指すことになる）。
   *
   * **例外が1つある（#1554）:** 打ち切り済みの作業者が残した背景処理が終わり、
   * かつマネージャーが止まっている（`done`）ときだけ、
   * `#wakeForFinishedBackgroundTaskOutputs` が呼ぶ。打ち切った作業者は自分では
   * 再開せず、SDK がマネージャーを起こすかは確かめられていないためである。
   *
   * **ただしこれは型にもテストにも書かれておらず、たまたま設計がそうなっている
   * だけの前提である。** 固定しているのは `runner-wakeup.test.ts` の
   * 「`task_notification` を受けても `byCause.input` は増えない」の1本のみ。
   */
  push(text: string, images?: readonly AgentInputImage[]): void {
    if (this.#sdkSession.stopped) return;
    this.#sdkSession.enqueueInput(
      images === undefined || images.length === 0 ? { text } : { text, images },
    );
    this.#sdkSession.setStatus('running');
    this.#sdkSession.wakeInput();
  }

  /**
   * 返事の宛先は `requestId` で指す。推測しない（取り違えは拒否を承認に変える）。
   *
   * **確定した allow/deny/unreadable を同期的に返す（#322。3値目は
   * issue #1827/#1837）。** `decideAnswer` を `#onPermission` の `.then()`
   * （SDK へ実際に返す `PermissionResult` を組み立てる側）と共有しているので、
   * ここが返す値と SDK へ返る値は常に同じ計算から出る——2箇所に式を書くと、
   * Issue #322 が候補2（`manager.ts` で `inferDecision` を呼び直す）を却下
   * した理由（「runner.ts 側が変わったときに黙ってずれる」）を場所を変えて
   * 再現する。
   *
   * **`decision` 欄には `unreadable` をそのまま出す**（`decideAnswer` が
   * SDK 向けに `deny` へ畳んだ値ではなく、畳む前の3値目）。`ManagerPool#send()`
   * （`manager.ts`）はこれを見て「答え直せ」を伝える——`deny` に畳んで
   * しまうと、本当に拒否された回と区別できなくなる。
   */
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

  /**
   * 公開 API（`Host#transcript(managerId)` 等から呼ばれる）。**戻り値の形は
   * 1バイトも変えない**——ここを3状態にすると呼び出し側（`index.ts` の
   * export 経由で他パッケージからも見える公開面）へ波及する。3状態の判別は
   * {@link #readTranscript}（private）へ切り出し、ここはそれを従来の
   * `string | null` へ薄く畳むだけの層にする。
   */
  async transcript(): Promise<string | null> {
    const result = await this.#readTranscript();
    return result.status === 'ok' ? result.body : null;
  }

  /**
   * `Host#unpushedWork(managerId)` から呼ばれる（Issue #1039）。探索の起点は
   * `this.#cwd`——これは `manager_start` の時点でデーモンから渡された
   * `job.cwd` と同じ値なので、呼び出し側（デーモン）から改めて渡す必要が無い
   * （「runner 側が名乗り、デーモンは中身を解釈せず中継する」という #1039 の
   * 採用案(A)そのもの）。
   *
   * **`this.#id` も `computeUnpushedWork` へ渡す**（2026-09-24、クローンの
   * 決定。オーナーの決定ではない——`unpushed-work.ts` 冒頭の doc「3.6.」）。
   * `this.#id` は `manager_start` が名乗った委譲自身の id で、これを渡すと
   * `this.#cwd` に加えて `/tmp` 直下のその id 名のディレクトリも探索の起点に
   * なる——担い手が `job.cwd` を避けて `/tmp/mgr-<id の先頭>` へ clone や
   * worktree を作る運用（実測で観測済み）を拾うためである。
   *
   * git の起動は SDK の子プロセスと同じ `#spawnAsChildUser` を通す
   * （`childUser` が無い構成——ローカル実行——では素の `spawn` を使う）。
   * **⚠️ これで UID の問題が解けるかは未検証。**
   */
  async unpushedWork(options?: { signal?: AbortSignal }): Promise<UnpushedWorkResult> {
    const spawnFn = this.#gitSpawnFn();
    // **`options.signal` は「次の作業ツリーへ進む前」だけを止める。** 既に
    // 始めた1本の git 呼び出しは、`computeUnpushedWork` 自身のタイムアウトが
    // 満ちるまで走らせる——`apps/daemon/src/runner-client.ts` の `#call` と
    // 同じ「相手は止めない」作法（期限は待つのをやめるためだけにある）。
    return computeUnpushedWork(this.#cwd, {
      spawn: spawnFn,
      env: this.#childEnv(),
      managerId: this.#id,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * 観測用の `git` を起こす口。SDK の子プロセスと同じ `#spawnAsChildUser` を通す
   * （`childUser` が無い構成——ローカル実行——では素の `spawn`）。`unpushedWork`
   * と `rescueRef` が共有する。
   */
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

  /**
   * 退避 ref を1回 push する（Issue #1266。`rescue-ref.ts`）。`Host` の周期と、
   * 畳む直前（`stop()` の `captureUnpushedWork`）から呼ばれる。
   *
   * **同時に走るのは1本まで**——走っている間に呼ばれたら見送る（重ねない）。
   * **投げない**（失敗は`rescue_ref` の `notPushed` として運ぶか、運ぶ変化が
   * 無ければ黙る）。変化のあった作業ツリーがあるときだけ `rescue_ref` を emit する。
   * 資格は `#childEnv()`（観測の git と同じ env）に在る。
   */
  async rescueRef(options: { signal?: AbortSignal; waitForRunning?: boolean } = {}): Promise<void> {
    if (this.#rescueRunning !== null) {
      // 周期の回が走行中。周期からの呼び出しは見送る（重ねない）。**畳む直前の回**
      // （`waitForRunning`）は、走行中の回の終わりを待ってから自分の回を走らせる——
      // 見送ると、畳む直前の変更が退避されないまま器が消える。待ちも `signal`
      // （畳む直前の期限）の内側で、期限が来たら諦める。
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

  /**
   * 生ログの読み取り口。**「無い」の種類を3つに区別して返す**（#630 / #629 が
   * 「範囲外」として残した2つの穴のうち、`#shipArchive()` 側の穴の直し）。
   *
   * - `no-path`: `#transcriptPath` を一度も受け取っていない
   *   （＝ `PostToolUse` / `PreCompact` フックが一度も走っていない）。
   *   **疑うべきは計器の配線**（hook が来ていない）。
   * - `unreadable`: path は在るが `readFile` が投げた。
   *   **疑うべきはディスク・権限。**
   * - `ok`: 読めた（本文が0文字のこともある——それは正常。「何も書かれて
   *   いないセッション」であって、上の2つとは次の一手が違う）。
   *
   * **`transcript()`（public）はこの3状態を `string | null` へ畳んで返す**
   * ——上2つを同じ `null` に潰すのは呼び出し側の判断であって、ここでは潰さない。
   */
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

  /**
   * **薄いラッパーである（Issue #1602 / #1605）。** 中身（`#stopBody`）を
   * 呼ぶ前に、その Promise を `#closing` へ控える——2本目以降の `stop()`
   * がこれを await して、畳み中の畳み（`#finish()` 由来でも `stop()` 自身
   * 由来でも）を追い越さないようにするためである（`#closing` の doc）。
   * **中身の順序・`closed` を出すかどうかは変えていない。**
   *
   * **`#closing` を控える・待つ・消す3行は `RunnerSdkSession#trackClosing`
   * へ切り出した**（Issue #1190 案X）。`stop()` と `#finish()` が持っていた
   * 同じ3行を1本化しただけで、いつ・何を畳むかはここに残る。
   *
   * **`options.captureUnpushedWork`（Issue #1266 候補(C)）。** `true` の
   * ときだけ、`#stopBody` が畳みの最後に未 push の観測を取り、
   * `shutdown_unpushed_work` イベントとして運ぶ——`runner-protocol.ts` の
   * 同イベントの doc「どの `stop()` から出るか」のとおり、`Host#shutdown()`
   * だけがこれを `true` で呼ぶ。**2本目以降の `stop()`（直上の早期 return）
   * には効かない**——畳みは1本目が担うので、2本目が渡した値は使われない
   * （既に走っている畳みが、その1本目の呼び出し時点の値で決まっている）。
   */
  async stop(reason: string, options: { captureUnpushedWork?: boolean } = {}): Promise<void> {
    if (this.#sdkSession.stopped) {
      // **Issue #1602 / #1605。畳み中のもの（`#finish()` 由来でも `stop()`
      // 自身の畳み由来でも）があれば、それを待ってから返る。**
      //
      // 以前（#1602 より前）はここで即座に返っていた——`stop()` が戻った
      // のに、畳みはまだ途中の `#finish()` に任されたままだった（`stop()`
      // を await した呼び出し元は「畳み終わった」と思って先へ進めて
      // しまう）。#1602（PR #1604）はこれを直したが、待っていたのは
      // `#finish()` 由来の畳みだけだった——`stop()` **自身**が畳んでいる
      // 最中に2本目の `stop()`（または `Host#shutdown()` 経由の2本目）が
      // 来ると、同じ形の穴が残っていた（Issue #1605）。
      //
      // **いまは `#closing` が両方の畳みを控えるので、どちらが走っていて
      // も、2本目はここで待ってから返る。** 二重呼び（`stop()` → `stop()`
      // の重なり）は従来どおり「自分では畳まない」——2本目は `#stopBody`
      // を呼ばず、1本目（またはたまたま先に走っていた `#finish()`）の
      // 畳みを待つだけである。**変わったのは「待ってから返るかどうか」
      // だけで、「誰が畳むか」（＝畳みが一度しか走らないこと）は変えて
      // いない。**
      //
      // **例外はそのまま伝播させる。** `#finish()` のラッパー（`#finish` の
      // doc）と同じ理由——`Host#stop` の呼び出し元（`manager.ts` の
      // `#confirmStoppedAndReleaseLease`）は既に `runner.stop()` の例外を
      // try/catch で受けており、`Host#shutdown` の呼び出し元
      // （`manager.ts` の `runner.close().catch(() => undefined)`）も
      // 既に例外を飲み込む。どちらも「`stop()` が投げうる」という前提を
      // 既に持っているので、ここで新しく飲み込むと、その前提を握りつぶす
      // 側の変更になる（この PR の報告に、呼び出し元を読んだ根拠を書く）。
      const closing = this.#sdkSession.closing;
      if (closing) await closing;
      return;
    }
    await this.#sdkSession.trackClosing(() => this.#stopBody(reason, options));
  }

  /** `stop()` の中身。呼ぶのは `stop()` のラッパーだけである。 */
  async #stopBody(reason: string, options: { captureUnpushedWork?: boolean } = {}): Promise<void> {
    this.#sdkSession.markStopped();

    // **オーナー判断（2026-09-26、Issue #1533）。報告は「stop が指示された
    // 時点の状態」を名乗る——`#settleAll` より前でここに控える。**
    // `#shipArchive` / `#flushUnreported` を `#reader` の後ろへ動かした結果、
    // 下の `#settleAll` が先に走るようになった。`settle()`（`#pending` の
    // `settle:` コールバック）は「`waiting_human` かつ `#pending` が空になった」
    // 時点で `#status` を `running` に戻す既存の仕組みを持つので、控えずに
    // `this.#status` をそのまま読むと、確認が解放された**後**の値
    // （`running`）を報告が名乗ってしまう——`#settleAll` が
    // `#flushUnreported` より後だった以前には無かった状態変化で、報告の
    // 意味が変わってしまう。**ここで控えるのは、その変化を打ち消し、以前
    // どおり「stop が指示された瞬間の状態」を報告に載せるためである。**
    const statusAtStop = this.#sdkSession.status;

    // **器の入れ替えと `manager_stop` はここを通る**（`Host#shutdown` / `Host#stop`
    // → `stop()`）。`result` を待っていると、この経路で畳まれたぶんは台帳に1行も
    // 残らない。生ログと同じで、渡し損ねたら二度と取れない。
    await this.#flushUsage();

    // **`worker_wait` も同じ理由で取りこぼさない。** この経路は `#finish` を
    // 通らないので、ここで閉じないと開いたままの区間が黙って消える
    // （`#finish` の doc と同じ判断）。`settled` は渡さない — 中で
    // `RunnerWorkerWaitWindow` の `#openTasks` の状態から導く
    // （`#closeWorkerWaitWindow` の doc）。
    this.#closeWorkerWaitWindow();

    // **分類できなかった失敗の件数も、同じ理由でここで出す（Issue #393）。**
    // 直上の `worker_wait` とまったく同じ穴である —— `#finish` にだけ置くと、
    // **器の入れ替えと `manager_stop` で畳まれたセッションのぶんが黙って消える。**
    // 初出の1行は既に出ているので存在は残るが、**量が失われる**。
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);

    // **`#settleAll` の位置はここに残す（`#wakeInput` → `query.close()` の前）。**
    // 経路Aと経路Bで `report`/`settled` の前後が入れ替わるのは、この行を動かした
    // からではなく、下の `#shipArchive` / `#flushUnreported` を後ろへ動かした
    // からである（Issue #1533 の測定コメントが指摘した (b) の食い違い）。
    this.#settleAll(reason);
    this.#workerTools.settleAll();
    this.#sdkSession.wakeInput();
    this.#peerBroker?.closeAll();
    this.#sdkSession.closeQuery();
    // **Issue #1533。生ログの送り出しと報告を、CLI の読み手（`#reader`）が
    // 終わるまで待ってから出す。** 以前はここが `query.close()` の前にあり、
    // CLI がまだ生きているうちに一発で `readFile` していた —— 読んだ後に CLI が
    // 書く行（stdin の EOF を受けてから書く最後の数行など）を確実に取りこぼす
    // 形だった。`#finish()` 側には既に「`close()` より先に読む」という注釈が
    // あるが、あれは control channel（`#flushUsage` が使う）の話であって、
    // 生ログ（ファイル）の読み出しとは別の資源である——生ログはここで
    // `#reader` の終わりを待ってから読む形に変える。
    //
    // **未確認の前提**: CLI が stdout を閉じた（＝`#reader` が終わった）時点で、
    // 生ログを書き終えているという前提の上に立っている。SDK
    // （`@anthropic-ai/claude-agent-sdk@0.3.282`）の `Query#close()` は stdin を
    // 閉じたあと 2000ms 待って `SIGTERM`、さらに 5000ms 待って `SIGKILL` を
    // 送るだけで、生ログ（`transcript_path`）を書いているのは CLI のサブ
    // プロセス自身である——そのバイナリの中でいつフラッシュ・fsync するかは
    // 読めない（Issue #1533 のコメント、SDK 調査）。**確かめていない。**
    await this.#sdkSession.reader?.catch(() => undefined);
    // 止まる前に全文を返す。runner のディスクは器と一緒に消えるので、ここで
    // 渡し損ねると manager_id から生ログへ降りる経路が切れる。
    await this.#shipArchive();
    // **`#finish` と同じ理由でここにも置く（#323）。** この経路は `closed` すら
    // 出さないので、置かないと「マネージャーが既に書いた本文」が器と一緒に消える
    // — 直上の `#shipArchive` / `#flushUsage` / `#closeWorkerWaitWindow` が
    // ここに並んでいるのと同じ穴である。
    //
    // **`this.#status`（いまの値）ではなく `statusAtStop`（入口で控えた値）を
    // 渡す。** 上の断りのとおり——`#settleAll` が確認を解いた後の `#status` を
    // 読むと、報告の意味が変わってしまう。
    this.#flushUnreported(reason, statusAtStop);
    // **未 push の観測を、best-effort で運ぶ（Issue #1266 候補(C)）。**
    //
    // `options.captureUnpushedWork` が `true` のとき（＝ `Host#shutdown()`
    // 経由——日常の redeploy）だけ、ここで1回取って
    // `shutdown_unpushed_work` イベントとして emit する。`Host#stop(managerId)`
    // 経由（デーモンが明示的に指示する停止）はこのフラグを立てないので、
    // この分岐に入らない——`runner-protocol.ts` の同イベントの doc「どの
    // `stop()` から出るか」に理由がある。
    //
    // **`#finishBody()` の同じ処理と対になる**——あちらは `closed` を出す
    // 経路（枠落ち・失敗）、こちらは出さない経路（redeploy）を埋める。
    // `#finishUnpushedWorkFn` を同じ形（`.then`/`.catch` で `kind` を畳む）
    // で呼ぶのも同じ理由——2箇所で変換を手で合わせない。
    //
    // **例外を投げない。** `computeUnpushedWork` 自身は例外を投げない設計
    // だが、`#finishBody()` と同じ理由で `.catch()` を添えてある——この
    // 観測1回の失敗で `stop()` 自体（＝畳みそのもの）を巻き添えにしない
    // ため。取れなかったときは `kind: 'unavailable'` と理由を載せる。
    //
    // **時間の上限（`STOP_UNPUSHED_WORK_TIMEOUT_MS`）を守る。** SIGTERM から
    // runner が自分で `exit(0)` するまでの猶予（`FORCED_EXIT_MS`）を大きく
    // 食わないよう、期限を切ったうえで進める——`Host#shutdown()` は全
    // セッションを並行に畳むので、セッション数に関わらずこの1本ぶんしか
    // 上乗せしない。
    if (options.captureUnpushedWork === true) {
      // 畳む直前にも1回退避する（Issue #1266）。**観測の emit は退避を待たない**
      // （待たせると #2749 の競走の窓が広がる）。観測と並行に走らせ、観測を先に emit
      // してから退避の終わりを待つ。走行中の周期の回が居ればその終わりを待つ
      // （`waitForRunning`）。待ちと実行は同じ期限 `STOP_RESCUE_TIMEOUT_MS` の内側。
      // **合計の見積もり**: 観測は最大 `STOP_UNPUSHED_WORK_TIMEOUT_MS`（5秒）と退避の
      // 20秒は並行なので、畳みに足されるのは最大20秒——`FORCED_EXIT_MS`（55秒）の内側。
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

  /**
   * 貸し出し期限の自己失効（roadmap M5 PR4）。**`stop()` とは別の経路である。**
   *
   * `stop()`（デーモンからの明示停止・器の shutdown）は `closed` イベントを
   * 出さない — 呼んだ側（デーモン）は自分が起こした結果を `runner.list()` で
   * 確かめられるので、知らせは要らない（`manager.ts#abort` が `sessionGone` を
   * 自分で探りに行く形と対になっている）。**自己失効はランナー自身の判断**なので、
   * デーモンはこれを知る手段が `closed` イベントしかない。だから `stop()` ではなく
   * `#finish()` を通す。
   *
   * **status は `lost` にする。** 「戻れないと確定した」という既存の意味
   * （`#recoverFromFailedResume` が resume 不能を `lost` にしているのと同じ）に、
   * 「このプロセスからはこれ以上続けられない、が持ち主を失ったわけではない」
   * という自己失効の性質が最も近い。
   *
   * **ただし `lost` だけでは、自己失効と resume 不能を区別できない。** どちらも
   * 「このプロセスではもう続けられない」だが、前者は生ログさえあれば別の器から
   * 続けられる（持ち主を失っていない）のに対し、後者は材料そのものが無い。
   * そこで `closed` に構造化された印 `selfFenced: true` を立てる
   * （`runnerEventSchema` の `closed` の doc）。**文言（`reason`）では判定させない**
   * ——台帳側（`manager.ts`）がこの印だけを見て、`status` を動かさずに貸し出し
   * （`lease`）を返し、引き取り直せるようにする。
   */
  async selfFence(reason: string): Promise<void> {
    if (this.#sdkSession.stopped) return;
    await this.#finish('lost', reason, { selfFenced: true });
  }

  /**
   * 認証トークンが差し替わったので、次のターンの境界でこのセッションを畳んで
   * 開き直す（`Host#setCredentials` から呼ばれる。`clone.ts` の
   * `recycleSessionForToken()` と同じ3段に相乗りする）。
   *
   * **印を立てるだけ。セッションには触らない。** `#query === null`（まだ
   * セッションが無い）なら何もしない —— クローン側と同じ門である。次に
   * `#open()` するのはもう新しい鍵のもとなので、そのために印を立てる必要は
   * 無い（立てても、そのとき `#pending` 等はまだ存在しないので意味を持たない）。
   */
  recycleForToken(): void {
    if (this.#sdkSession.query === null) return;
    this.#sdkSession.requestTokenRecycle();
    this.#sdkSession.wakeInput();
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  #open(resume?: string): void {
    if (this.#sdkSession.query) return;
    // **ここが「器（CLI プロセス）を実際に開く／開き直す」唯一の場所である**
    // ——SDK の `SDKBackgroundTasksChangedMessage` の JSDoc が言う
    // 「whenever the session's CLI process (re)starts」[sdk-verbatim SDKBackgroundTasksChangedMessage] に正確に対応するのは
    // ここであって、次に来る `init`（`case 'session_started'`）ではない
    // （`init` はターンの頭ごとに来るだけで、器の (re)start を意味しない
    // ——詳しくは `#liveBackgroundTasks` の doc）。`#recoverFromFailedResume`
    // が `#workerWaitWindow.clear()` を「前のセッションの task_id を持ち越さない」
    // ために置いているのと同じ理由で、ここでも前の器の在り高を持ち越さない。
    this.#sdkSession.resetLiveBackgroundTasks();
    this.#nonWorkerTaskIds.clear();
    const generation = this.#sdkSession.generation;
    const session = this.#driver.open(this.#buildSpec(resume));
    // **`#query` を先に、`#reader` を後に代入していた元の2行を、
    // `RunnerSdkSession#open` の1回の呼び出しへまとめた**（Issue #1190
    // 案X）。`#read`（`reader` の中身）は同期の前置きの中で `this.#query` を
    // 読まないので、まとめても観測できる違いは無い（`runner-sdk-session.ts`
    // の `open` の doc）。
    this.#sdkSession.open(session, this.#read(session, generation));
  }

  /**
   * MCP `peer` の登録（stdio。中継の子 `clone-tool-relay-child` を起こして peer 専用ソケットへ繋ぐ）。
   * **使い捨ての token をここで発行する**（開くたびに1本。接続1回で失効）。無ければ `undefined`。
   *
   * 呼べる provider は、PEERS から**このセッション自身の provider（常に `claude`）を除いたもの**である
   * （`isPeerAllowed` と同じ線）。空なら何も出さない。
   * 中継の子の成果物が見つからないときは、マネージャーの起動を止めずに note で言う（静かに消さない）。
   */
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
        // cwd・env・子プロセスの起こし方・人間の MCP 連携（peer 自身は除く）はマネージャーと同じ。
        ...this.#buildSpec(undefined, true),
        input: parts.input,
        // **alteroid はモデルを選ばない**: 名指しが無ければ Claude は既定の帯、Codex は Codex の既定
        // （置かれたモデルはホストの provider のものなので、peer には効かせない）。名指しは人間が開けた
        // 一覧の中からだけ届く（`peer-broker.ts` が一覧外を断ってから渡す。#3934）。
        model: parts.model ?? resolveManagerModel({}),
        modelPlaced: parts.model !== undefined,
        workerModel: resolveWorkerModel({}),
        // **構えは呼び出し元のマネージャーと同じ**（2026-10-07 のオーナー決定。#3940）。Codex なら
        // `codexApprovalPolicyFor` で写る（bypassPermissions → never、それ以外 → on-request）。
        // それでも出た確認は、まずマネージャーへ返り、判断できないときだけクローンへ上がる（`peer-broker.ts` の doc）。
        // `strictApprovals` は載せない（載せると構えが `default` / `untrusted` に締まる）。
        permissionMode: this.#permissionMode,
        systemPromptAppend: PEER_SYSTEM_PROMPT_APPEND,
        // peer の生ログは預けない（マネージャーの生ログと混ぜない）。
        sessionLog: { append: async () => undefined, load: async () => null },
        onPermission: parts.onPermission,
        onNote: parts.onNote,
        onPreToolUse: () => ({ kind: 'continue' }),
        onPermissionDenied: async () => ({ kind: 'no-retry' }),
        // **peer の実行も日誌に残す**（#2753。「全ツール実行の記録」は監査の層の約束）。出所は
        // `actor: peer:<provider>`。マネージャー本体の帳面（`#preToolInputHeads` 等）には触れない。
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

  /**
   * peer の失敗した道具呼び出しを日誌へ（#2753）。形は `#onPostToolUseFailure`（マネージャー本体）と
   * 同じ `note`（`TOOL_USE_FAILURE_NOTE_PREFIX`）で、`actor` だけ `peer:<provider>`。`tool_use` に
   * しない理由（旧 daemon が未知の欄を落とす）も `#onPostToolUseFailure` の doc のとおり。
   */
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
    // **子プロセスへ実際に渡す env を1回だけ作り、そこから鍵の指紋を控える**（Issue #2877 PR2）。
    // 指紋は `token_list` と同じ `fingerprintOf`（sha256 の先頭12桁）で、値そのものは持たない。
    // **プロファイルが上書きした後の値を見る**（子が実際に掴む鍵）。peer のセッションは別物なので控えない。
    const childEnv = this.#childEnv();
    if (!forPeer) this.#tokenFingerprint = tokenFingerprintOf(childEnv);
    return {
      input: this.#inputStream(),
      // 既定は `opus`。人間が `ALTEROID_MANAGER_MODEL` に置いていればそれを使う
      // （設定ではなく承認の置き場。`model-tier.ts`）。**ここが正本である** —
      // デーモン側の自己認識に出るのは同じ env から解いた宣言であって、
      // 実際にセッションへ渡っているのはこの値である。
      model: resolveManagerModel(this.#env),
      // 人間が置いたか。Claude 以外の駆動役は、置かれたときだけモデルを provider へ渡す。
      modelPlaced: placedModelTier(this.#env, MANAGER_MODEL_ENV_KEY) !== null,
      // 人間が開く Claude Code と同じ既定（Auto）。`canUseTool` は下に残してあり、
      // `default` へ戻せば1件ずつクローンへ確認が回る。
      permissionMode: this.#permissionMode,
      systemPromptAppend: buildManagerSystemPrompt({
        managerId: this.#id,
        workerName: WORKER_AGENT_NAME,
      }),
      // 作業者層の本体はこの1個だけ。`tools` を書かない = 親の全ツールを継承。
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: buildWorkerPrompt(),
      // **省略しない。** SDK の既定は親（マネージャー）の継承なので、
      // 省けばマネージャーを差し替えた人が作業者まで巻き添えで動かすことになる。
      workerModel: resolveWorkerModel(this.#env),
      cwd: this.#cwd,
      env: childEnv,
      // 既定は閉じる。人間が `ALTEROID_MANAGER_AUTO_MEMORY=true` を置いたときだけ
      // 開く（north_star 禁止2「方針は設定で開けられなければならない」）。
      managerAutoMemoryEnabled: resolveManagerAutoMemoryEnabled(this.#env),
      // 人間の MCP 連携の登録（#325 段3）。**開くたびに読む** —— 走行中に降りた登録は
      // このセッションには届かないが、次の resume・開き直しからは効く。
      ...(() => {
        const human = this.#mcpServers();
        // MCP `peer`（#486 S7）。PEERS が空・peer の口が無い・peer セッション自身の spec なら
        // 何も足さない（`human` をそのまま渡す＝今日と同じ）。
        const peerEntry = forPeer ? undefined : this.#peerMcpEntry();
        if (peerEntry === undefined) return human === undefined ? {} : { mcpServers: human };
        return { mcpServers: { ...human, [PEER_MCP_SERVER_NAME]: peerEntry } };
      })(),
      // 生ログはデーモンへ預ける。runner は永続化の器を持たない（記憶ストアの
      // 鍵を runner に置かないため）。
      sessionLog: this.#sessionLog(),
      ...(resume === undefined ? {} : { resume }),
      // 子プロセスを別 UID へ降ろす。**能力は1つも削らない** — 道具も preset も
      // そのままで、変えるのは実行する主体だけである（実行環境の境界）。
      ...(this.#childUser === undefined
        ? {}
        : { spawnProcess: (options) => this.#spawnDelegationProcess(options) }),
      onPermission: (request) => this.#onPermission(request),
      // 駆動役の観測（拒否ではないもの）は日誌の note にだけ残す。escalate はしない。
      onNote: (text) => this.#emit({ type: 'note', managerId: this.#id, text }),
      // **上の5本と違い、これだけが実際にブロックする**（#894 段1・案(A)）。
      // 理由は `#onPreToolUse` の doc を見よ。
      onPreToolUse: (record) => this.#onPreToolUse(record),
      // **分類器の拒否に、クローンの判断で1回だけの許可を出す**（issue #1105
      // P1）。理由は `#onPermissionDenied` の doc を見よ。
      onPermissionDenied: (record) => this.#onPermissionDenied(record),
      onPostToolUse: (record) => this.#onPostToolUse(record),
      // **`PostToolUse` と排他**（Issue #924 の実測分岐。#929）。理由は
      // `#onPostToolUseFailure` の doc を見よ。
      onPostToolUseFailure: (input) => this.#onPostToolUseFailure(input),
      onPreCompact: (record) => this.#onPreCompact(record),
      // **観測専用**（`worker_wait`）。`{ continue: true }` を返すだけで何も
      // ブロックしない。理由は `#onUserPromptSubmit` の doc を見よ。
      onUserPromptSubmit: (record) => this.#onUserPromptSubmit(record),
      // **観測専用ではない**（#357）。当人が起こした背景処理が残っていれば
      // 起こし直しの `additionalContext` を返すことがある。理由は
      // `#onSubagentStop` の doc を見よ。
      onSubagentStop: (record) => this.#onSubagentStop(record),
      // **観測専用**（#861）。`{ continue: true }` を返すだけで、**何も判断せず、
      // 何も抑制しない。** 理由は `#onStop` の doc を見よ。
      onStop: (record) => this.#onStop(record),
    };
  }

  /**
   * 生ログの預け先。**runner は DB を知らない。**
   *
   * `append` は上へ流すだけ（永続化はデーモン）。`load` は resume 時にデーモンが
   * 渡してきた素材を返す — runner のディスクに前回の生ログが残っている前提を
   * 置かないための口である（器は作り直される）。
   */
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

  /** SDK の子プロセスを別 UID で起こす（実体は `spawnAsUser`）。 */
  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  /**
   * **委譲の Claude Code プロセスを起こし、pid を控える（#1334 段1）。**
   *
   * `#spawnAsChildUser`（プロファイル評価・`unpushedWork` の `git` 起動と共有）
   * とは別の口にしてあるのは、`detached: true`（新しいセッションの長にする）と
   * pid 追跡（`onDelegationProcessSpawned` / `onDelegationProcessExited`）の
   * どちらも、**委譲そのものの起動経路にだけ**効かせたいからである——他の2つは
   * 「委譲のセッション」ではないので、対象を広げない。
   *
   * **`spawnClaudeCodeProcess` は、SDK が1つの `RunnerSession` の寿命の中で
   * 複数回呼びうる**（開き直しや鍵の入れ替えで query を作り直したとき。SDK は
   * transport を作るときに1回だけ呼ぶ——`sdk.mjs` の
   * `this.process=this.options.spawnClaudeCodeProcess(…)`）。
   * だから pid 追跡は「セッションが1本開いた／閉じた」ではなく「委譲プロセスが
   * 1本起きた／終わった」の粒度で行う。
   *
   * ⚠ **作業者（Task の subagent）ごとには呼ばれない。** 作業者はマネージャーの
   * CLI プロセスの中で走るので、作業者が起こしたプロセスはマネージャーの CLI と
   * 同じセッション ID を持つ（#1334 の 2026-09-25T14:27Z のコメント）。
   * 「並列の作業者がそれぞれ独立したセッション ID を持つ」とは読まないこと。
   */
  #spawnDelegationProcess(options: SpawnAgentProcessOptions): DelegationProcessHandle {
    const child = this.#spawnAgentProcessFn(options);
    const pid = child.pid;
    if (pid !== undefined) {
      this.#onDelegationProcessSpawned(pid);
      const noteExited = (): void => this.#onDelegationProcessExited(pid);
      // **`exit` と `error`（起動そのものの失敗）の両方を見る。** どちらでも
      // このプロセスはもう「生きている委譲」ではない——`error` のときに `exit`
      // が来るかは環境依存なので、どちらか片方だけに頼らない
      // （`noteExited` が2回呼ばれても、`Host` 側の集合操作は冪等である）。
      child.once('exit', noteExited);
      child.once('error', noteExited);
    }
    return child;
  }

  /**
   * 記憶ストアの所在は子プロセスへ渡さない（渡さなければ構造的に触れない）。
   *
   * 逆に、**下（外の世界）へ手を伸ばす鍵は現在値で上書きして渡す**。`this.#env` は
   * runner が起動した瞬間のスナップショットなので、そのまま配ると人間が後から
   * 差し替えた鍵が永久に届かない（`credentials.ts`）。
   */
  #childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    /**
     * **⭐ 鍵の名前は、まず自分の env から落とす**（人間の決定 2026-09-11）。
     *
     * **runner は単体では動かない器である。** 鍵はクローンからもらって初めて
     * 持つ ——「器の環境変数に在れば、それで走る」は、次の2つを同時に壊す:
     *
     * 1. **現役でない鍵で走る。** 実測（本番 2026-09-11）では、runner の env に
     *    在ったのは**週次上限で冷却中のトークン**で、プールの現役とは別物だった。
     *    デーモンが降ろすまでの窓（と、降ろしに失敗した回）はそれが効く
     * 2. **食い違いが見えない。** 子は env から読むだけなので、「クローンが撒いた
     *    もの」と「器に残っていたもの」を区別できない（`#pushAgentToken` の doc）
     *
     * ⟹ 出所を1つにする。**落としてから重ねれば、値の出所は器（デーモンが
     * 降ろしたもの）だけになる。** 降りていなければ子は持たない —— それが
     * 「単体では動かない」の実体である。
     *
     * **`WITHHELD_ENV_KEYS`（下）とは向きが違う。** あちらは*上*（記憶）へ到達
     * する鍵を子から隠すためで、最後に消す。こちらは*下*（外の世界）へ手を伸ばす
     * 鍵の**出所を1つに絞る**ためで、重ねる前に消す。**順序が逆だと意味が消える** ——
     * 後で消すと、せっかく降ろした鍵まで一緒に落ちる。
     */
    for (const name of ROTATABLE_CREDENTIAL_KEYS) delete env[name];
    if (this.#credentials !== undefined) {
      // 器の現在値が凍った env に勝つ。順番を逆にすると鍵が回らない。
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    // **プロファイルは鍵より後。** 人間が明示的に書いたほうが勝つ（`credentials`
    // は1つの鍵を回すための細い口で、こちらは実行環境そのものの宣言である）。
    //
    // 重ねるのは2つ。評価済みの差分（**本命**。この env を継承した先で
    // マネージャーも作業者も MCP サーバも走る）と、`BASH_ENV` などの所在
    // （効く場面では読み直される口）。
    //
    // **走行中の仕事への配達をここに期待しないこと。** 起動時に畳んだ env は
    // その子の一生分である。`BASH_ENV` は**非対話なら `bash -c` でも読まれる**が、
    // 届く相手と届かない相手が混在する（`profile.ts` のモジュール doc）。走行中へ
    // 確実に届くのは `gh` シムがファイルを読み直す経路だけである。
    Object.assign(env, this.#profileEnv());
    // **伏せるのは最後。** 先に消してから鍵を重ねると、鍵の名前として
    // `ALTEROID_DATABASE_URL` を渡すだけで、伏せたはずの値を注入し直せる。
    // 配る仕組みが伏せる仕組みを越えないよう、順序でも保証する（`credentials.ts`
    // の名前検査・プロファイル末尾の `unset` と三重にしてあるのは、どれか1つを
    // 通り忘れても穴にしないため）。
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  /** 待っているストリームを全部起こす。**1本だけ覚えない** — 世代が重なる。 */
  async *#inputStream(): AsyncGenerator<AgentUserInput> {
    const generation = this.#sdkSession.generation;
    for (;;) {
      // **世代の確認を `shift` より先に。** 逆にすると、畳まれる直前の死んだ
      // ストリームが新しいセッション宛の1通を引き抜いてから終わる。
      if (generation !== this.#sdkSession.generation) return;
      const next = this.#sdkSession.dequeueInput();
      if (next !== undefined) {
        // **`worker_wait` の `byCause.input` の材料。** 実際に消費した入力だけを
        // 数える（積んだ時点ではなく、SDK が読み取った時点）。
        this.#turnTally.incrementInputsSinceResult();
        yield next;
        continue;
      }
      if (this.#sdkSession.stopped) return;
      // **認証トークンを回したので、このセッションを畳んで作り直す**
      // （`recycleForToken` の doc）。
      //
      // **ここが「ターンの境界」である** —— 積まれた入力が無く（上の `shift` が
      // `undefined`）、かつ `#atTokenRecycleBoundary()` が見る残り4条件（ターンが
      // 走っていない・確認待ちが無い・背景処理が生きていない・`#sessionId` が
      // 在る）も揃ったときだけ。**1つでも欠けていれば `return` せず、印を
      // 立てたまま待つ**（下ろさない）。
      //
      // **`#stopped` に相乗りしないこと。** あれは runner セッション全体の停止で、
      // 混ぜると「トークンを回したらマネージャーが止まる」になる
      // （`clone.ts` の同じ判断と同じ理由）。
      //
      // **ここで `#endedInputForTokenRotation` を立てる。** `#read` はこの印
      // だけを見て「自分から閉じた」を判定する（`#recycleForToken` を見ないこと
      // ——あちらは「畳みたい」という意図で、意図が残ったまま SDK が自分の理由で
      // ストリームを閉じる（b）ことがある。判定を1つの計器に潰すと、(b) を
      // (a) と誤認して嘘の `note` を出すことになる。`#endedInputForTokenRotation`
      // の doc を見よ）。
      if (this.#sdkSession.wantsTokenRecycle && this.#atTokenRecycleBoundary()) {
        this.#sdkSession.consumeTokenRecycleAtBoundary();
        return;
      }
      await this.#sdkSession.waitForInput();
    }
  }

  /**
   * 認証トークンの畳み直しに要る境界条件が、いま全部揃っているか。
   *
   * **呼び出し側（`#inputStream`）は「積まれた入力が無い」ことを既に確認済み**
   * なので、ここでは残り4つだけを見る:
   *
   * - `#status !== 'running'` —— ターンが走っていない
   * - `#pending.length === 0` —— 確認待ちが無い（畳むと `canUseTool` が宙に浮く）
   * - `#liveBackgroundTasks.length === 0` —— 起こしっぱなしの背景処理が無い
   *   （畳むと道連れになる）
   * - `#sessionId !== undefined` —— resume で開き直せる（無ければ会話が切れる）
   *
   * **1つでも欠けたら false。** 呼び出し側はそのとき `return` せず、印を
   * 立てたまま次の境界まで待つ。
   *
   * **この判定自体は受動的で、誰かに起こされない限り評価し直されない。**
   * `#inputStream` は `await new Promise(...)` で眠っているだけなので、
   * 4条件のどれかが後から満たされても、それだけでは何も起きない —— 起こす
   * 側（`#wakeInput()` を呼ぶ側）が要る。**再検査を起こす契機は3つ**:
   *
   * 1. `push()`（新しい入力）—— 常に `#wakeInput()` を呼ぶ。`#status` が
   *    `running` へ変わるので、多くの場合はこの直後に条件が崩れる側だが、
   *    `answer()` 経由で確認待ちが片付いた直後の再検査もここに乗る
   * 2. `#apply` の `'result'` の枝 —— `#status` が `running` でなくなる
   *    （このフィールドが変わる張本人）ので、ここで起こす
   * 3. `#apply` の `'background_tasks'` の枝 —— `#liveBackgroundTasks` が
   *    空へ戻る（このフィールドが変わる張本人）のは、ここで起こさなければ
   *    誰も気づかない。背景処理の**完了**はターンが走っていない最中に
   *    単独のイベントとして届きうる（`SDKBackgroundTasksChangedMessage` の
   *    JSDoc が membership の変化として completion を明示的に挙げている
   *    ——逐語は `case 'background_tasks'` の枝に置いた）ので、`'result'` の
   *    枝だけでは足りない
   *
   * **`#pending` と `#sessionId` には専用の起こしを置いていない。** 前者は
   * `answer()` が `#status` を `running` へ戻し、その後に必ず来る `'result'`
   * が起こす。後者（`session_started`）はターンの頭に来るので、その入力の
   * `push()` が既に起こしている——どちらも上の3契機のどれかに合流する。
   */
  #atTokenRecycleBoundary(): boolean {
    return (
      this.#sdkSession.status !== 'running' &&
      this.#pending.length === 0 &&
      this.#sdkSession.liveBackgroundTasks.length === 0 &&
      this.#resumeState.sessionId !== undefined
    );
  }

  /**
   * `generation` は、このストリームが何世代目のものかである。
   *
   * **作り直しの後に古い読み手が `#finish` しない**ようにするために持つ。
   * 引き継ぎで新しいセッションを開くと、畳まれた古いストリームの `for await` が
   * そこで終わって降りてくるが、それは失敗でも完了でもない。
   */
  async #read(session: AgentManagerSession, generation: number): Promise<void> {
    try {
      // **provider の綴りを読むのは駆動役の中までである**（Claude は
      // `claude-manager-driver.ts` の `foldClaudeMessage`）。ここへ流れるのは中立
      // イベントだけで、次の provider を足しても `#apply` は1本のままになる（#486）。
      // **畳まれた世代の出来事は、新しい世代へ通さない**（Issue #3022 仮説2）。復帰
      // （`#recoverFromFailedResume`）は `#apply` の `result`（失敗）の中でも起きるので、世代が
      // 進んだ後も、この古いストリームの `for await` は回り続けうる。実 SDK が `close()` の後に
      // メッセージを出すかは確かめられないが、**出すなら、その `result` の累積は新しい世代の
      // 累積（resume で 0 から数え直し）の後ろに届き、台帳では逆順になって過大に数える**
      // （歯: `runner-usage-generation.test.ts`）。**取りこぼさない根拠:** 復帰するのは
      // resume が効かず手が動いていない（`progressed` が偽）世代だけで、その世代に積むべき
      // 消費は無い。`usage` を出す `result` は `#markProgressed()` と同じ同期の区間で出す
      // ので、消費を出した世代は復帰の対象にならない。
      await session.readEvents((event) =>
        generation !== this.#sdkSession.generation ? Promise.resolve() : this.#apply(event),
      );
      if (this.#sdkSession.stopped || generation !== this.#sdkSession.generation) return;
      // **認証トークンの畳み直しで、自分から入力ストリームを終えた回。**
      // 判定は `#endedInputForTokenRotation` だけで行う（`#recycleForToken`
      // ではない）。`#inputStream` が境界（`#atTokenRecycleBoundary()`）を
      // 認めて `return` したときだけこの印が立つ —— それ以外の「閉じた」
      // （SDK が自分の理由で閉じた・resume が効かなかった等）は下の
      // `#recoverFromFailedResume` の対象である。
      //
      // **⚠️ ここを `#recycleForToken` で判定しないこと。** あれは「畳みたい」
      // という意図でしかなく、境界条件が揃わず `#inputStream` がまだ `return`
      // していない状態（例: 確認待ちが残っている・背景処理が生きている）でも
      // 立ったままになりうる。その状態で SDK が自分の理由でストリームを
      // 閉じたとき、意図の印だけを見ると「畳み直しが起きた」と誤認し、
      // 実際には開き直っていないのに嘘の `note`（「認証トークンが差し替わった
      // ので…」）を出し、しかも `#reopenForTokenRotation` を呼んで
      // まだ答えていない確認（`#pending`）等を道連れにしたまま新しいセッションを
      // 開いてしまう（レビュー指摘。種類の違うものを1つの計器で見分けていた形）。
      //
      // **この分岐を `#finish('done', …)` より前に置くこと。** 見ないと、
      // 畳み直しのつもりの正常な閉じが「マネージャーのセッションが閉じた」
      // という `done` の報告に化けてしまう。
      if (this.#sdkSession.takeEndedForTokenRotation()) {
        const sessionId = this.#resumeState.sessionId;
        if (sessionId === undefined) {
          // **境界検査（`#atTokenRecycleBoundary`）が `#sessionId !== undefined`
          // を既に確認しているので、ここには来ないはずである。** 来た場合に
          // 何もせず放置すると `#query` が死んだまま誰も開き直さないので、
          // 安全側として通常の「セッションが閉じた」経路へ委ねる —— 資格情報の
          // 畳み直しに特有の分岐をこの先まで引きずらない。
          await this.#finish('done', 'マネージャーのセッションが閉じた。');
          return;
        }
        this.#reopenForTokenRotation(sessionId);
        return;
      }
      // 一度も手が動かないまま閉じたのなら、resume は効かなかった。
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
      // **`String(error)` の手前で分類を取る（#713）。** 語そのものは `reason` にも
      // 残る（Node の `Error` は `message` に `syscall` と `code` を織り込む）が、
      // **文字列になった時点で「機械が判定できる形」ではなくなる。** 受け取る側が
      // 枠（429）と器の資源（`EAGAIN`）を分けるのに文字列を解釈し始めると、
      // `runner-protocol.ts` が `reasonType` の doc で禁じている形になる。だから
      // **発生点で分類を作り、`reason` とは別の欄で並べて運ぶ**（`system-error.ts`）。
      //
      // **`reason` の人が読む一文は、今までと1文字も変えない**（受信箱・日誌・
      // `closed_failed` の合成通知がこの一文を読む。`runner-closed-system-error.test.ts`
      // の「reason はこれまでと変わらない」）。ただし素の `String(error)` のままだと、
      // 値を運ぶ例外（drizzle の `params:`、URL の資格など）がそのまま日誌と受信箱へ
      // 出る（#2483）。そこで `reasonOf`（構造化の欄を後ろに足すので文が変わる）では
      // なく、`String(error)` に伏せ字（`redactErrorText`）だけを通す——普通の例外では
      // 文は変わらず、値を運ぶ部分だけが伏せられる。`systemError` は `error` から
      // 直に取るので、この文字列には依らない。
      const systemError = systemErrorFactsOf(error);
      const reason = redactErrorText(String(error), process.env);
      // **`#stopped` なら、ここから下は何もしない（#1589）。** 止めているのは
      // `stop()` であり、畳むのも `stop()` の仕事である —— `stop()` は
      // `#query.close()` の後に `await this.#reader` でこの `#read` を待って
      // おり、そのあいだにストリームが例外で抜けても、`stop()` が
      // `#closeWorkerWaitWindow` / `#shipArchive` / `#flushUnreported` /
      // `#settleAll` / `onClosed()` まで一式を畳み終える。ここで
      // `#finish('failed', …)` を呼ぶと、`stop()` が畳んだ直後に同じ一式を
      // 二重に走らせたうえ、`stop()` は出さないと決めている `closed` を
      // 「マネージャーのセッションが落ちた」という嘘の理由で出してしまう
      // （人間が止めたセッションが `failed` として記録される）。
      // **作り直しの判定（`#recoverFromFailedResume`）も同じ理由で止める** ——
      // 止めた後のセッションを新しい世代へ作り直す意味が無い。
      // これは自然終了側の `if (this.#stopped || generation !== this.#generation)
      // return;` と同じ向きの門を、例外側にも揃えるものである。
      if (!this.#sdkSession.stopped) {
        switch (this.#recoverFromFailedResume(reason)) {
          case 'recovered':
            return;
          // **`failed` にしない。** 「セッションが落ちた」は、話しかければ直るかも
          // しれない失敗に見える。戻れなかったことが確定しているなら、そう言う。
          case 'unresumable':
            // **`lost` にも同じ分類を付ける。** 例外は同じ1つで、`status` が違うのは
            // 「戻れるか」の軸である —— 分類の軸（何で落ちたか）とは別物なので、
            // 片方にだけ付けると同じ例外が経路によって見えたり見えなかったりする。
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

  /**
   * 認証トークンの畳み直しが境界条件を満たしたので、SDK セッションを開き直す。
   *
   * **`#recoverFromFailedResume` の `recovered` 枝と同じ3段に相乗りする** ——
   * 世代を進めてから `#query` / `#reader` を畳み、`resume` で開き直す。世代を
   * 進めないと、畳まれた古い `#inputStream`（このセッションのものは既に
   * `return` 済みだが、同じ形を崩さないために揃える）が新しいセッション宛の
   * 入力を横取りする経路を残すことになる。
   *
   * **`#resumeAttempt` も立てる。** ほとんどの場合 `#progressed` が既に立って
   * いる（このセッションで一度でも成功した result を受けている）ので、
   * `#recoverFromFailedResume` は `#resumeState.progressed` の時点で
   * `not-a-resume-failure` を返すだけになる —— つまり以後は「普段の resume 失敗」
   * と同じ扱いに合流する。**ただし、まだ一度も進んでいないセッション**
   * （最初のターンが確認待ちのまま境界へ来た場合）で、この開き直し自体の
   * resume が効かなかったときは、これが無いと「セッションが閉じた」という
   * `done` に化ける（`#recoverFromFailedResume` の doc）。
   *
   * **会話は切らない。** `#recycleForContextWindow`（クローン側の対）と違い、
   * こちらは `sessionId` をそのまま渡して resume で同じ会話を続ける ——
   * 畳むのは SDK の子プロセスであって、会話でも記憶でもない。
   *
   * **跡を残す。** 値も指紋の照合結果の中身も書かず、日本語で経緯だけを言う
   * （`note` は「runner が何かを落とすときの口」——`runner-protocol.ts` の
   * doc）。旧いデーモンの zod も `note` は既に解釈できるので、プロトコルへ
   * 新しい `type` を足さずに済む。
   */
  #reopenForTokenRotation(sessionId: string): void {
    // **`#generation` を進めて `#query` / `#reader` を畳む4行は
    // `RunnerSdkSession#teardownForRecreate` へ切り出した**（Issue #1190
    // 案X）。`ResumeRecoveryHost.teardownForRecreate` と重複していた同じ4行を
    // 1本化しただけで、順序は変えていない。
    this.#sdkSession.teardownForRecreate();
    this.#resumeState.armResumeAttempt(sessionId);
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        '鍵・環境変数（認証トークンを含む）が差し替わったので、ターンの境界でセッションを畳んで' +
        '開き直した（会話は resume で続く）。',
      // **daemon 側に「いま開き直した」を構造化して伝える**（Issue #914 提案1。
      // `runner-protocol.ts` の `note.tokenRotation` の doc）。`text` の
      // 言い回しでは判定させない——`manager.ts` の `case 'note'` はこの旗を
      // 見て、この委譲が抱えている鍵の世代（`#tokenIdentities`）を
      // 自分の現役の身元で更新し直す。ここでは世代そのものは運ばない
      // （runner はどの世代かを知らない。旗だけで足りる）。
      tokenRotation: true,
    });
    this.#open(sessionId);
  }

  /**
   * `#progressed` を立てる唯一の口。**必ずここを通す。**
   *
   * 手順そのものは `runner-resume-state.ts` の `RunnerResumeState.markProgressed`
   * へ切り出した（Issue #1190 案X）——ここは薄い口である。触るフィールドの
   * 持ち主は変わっていない。
   */
  #markProgressed(): void {
    this.#resumeState.markProgressed();
  }

  /**
   * 前のセッションへ戻れなかったときの出口。
   *
   * **黙って引き下がることも、黙って挑み直すこともしない。** 生ログはデーモンが
   * 預かっているので、session_id が腐っていても続きの材料はある。新しい
   * セッションを開いて、そこへ記録ごと引き継がせる（`resume` が拒まれたことは
   * それ自体を事実として上へ降ろす）。
   *
   * 材料まで無いなら止まるしかない。**そのときも黙らない** — 投げ直しても同じ
   * 答えが返る失敗なので、デーモンが自動の挑み直しを打ち切ってクローンへ回す。
   *
   * 戻り値:
   *
   * - `recovered`: 新しいセッションへ引き継いだ。呼び出し側は `#finish` しない
   * - `unresumable`: 戻れないと確定した。**呼び出し側はこのセッションを畳む**
   * - `not-a-resume-failure`: resume の失敗ではない。呼び出し側は普段どおり
   *
   * **`unresumable` を `not-a-resume-failure` と同じ戻り値にしない。** 一緒に
   * すると、戻れなかった resume がそのまま「1ターン終わった」という報告として
   * 上がり、台帳には `done`（＝待機中。話しかければ続く）が残る。器を作り直すと
   * プロセス内の諦めは消えるので、腐った session_id しか無いマネージャーが
   * 「まだ続けられるもの」としてクローンへ見え続ける。
   *
   * **手順そのものは `runner-resume-recovery.ts` へ切り出した**（Issue #1190
   * 案Z）。ここは {@link ResumeRecoveryHost} を実装した `#resumeRecoveryHost`
   * （private フィールド。下の宣言を見よ）を渡すだけの薄い口である——触る
   * フィールドの持ち主は変わっていない（切り出しの理由・限界・順序の約束の
   * 逐語は `recoverFromFailedResume`（`runner-resume-recovery.ts`）自身の
   * doc を見よ）。
   *
   * **`ResumeRecoveryHost` は `class … implements` にしない。** 実装すると
   * 9本のメソッド（`teardownForRecreate` 等）が `RunnerSession` の**公開面**に
   * 生える——`runner.ts` の中の誰でも、手順の断片を順序を無視して呼べるように
   * なってしまい、案Zの動機（「順序の約束が関数の境界の内側に入り、呼び出し側
   * から破れなくなる」）と正反対になる。代わりに、`#resumeRecoveryHost` を
   * private フィールドとしてオブジェクトリテラルで組み立てる——各メソッドは
   * private フィールドを閉じ込めたアロー関数で、`RunnerSession` の外はおろか
   * **同じクラスの他のメソッドからも名指しで呼べない**（フィールドとしてしか
   * 参照できず、しかも `ResumeRecoveryHost` 型を知っているのは
   * `recoverFromFailedResume` の呼び出し1箇所だけ）。
   */
  #recoverFromFailedResume(reason: string): ResumeRecoveryOutcome {
    return recoverFromFailedResume(this.#resumeRecoveryHost, reason);
  }

  /**
   * `ResumeRecoveryHost`（`runner-resume-recovery.ts`）の実装。
   *
   * **ここに書いてあるのは委譲だけで、判断は無い。** 何を・どの順で呼ぶかは
   * `recoverFromFailedResume`（`runner-resume-recovery.ts`）が持つ。各メソッドの
   * doc は `ResumeRecoveryHost` 側にあるので、ここでは繰り返さない。
   *
   * **`RunnerSession` の構築時に1回だけ組み立てる。** 呼ぶたびに作り直しても
   * 実害は無い（9個のアロー関数を包むオブジェクト1つ、コストは無視できる）が、
   * `#recoverFromFailedResume` は3箇所から呼ばれるだけの低頻度経路なので、
   * どちらでも良い——フィールドとして1回だけ作る形を採った。
   */
  readonly #resumeRecoveryHost: ResumeRecoveryHost = {
    takeResumeAttempt: () => this.#resumeState.takeAttempt(),
    hasProgressed: () => this.#resumeState.progressed,
    renderSeedRecord: () => renderSessionLog(this.#resumeState.seed),
    closeWorkerWaitWindow: () => this.#closeWorkerWaitWindow(),
    discardCarriedOverWork: () => {
      // **委譲の区間を持ち越さない。** 新しいセッション（か、この後の終了）は
      // 前のセッションが開いていた作業者の `task_id` を一切知らない。持ち越すと
      // 二度と来ない `task_notification` を待ち続けて区間が永久に閉じない。
      // **必ず `closeWorkerWaitWindow`（直上）の後に呼ぶこと**（`close()` を
      // 先に、`clear()` を後に——`RunnerWorkerWaitWindow` の doc「順序の約束」）。
      this.#workerWaitWindow.clear();
      this.#nonWorkerTaskIds.clear();
      // **このターンで開いた作業者の数（#1373）も、同じ理由で持ち越さない。**
      // この経路は `turn_ended` を通らないので、あちらの読み出しと空への
      // 戻しが走らない。ここで捨てないと、前のセッションで開いた作業者が
      // 次のセッションの最初のターンの数に入る。
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
      // 前のストリームを畳んでから開く。世代を進めないと、死んだ `#inputStream` が
      // 引き継ぎの一言を横取りする。**中身は `RunnerSdkSession#teardownForRecreate`
      // へ切り出した**（Issue #1190 案X。`#reopenForTokenRotation` と重複して
      // いた同じ4行を1本化した）。
      this.#sdkSession.teardownForRecreate();
      // 新しいセッションは resume しないので、素材は本文へ畳んで渡す
      // （`sessionId` / `seed` の解放は `RunnerResumeState.discardForRecreate`）。
      this.#resumeState.discardForRecreate();
      // **前の器へ向けた入力を捨てない。** 一言も落とさずに引き継ぎへ折り込む
      // （落とすと、人間やクローンがちょうど送った指示だけが消える）。
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

  /**
   * 中立イベント1件へ反応する（`agent-events.ts` の表の (ii)）。
   *
   * **provider の綴りはここには無い。** 何が起きたかを決めるのは
   * `foldClaudeMessage` で、ここが決めるのは「起きたことへマネージャー層がどう
   * 反応するか」だけである —— 何を `RunnerEvent` として降ろすか、委譲の区間を
   * どう数えるか、どこでセッションを畳むか。**クローン層の同じ場所は
   * `clone.ts` の `#apply` で、副作用は2層で15種あり重なるのは2種だけである。**
   *
   * **`async` である（#967 で足した）。** `case 'turn_ended'` が文脈占有を
   * 聞く（`#observeContextUsage`）ために control channel への往復を1回
   * 挟むため。唯一の呼び出し元（`#read` の `for` ループ）は各イベントを
   * `await` してから次へ進む——同じメッセージ内の複数イベントも、次の
   * メッセージも、この1件の処理が終わるまで割り込まない。
   */
  async #apply(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started': {
        // **`init` そのものはリセットの契機にしない。** `SDKSystemMessage`
        // の JSDoc（逐語。version 0.3.261 同梱の sdk.d.ts）:
        //
        // [sdk-verbatim SDKSystemMessage]
        // > Session metadata the CLI emits at the start of each turn, normally ahead of every other message of that turn: session_id, model, working directory, tools, MCP servers, slash commands, permission mode, and the capabilities list for feature detection.
        //
        // **＝ init はターンの頭ごとに来る。** 器（CLI プロセス）が
        // (re)start したときにしか来ないのではない。
        //
        // 一方 `SDKBackgroundTasksChangedMessage` の JSDoc（同じく逐語）が
        // 言っているのは：
        //
        // [sdk-verbatim SDKBackgroundTasksChangedMessage]
        // > The level is per-process: nothing is emitted at startup, so consumers must reset to the empty set whenever the session's CLI process (re)starts and let the next membership change repopulate it.
        //
        // ここが言っているのは「背景タスクの level 信号が per-process で
        // ある」ことだけで、「init はプロセス起動時にしか来ない」ではない。
        // **以前のここのコメントは、この一節を init の発火条件の説明として
        // 誤って流用していた。** 同じ session_id のまま来る init は、ターン
        // が変わっただけで器は入れ替わっていない——ここで無条件にリセット
        // すると、ターンの頭ごとに在り高が0へ落ち、そのターン中に
        // `background_tasks_changed` が来なければ `awaitingBackground` が
        // 付かず、報告が畳まれずクローンを起こしていた（実測: K 本並列に
        // 出すと K-1 回よけいに起こす）。
        //
        // **器が本当に入れ替わったかは `#open()`（フィールド初期化・reopen
        // 側）が既に見ている**（`#liveBackgroundTasks` の doc の契機1・2）。
        // ここで見るのは、SDK 側でセッションが差し替わった場合の保険——
        // `event.sessionId` が直前の値と違うときだけ、判定できないときは
        // 配る側へ倒すという原則に沿ってリセットする。**比較と代入は
        // `RunnerResumeState.observeSessionStarted` の中で、代入より前に
        // 比較する順序のまま行う**（Issue #1190 案X。初回は `sessionId` が
        // 未設定なので必ずリセット側に倒れる＝空→空で無害）。
        if (this.#resumeState.observeSessionStarted(event.sessionId)) {
          this.#sdkSession.resetLiveBackgroundTasks();
        }
        this.#emit({ type: 'session', managerId: this.#id, sessionId: event.sessionId });
        return;
      }

      case 'rate_limit': {
        // 枠の事実（アカウント単位）。**ターンの頭ごとに来る**ので、ここが
        // 走行中の唯一の最新情報になる（使い捨ての probe は idle 用）。
        this.#emit({ type: 'rate_limit', managerId: this.#id, facts: event.facts });
        return;
      }

      case 'permission_denied': {
        // 確認へ上げずにその場で止められた1件（分類器・deny 規則）。
        //
        // **`permissionMode: 'auto'` ではここが唯一の生の合図である。** `canUseTool`
        // は呼ばれないので、この合図を捨てるとマネージャーや作業者の手が止まったこと
        // は誰にも見えない。SDK 曰くこれは best-effort（取りこぼしうる）で、
        // authoritative なのは `result.permission_denials` — だから**両方**読む。
        this.#noteDenial(event.denial, 'live');
        return;
      }

      // 委譲の区間を追う（`worker_wait`）。**どの合図を委譲の開閉として数え、
      // どれを数えないかは provider の写しが決めている**（`claude-provider.ts` の
      // `foldClaudeMessage` —— 取りこぼすと契機がどこにも残らなかった事故の
      // 経緯もあちらに在る）。ここが決めるのは、開閉を受けて区間をどう数えるか
      // だけである。
      case 'delegation_started': {
        this.#onTaskStarted(event);
        return;
      }

      case 'delegation_notified': {
        this.#onTaskNotification(event);
        return;
      }

      case 'usage_notice': {
        // 上限の文言。**API エラーとしては来ない**（SDK のコメント）ので、
        // 通知・情報メッセージの本文を見るしかない。ここを見ないと「枠を使い切って
        // 課金枠に移った」＝止まる一歩前を捉えられない。
        // **文言の分類そのものは provider の写しが済ませている**
        // （`claude-provider.ts` の `foldClaudeMessage`）。ここへ届く時点で
        // 「上限の合図である」は確定している。
        this.#emit({ type: 'usage_notice', managerId: this.#id, notice: event.notice });
        return;
      }

      case 'assistant_message': {
        // マネージャーが喋った本文を溜めておく。**作業者の本文は混ぜない** —
        // `parentToolUseId` が付いているものは Task の中の別の層の発言であって、
        // マネージャーが人間（＝クローン）へ向けて書いたものではない。
        if (event.parentToolUseId === null) {
          const said = assistantText(event.blocks);
          // **SDK が「これは応答ではない」と印を付けたメッセージは報告に混ぜない。**
          // 支出上限（`billing_error`）・枠（`rate_limit`）・認証の失敗はここへ来る。
          // 直す前はこの印を1度も見ておらず、上限の英語文言がそのまま
          // 「マネージャーの報告」として台帳・日誌・クローンの受信箱へ流れていた
          // （`sdk-failure.ts` の doc。クローン側の穴と同じ形である）。
          const rejected = assistantFailureOf(event.errorCode, said);
          if (rejected !== undefined) {
            this.#turnTally.setRejected(rejected);
            return;
          }
          if (said.length > 0) {
            // **`#flushUnreported()` のための材料**（`RunnerTurnTally` の
            // `#saidUuid` の doc）。通常の経路（`result` が来る回）はこの値を
            // 1度も読まない。
            this.#turnTally.recordSaid(said, event.id);
          }
        } else {
          // **作業者の発言に付いた拒否の印は、ターンの失敗にはせず数えるだけ**
          // （`RunnerTurnTally` の `#workerRejectionsThisTurn` の doc。#1373）。
          const rejected = assistantFailureOf(event.errorCode, '');
          if (rejected !== undefined) this.#turnTally.pushWorkerRejection(rejected.code);
        }
        return;
      }

      case 'background_tasks': {
        // **REPLACE 意味論。加算・削除の差分計算はしない**
        // （`#liveBackgroundTasks` の doc）。読むのは `result` の枝だけ。
        this.#sdkSession.replaceLiveBackgroundTasks(event.tasks);
        // **認証トークンの畳み直しの印が立っていれば、ここでも起こす**
        // （`'result'` の枝と同じ形。理由は3点。
        //
        // 1. 境界条件（`#atTokenRecycleBoundary()`）の判定は `#inputStream`
        //    側が持つので、ここで起こしても条件が揃っていなければ（確認待ちが
        //    残っている・ターンがまだ走っている等）そのまま待ちへ戻るだけである
        // 2. **畳んでよいのは `#liveBackgroundTasks` が空のときだけで、それは
        //    境界検査（`#atTokenRecycleBoundary()` の3つ目の条件）が既に見て
        //    いる。** 起こすだけで畳んで良いかの判定を重複させているのではない
        //    ——残っている背景処理を道連れにする心配は境界検査の側が塞ぐ
        // 3. **背景処理の「完了」は、新しい入力を伴わない単独のイベントとして
        //    ターンの外で届きうる。** `SDKBackgroundTasksChangedMessage` の
        //    JSDoc（逐語）が membership の変化を挙げている:
        //
        //    [sdk-verbatim SDKBackgroundTasksChangedMessage]
        //    > emitted whenever membership changes (start, completion, kill, a foreground agent being backgrounded)
        //
        //    **＝ completion も membership の変化に含まれる。** 起こしを
        //    `'result'` の枝1つに任せると、`awaitingBackground` で畳んだ後の
        //    完了は誰も起こさず、次に届く入力（次のターン全体）が古いトークン
        //    のまま走る——この枝が塞ぐのはその穴である
        if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
        return;
      }

      // **この層が反応しない事実。** 逐次配信（`text_delta`）はクローン層の画面の
      // ためのもので、マネージャーの `Options` は `includePartialMessages` を
      // 立てていない。道具の結果（`tool_result`）も同じく画面の合図である。
      // **「まだ書いていない」ではなく「この層は見ないと決めてある」である。**
      case 'text_delta':
      case 'tool_result':
        return;

      // **こちらは「見ないと決めてある」ではなく「まだ書いていない」である。**
      // compaction の観測は、いまはクローン層の `turn_usage`（`clone.ts` の
      // `case 'turn_ended'`）にだけ載せてある —— マネージャー層の
      // `turn_usage`（`manager.ts` の `case 'usage'`）はこのイベントを読んで
      // いない。同じ形をこちらにも足すかどうかは、この PR の範囲外の判断として
      // 別途に残す（PR 本文「言えないこと」）。
      case 'compaction':
        return;

      case 'turn_ended': {
        // **ターンの境界の文脈占有を、`usage` を降ろす前に1回だけ聞く**
        // （`schema.ts` の `contextUsageObservationSchema` の doc）。失敗しても
        // このターンの成否には影響させない —— `#observeContextUsage` が
        // 例外を内側で受け止める。`clone.ts` の `#apply` の `case 'turn_ended'`
        // と同じ位置（成否分岐より前）に置く——成否で絞ると、失敗したターン
        // （#931 が実測した5連続 429 の側）の文脈占有が測れなくなる。
        const contextUsage = await this.#observeContextUsage();

        // **測った値を、成否分岐の外で無条件に emit する（Issue #976）。**
        // 下の `usage` イベント（`event.succeeded` の内側でしか emit
        // されない）に相乗りさせる経路は残したままだが、それだけでは
        // 失敗したターンの文脈占有はどこにも残らない——上のコメントが
        // 「測る位置」で防ごうとした事態が、出口側の関門でそのまま起きて
        // いた。**`event.succeeded` を見る前に、観測できた値をここで
        // 独立にも送る**——`turn_usage`（消費の増分）とは別の行として
        // 日誌へ残る（`manager.ts` の `case 'context_usage'`、`schema.ts`
        // の `context_usage` の doc）。
        if (contextUsage !== undefined) {
          this.#emit({
            type: 'context_usage',
            managerId: this.#id,
            sessionId: this.#resumeState.sessionId,
            turnSucceeded: event.succeeded,
            contextUsage,
          });
        }

        // ターンの区切りで必ず畳む。持ち越すと、前のターンの本文が次の報告に
        // 混ざって「言っていないことを言った」ことになる。印（`rejected`）も
        // 委譲の契機（`worker_wait` の材料）も同じ区切りで、まとめて1回で畳む
        // （`RunnerTurnTally.takeAtResult` の doc）。
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

        // **窓（作業者を待つ区間）への足し込みは `RunnerWorkerWaitWindow` へ
        // 委譲した**（Issue #1190 案X。前例は PR #1565 / #1551 / #1550 /
        // #1523）。窓が開いている（区間が開いているか閉じ待ちのとき）だけ
        // 足し込む——委譲の外で起きたターン（人間・クローンと直接話している
        // だけの回）なら {@link RunnerWorkerWaitWindow.foldTurn} は何もせず
        // `null` を返す。**最後の完了通知そのものを契機に回ったこのターンを
        // 数え終えてから閉じる**——閉じ待ちなら、足し込んだ直後に閉じて
        // `worker_wait` の中身を返す（`RunnerWorkerWaitWindow` の doc
        // 「`#windowClosing`」参照）。`#emit` するかどうかの判断はここに残す
        // ——`foldTurn` が非 `null` を返したときだけ出す。
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

        // **成否で絞らない。** 拒否は成功したターンにも失敗したターンにも載る（型は
        // `SDKResultSuccess` と `SDKResultError` の両方が持っている）。`usage` と違って
        // ゼロ埋めで害が出る値ではないので、ここは落とさず全部見る。
        for (const denial of event.denials) this.#noteDenial(denial, 'result');

        // **SDK が「応答ではない」と言っている印**（`assistant.error` /
        // `result.subtype` / `subtype: 'success'` なのに `is_error`）。
        //
        // **`succeeded` はこれを兼ねられない。** あちらは台帳の問い
        // （この累積を通してよいか）で `subtype === 'success'` だけを見るので、
        // `is_error: true` の result を成功として通す（`sdk-failure.ts` の表）。
        // 下の `#progressed` と `usage` は従来どおり `succeeded`（＝
        // `usage.ts` の `isSuccessResult`）のままにしてあり、
        // 変えたのは**報告の扱い**だけである。
        const failure = event.failure ?? rejected ?? undefined;

        // **`init` が来たことは「戻れた」ことではない。** 実機では、開きはしたが
        // その回が `error_during_execution` で何も返さずに終わる形も出ている。
        // 手が動く前の結果なし終了は、この resume が効かなかったということである。
        if (event.succeeded) {
          this.#markProgressed();
          // 消費の累積を降ろす（台帳へ畳むのはデーモン）。
          //
          // **成功した result だけを通す。** SDK は
          // 「Crash/startup-error results may carry zeroed values」と言っている。 [sdk-verbatim SDKResultSuccess.total_cost_usd]
          // ゼロを「累積が 0 になった」として通すと、受け取った側の基準が下がり、
          // 次に届いた本物の累積が丸ごと増分になる＝記録済みの分がもう一度積まれる。
          //
          // **絞っても取りこぼさない。** 値は累積なので、失敗した回のぶんも次の成功が
          // 運んでくる。落ちるのは「セッションが失敗で終わったときの最後の1ターン」
          // だけで、そこで打ち切りなので後続へ波及しない。
          if (event.usage !== undefined) {
            this.#emit({
              type: 'usage',
              managerId: this.#id,
              sessionId: this.#resumeState.sessionId,
              models: event.usage.models,
              // **応答として返ったかを別の欄で運ぶ**（`runner-protocol.ts` の
              // `answered` の doc）。`succeeded` は台帳の問いなので、枠で
              // 落ちた `is_error: true` のターンもここへ来る——受け手が
              // これを成功と読むと、回し手が `recovered` と枠を往復し続ける。
              answered: failure === undefined,
              // **この回だけ付く。** `#flushUsage`（セッションを畳む直前の
              // 別経路）は `turnBoundary` を持たないので付けない
              // （`#observeContextUsage` の doc）。無い（`undefined`）ことは
              // 「observe できなかった」だけでなく「`this.#query` が既に
              // 無かった」も含む——`contextUsageObservationSchema` の doc の
              // 3値の使い分けと同じ。
              //
              // **⚠️ Issue #976 以降、ここは唯一の経路ではない。** 上で
              // `context_usage` イベントとして独立にも送ってある——こちらは
              // 「成功して増分もあった回」に限られる旧来の経路で、後方互換と
              // 既存の読み手（`manager.ts` の `turn_usage.contextUsage`）の
              // ために残す。失敗した回・増分がゼロの回は `context_usage` の
              // 側でしか観測できない（これが #976 の直した非対称そのもの）。
              ...(contextUsage === undefined ? {} : { contextUsage }),
            });
          }
        }

        // **なぜ終わったのかを落とさない。** 実際に支出上限へ当たったとき、
        // マネージャーは `You've hit your individual spend limit` を返して終わった。
        // これを「結果なしで終了」だけにすると、上限で止まったのか失敗したのかを
        // クローンが区別できない — 前者は待つ / 人間に頼む、後者は挑み直す、で
        // 手が正反対になる。判定は SDK の定数で行う（自前の正規表現は腐る）。
        //
        // **成否の分岐の外に出してある。** `assistant.error` で止まった回は `result` が
        // 成功で返ってくることがあり、`else` の中に置くとその回だけ検知できない。
        // 分類にかけるのは**SDK が失敗として出した文言だけ**である（マネージャーが
        // 書いた本文 `said` は通さない — `classifyUsageNotice` は部分一致なので、
        // 「上限に当たった」と報告に書いた瞬間に上限と誤判定する）。
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
          // **1件も分類できなかった回に跡を残す（Issue #393）。** ここを黙って
          // 抜けると、**回し手が原理的に聞けない失敗**が何回起きているかがどこにも
          // 残らない —— 資格が1つも無い器で起こしたときがその形で、マネージャーが
          // 落ち続けてもプールは何も検知しない。**出す判断は変えていない**
          // （分類できたら従来どおり `usage_notice` を出し、できなければ従来どおり
          // 何も出さない）。足したのは数えることだけである。
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
          // **戻れなかった resume を「1ターン終わった」として報告しない。** ここを
          // 素通りさせると `report` が上がり、台帳には `done`（＝終えて待機中。
          // 話しかければ続く）が書かれる。実際には腐った session_id しか無いので、
          // クローンは「まだ続けられるもの」を見せられ、話しかけるたびに失敗する。
          // 手が動いていないのだから、ここは畳むのが正しい。
          if (outcome === 'unresumable') {
            // **落ち方は変えない。「どこで」だけを足す（#438 案D）。**
            //
            // **他5箇所（1122 / 1297 / 1300 / 1313 / 1319）のように `await` へ
            // 揃えることはしていない。** ここを囲む `#dispatch` は同期メソッドで、
            // 呼び出し元（`#read` の `for await`）も `await` せずに呼んでいる。
            // 揃えるには両方を非同期へ変えることになり、**メッセージ処理に直列化点が
            // 1つ増える** —— その影響は測っていないので、この変更には含めない。
            // **（追記 #2056）この前提はもう無い。** `#dispatch` は #602 で
            // `async #apply(event)` に置き換わり、`#read` も `await this.#apply(event)`
            // で呼んでいる。それでもここは `void` のまま残してある —— `await` へ
            // 揃えるかは、`stop()` との競合（下の #1597）を含めて別の変更で測ること。
            //
            // **`#stopped` なら、ここで `#finish` を呼ばない（#1597）。** 待たずに
            // 発火する `void this.#finish('lost', …)` は、resume 直後（まだ一度も
            // 手が動いていない）に結果なしの result が来て `unresumable` と判定
            // されたとき、await を挟まず `stop()` が重なると `stop()` と競合する。
            // `stop()` は `#stopped = true` を立ててから自分で畳み一式
            // （`#closeWorkerWaitWindow` / `#settleAll` / `#shipArchive` /
            // `#flushUnreported` / `#onClosed()`）を行い、`closed` を出さないと
            // 決めている（doc「あちらは closed すら出さない」）。ここで無条件に
            // `#finish('lost', …)` を発火すると、`stop()` が `host.list()` から
            // 消した**後**に `closed(status=lost)` が遅れて出てしまう
            // （Issue #1589 / PR #1590 が `#read` の catch 節に足した門と同じ形の
            // 穴——あちらは塞いだが、この枝は #1590 の本文が「確かめていない」
            // として残していた場所そのものである）。**畳むのは `stop()` の仕事
            // なので、ここは何もしない。**
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

        // **失敗した回の報告に、失敗であることを載せる。** 直す前は成否によらず
        // `reportText(said, resultText(message))` を上げていたので、上限の英語文言が
        // そのまま「マネージャーの報告」として台帳（`lastReport`）・日誌・クローンの
        // 受信箱へ流れていた。クローンから見て「報告が来た」と「エラーで死んだ」が
        // 区別できない ＝ クローン側で塞いだのと同じ穴がここに残っていた。
        //
        // **本文（`text`）の側でも包む。** 構造化した `failure` だけに頼ると、それを
        // 見ていない読み手（台帳の `lastReport` を出す画面・日誌を読む人間）には
        // 依然としてエラー文が報告として見える。
        //
        // **失敗で終わった回は `contentless` に含めない。** `failedReportText` は
        // 必ず本文を作るし、上限に当たった事実はクローンが知る必要がある
        // （このターン限りは待つ／挑み直すの判断材料）ので、`failure !== undefined`
        // の枝では `reportText` そのものを呼ばない。
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
        // **ここがターンの境界になった。** 認証トークンの畳み直しの印が立って
        // いれば、入力待ちで止まっている `#inputStream` を起こす
        // （`clone.ts` の `#finishTurn` と同じ理由 —— 起こさないと、次に
        // 入力が届くまで古いトークンのまま走り続ける）。
        //
        // **無条件に起こしてよい。** 境界条件（`#atTokenRecycleBoundary()`）の
        // 判定は `#inputStream` 側が持つので、ここで起こしても条件が揃って
        // いなければ（確認待ちが残っている・背景処理が生きている等）そのまま
        // 待ちへ戻るだけである。
        if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
        // **マネージャーがバックグラウンド実行の完了を待つためだけに畳んだ
        // ターンの報告に、その旨を載せる（`runner-protocol.ts` の
        // `report.awaitingBackground` の doc）。**
        //
        // 実測の経緯: `Bash` を `run_in_background: true` で起こした直後、
        // マネージャーが「完了を待つ」とだけ言って `end_turn` で畳むと、その
        // 最後の発話がそのまま「報告」としてクローンへ配られ、クローンの
        // ターンを1本無駄に起こしていた（依頼者が生ログで実測、同日に11本）。
        //
        // **3条件すべてを満たすときだけ載せる**（1つでも欠けたら必ず配る側
        // へ倒す）:
        // 1. `failure === undefined` —— 失敗で終わった回は必ず配る
        //    （上限・拒否は握り潰さない）
        // 2. `this.#status === 'done'` —— `waiting_human`（確認待ちが在る）
        //    回は必ず配る。確認待ちを黙って畳むと人間の判断が止まる
        // 3. `this.#liveBackgroundTasks.length > 0` —— 起こしっぱなしの
        //    背景処理が実際に在るときだけ
        const awaitingBackground =
          failure === undefined &&
          this.#sdkSession.status === 'done' &&
          this.#sdkSession.liveBackgroundTasks.length > 0
            ? {
                count: this.#sdkSession.liveBackgroundTasks.length,
                // **診断用の写しであって判定には使わない**（doc のとおり）。
                breakdown: summarizeBackgroundTasks(this.#sdkSession.liveBackgroundTasks),
              }
            : undefined;
        this.#emit({
          type: 'report',
          managerId: this.#id,
          // **#206: provider がこの結果に払った id を運ぶ。** SDK の `result.uuid` で、
          // `#onPermission` が `extra.requestId` / `extra.toolUseID` をそのまま
          // 使うのと同じ作法——runner が新しい値を振るのではなく、SDK 側の
          // 識別子をそのまま `reportId` として運ぶ（`runnerEventSchema` の
          // `report.reportId` の doc）。
          reportId: event.id,
          text: outcome.text,
          status: this.#sdkSession.status,
          ...(failure === undefined ? {} : { failure: { code: failure.code, via: failure.via } }),
          ...(outcome.contentless ? { contentless: true } : {}),
          ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
          // **`failedReportText` を使った経路だけが立てる**
          // （`runnerEventSchema` の `report.synthesized` の doc）。この本文は
          // runner 自身の定型文＋SDK の失敗文言の連結であり、マネージャー本人が
          // 書いた・喋った断片を含まない——`failure !== undefined` の枝でしか
          // `failedReportText` を呼んでいない（このすぐ上の `outcome` の分岐）
          // ので、判定はそこにそのまま乗せる。**値は族の名前**（`'turn_failed'`
          // ＝「ターンが失敗して終わった」。`manager.ts` 側の
          // `SynthesizedNoticeLabel` と同じ語彙を使う）。
          ...(failure === undefined ? {} : { synthesized: 'turn_failed' }),
        });
        // **#1554: このターンの間に積まれたが、道具呼び出しが無いまま畳まれて
        // 配達されなかった分を拾う。** `report` を出した後に呼ぶ（`push()` が
        // 状態を `running` へ戻すので、先に呼ぶと上の `report.status` /
        // `awaitingBackground` が嘘になる）。`wantsTokenRecycle` の
        // `wakeInput()` とは独立——`push()` は入力を積んでから起こすので、
        // 畳み直しの境界条件は積まれた入力を見て待つ側へ倒れる。
        this.#wakeForFinishedBackgroundTaskOutputs();
        return;
      }

      // **枝が増えたらここが型で落ちる（#285 と同じ形）。** 落ちたら「この層は
      // その事実にどう反応するか」を決めてから通すこと —— 既定で無視へ倒すと、
      // provider が名乗り始めた事実が黙って網の外へ出る。
      default: {
        const unread: never = event;
        void unread;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 委譲の契機を数える（`worker_wait`）
  // -------------------------------------------------------------------------

  /**
   * `task_started`。`#openTasks` が 0→1 になった瞬間に区間を開く（Issue #1190
   * 案X で `RunnerWorkerWaitWindow`（`runner-worker-wait-window.ts`）へ切り出した）。
   *
   * **Issue #2113: 作業者（`local_agent`）のタスクだけを数える。** SDK は
   * `task_started` を作業者以外のタスク（`local_bash` 等）でも出す
   * （`isWorkerTaskType` の doc）。直す前はここで `task_type` を見ずに一律
   * 「作業者が開いた」として数えていたため、マネージャー自身が委譲していない
   * ターンでも `openedWorkers` が増え、`worker_wait` の区間まで開いていた
   * （実測: 枠の失敗で「作業者が35体開いていた」と報告した回に、実際に
   * マネージャーが開いた作業者は1体だった）。
   */
  #onTaskStarted(event: AgentDelegationStarted): void {
    // provider が id を名乗らなければ、取りこぼすより偽の id で数える方を選ぶ
    // （他の道具の `brief`/`randomUUID` 系の判断と同じ）。**代用値をここで作るのは、
    // 何で埋めるかが層の判断だからである**（`agent-events.ts` の doc）。
    const taskId = event.taskId ?? randomUUID();
    // **作業者ではないタスク（`local_bash` 等）は、ここで両方とも数えない**
    // ——`#turnTally`（このターンの状況証拠）にも `#workerWaitWindow`
    // （委譲を待つ区間）にも足さない。対応する `task_notification` が後で
    // 来ても、`#openTasks` に入っていないので `RunnerWorkerWaitWindow.notified`
    // は「対応の無い通知」として無害に無視する（あちらの doc を見よ）。
    if (!isWorkerTaskType(event.taskType)) {
      // 通知側で弾くために控える（`task_notification` は `task_type` を運ばない）。
      // 代用の id（`randomUUID()`）は通知と突き合わないので控えない。
      if (event.taskId !== undefined) this.#nonWorkerTaskIds.add(event.taskId);
      return;
    }
    // **#1373: `RunnerWorkerWaitWindow` の `#openTasks` の開閉とは無関係に、
    // このターンで開いた作業者を別勘定で数える。** `RunnerTurnTally` の
    // `#openedWorkersThisTurn` の doc を参照。
    this.#turnTally.addOpenedWorker(taskId);
    this.#workerWaitWindow.taskStarted(taskId);
  }

  /**
   * `task_notification`。開いている委譲から1件外し、全部片付いたら閉じ待ちにする。
   *
   * **併せて #901 を見る。** `task_id` が「打ち切った」と控えられていれば
   * （＝背景処理の待ちの上限（30分）で打ち切られていて、まだ同期の `Task` 結果として
   * 消費されていない）、`RunnerCutOffWorkers#consumeCutOff` で消して
   * `recordPendingNotification` で付け替える——`task_notification` 自体には
   * `additionalContext` を注げないので（`RunnerCutOffWorkers` の
   * `#pendingCutOffNotifications` の doc）、次にマネージャー自身の道具が動いた
   * ときに配達する。
   *
   * **#1373 続き: `status: 'failed'` を状況証拠として数える。** `claude-provider.ts`
   * が運んでくる `status` は絞らず string のまま（`AgentDelegationNotified.status`
   * の doc）なので、ここで見るのは `=== 'failed'` の一致だけである——SDK が
   * 版で値を増やしても、知らない値は自然に「失敗ではない」側へ落ちる（数えない
   * だけで、握り潰しはしない）。**枠(429)を名乗っているかは、手で書いた文言
   * 一致ではなく `classifyUsageNotice`（SDK の定数を使う既存の分類器。
   * `usage-limits.ts`）に `summary` を通した結果で決める** —— この関数は
   * このメソッドの少し下（`turn_ended` の枝）で `usage_notice` の判定にも
   * 使われているのと同じ関数である。
   *
   * **併せて #1554 も見る（上とは別の id 空間の相関）。** 上の分岐が見る
   * `task_id` は「作業者（subagent）自身の完了」（`task_id === agentId`）
   * だが、この `task_notification` は**背景の Bash 処理そのものの完了**
   * （`task_id === background_tasks[].id`）でも同じ形で届く——`BackgroundTaskSummary.type`
   * の doc が挙げる `'shell'` 等がそれである。この2つの id 空間は別物
   * なので、上の分岐と独立に、`RunnerSubagentStopState#backgroundTaskOwner`
   * で「この背景処理の所有者」を引く。所有者が在り（マネージャー自身の
   * 分＝空文字は除く）、かつその所有者が {@link RunnerCutOffWorkers.isCutOff}
   * なら、「打ち切った作業者が残した背景処理が終わった」という配達待ちを
   * 積む（`#annotateCutOffWorkers` が次のマネージャー自身の道具呼び出しで
   * 配達する）。**`output_file` が読めなければ `null` を渡す**（作り物の
   * パスを主張しない——配達側が「取れなかった」と書く）。**積んだ直後に、
   * マネージャーが止まっていれば起こす**（`#wakeForFinishedBackgroundTaskOutputs`。
   * 走っていれば次の道具呼び出しか、ターンの `result` がそれを拾う）。
   */
  #onTaskNotification(event: AgentDelegationNotified): void {
    const taskId = event.taskId;
    // **開閉（1→0 の遷移で閉じ待ちを立てる）は `RunnerWorkerWaitWindow` へ
    // 切り出した**（Issue #1190 案X）。対応の無い通知（本来起きない想定だが
    // 防御的に見る）で誤って閉じ待ちを立てないのは、あちら側の doc を見よ。
    this.#workerWaitWindow.notified(taskId);
    // **Issue #3008: `SubagentStop` のフックの中で完了を待っている者の補助の合図。**
    // 主は `background_tasks`（`liveBackgroundTasks`）だが、あちらは id 空間が同じかを
    // 誰も実測していない（`RunnerBackgroundWaiters` の doc）ので、背景処理自身の完了
    // 通知（`task_id` ＝ `background_tasks[].id`。#1554 の節）も「終わった」として控える。
    if (taskId !== undefined) {
      this.#sdkSession.backgroundWaiters.noteFinished(
        taskId,
        typeof event.outputFile === 'string' ? event.outputFile : null,
      );
    }
    // **作業者ではないタスク（`local_bash` 等）の通知は、下の2つの数え上げ
    // （`notifications`・failed 通知）に入れない**（Issue #2113 の続き。
    // `task_started` 側だけを直すと、Bash の失敗が「作業者の failed 通知」に
    // 積まれ、要旨が枠を名乗れば枠の件数まで立つ）。**#901 / #1554 の付け替えは
    // 下でこれまでどおり通す**——背景の Bash 処理の完了は #1554 の材料そのもの
    // である。対応する `task_started` を見ていない通知は、この控えに無いので
    // 従来どおり数える。
    const nonWorker = taskId !== undefined && this.#nonWorkerTaskIds.delete(taskId);
    // **`worker_wait.notifications` の材料。** 対応する `task_started` を見て
    // いなくても数える — 通知そのものは事実である。
    if (!nonWorker) this.#turnTally.incrementNotificationsSinceResult();

    if (!nonWorker && event.status === 'failed') {
      const limitNamed =
        event.summary !== undefined && classifyUsageNotice(event.summary) !== undefined;
      this.#turnTally.recordFailedWorkerNotification(taskId, limitNamed);
    }

    // #901: 同期経路（`#annotateCutOffWorker`）でまだ消費されていなければ、
    // ここで「未配達の打ち切り注記」として控える。
    if (taskId !== undefined && this.#cutOffWorkers.consumeCutOff(taskId)) {
      this.#cutOffWorkers.recordPendingNotification(taskId);
    }

    // #1554: 背景処理そのものの完了。所有者が打ち切られたことのある
    // 作業者なら、出力の在り処を配達待ちへ積む（「打ち切られていない
    // 作業者の処理には載らない」「持ち主が分からない処理には載らない」の
    // 2つの歯はここで成立する——`owner` が undefined／`''`（マネージャー
    // 自身）なら早期 return し、`isCutOff` が false でも積まない）。
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

  /**
   * 積まれた「打ち切った作業者の背景処理の完了」（#1554）を、マネージャーが
   * 止まっているときだけ `push()` で届けて起こす。
   *
   * 打ち切った作業者は自分では再開しないので、マネージャーがターンを閉じて
   * 待っていると次の道具呼び出しが来ず、配達待ちが積まれたまま誰も起こさない。
   * **`stopped` は何もしない（配達待ちも消さない）。`running` も何もしない**
   * ——次の道具呼び出し（`#annotateCutOffWorkers`）か `#read` の `result` の枝が
   * 拾う。**`waiting_human` も起こさない（`done` のときだけ）**: `push()` は
   * 状態を `running` へ戻すので、確認待ちが残ったまま「確認待ちではない」と
   * 名乗ることになり、`answer()` の宛先（`#pending`）との対応が崩れる。確認待ちが
   * 解けて走り出せば `running` の経路が拾う。
   */
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

  /**
   * 開いている委譲区間を1件の `worker_wait` として降ろし、閉じる。**中身の
   * 組み立てと `settled` の算出は `RunnerWorkerWaitWindow.close()`（Issue #1190
   * 案X）へ切り出した——ここに残るのは「非 `null` なら emit する」という
   * 判断だけである。**
   *
   * **窓が閉じていれば何もしない。** `#finish` / `stop` / 引き継ぎのどこから
   * 呼んでも安全に重ねられるようにするための無害化である
   * （`RunnerWorkerWaitWindow.close` の doc）。
   *
   * **`settled` は引数で受け取らず、`RunnerWorkerWaitWindow` の中で `#openTasks`
   * の状態から導く。** 呼び出し側に真偽値を持たせると、`#finish` / `stop` /
   * 引き継ぎの3経路が固定で `false` を渡すことになり、**「委譲した作業者全員
   * から完了通知を受け切った直後に、次の `result` が来ないままセッションが
   * 畳まれた」場合まで `false`（＝受け切れなかった）と偽って報告する。** これは
   * この PR が答えたい問い（最後の完了通知の後、SDK はマネージャーを起こすのか）
   * のど真ん中で起きる — 「起こさない」という当たりの仮説が成り立つ場合に
   * 限って、**全区間に偽の印が付く**ことになる。
   */
  #closeWorkerWaitWindow(): void {
    const closedWindow = this.#workerWaitWindow.close();
    if (closedWindow === null) return;
    this.#emit({ type: 'worker_wait', managerId: this.#id, ...closedWindow });
  }

  /**
   * 止められた1件を上へ降ろす（同じ id は一度だけ）。
   *
   * **`#progressed` は立てない。** 拒否は「やろうとしたが何も起きなかった」で
   * あって、手が動いた印ではない。ここで立てると、resume が効かずに終わった回を
   * 「もう作業した」と誤認して生ログからの作り直しを止めてしまう。
   */
  #noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): void {
    const tool = denial.tool ?? '(不明な道具)';
    const input = denial.input;
    if (typeof denial.toolUseId === 'string') this.#settleWorkerTool(denial.toolUseId);

    // **1回だけの許可で allow を返した呼び出しを、SDK がそれでも拒否したかの
    // 検出**（issue #1105 P1、`clone.ts` の `#allowedByGrantToolUses`/
    // `#noteGrantFunneled` と同じ形。issue #863 残項目）。**必ず SDK が実際に
    // 付けてきた `denial.toolUseId` で引く**——下で組む代用の `toolUseId`
    // ではない。代用値はここで意味を持つ実在の id ではないので、それで引くと
    // 無関係な一致が起きうる。
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

    // id が無ければ道具と入力から作る。**取りこぼすより重複を許す。**
    //
    // **⚠️ この代用鍵は live と result で一致しない。** 走行中の合図に入力は付かず
    // （`input` は `undefined`）、ターン終わりの記録には付くので、同じ1件の拒否が
    // 別々のハッシュになる。すると下の重複排除が効かず、`permission_denied` が2本
    // 降りて道具ごとの合計が1件で2つ増え、`shouldEscalateDenial` の exact-equality
    // （`manager.ts`）が段を跨いで**クローンへの escalation を飛ばす。**
    //
    // **それでも道具名だけで束ねない。** id の無い回に live 側が持つのは理由と分類、
    // result 側が持つのは入力で、共有する識別子は道具名しか残らない。道具名で束ねると
    // 「同じ拒否の2度目」と「live を見逃した初出」が潰れる —— SDK は**その両方が
    // 起きうる**と書いており（`permission-denied.test.ts` の逐語）、どちらの「無い」も
    // 消せない。**束ねる材料が無いので束ねず、前提のほうへ歯を置いた** ——
    // `tool_use_id` は SDK の型で live / result の両方とも必須なので、この経路は
    // いま踏まれない。**必須でなくなったら `pnpm typecheck` が落ちる**
    // （`permission-denied.test.ts` の「SDK の型の前提」）。
    //
    // **代用値を作るのはこちら側の仕事である**（`agent-events.ts` の
    // `AgentPermissionDenial` の doc）。provider の写しは「無かった」をそのまま
    // 運ぶだけで、何で埋めるかは層が決める。
    //
    // **入力そのものを鍵に混ぜない。** ここは以前 `brief(input, 120)` を素で
    // 連結していたが、この鍵は `#denied` の `onForget` が**日誌へそのまま並べる**
    // （`ids.join(', ')`）。道具の入力には環境変数の値やトークンが入りうるので、
    // 記憶が上限に達した回にだけコマンド本文が日誌へ出る経路が開いていた。
    // **同じ文字列は同じ鍵になる**ので、畳み方（＝重複排除の効き方）は変わらない。
    //
    // **`brief` の切り口が補助面の文字の手前へ寄るようになった（issue #2449）の
    // に合わせて、この鍵の材料も寄せたままにする。** 素の slice を残す分岐は
    // 作らない。理由は3つ。(1) 鍵の値が変わるのは、120コード単位目を補助面の
    // 文字がまたぐ入力だけで、同じ runner の中ではどの呼び出しも同じ関数を通る
    // ので、同じ入力は同じ鍵のまま（`#denied` はプロセスの記憶で、持ち越さない）
    // (2) 区別の力は実質変わらない——`digestOf` の `update()` は孤立サロゲートを
    // U+FFFD として UTF-8 にするので、素の slice でも「どの絵文字だったか」は
    // 鍵に残っていなかった（`p\ud83d` / `p\ud83e` / `p�` は同じ digest に
    // なる。2026-10-01 の手元の実測） (3) この代用鍵は `tool_use_id` が無いときだけ
    // 作られ、それは上の断りのとおりいま踏まれない。
    const toolUseId = denial.toolUseId ?? `${tool}:${digestOf(brief(input, 120))}`;
    // **`PreToolUse` が拒否より前に控えた入力の先頭を、有れば引いて消す**
    // （issue #1105。`#preToolInputHeads` / `#capturePreToolInputHead`）。
    // ここで引くのは、この呼び出し1回につき `permission_denied` を1度しか
    // 降ろさない（直後の重複排除）のと揃えるため——2度目以降の呼び出しで
    // 引いても、下の早期返却でどのみち使われない。**引いたら消す**（帳面に
    // 残さない。同じ tool_use_id の拒否がもう一度来ても、控えは戻らない
    // ——生の入力を持ち回っていない以上、作り直すことはできない）。
    const inputHead = this.#preToolInputHeads.get(toolUseId);
    if (inputHead !== undefined) this.#preToolInputHeads.delete(toolUseId);
    // **既に降ろしてある1件でも、入力を持つ記録が後から来たら形だけ足す。**
    //
    // 同じ拒否は `via: 'live'`（走行中の合図）と `via: 'result'`（ターン終わりの
    // 記録）の両方に載るが、**入力を持っているのは後者だけ**である
    // （`runner-protocol.ts` の `input` の doc）。ここが `has` だけで弾いて
    // いたので、入力を持つ authoritative な記録が丸ごと捨てられ、日誌には
    // 「何を実行しようとしたか」が1件も残らなかった——読む側は「良性のコマンドが
    // 誤検知された」と「拒否されるべきコマンドだった」を区別できず、次の一手を
    // 選べない。
    //
    // **これは `input` の欄を後から詰めているのではない**（`runner-protocol.ts`
    // の `input` の doc が禁じているのはそちら）。降ろしているのは SDK が
    // `result.permission_denials` で実際に名乗った値であって、推測ではない。
    //
    // **本文は載せず形だけ載せる**（`denial-shape.ts`）。**足すのは1度だけ** ——
    // `result` が累積かどうかは SDK の型に書かれていない（この帳面の doc）ので、
    // 2度目以降は下の早期返却が落とす。
    //
    // **`permission_denied` をもう一度降ろさない。** デーモン（`manager.ts`）は
    // 拒否を1件ずつ数えており、`shouldEscalateDenial` は「1ずつ増える数」を
    // 前提にしている。2本目を降ろすと二重計上になり、段（3件目・10件目…）を
    // 跨いで escalation が飛ぶ。**だから既存の `note` で足す** —— protocol に
    // 種別も欄も足さないので、デーモンと runner のデプロイ順序がどちらでも
    // 壊れない（新しい種別を足すと、まだ知らないデーモンでは
    // `runnerEventSchema` の `safeParse` が落ちて `unknown-shape` の
    // 取りこぼしとして鳴る。`apps/daemon/src/runner-client.ts`）。
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
    // `decision_reason` / `decision_reason_type` / `message` は SDK の走行中の
    // 合図（`via: 'live'`）にしか付かない任意フィールドである（`result` の
    // `SDKPermissionDenial` は理由を持たない）。**文字列であることを確かめて
    // からしか載せない** — `undefined` を代入すると `JSON.stringify` で落ちる
    // にせよ、型を保証しないまま runner-protocol.ts の `z.string().optional()`
    // へ渡すのは事故のもとである（SDK の型変化で数値や null が来ても黙って通す
    // ことになる）。無いものは作り物を出さず、キーごと省く。
    //
    // **`actor` は `via: 'live'` のときだけ載せる（`#onPostToolUse` と同じ式）。**
    // `via: 'result'`（`result.permission_denials`）の SDK 型（`SDKPermissionDenial`）
    // は `tool_name` / `tool_use_id` / `tool_input` の3つしか持たず、`agent_id`
    // が原理的に存在しない。**「マネージャーだった」と決めつけないこと** ——
    // それは「層が取れた」ではなく「取れなかった」であり、`actor` をキーごと
    // 省いて第3の状態のまま runner-protocol.ts / manager.ts へ渡す
    // （このメソッド既存の「無いものは作り物を出さず、キーごと省く」規則を
    // そのまま延長しただけである）。**同じ扱いが、runner とデーモンの
    // デプロイのずれの窓も塞ぐ** —— 古い runner がまだ `actor` を送ってこない
    // 回も、同じ「取れていない」へ自然に落ちる。
    //
    // **`agent_type` は今のところ常に無い。** `SDKPermissionDeniedMessage`
    // （`via: 'live'` の合図）は `agent_id` は持つが `agent_type` を持たない
    // （`PostToolUseHookInput` にはあるが、この合図には無い。**この不在には
    // 歯が在る** —— `permission-denied.test.ts` の
    // `走行中の合図は agent_type の欄を持たない`。**⚠️ 版番号を根拠に書かない。**
    // 不在は `check:sdk-quotes` では守れず（あの門は「在ること」しか言えない）、
    // 守っているのは型の歯のほうである）。だから作業者の拒否は `WORKER_AGENT_NAME`
    // （`worker`）に落ちる ——`#onPostToolUse` のように呼び出した Task の
    // 具体的な agent_type までは分からない。**揃えられなかった点であり、
    // SDK の型に無い情報をここで作り物として埋めることはしない。** 将来
    // SDK がこの欄を持たせてきた場合に備えて読みはするが、現状では
    // 常に `undefined` である。
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
      // **`input` の欄には絶対に詰めない**（`runner-protocol.ts` の `input`
      // の doc が明文で禁じている）。ここは別の任意欄——SDK の拒否の合図が
      // 運んだ値ではなく、同じ `tool_use_id` で `#onPreToolUse` が拒否より
      // 前に見た入力を、伏せて切ったものである（issue #1105）。
      ...(inputHead === undefined ? {} : { inputHead }),
    });
  }

  /**
   * ターンの境界の文脈占有を、SDK の control channel から1回だけ聞く
   * （`schema.ts` の `contextUsageObservationSchema` の doc）。
   *
   * **クローン層（`clone.ts` の `#observeContextUsage`）と同じ形である。**
   * #967 —— このメソッドが移されるまで、委譲セッション（マネージャー／
   * ランナー層）の側には文脈占有を測る計器が1つも無かった（`getContextUsage`
   * の呼び出しがクローン層の1箇所にしか無いことは #967 の本文が実測している）。
   * **分類ロジック（`kind` を見た畳み込み）は複製しない** —— それを行う
   * `summarizeContextCategories`（`context-usage.ts`）はここでは呼ばない。
   * ここは SDK の値をそのまま写すだけで、集計は読む側（`context-usage.ts`）が
   * 1箇所で持つ。
   *
   * **`this.#query` が既に無ければ何も聞かない。** セッションが終わる窓
   * （`#query = null` にした後）でここへ来ると `getContextUsage` を持たない
   * 値を呼ぶことになるので、`null` のときは呼ばずに `undefined` を返す ——
   * これは「試して失敗した」ではなく「まだ観測していない」の側である
   * （`contextUsageObservationSchema` の doc、欄そのものが無い行の意味）。
   *
   * **失敗してもターンを止めない。** 呼び出しは `try`/`catch` で必ず値を
   * 返す形にしてあり、呼び出し元（`case 'turn_ended'`）はここで例外を
   * 待ち受けない。
   *
   * **秘密を漏らさない。** 例外・rejection の理由は `usage-probe.ts` の
   * `describeProbeError`（`redactEnvSecrets` を内側で通す）でしか運ばない
   * ——新しい伏せ字の仕組みは作っていない。
   */
  async #observeContextUsage(): Promise<ContextUsageObservation | undefined> {
    const session = this.#sdkSession.query;
    if (session === null) return undefined;
    const startedAt = Date.now();
    try {
      const usage = await session.contextUsage();
      // **内訳は既に払ってあるものを写すだけである。** `clone.ts` の
      // `#observeContextUsage` と同じ理由（あちらの doc に逐語）——
      // 既定の `detail: 'full'` により、内訳を取り出さなくても費用は同じ。
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
        // **空の配列のときは欄そのものを作らない。** クローン層と同じ理由
        // （AGENTS.md の地雷「取れない軸に 0 の行を作る」）。
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

  /**
   * **畳む直前に累積をもう一度読む。** 台帳の穴はここでしか塞げない。
   *
   * 台帳へ入るのは `result.modelUsage` だけなので（`#apply` の `turn_ended`）、**`result` を
   * 1度も出さずに終わったセッションの消費はどこにも載らない。** しかも載らない
   * だけではなく一覧にも現れないので、「いくら取りこぼしたか」すら分からない。
   * 実測では、30分走って PR をマージまで運んだ委譲が器の入れ替えで畳まれ、台帳に
   * 1行も残らなかった（`mgr-eef70c01`）。
   *
   * SDK は同じ値を control channel からも出している —
   * `SDKControlGetUsageResponse.session.model_usage` は `result.modelUsage` と
   * **同じ型・同じ意味の累積**で、`result` を待たずに読める
   * （`usage.ts` の `sessionModelUsageOf`）。
   *
   * **best-effort である。決して投げず、畳む経路をこれに縛らない。**
   *
   * - 実測で、ターンを回している最中の control 要求は
   *   `ProcessTransport is not ready for writing` で失敗する（`usage-probe.ts` の
   *   注記4）。**失敗は異常ではなく通常の枝**である。取れなければ取れないまま畳む
   * - **全部ゼロなら降ろさない。** ゼロは「使っていない」ではなく「読めなかった」で
   *   ある。降ろすと台帳にゼロだけの基準ができて、**「記録が無い」が「$0.00 使った」に
   *   化ける**（`foldUsageSnapshot` が守っているのは基準を*下げない*ことで、基準を
   *   *作らない*ことではない）
   * - 値は累積なので、この1回が `result` 経由の記録と重なっても増分が 0 になるだけ
   *   である（`runner-protocol.ts`「累積なら再送に耐える」）
   *
   * **読み取りそのものは `usage.ts` の `readSessionUsage` が持つ。** クローン層の
   * `clone.ts` の `#flushSessionUsage` が同じものを呼ぶ。**層ごとに書き分けない**
   * —— 片方だけが直っている状態は、直っていない側の欠落を「使っていない」と
   * 読ませる（そちらの doc に、なぜ両方要るかを逐語で書いた）。
   */
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

  /**
   * **`result` を受け取らないまま畳むとき、既に喋られていた本文を報告として出す（#323）。**
   *
   * 報告は `#apply` の `turn_ended`（SDK の `result` を写したもの）の枝でしか作られない。
   * assistant のメッセージは（`stop_reason` が `end_turn` でも）`RunnerTurnTally`
   * の `#said` に積まれるだけで、畳むのは `result` の到来だけである。**だから `result` が
   * 来ないまま終わる回は、マネージャーが書き終えた本文が丸ごと消えていた** —
   * 生ログ（`manager_transcript`）にだけ残り、台帳にも日誌にもクローンの
   * 受信箱にも1文字も出ない。これは #323 が「生ログには `end_turn` まで在り、
   * `manager_list` の直近の報告にも台帳にも出ない」と書いた症状そのものである。
   *
   * **`result` が来ない回は例外ではない。** `#finish` の doc が逐語で
   * 「ここを通るのはクラッシュ・`lost`・`failed`、つまり `result` が出ない
   * まま終わる経路そのものである」と書いており、`stop()`（器の入れ替えと
   * `manager_stop`）も同じ穴を持つ（あちらは `closed` すら出さない）。
   *
   * **空なら1件も出さない。** 中身の無い報告はクローンのターンを1本焼く
   * （`runner-protocol.ts` の `report.contentless` の doc）。ここは
   * 「積んだ本文が在るときだけ出す」なので、`contentless` は構造上立たない
   * — だからこのイベントに `contentless` は付けない。
   *
   * **畳んでから出す。** 二度呼ばれても二度は出ない（`stop()` の後に
   * `#read` の catch から `#finish` が来る経路が実在する）。
   *
   * **`RunnerTurnTally` の `#rejected`（SDK が「応答ではない」と印を付けた
   * 事実）はここでは読まない。**
   * あれはターンの終わり方を言う印で、その確定は `result` が運ぶ。
   * `result` が来ていないこの経路では「失敗として終わった」と名乗れない
   * ——名乗れないものを名乗らない（`AGENTS.md`「取れない軸に0の行を作る」）。
   *
   * **`unreported` を立てる（Issue #917）。** `failure` は上の理由で立てられ
   * ないが、この本文（`unreportedText()`）は完遂した報告ではなく畳まれる前の
   * 途中経過である——`runnerEventSchema` の `report.unreported` の doc が
   * 詳しい。値は `reason` をそのまま運ぶ（言い換えない）。
   */
  #flushUnreported(reason: string, status: JobStatus): void {
    if (!this.#turnTally.hasSaid) return;
    const { said, reportId } = this.#turnTally.takeSaid();
    this.#emit({
      type: 'report',
      managerId: this.#id,
      // 無ければ付けない。デーモン側は `reportId` の無い report を「冪等化を
      // 諦める」経路で受ける（`manager.ts` の `case 'report':`）——捨てはしない。
      ...(reportId === undefined ? {} : { reportId }),
      text: unreportedText(said, reason),
      status,
      unreported: { reason },
    });
  }

  /**
   * `selfFenced` は `RunnerSession#selfFence` からだけ渡す。
   *
   * **他の呼び出し元（resume 不能・クラッシュ）は渡さない**——渡さなければ
   * `runnerEventSchema` の `closed.selfFenced` は既定で undefined になり、
   * デーモン側の判定（自己失効なら `lease` だけ返す）は自己失効の1経路にしか
   * 効かない（`runner-protocol.ts` の `closed` の doc）。
   *
   * **薄いラッパーである（Issue #1602 / #1605）。** 中身（`#finishBody`）を
   * 呼ぶ前に、その Promise を `#closing` へ控える——`stop()` がこれを
   * await して、畳み中の `#finish()` を追い越さないようにするためである
   * （`#closing` の doc。**#1602 の時点では `#finishing` という専用の欄
   * だったが、#1605 で `stop()` 自身の畳みも同じ形で控える必要が出たため、
   * 1つの欄へ統合した**）。**中身の順序・`closed` を出すかどうかは変えて
   * いない。** ここで例外を握り潰さない（`await promise` をそのまま伝播
   * させる）——`#finish()` を呼ぶ側（`stop()` と、fire-and-forget な7箇所
   * の呼び出し元）のどちらも元から例外の伝播を前提にしていたので、ここで
   * 新しく飲み込むと片方の前提を壊す（`stop()` の doc に理由の詳細）。
   *
   * **`#closing` を控える・待つ・消す3行は `RunnerSdkSession#trackClosing`
   * へ切り出した**（Issue #1190 案X。`stop()` と重複していた同じ3行を
   * 1本化した）。
   */
  async #finish(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    await this.#sdkSession.trackClosing(() => this.#finishBody(status, reason, options));
  }

  /** `#finish()` の中身。呼ぶのは `#finish()` のラッパーだけである。 */
  async #finishBody(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    this.#sdkSession.markStopped();
    // **量をここで1行にまとめる。終わり口はここだけではない（Issue #393）。**
    // もう1本は `stop()`（器の入れ替えと `manager_stop` が通る道）で、**あちらは
    // ここを通らない** —— だから同じ呼び出しが両方に在る（`stop()` の中の
    // `#closeWorkerWaitWindow` の隣に、同じ理由で並べてある）。
    //
    // **片方だけにすると、存在は残るが量だけが失われる。** 初出の1行は経路に
    // 関係なく出るので、**落ちていることに気づく手がかりが出力に無い。**
    // 数え上げの持ち主は `noteUnclassifiedFailuresSummary` の doc に在り、
    // そこは「すべての終わり口」ではなく現物の2本を名指ししている。
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);
    // **`close()` より先に読む。** 閉じた後の control channel からは何も取れない。
    // ここを通るのはクラッシュ・`lost`・`failed`、つまり `result` が出ないまま
    // 終わる経路そのものである。
    await this.#flushUsage();
    // **取りこぼしを作らない。** window が開いたまま（か閉じ待ちのまま）
    // 畳まれるなら降ろしてから閉じる。`settled` は渡さない —
    // `RunnerWorkerWaitWindow` のその時点の `#openTasks` から導く
    // （`#closeWorkerWaitWindow` の doc）。委譲した全員
    // から通知を受け切っていたのに `result` が来ないまま閉じた回は
    // `settled: true` になる（`turns` が最後の1回を含まないだけである）。
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
    // **生ログに在る本文を、報告としても渡してから閉じる（#323）。**
    // `#shipArchive()` の後に置いてあるのは、この報告を読んだクローンが
    // すぐ `manager_transcript` で裏を取れるようにするためである。
    this.#flushUnreported(reason, status);
    // **未 push の観測を、`closed` を emit する前に1回取って運ぶ
    // （Issue #1266 候補(2)）。**
    //
    // `schema.ts` の `lastUnpushedWorkObservationSchema` の doc「残る族」が
    // 挙げる3つの呼び出し元（`manager_stop` の断り・`case 'report'`・
    // `case 'tool_use'`）は、どれも「セッションがまだ生きていて、次の
    // ターンか道具の実行が起きたとき」にしか発火しない——枠落ち（429）や
    // 失敗でこのセッションが `closed`（`lost` / `failed`）になる経路では、
    // 一度も呼ばれない。
    //
    // **デーモン側が `closed` を受けてから `pool.unpushedWork()` を呼んでも
    // 手遅れである。** この関数はこの直後で `#onClosed()`（`Host` 側の
    // `#sessions.delete` に繋がる）を同じ同期区間で呼ぶので、デーモンが
    // `closed` を受信してから改めて runner へ問い合わせる頃には、ほぼ確実に
    // セッションが消えていて空振りする。**だから runner が自分で先取りして
    // 運ぶ**（`systemError` / `cgroupEvents`——直下の Issue #1517「最小の形」
    // 1——と同じ形。台帳への書き込みは `manager.ts` の `case 'closed'` が
    // 持つ）。
    //
    // **`FINISH_UNPUSHED_WORK_TIMEOUT_MS` は `manager.ts` の
    // `UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS` と同じ値・同じ理由**
    // （安全側に短く取った未検証の既定値。`manager.ts` 側の doc の
    // 「⚠️ 実測に基づく値ではない」をそのまま継ぐ）。**値を共有する定数には
    // していない**——`manager.ts` が `runner.ts` を import する既存の向き
    // （`tools.ts` が `manager.ts` を import する側なのと同じ形。あちらも
    // 同じ理由で値を重複させている）を守るための重複であって、新しい値の
    // 判断ではない。
    //
    // **`#finishUnpushedWorkFn` は既定で `this.unpushedWork(options)`
    // （本物の `computeUnpushedWork`）を呼ぶ**——テストから差し替えられる
    // （`RunnerSessionOptions.finishUnpushedWorkFn` の doc。フェイクタイマー
    // の下で実 I/O を待つ歯が `readCgroupEventCountersFn` と同じ理由で
    // これも差し替える）。
    //
    // **この呼び出し自体は例外を投げない設計**（`computeUnpushedWork` の
    // doc「この関数自体は例外を投げない」）だが、**それでも `.catch()` を
    // 添えてある**——設計が将来守られなくなっても、この1回の観測の失敗が
    // `#finish()` 自体（＝委譲が終わる経路そのもの）を巻き添えにしないことを、
    // ここの形で保証するため（`#observeUnpushedWorkOnce` の doc と同じ理由）。
    // 取れなかったときは `kind: 'unavailable'` と理由を載せる——欄を省く
    // （＝古い runner）のと混ぜない。
    const unpushedWork = await this.#finishUnpushedWorkFn({
      signal: AbortSignal.timeout(FINISH_UNPUSHED_WORK_TIMEOUT_MS),
    })
      .then((result): FinishUnpushedWorkOutcome => ({ kind: 'ok', result }))
      .catch((error: unknown): FinishUnpushedWorkOutcome => ({
        kind: 'unavailable',
        reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
      }));
    // **「畳んだとき」の1点を、ここで初めて読む（Issue #1517「最小の形」1）。**
    // `#openedCgroupEvents` は構築時（＝「開いたとき」）に読み始めた
    // `Promise` で、ここで初めて await する——構築からここまでの間に
    // 例外は投げない実装（`readCgroupEventCounters` の doc）なので、
    // ここで初めて失敗を気にする必要は無い。`cgroupEventsDeltaOf` が
    // 差分を作れなければ（片方の軸が読めなかった・逆行していた）
    // `undefined` を返し、そのときは欄ごと出さない。
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

  // -------------------------------------------------------------------------
  // 配線 — マネージャーから見た「ユーザー」はクローン
  // -------------------------------------------------------------------------

  /**
   * 許可確認と `AskUserQuestion` をデーモン（＝クローン）へ回す。
   *
   * ここは追加の関門ではない。人間が画面越しに受け取っていた確認が、そのまま
   * クローンへ届くだけである。だから待ち時間に上限を置かない — 止まるのはこの
   * 1件だけで、他は走り続ける。
   *
   * **`permissionMode` が `auto` でもこの配線は外さない。** SDK が確認を降ろして
   * きたとき（`AskUserQuestion` を含む）の行き先はここ1本である。
   */
  async #onPermission(
    permission: AgentPermissionRequest,
    source?: PeerApprovalSource,
  ): Promise<AgentPermissionDecision> {
    const { toolName, input, kind, signal, reason } = permission;
    // 確認を出せている＝セッションは開いて手を動かしている。
    this.#markProgressed();
    // SDK は同じ確認を再送しうる。id を SDK 側の識別子に揃えて、再送では新しい
    // 待ちを積まずに同じ結果を返す（二重に消費されると片方が永久に返らない）。
    // **peer の確認は id に出所を前置する**（マネージャー自身の確認の id と混ざらない）。
    const rawId = permission.requestId ?? randomUUID();
    const id =
      source === undefined ? rawId : `peer:${source.provider}:${source.sessionId}:${rawId}`;
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;
    // **解けた後の再送も同じ扱いにする。** ここを `#pending` だけで見ていたのが
    // 「答えたのに待っていないと言われる」の原因だった（`#resolved` の注記）。
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) return resolved;

    // **分け方（`kind`）は駆動役が決めて渡す**（Claude は `isDaemonAnsweredTool`
    // ——`daemon-answered-tool.ts`、Issue #2173。`name === 'AskUserQuestion'` と
    // 同じ真偽値）。`manager-activity.ts` の `classifyManagerActivity` も同じ分け方を
    // 使うので、判定のコピーを2つ作らない。
    const baseSummary =
      kind === 'question'
        ? describeQuestions(input)
        : `${toolName} の実行許可: ${brief(input)}${reason === undefined ? '' : `\n理由: ${reason}`}`;
    // **出所の印は要約の先頭に必ず付ける**（日誌・待ち・クローンの受信箱のどれにも出る。
    // 旧いデーモンが `source` 欄を落としても、印は本文に残る＝印の無い経路は作らない）。
    const summary =
      source === undefined ? baseSummary : `${peerApprovalMark(source.provider)}${baseSummary}`;
    // **ここで1度だけ取る（#334）。** `state()` も `ask` イベントもこの値を
    // そのまま運ぶだけにする——経路ごとに取り直すと、同じ確認が経路によって
    // 違う「待ち始めた時刻」を名乗る。
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
      // **`decideAnswer` が決定の唯一の実装である（#322）。** `Session#answer()`
      // が同じ関数を同じ引数（`kind` / `decision` / `message`）で呼んでいるので、
      // クローンへ即座に返す値（`Pool#send` の `answered.decision`）と、SDK へ
      // 実際に返る `behavior` は常に同じ計算から出る。**この呼び出しは変えない**
      // ——ここが変わると `Session#answer()` との一致（#322）が壊れる。
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      // **畳む（`withdrawn`）・中断（`aborted`）の経路では、`question` も
      // deny で返す（Issue #1593）。** `decideAnswer` は「クローンが答えた」
      // ときの計算のままにしておき、ここで別枠として上書きする——`kind` が
      // `question` のとき `decideAnswer` は常に `allow` を返す（doc のとおり）
      // ので、`withdrawn` / `aborted` を見ずに `decision` だけで判定すると、
      // 人間が答えていない問いに `withAnswers(input, answer.message)`
      // （畳む・中断の理由の文言）が「答え」として乗ってしまう——これが
      // #1593 の症状そのものである。**判定は `settle` の値が運ぶ経路の印
      // だけで行い、`message` の文字列は嗅がない**（AGENTS.md の同じ考え方）。
      // `kind === 'permission'` のときは `decision` が既に `'deny'` なので
      // ここは実質何も変えない（`#settleAll` も `onAbort` も明示の
      // `decision:'deny'` を渡している——`unreadable` も常に false になる、
      // 明示の decision が優先されるため）。
      const teardown = answer.withdrawn === true || answer.aborted === true;
      // **`unreadable`（issue #1827/#1837）: SDK へ返る拒否文にも、読み取れ
      // なかったので拒否したことを載せる。** teardown 側（畳み・中断）は
      // クローンの回答そのものではないので対象外——`unreadable` はここでは
      // 常に false（上のコメントのとおり）だが、念のため teardown も明示で
      // 外している。
      const denyMessage =
        !teardown && unreadable ? unreadableDenyMessage(answer.message) : answer.message;
      const outcome: AgentPermissionDecision =
        teardown || decision === 'deny'
          ? { behavior: 'deny', message: denyMessage }
          : kind === 'question'
            ? { behavior: 'allow', updatedInput: withAnswers(input, answer.message) }
            : { behavior: 'allow' };
      // **解けたことを覚えるのはここ1箇所。** 回答でも中断でも停止でも、解けた
      // 事実は同じように残る（経路ごとに覚え忘れる隙を作らない）。**再送されて
      // もここは再実行されない**（`#resolved` から即返す分岐が上に在る）ので、
      // 一度確定した deny は再送のたびに同じ deny のまま返る。
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
      // **待ち行列から自分を外すのは settle の責任**。呼び出し側任せにすると、
      // 中断で解けた1件が行列に残り、次に届いた言葉を食い潰す。
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

    // マネージャー側で中断されたら宙吊りにしない。
    // **`aborted: true` を渡すのはここだけである（Issue #1593）。** `withdrawn`
    // と同じ形の、経路を運ぶだけの印——`settled` イベントには載せない
    // （`request.settle` は `withdrawn` だけを見る）。ここが立てるのは
    // `answered.then()` が `question` を deny へ倒すための材料である。
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

  /**
   * 分類器（auto mode classifier）にその場で拒否された道具の呼び出しへ、
   * クローンの判断で「1回だけの許可」を出す（issue #1105 P1）。
   *
   * ## 何をするか・何をしないか
   *
   * SDK の `PermissionDenied` フックが返せるのは `retry?: boolean` の1個
   * だけ——「もう一度試してよい」とモデルの文脈に一文足すだけで、実行その
   * ものを許可する力は持たない。**このメソッドがすることは2つに分かれる。**
   *
   * 1. `#onPermission` とほぼ同じ形の待ち行列を積み、クローンの答え
   *    （`allow`/`deny`）を待つ——`ask`/`settled` イベント・`#pending`/
   *    `#resolved`・`decideAnswer` をすべて共有する（既存の許可確認と同じ
   *    経路。issue #1105 本文の設計判断1）。**`#onPermission` の実装を
   *    直接は再利用していない**——あちらは最終的に `PermissionResult`
   *    （SDK の `canUseTool` へ返す形）を組み立てる関数で、ここは
   *    `retry?: boolean` へ写す別の形を組み立てる。両方に手を入れると
   *    デリケートな挙動（`extra.requestId` の再送・`withdrawn`/`aborted`
   *    の扱い）を壊しかねないため、あえて並行した実装にしてある。
   * 2. `allow` なら `#oneShotAllows` へ控えて `retry: true` を返す。撃ち直しの
   *    実際の許可は `#onPreToolUse`（`#consumeOneShotAllow`）が担う。`deny`
   *    なら控えず、クローンの一言を `note`（P0 と同じ経路）で降ろす。
   *
   * ## 一致の鍵が作れない入力
   *
   * `record.toolName` が無い、または `matchInputOf(record.toolInput)` が
   * `undefined`（畳めない）ときは、クローンへの確認そのものを上げず
   * `no-retry` で終える——一致させる鍵が無い以上、たとえクローンが allow と
   * 答えても撃ち直しを安全に特定できない（issue #1105 の「入力が1文字違えば
   * 返さない」という要求を、作れない鍵にまで緩めない）。
   *
   * **鍵は入力全体（`matchInputOf`）で作る。`command` の文字列だけではない**
   * （issue #1768）。以前は `rawLineOf`（`command` 欄があればそれだけを返す、
   * 表示用の関数）を鍵にも流用していたため、`command` が同じで
   * `run_in_background` 等ほかの欄だけが違う撃ち直しにまで、この許可が
   * 及んでいた。表示（`buildDenialInputHead`。下の `inputHead`）は今までどおり
   * `rawLineOf` を土台にする——変えたのは鍵の材料だけである。
   *
   * ## フックの持ち時間切れ（issue #1105 本文の設計判断5）
   *
   * `record.signal`（SDK の `options.signal`）が落ちたら、**安全側（`no-retry`）
   * で確定させ、`#pending` からもその場で外す。** これにより:
   *
   * - 遅れて届いたクローンの `allow` は**構造的に**捨てられる——`#pending`
   *   から既に外れているので、`manager_send` はこの `requestId` を
   *   「もう解けている」として扱う（`Session#answer()` の `find` が外れる）。
   *   「捨てるか控えるか」を実行時の分岐で選んでいるのではなく、settle した
   *   時点で選択の余地そのものを無くす形にした——安全側という既定を、後から
   *   の競合状態に依存せずに保証するためである
   * - **次の同じ入力のために控え直す、という道は採らない。** 時間切れが起きた
   *   時点でクローンはまだ答えていない（答えていれば時間切れの前に解けて
   *   いる）ので、「控える中身」がそもそも存在しない
   *
   * **時間切れは `settled.withdrawn` とは別の事実として `note` で残す。**
   * `withdrawn` は `#settleAll`（セッション全体を畳むときに未決の確認を
   * 一括で解く経路）専用の印であって、ここ（1件のフックの持ち時間切れ）とは
   * 発生源が違う——同じ印を使い回すと、`manager.ts` の `case 'settled'` が
   * 「CLI に一度も届かなかった」と「フックの時間切れで安全側に倒れた」を
   * 区別できなくなる。
   */
  async #onPermissionDenied(
    record: AgentPermissionDeniedRecord,
  ): Promise<AgentPermissionDeniedDecision> {
    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const toolName = record.toolName;

    // **入口の1行（issue #1766）。** PermissionDenied フックが呼ばれたこと自体を
    // 日誌に残す（マネージャー本人の拒否で確認が届かない原因が、フックが来て
    // いないのか呼ばれて落ちたのかを区別するため）。返り値・ask・順序は変えない。
    // 理由は先頭だけ（改行は潰す）。tool_input は載せない。
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

    // **既存の許可確認と同じ重複排除**（`#onPermission` と同じ理由——SDK は
    // 同じ確認を再送しうる）。
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

    // **`withdrawn` を型から落とさない（issue #2448）。** `#settleAll` は
    // `#pending` のすべてに `withdrawn: true` を渡す。以前はここの型が
    // `withdrawn` を持たず、`request.settle` も `settled` へ載せなかったので、
    // 畳みで解けた確認が取り下げ（#1586）として日誌に残らず、下の deny の
    // note が「クローンが許可を出さなかった」とクローンの判断として書いていた。
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
      // **`decideAnswer` を共有する**（#322 と同じ考え方——`#onPermission` と
      // 別々に判定を書くと、runner.ts 側が変わったときに黙ってずれる）。
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      // **`unreadable`（issue #1827/#1837）は `aborted`（フックの持ち時間
      // 切れ。`onTimeout` が明示の `decision:'deny'` を渡す）・`withdrawn`
      // （畳み。`#settleAll` が明示の `decision:'deny'` を渡す）とは別枠——
      // 明示の decision がある回は `unreadable` が常に false なので、ここで
      // 二重に足しても実害は無いが、意図を明示するために分けて書く。
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
        // **`#onPermission` の `settle` と同じ形で `withdrawn` を載せる（issue
        // #2448）。** `manager.ts` の `case 'settled'` が取り下げ（#1586）の行を
        // 日誌へ書くのは、これが在るときだけである。
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

    // **フックの持ち時間切れ（既定 600000ms。静的な実測）を安全側で確定させる**
    // （このメソッドの doc「フックの持ち時間切れ」）。
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

    // **畳みで解けた確認は、クローンの判断として書かない（issue #2448）。**
    // クローンは答えていない。取り下げの事実は上の `settled.withdrawn` が
    // 運び、`manager.ts` の `case 'settled'` が日誌へ1行残す（#1586）ので、
    // ここで note を重ねない——`#onPermission` も畳みの回に note を出さない。
    // 下の deny の分岐より前に置くのは、`#settleAll` が明示の
    // `decision:'deny'` を渡すので、ここを抜けると「出さなかった」に落ちるため。
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

    // 先に、ほかの期限切れ・未使用の許可を note へ降ろす（遅延評価。動作は変えない）。
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

  /**
   * `Bash` へ渡すコマンドが「無限に待つだけの形」なら、**確認に上げる**
   * （#894 段1・案(A)。既定の扱いは #2884 で deny から ask へ変えた）。
   *
   * ## なぜここだけが判断を返す
   *
   * このクラスの他のフック（`#onPostToolUse` 以下・`#onSubagentStop` /
   * `#onStop` 等）はすべて観測専用で、`{ continue: true }` を返すだけである。
   * ここは違う —— #894 が実測したのは「システムプロンプトへ逐語で書いても
   * 守られない」ということそのものなので、対策を「もっと強く書く」側へは
   * 倒さず、**機械の門**へ倒す（Issue #894 の候補(a)）。判定の
   * 中身（何を弾き、何を通すか）は `bash-wait-guard.ts` の
   * `inspectBashCommand` の doc を見よ —— ここは SDK への配線と、弾いた
   * ことを日誌へ残す役目だけを持つ。
   *
   * ## 門に当たったときの扱いは設定で決まる（issue #2884）
   *
   * マネージャーは Claude Code で、クローンはそれを使う人間である（オーナーの回答 2026-10-05）。
   * 人間は Claude Code で、確認に上がってきた操作を自分の判断で許可できる。最初の実装（#894）は
   * 確認に上げずに **deny** を返し、誰も開けられなかった（north_star 禁止2「方針は設定で
   * 開けられなければならない」に反する）。いまは `ALTEROID_BASH_GUARD`（`bash-guard-mode.ts`）が決める:
   *
   * - `ask`（既定）: `permissionDecision: 'ask'` を返す。SDK が `canUseTool` へ流し、`#onPermission` が
   *   クローンへ上げる（理由は `decisionReason` として summary に載る）。クローンは `manager_send` の
   *   `decision` で許可できる。**作業者（サブエージェント）の Bash でも同じ**（本物の本体で確かめてある。
   *   `real-cli-pre-tool-use-ask.test.ts`）
   * - `deny`: 従来どおり止める（確認に上げない）。人間が選んだときだけ
   * - `off`: 判定器を呼ばない
   *
   * ## `Bash` 以外・`command` が文字列でない入力は素通しする
   *
   * `inspectBashCommand` は `Bash` の呼び出しだけを見る判定器であって、
   * 他のツールの入力の形を知らない。**ここで弾くのは `Bash` だけである** —
   * 他のツールまで巻き込むと、この PreToolUse が「何でも弾きうる門」に
   * 見えてしまい、地雷表「確認が要る行為の一覧を作る」に近づく。
   *
   * ## 判断は中立の `{ kind: 'ask' }`（既定）か `{ kind: 'deny' }`（設定）で返す
   *
   * `decision: 'block'`（セッション全体を止める側の口）ではなく、この
   * ツール呼び出し1件だけを拒否する口を使う（SDK の型定義。逐語は
   * `claude-provider.ts` の `wrapPreToolHook` の doc）。**中立の判断
   * （`AgentPreToolDecision`）を返す**（#486 中立の口の3本目）——SDK の
   * `hookSpecificOutput.permissionDecision: 'deny'` へ包み直すのは
   * `claude-provider.ts` の `wrapPreToolHook` の仕事である。マネージャーは
   * 拒否の事実と理由（代替の提示つき）を受け取り、そのターンを続けられる。
   *
   * ## 弾いたら escalate しない note を1本出す
   *
   * 依頼者（クローン）が日誌から拾えるように、弾いたこと自体を残す。
   * **`escalate` は立てない** —— これは「作業者が動けなくなった」
   * （`#onSubagentStop` の `escalate: true`）のような危険の通知ではなく、
   * ツール呼び出し1件がその場で拒否に置き換わっただけの経過だからである。
   *
   * ## 冒頭で全道具の入力の先頭を控える（issue #1105）
   *
   * `#capturePreToolInputHead` は、この直後の `Bash` 限定の早期返却より前に
   * 呼ぶ——分類器（器の auto mode classifier）はどの道具でも拒否しうるので、
   * ここを `Bash` に絞ると `Edit` 等の拒否には控えが一切乗らない
   * （kiritan の実測、issue #1105 本文）。控えは `#noteDenial` が
   * `system/permission_denied`（`tool_input` を持たない走行中の合図）へ
   * `inputHead` を足すための材料になる。
   *
   * ## 末尾で1回だけの許可を消費する（issue #1105 P1）
   *
   * `bash-wait-guard` の deny（直上）より**後**に置く——`ALTEROID_BASH_GUARD=deny` では、
   * クローンの1回だけの許可で門（#894）を上書きしない。`ask`（既定）では門は確認であって
   * 禁止ではないので、クローンが同じ呼び出しに出した1回だけの許可がそれを開ける（#2884。
   * 関数の最後で `ask` と突き合わせる）。`Bash` が弾かれなかった回・`Bash` 以外の全道具が
   * ここへ落ちる。
   *
   * ## 判定の周りの例外で deny を消さない（issue #1960）
   *
   * このフックが例外で終わると、SDK は CLI へ error を返し、CLI はそれを
   * 「ブロックしない」として通常の許可の流れへ戻す（`hook_callback_failed` →
   * `blocked: false`。issue #1960 の実測）。マネージャー・作業者のセッションでは、
   * それはツールがそのまま走ることを意味する＝**ガードが素通りになる。** そこで:
   *
   * - 入力の頭の控え（`#capturePreToolInputHead`）と note の送り出し（`#emit`）は
   *   観測のための副作用なので、失敗しても判定を止めない（stderr へ1行だけ残す）
   * - `Bash` の判定（`inspectBashCommand`）そのものが投げたら、確認（ask）へ倒す。
   *   上がらずに止めて誰も開けられない形にしない（#2884）。`deny` の設定でだけ止める
   */
  async #onPreToolUse(record: AgentPreToolRecord): Promise<AgentPreToolDecision> {
    this.#tryObservation('PreToolUse の入力の頭の控え', () => {
      this.#capturePreToolInputHead(record);
    });

    // **門に当たった Bash を、確認に上げる（`ask`、既定）か、止める（`deny`）か、掛けない（`off`）か**
    // は `ALTEROID_BASH_GUARD` が決める（issue #2884。`bash-guard-mode.ts`）。`ask` で返した呼び出しは
    // この関数の最後で、クローンの1回だけの許可を見たうえで返す（`guardAsk`）。
    let guardAsk: { reason: string } | undefined;
    if (record.toolName === 'Bash') {
      const toolInput = record.toolInput as
        { command?: unknown; run_in_background?: unknown } | null | undefined;
      const command = toolInput?.command;
      if (typeof command === 'string') {
        // **`run_in_background` はコマンド文字列に現れない。** 背景へ置いた
        // ことを判定器へ渡せる経路はここだけである（`bash-wait-guard.ts` の
        // `isBackgroundedGhRunWatch` の doc）。**`=== true` で受ける** ——
        // 欠けていても形が崩れていても `false`（＝前景）になり、通す側へ倒れる。
        let verdict:
          ReturnType<typeof inspectBashCommand> | { blocked: true; form: string; reason: string };
        try {
          // **本番デプロイの起動（release-prod）は、`off` でも確認に残す**（`bash-release-prod-guard.ts`）。
          // 待つ形の門（`inspectBashCommand`）だけが `off` で外れる。
          const releaseProd = inspectReleaseProdDispatch(command);
          verdict = releaseProd.matched
            ? { blocked: true, form: releaseProd.form, reason: releaseProd.reason }
            : this.#bashGuard === 'off'
              ? { blocked: false }
              : inspectBashCommand(command, {
                  backgrounded: toolInput?.run_in_background === true,
                });
        } catch (error) {
          // 判定できなかった呼び出しは、素通しにしない（issue #1960）。**倒れる先は確認である**
          // （issue #2884。上がらずに止めて誰も開けられない形にしない）。`deny` を選んだ人にだけ止める。
          // reason は CLI・モデル側へ出る。伏せ字を通す（issue #2559。#2509 と同じ扱い）。
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
          // `off` でここに来るのは本番デプロイの起動だけで、確認に残す（`deny` の設定でだけ止める）。
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

    // **ガードの deny より後に置く（弾いた呼び出しは Post も拒否の合図も来ないので、置くと片付かない）。作業者の道具だけ、長く実行中かの見張りを置く**（Issue #2725）。Pre では何も送らない。
    this.#tryObservation('作業者の道具の見張り', () => {
      if (record.agentId === undefined || record.toolUseId === undefined) return;
      this.#workerTools.begin({
        agentId: record.agentId,
        actor: `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`,
        tool: record.toolName ?? '(不明)',
        toolUseId: record.toolUseId,
      });
    });

    // `#consumeOneShotAllow` は `deny` を返さない（戻り値の型で塞いである）。だから書き換えを
    // `deny` に付けることは型の上で起きない（#2119。以前は `|| decision.kind === 'deny'` の
    // 守りを書いていたが、実行されない分岐で、変異で外しても歯が赤にならなかった）。
    // 将来 `deny` を返すように変われば、`tsc` がここで落ちる。
    const decision = this.#consumeOneShotAllow(record);
    const rewrite = this.#planBashToolTimeoutRewrite(record);
    // **門の確認（`ask`）は、クローンの1回だけの許可が在れば、その許可が開ける**（issue #2884）。
    // 許可はクローンが同じ呼び出しに明示して出したもので、確認に上げた答えと同じ重さである
    // （`deny` の設定では、これまでどおり門が先に効く＝上の `return` で終わっている）。
    const resolved: Exclude<AgentPreToolDecision, { kind: 'deny' }> =
      guardAsk !== undefined && decision.kind === 'continue'
        ? { kind: 'ask', reason: guardAsk.reason }
        : decision;
    if (rewrite === undefined) return resolved;
    return { ...resolved, rewrite };
  }

  /**
   * `Bash` のツールの `timeout` 引数が、コマンドの中の `timeout <継続時間>` より
   * 短ければ、引き上げた入力を返す（issue #2088。判定は `bash-tool-timeout.ts`）。
   *
   * **弾かない。** 入力の `timeout` の欄だけを引き上げ、他の欄は1文字も変えない。
   * 引き上げたことは日誌の note（`形=bash-tool-timeout-raised`）と、打った側への
   * 一文（`rewrite.note`）の両方に残す——書き換えを観測から消さないため。
   *
   * 判定が投げても呼び出しは止めない（書き換えは安全弁ではなく便宜なので、
   * 倒れる先は「書き換えない」）。stderr へ1行だけ残す。
   */
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

  /**
   * 観測のための副作用（控え・note）を、判定を止めずに走らせる（issue #1960）。
   * 失敗は stderr へ1行だけ残す——ここで投げ直すと `#onPreToolUse` が例外で終わり、
   * ガードの deny が CLI へ届かなくなる。
   */
  #settleWorkerTool(toolUseId: string): void {
    this.#tryObservation('作業者の道具の見張りの片付け', () => {
      this.#workerTools.settle(toolUseId);
    });
  }

  #tryObservation(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      process.stderr.write(`alteroid: ${label}が失敗した（判定は続ける）: ${reasonOf(error)}\n`);
    }
  }

  /**
   * クローンが `#onPermissionDenied` で出した「1回だけの許可」（issue #1105
   * P1）を、同じ `(actor, tool, 入力の完全一致のダイジェスト)` であれば
   * 1回だけ使う。
   *
   * ## 呼び出し順序: `deny` の設定では、門を上書きしない
   *
   * `#onPreToolUse` からは、`bash-wait-guard`（#894）の deny が**確定した後**
   * にしか呼ばれない。⟹ `ALTEROID_BASH_GUARD=deny` では、待つだけの `Bash` はクローンの
   * 許可があっても通らない——issue #1105 本文の設計判断3「既存の `PreToolUse` の deny は、
   * 1回限りの許可より先に効かせる」をこの順序そのもので担保する。
   *
   * **既定（`ask`）では、門は確認である**（#2884）。`#onPreToolUse` は門の `ask` を持ったまま
   * ここを呼び、許可が在れば `allow` を返す（クローンが同じ呼び出しに明示した許可は、確認に上げた
   * 答えと同じ重さである）。許可が無ければ `ask` のまま返る。
   *
   * ## 全道具が対象（`Bash` に絞らない）
   *
   * 分類器は `Bash` 以外（`Edit` / `Write` / `NotebookEdit` 等）にも掛かる
   * （issue #1105 の静的な実測、2026-09-26 のコメント）。`#onPermissionDenied`
   * はどの道具の拒否でも許可を出せるので、ここで `Bash` に絞ると撃ち直しの
   * ほとんどが通せなくなる。
   *
   * ## 一致の鍵は表示用の伏せ字済みの値ではない
   *
   * `matchInputOf(record.toolInput)` の完全一致のダイジェストを使う——
   * `buildDenialInputHead`（伏せ字つき・160字に切る、表示専用）を鍵にすると、
   * 先頭160字が同じで残りが違う別の入力が誤って一致しうる（issue #1105 の
   * 要求「入力が1文字違えば返さない」）。
   *
   * **⚠️ 以前は `rawLineOf(record.toolInput)` を鍵にしていた（issue #1768 で
   * 修正）。** `rawLineOf` は表示用の関数で、`command` という文字列欄を持つ
   * 入力からは**その欄だけ**を返し、ほかの欄（`run_in_background` /
   * `timeout` / `dangerouslyDisableSandbox` 等）を捨てる。`Bash` の入力は
   * まさにこの形なので、`command` が同じでほかの欄だけが違う撃ち直し
   * （前景/背景・サンドボックスの有無など、実行の意味論を変える差分）にまで
   * 1回だけの許可が及んでいた——「入力が1文字違えば返さない」という上の要求
   * を満たしていなかった、許しすぎる側の穴。`matchInputOf` は入力の**全欄**
   * （キー順に依らない正規化）を鍵の材料にすることでこれを塞ぐ。
   *
   * ## 使い切る・期限切れは使わない
   *
   * 一致した鍵は `get` の直後に必ず `delete` する——一致してもしなくても
   * 1回で終わり（issue #1105 本文の設計判断3）。寿命
   * （`ONE_SHOT_ALLOW_TTL_MS`）を過ぎていたら `allow` を返さず、分類器の
   * 判定へそのまま委ねる（安全側）。**ちょうど寿命が尽きたミリ秒も「過ぎた」
   * 側に含める**（issue #1768。以前は `<` で比べていたため、この1点だけ
   * 「まだ有効」に倒れていた——許しすぎる側の穴だった）。
   */
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
    // 今回の鍵以外で、撃ち直されないまま期限が切れた許可を note へ降ろす。今回の鍵は
    // 下の既存の分岐（撃ち直しが遅れて来た）が扱う。ここは帳面を掃除して note を出すだけで、
    // 今回の鍵の判定には触れない。
    this.#noteUnusedExpiredOneShotAllows(key);
    const grant = this.#oneShotAllows.get(key);
    if (grant === undefined) return { kind: 'continue' };
    // 使い切る。一致しても1回だけ。
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

    // **#1603 と同じ形の検出材料を控える**（`#noteDenial` が引く）。
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

  /**
   * 1回だけの許可が**撃ち直されないまま**期限切れになったことを、note に残す
   * （#2352 の点3）。`#consumeOneShotAllow` の「撃ち直しが遅れて来た」note とは
   * 別の事実である（こちらは撃ち直しが来ていない）。
   *
   * **遅延評価である（タイマーは置かない）。** `#consumeOneShotAllow`（あらゆる
   * 道具の `PreToolUse`）と `#onPermissionDenied` の入口で、期限を過ぎた鍵を
   * 捨てて1件ずつ note を出す。タイマーを置かないので、セッションの終了・畳みで
   * 片付け漏れる物が無い。**限界：次の道具呼び出しか次の拒否が来ない限り
   * 観測されない**（担い手が黙ったまま・畳まれた場合は出ない）。
   *
   * 動作は変えない：消すのは既に `expiresAt <= now` で `allow` を返せない鍵だけで、
   * 鍵・TTL・retry・consume の条件は同じ。`except` は今回 consume しようとしている鍵。
   */
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

  /**
   * `PreToolUse` が見た入力の先頭を、拒否より前に控える（issue #1105）。
   *
   * **全道具で行う。** 直前の `#onPreToolUse` の `Bash` 限定の早期返却は
   * `bash-wait-guard.ts` の判定にだけ掛かるもので、この控えには掛からない
   * ——分類器はどの道具でも拒否しうる。
   *
   * **`record.toolUseId` が無ければ何もしない。** 鍵が無ければ後で
   * `#noteDenial` から引けない（旧い provider の写しがこの欄を持たない回。
   * `AgentPreToolRecord.toolUseId` の doc）。
   *
   * **控えるのは伏せ字済み・160文字以内の先頭だけ**
   * （`buildDenialInputHead`。`denial-input-head.ts`）。生の入力は
   * 保持しない——`denial-shape.ts` の `DeniedRecord` が「入力そのものを
   * 覚えない」のと同じ理由（忘れるまでの間ずっと鍵が入りうる文字列を
   * 抱えることになり、`onForget` の日誌行へ滲み出る経路も増える）。
   */
  #capturePreToolInputHead(record: AgentPreToolRecord): void {
    if (record.toolUseId === undefined) return;
    const preview = buildDenialInputHead(record.toolInput, this.#env);
    if (preview === undefined) return;
    this.#preToolInputHeads.set(record.toolUseId, preview);
  }

  /**
   * マネージャーと作業者の全ツール実行をデーモンの日誌へ（監査）。
   *
   * **併せて、背景タスクの所有者を控える**（#570。`#backgroundTaskOwners`）。
   * ここでしか取れない —— `SubagentStop` の `background_tasks[]` に所有者の欄が
   * 無く、作業者の生ログ側にも構造化された形では出ないためである（実測: 生ログ
   * に出るのは `Command running in background with ID: …` という**自由文**だけ）。
   *
   * **成功で決着した呼び出しぶんの入力の先頭も、ここで帳面から消す**
   * （`#preToolInputHeads`。issue #1105）——控えっぱなしにしない。
   *
   * **`#oneShotAllowedToolUses` も同じ理由で消す**（issue #1105 P1）。
   * `PreToolUse` は実行より前にしか発火しないので、成功で終わった呼び出しに
   * 後から拒否が届くことはない。
   */
  async #onPostToolUse(record: AgentToolAuditRecord): Promise<AgentContextOutcome> {
    if (typeof record.toolUseId === 'string') {
      this.#preToolInputHeads.delete(record.toolUseId);
      this.#oneShotAllowedToolUses.delete(record.toolUseId);
      this.#settleWorkerTool(record.toolUseId);
    }
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    // 道具が動いた＝このセッションは生きている（生ログからの作り直しはもうしない）。
    this.#markProgressed();

    // **`worker_wait.toolless` の材料。** マネージャー自身の道具だけを数える
    // （`hook.agent_id` が付いているものは作業者の分なので混ぜない）。
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

    // マネージャー自身の呼び出しだけを見る（`Task` を呼ぶのはマネージャーなので
    // `agent_id` が付かない。#901）。**道具の種類は問わない** — 同期の `Task`
    // 結果（`#annotateCutOffWorker`）はこの呼び出し自身の `tool_response` を見るが、
    // `#pendingCutOffNotifications`（`task_notification` 経由）はどの道具の
    // 呼び出しにでも相乗りする（先に届いた別の完了通知を配達するだけなので、
    // いまの `tool_response` の中身とは無関係）。
    const additionalContext =
      record.agentId === undefined ? this.#annotateCutOffWorkers(record.toolResponse) : null;
    if (additionalContext === null) return { kind: 'continue' };
    return { kind: 'addContext', text: additionalContext };
  }

  /**
   * マネージャー自身の次の `PostToolUse` に載せる #901 / #1554 の注記をまとめる。
   * 何も無ければ `null`。
   *
   * 3つの経路を両方（すべて）見て、在るものだけ連結する（同じ呼び出しの結果に
   * 複数載っても壊れない——1回のツール呼び出しの背後で、複数の作業者がそれぞれ
   * 別の理由で打ち切られていることはありうる）:
   *
   * 1. **同期の `Task`** — この呼び出し自身の `tool_response` が
   *    `status:'completed'` かつ `agentId` が `RunnerCutOffWorkers` に控えられて
   *    いる（`#annotateCutOffWorker`）
   * 2. **背景委譲（`async_launched`）** — `task_notification` で先に届いていて
   *    「未配達の打ち切り注記」として控えられている分
   *    （`#drainPendingCutOffNotifications`）。**道具の種類・`tool_response` の
   *    中身を問わない** — 先に届いた別の完了通知を配達するだけだからである
   * 3. **打ち切った作業者が残した背景処理そのものの完了（#1554）** —
   *    `task_notification` の `output_file` を配達する
   *    （`#drainFinishedBackgroundTaskOutputs`）。同じく道具の種類を問わない
   */
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

  /**
   * 打ち切られた瞬間に残っていた背景処理の一覧を、人間が読める行へ変換する
   * （Issue #1554。`#annotateCutOffWorker` / `#drainPendingCutOffNotifications`
   * の両方が使う）。1件も控えていなければ空配列。
   *
   * **`#renderSubagentStopTaskLines` を使い回さない。** あちらは
   * `BackgroundTaskSummary`（`unknown` のまま渡された生の要素）を読むが、
   * こちらは `RunnerCutOffWorkers.cutOffTasks` が返す、既に防御的に読み
   * 切ってある {@link CutOffBackgroundTaskSummary}（`id` / `command?` の2欄
   * だけ）を読む——型も出所も違うので、同じ関数にしない。
   */
  #renderCutOffTaskLines(agentId: string): string[] {
    return this.#cutOffWorkers
      .cutOffTasks(agentId)
      .map(
        (task) => `- id=${task.id}${task.command === undefined ? '' : ` command=${task.command}`}`,
      );
  }

  /**
   * 続きを頼む案内（Issue #1554）。上限に達した note と、打ち切りが判明した
   * 注記（#901 の2経路）と、背景処理そのものの完了（#1554）の**全部**で
   * 同じ文面を使う——マネージャーが読む場所によって案内が変わると、どの
   * 場所で読んでも同じ手を思い出せるという利点が消える。
   *
   * **`SendMessage` は遅延読み込みの道具なので、まず `ToolSearch` で読み
   * 込む必要があると明記する**（手順1 の調査結果）。**即時に届くとは
   * 書かない** — 届くのはその作業者の次の道具の区切りであり、作業者は
   * 読む前に動くことがある（同じ調査結果の留保）。
   */
  #resumeGuidance(agentId: string): string {
    return (
      `続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから ` +
      `agentId=${agentId} へ送ること——同じ文脈のまま再開できる。` +
      '届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。'
    );
  }

  /**
   * 打ち切った作業者が残した背景処理そのものの完了（Issue #1554）を、
   * マネージャーへ全件配達する。1件も無ければ `null`。**配達経路は2つ**
   * ——マネージャーが走っているときは次の道具呼び出し（`#annotateCutOffWorkers`）、
   * 止まっているときは `#wakeForFinishedBackgroundTaskOutputs` の `push()`。
   * どちらも取り出し＝消費なので、二重には届かない。
   *
   * `#drainPendingCutOffNotifications` と同じ形——note は配達時点で1本ずつ
   * 出し（日誌に残す）、マネージャーへ渡す文面は連結して返す。
   */
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

  /**
   * `Task` の結果が、背景処理の待ちの上限（30分）で打ち切った作業者のものなら、マネージャーへ
   * 渡す注記を返す（#901）。そうでなければ `null`。**同期の `Task`
   * （`status:'completed'`）の経路。** `async_launched` の経路は
   * `#drainPendingCutOffNotifications` が持つ。
   *
   * **結び目は `tool_response.agentId`（`AgentOutput` の欄）と `SubagentStop` の
   * `agent_id` である。** フックの `agent_id` どうしでは結べない（`Task` の
   * `PostToolUse` はマネージャー側で発火するので `agent_id` が付かない。#901 本文）。
   *
   * ⚠️ **2つの id が同じ値であることは、本物の `query()` を流して測ってはいない。**
   * SDK バイナリ（`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.281`）を静的に
   * 走査し、`local_agent` タスクの登録経路でどちらも同じソース変数であることを
   * 確認した（`RunnerCutOffWorkers` の `#pendingCutOffNotifications` の doc に
   * 逐語で残してある）。加えてマネージャーの器での実行時観測1件（起動時の
   * `agentId` と、後で届いた `task_notification` の `task_id` が同一だった）
   * とも整合する。**それでも `query()` そのものを実行した確認ではない**
   * ——違っていれば注記が出ないだけで、挙動は今までと同じ側へ倒れる。
   */
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
      // **Issue #1554: 打ち切られた瞬間に残っていた背景処理を id / command で
      // 名乗る。** 出力の在り処はこの時点では分からない——`task_notification`
      // が届いた後で `#drainFinishedBackgroundTaskOutputs` が別に配達する。
      ...this.#renderCutOffTaskLines(agentId),
      '出力の置き場所は、処理が終わったら知らせる（#1554）。',
      this.#resumeGuidance(agentId),
    ].join('\n');
  }

  /**
   * `RunnerCutOffWorkers` の「未配達の打ち切り注記」を全件配達する（#901。
   * `async_launched` の経路）。1件も無ければ `null`。
   *
   * **note はここ（配達時点）で1本だけ出す。** `#onTaskNotification` が控えた
   * 時点では出さない——既存の `#annotateCutOffWorker` の note（「Task の結果に
   * 注記した」）が「実際にマネージャーへ渡す注記へ組み込んだ」ことを表す過去形
   * であり、控えただけの段階でこれと同じ文言を出すと「もう注記した」と読めて
   * しまう。控えた事実そのものは、打ち切りの瞬間に `#onSubagentStop` が
   * 無条件で出す `stall` の note（`outcome: 'limit_reached'`）が既に日誌へ
   * 残しているので、ここで出さなくても日誌から消えるわけではない。
   */
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
          // Issue #1554: 同上（`#annotateCutOffWorker` と同じ2行）。
          ...this.#renderCutOffTaskLines(agentId),
          '出力の置き場所は、処理が終わったら知らせる（#1554）。',
          this.#resumeGuidance(agentId),
        ].join('\n'),
      )
      .join('\n\n');
  }

  /**
   * 失敗・中断した道具呼び出しの合図（`PostToolUseFailure`）を拾う（Issue #929）。
   *
   * **`#onPostToolUse` と排他である**（`#buildOptions` の `onPostToolUseFailure`
   * の doc — clone.ts 側と同じ、出荷済みの SDK 実行体を実測して確認した排他
   * 分岐。Issue #924）。⟹ 1回の道具呼び出しにつき、このハンドラと
   * `#onPostToolUse` のどちらか一方だけが呼ばれる。
   *
   * ## なぜ `tool_use`（`outcome` 付き）ではなく `note` か
   *
   * `clone.ts` の `#journalToolUseFailure` は `tool_use` に `outcome` /
   * `error` を足して残す。**ここではその形を写していない。** 理由は
   * `RunnerEvent`（`runner-protocol.ts`）の `tool_use` を経由する先——
   * 旧 daemon の `runnerEventSchema`——が **strict ではなく、未知の欄を
   * 黙って落とす**ことにある（#929 の実測）。runner と daemon は別々に
   * デプロイされ、入れ替わる順序は保証されない。⟹ 新 runner がこの回に
   * `outcome: 'failed'` を足した `tool_use` を送っても、旧 daemon がまだ
   * 動いていれば `outcome` は黙って落ち、**この回は「成功した」`tool_use`
   * と区別が付かない形で日誌に残る。** 失敗を成功の顔で記録するのは、
   * 1件も記録しないより悪い——後から読む側が「この道具は成功した」と
   * 誤って信じる。
   *
   * **⟹ だから型（`runner-protocol.ts` の `tool_use`）は変えず、別の種別
   * （`note`）で出す。** `note` はもともと自由文の `text` 欄を持ち、
   * 旧 daemon の `case 'note'`（`manager.ts`）もそのまま日誌へ落とす経路が
   * 在る——新しい欄を足す必要が無い。`text` の先頭を固定の接頭辞
   * `TOOL_USE_FAILURE_NOTE_PREFIX` にして、後から機械的に拾えるようにする。
   *
   * **代償**: この形では、失敗した道具呼び出しは日誌の `tool_use` としては
   * 数えられない（`note` として残る）。`journal-search.ts` 等が `tool_use`
   * の件数で「自分で手を動かした回数」を数える場所からは、この回が漏れる。
   *
   * **(a)（`tool_use` に `outcome`/`error` を足す）へ移ってよい条件**: 以下の
   * どちらかが成り立ったとき。
   *
   * 1. runner と旧 daemon が混在する窓が無いと示せたとき（両方が常に同じ
   *    版でデプロイされる、または `runnerEventSchema` 側が先に strict へ
   *    直っている）
   * 2. 旧 daemon（`runnerEventSchema` が strict でない版）が退役したとき
   *
   * ## `#recordBackgroundTaskOwner` を呼ばない理由
   *
   * 成功側（`#onPostToolUse`）は `hook.tool_response` から背景タスクの所有者
   * を控えるが、**ここでは呼ばない。** `PostToolUseFailureHookInput` には
   * `tool_response` も `backgroundTaskId` を運べる欄も無い（#929 の
   * 2026-09-13 の測定コメント——`sdk.d.ts` を逐語で確認し、`BaseHookInput` /
   * `PostToolUseFailureHookInput` のどちらにもその欄が無いことを実測した）。
   * **材料が無いので、呼んでも何も控えられない。** 呼ばないのは手抜きでは
   * なく、入力の形がそもそも許していない。
   *
   * ## 自作ツールの除外
   *
   * **足していない。** 成功側の `#onPostToolUse` にも同種の除外
   * （`clone.ts` の `cloneToolJournalsItself` 相当）が無いため——除外規則は
   * 成功側と揃えることにしており、無い規則を失敗側にだけ新設しない。
   *
   * **`transcript_path` と `RunnerTurnTally` の `#toolsSinceResult` /
   * `#markProgressed` は成功側と同じ理由で拾う** —— `BaseHookInput` の欄で
   * 両方のフック入力に載るので、
   * 直近の道具呼び出しが失敗した回だけこれらを拾わずにいると、次に成功する
   * 道具呼び出しが来るまでのあいだ生ログの在り処や「自分で手を動かした
   * 回数」が古いまま取り残される（`#onPostToolUse` の同じ2行と同じ理由）。
   *
   * **`#preToolInputHeads` の掃除も同じ理由で拾う**（issue #1105）。この
   * 呼び出しは拒否ではなく失敗（実行できた・実行しようとしたが例外や
   * 中断で終わった）なので `#noteDenial` を経由しない——ここで消さないと、
   * 拒否ではなく失敗で終わった分の控えが上限による `onForget` まで残る。
   *
   * **`#oneShotAllowedToolUses` の掃除も同じ理由で拾う**（issue #1105 P1、
   * `#onPostToolUse` と同じ形）。
   */
  async #onPostToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    if (typeof record.toolUseId === 'string') {
      this.#preToolInputHeads.delete(record.toolUseId);
      this.#oneShotAllowedToolUses.delete(record.toolUseId);
      this.#settleWorkerTool(record.toolUseId);
    }
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    // 道具が動いた＝このセッションは生きている（成功側と同じ）。
    this.#markProgressed();

    // **`worker_wait.toolless` の材料。** マネージャー自身の道具だけを数える
    // （成功側の `#onPostToolUse` と同じ理由・同じ判定）。
    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const tool = record.toolName ?? '(不明)';
    const error =
      typeof record.error === 'string'
        ? // 道具の出力（トークン・資格付き URL）を運びうる自由文なので、伏せてから切る（#2493）。
          excerptLine(redactErrorText(record.error, process.env), TOOL_USE_FAILURE_ERROR_EXCERPT)
        : '(不明)';

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${TOOL_USE_FAILURE_NOTE_PREFIX} 道具=${tool}・actor=${actor}・error=${error}`,
    });
  }

  /**
   * 背景タスクを起こした主体を控える（#570。`#onPostToolUse` から呼ぶ）。
   *
   * **実測（SDK 0.3.247。`out8/hooks.jsonl` の逐語）:**
   *
   * ```
   * PostToolUse  agent_id=aa070833e2cf03a72  tool_name=Bash
   *              tool_response={… "backgroundTaskId":"b4kk5s3qh"}
   * SubagentStop agent_id=aa070833e2cf03a72
   *              background_tasks=[…, {"id":"b4kk5s3qh","type":"shell", …}]
   * ```
   *
   * ⟹ **`tool_response.backgroundTaskId` と `background_tasks[].id` は同じ値**
   * であり、同じ入力に `agent_id` が在る。これが所有者を引ける唯一の経路である。
   *
   * **入力は防御的に読む。** `tool_response` の形は SDK 側の都合で変わりうるので、
   * 文字列の `backgroundTaskId` が在るときだけ控える（無ければ何もしない）。
   *
   * **⚠️ 道具名で絞っていないが、このキーを返す道具は `Bash` だけである**（SDK 0.3.269
   * 同梱の型定義で実測。表は `OWNER_RECORDABLE_TASK_TYPES` の doc）。⟹ **ここで早期
   * return するのは異常ではなく、`Task` / `Monitor` / `Workflow` を含む `Bash` 以外の
   * すべての道具で通る正常な経路である。** 「引けなかった」を診断する側
   * （`#noteOwnerLookupFailure` / `#stopTaskOwnerKind`）は、この非対称を名簿で受けている。
   *
   * **併せて `command` も控える（Issue #1554）。** 所有者と同じ呼び出し
   * （同じ `PostToolUse`）が道具の入力（`tool_input.command`）も持っている
   * ので、ここで一緒に読む——`toolInput` は防御的に読み、文字列の `command`
   * が無ければ何も渡さない（`RunnerSubagentStopState.setBackgroundTaskOwner`
   * 側で「読めなかった」を空文字と混ぜない）。**用途は、打ち切った作業者が
   * 残した背景処理の完了（`task_notification`）をマネージャーへ配達すると
   * き、id と一緒に command も名乗れるようにすること**（`#onTaskNotification`
   * の Issue #1554 の節）。
   */
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

    // マネージャー自身の分は空文字で控える（「引けなかった」と混ぜないため）。
    // 上限を超えたら古い側から捨てる（`RunnerSubagentStopState.setBackgroundTaskOwner`
    // の中。理由は `BACKGROUND_TASK_OWNER_LIMIT`）。
    this.#stopState.setBackgroundTaskOwner(
      taskId,
      agentId ?? '',
      typeof command === 'string' ? command : undefined,
    );
  }

  /**
   * ターンの開始を数える（`worker_wait`）。**観測専用。** `{ continue: true }`
   * を返すだけで、何もブロックしない（ブロックすれば能力の削除になる）。
   *
   * **なぜこの hook を足すのか。** `result` が SDK 側の自己継続ターンごとに
   * 必ず来るのかは、手元の環境では確認できない。`UserPromptSubmit` はターンの
   * 開始ごとに発火するので、`submits`（ここで数える）と `turns`（`result` の
   * 回数）が食い違えば、それ自体が「`result` は自己継続ターンごとに出るのか」
   * という未解決の問いへの答えになる — どちらの仮説でも読める観測にしてある。
   *
   * `hook.agent_id === undefined` のときだけ数える（`#onPostToolUse` と同じ
   * 判定。作業者の分を混ぜない）。
   */
  async #onUserPromptSubmit(record: AgentUserPromptSubmitRecord): Promise<void> {
    if (record.agentId === undefined) {
      this.#turnTally.incrementSubmitsSinceResult();
      // **取れた分だけ載せる。** SDK の JSDoc
      // （`UserPromptSubmitHookInput.source`）曰く、この値は「system = 他の
      // 機械が起こしたターン（peer/channel messages・task notifications・
      // auto-continuation）」等を表す。**取れる見込みは 0.3.239 で変わった**
      // （「外部のペイロードには付かない」→「付かないこともある」。経緯と、
      // それでも割れない問いは `RunnerTurnTally` の `#submitSources` の doc）。
      // 取れない回に `'unknown': 1` のような行を作らない（AGENTS.md 地雷
      // 「取れない軸に0の行を作る」）。
      if (typeof record.source === 'string') {
        this.#turnTally.recordSubmitSource(record.source);
      }
    }
  }

  /**
   * 作業者セッションが停止した瞬間に、追跡中の背景処理の在り高を記録する
   * （#357 — 作業者が「バックグラウンド処理の完了通知を待つ」形でターンを
   * 閉じて空転する症状の実測口）。
   *
   * ## ⚠️ ここは観測専用ではない（PR #594 が観測専用にしていたのを、この PR で変えた）
   *
   * `#onSubagentStop`（#570 / PR #594）は「当人が自分で起こした背景処理が
   * 残ったまま畳もうとした」ことを正しく検出していたが、`note` を1本出して
   * `{ continue: true }` を返すだけだった。**この検出できている瞬間にこそ、
   * 作業者をその場で継続させる。** 根拠は SDK の型定義（逐語。
   * `SubagentStopHookSpecificOutput` の doc、`sdk.d.ts`）:
   *
   * [sdk-verbatim SubagentStopHookSpecificOutput]
   * > Hook-specific output for the SubagentStop event. additionalContext is non-error feedback delivered to the subagent; the subagent continues so it can act on it.
   *
   * ## ⚠️ `decision: 'block'` ではなく `additionalContext` を使う理由
   *
   * **`additionalContext` は「非エラーのフィードバックを渡すと作業者が
   * 継続する」口であって、止める口ではない。** `decision: 'block'` は
   * 逆方向 —— 止める・拒む側の口で、これを使うと AGENTS.md の地雷
   * 「ターン数上限・実行回数上限で暴走を止める」（能力の削除）に当たる。
   * こちらは能力を削っておらず、**むしろ委譲が黙って止まっていた状態から
   * 継続する能力を足す側**なので、その地雷には当たらない。だから
   * `decision` は一度も使わず、`additionalContext` だけを返す。
   *
   * **`note` イベントに乗せる。** `runner-protocol.ts` の欄は増やさない —
   * デーモンと runner は別々にデプロイされるので、runner が新しく名乗る値を
   * 足すと古い runner が居る窓が開く。`note` に足した任意欄 `escalate`
   * （`runner-protocol.ts` の doc）は旧デーモンの zod が黙って落とすので、
   * 同じ理由で安全である。**起こし直し自体はこの欄に依存しない** —
   * `hookSpecificOutput.additionalContext` は `note` とは別の返り値なので、
   * 旧デーモン・新デーモンのどちらが相手でも runner 側だけで完結する
   * （デプロイの順序は PR 本文を見よ）。
   *
   * ## ⚠️ `background_tasks` が非空であることは、空転の署名では **ない**
   *
   * ここは元々「非空＝作業者が背景処理を待って畳んだ署名」として書かれていた。
   * **実測（SDK 0.3.247。#570 に生 JSON が在る）で反証された:**
   *
   * 1. **畳もうとしている当人が必ず配列に入る**（`id` = `agent_id` /
   *    `type=subagent` / `status=running`）⟹ 発火4回すべてで非空だった。
   *    ⟹ 「空なら最初の1回だけ記録する」という枝には**到達しない**
   * 2. **兄弟の作業者も入る** — 道具を1つも使わない作業者の配列に、走っている
   *    別の作業者が載った ⟹ 件数では「この作業者が待っている」が言えない
   * 3. **`BackgroundTaskSummary` に所有者の欄が無い**（`id` / `type` / `status` /
   *    `description` / `command?` / `agent_type?` / `server?` / `tool?` / `name?`）
   *
   * ⟹ **だから絞る。** 所有者は `#onPostToolUse` が控えている
   * （`#recordBackgroundTaskOwner`。`tool_response.backgroundTaskId` と
   * `background_tasks[].id` が同じ値であることは実測済み）。
   *
   * **当人だけ／兄弟だけ／道具を使い終えて畳んだとき（`mine.length === 0`）は、
   * 一切触らない。** `#noteOwnerLookupFailure` の分岐だけを通り、
   * `additionalContext` も `escalate` も無い、これまでどおりの `note`（または
   * 無音）である。**ここを広げると、終わった作業者や兄弟だけの作業者まで
   * 無駄に起こすことになる。**
   *
   * ## ⚠️ `mine` は「当人が起こしたもの」であって「まだ走っているもの」ではない
   *
   * **ここが #570 の追跡で直した穴である。** 上の絞り込み（所有者で絞る）は
   * 入っていたが、**`status` を1度も読んでいなかった。** ⟹ SDK が畳み終えた
   * 背景処理を `background_tasks` に載せてくる回には、**もう終わっている門の
   * 完了を待たせる形で作業者を起こし直し**、作業者は同じ結論（もう待つものは
   * 無い）へ着いて畳み、起こし直しの上限に達して委譲がそこで止まる。
   *
   * **計測（`status` を6語で振った実測。2026-09-09）:** `completed` /
   * `failed` / `killed` / `done` / `succeeded` / `running` の**どれを渡しても**
   * 在庫は `1件`、起こし直しは `true` だった —— 判定は `status` を見ていない。
   *
   * ⟹ **`classifyBackgroundTaskStatus` で3つへ言い分ける**（走っている／
   * 終わった／**分からない**）。`'unknown'` は「走っている」側へ倒し、分から
   * なかったこと自体を `note` に書く（倒す先を間違えると起こし直しが黙って
   * 効かなくなる）。**全部が「終わった」側だったときは起こし直さないが、
   * 黙りもしない** —— `#noteSettledOnly` が1セッションに1回だけ日誌へ出す。
   *
   * **⚠️ この直しが説明しないもの（実測と仮定を混ぜないため明記する）。**
   * 依頼の発端となった観測では、残っていた背景処理の `status` は `running`
   * だった。⟹ **`status` が `running` のまま腐って届く経路が在るなら、この
   * 直しはそれを直さない。** ここで直したのは「SDK が『終わった』と言って
   * いるのに数えていた」ほうだけである。
   *
   * **`remaining.length > 0` のとき（当人が自分で起こした背景処理が、まだ
   * 終わっていない形で残っている）は、フックの中で完了を待つ**（Issue #3008。
   * 回数の上限 `SUBAGENT_WAKEUP_LIMIT_PER_TASK` / `_PER_AGENT` はこの Issue で外した。
   * 回数で暴走を止める形は AGENTS.md の地雷に当たり、8 の根拠は実測ではなかった）:
   *
   * 1. **待つ。** SDK は `SubagentStop` のフックの Promise を待つので、`remaining` の
   *    背景処理が全部終わるまで返さない（`#waitForBackgroundTasks`。足場は
   *    `RunnerBackgroundWaiters`）。待つ間、作業者のターンは進まない（⚠️ 実 SDK で
   *    トークンを使わないことまでは測っていない）。
   * 2. **終わった（`'settled'`） —— 1回だけ起こし直す。** `additionalContext` に、終わった
   *    背景処理の id・command・出力の置き場所（`task_notification` の `output_file`）を載せ、
   *    「結果を読んでから畳め」と伝える。`note` は `outcome: 'woken'`。通算は観測専用
   *    （`#subagentWakeupTotals`。`stall.wakeupCount` の出所）で、可否には使わない。
   * 3. **待ちの上限（`SUBAGENT_BACKGROUND_WAIT_MS`、30分）に達した（`'timeout'`） —— 起こし直さず
   *    打ち切る。** 旧い `limit_reached` の経路をそのまま使う: `note`（`outcome:
   *    'limit_reached'`）、1・3・9…の回だけ `escalate`（#1385。実行の制限ではなく知らせの
   *    間引き）、`#cutOffWorkers.recordCutOff`。⟹ その後に背景処理が終わったときの
   *    #1475 / #1502 / #1554 / #1563 / #2387 の配達と起こしが働く。`outcome` のスキーマは
   *    変えていない（旧デーモンとの互換）。
   * 4. **待ちの途中でセッションが畳まれた（`'released'`）—— 起こし直さずに返す。** 畳まれつつある
   *    世代で作業者にモデルを1ターン回させても、結果は誰にも届かない。打ち切りでもないので
   *    `recordCutOff` は通さない。跡は stall を持たない `note` で残す。
   *
   * **穴A（起こされるたびに新しい背景処理を起こして畳む作業者）を回数で止めない。** 各回は
   * 「背景処理が実際に終わった後の1ターン」なので、空転ではなく仕事である
   * （`SUBAGENT_BACKGROUND_WAIT_MS` の doc）。終わらない背景処理は30分で切れる。
   *
   * ## ⚠️ この `note`（および `additionalContext`）が出ないことは「空転が無かった」を意味しない
   *
   * **フックの発火そのものが条件付きである。** 実測では、作業者の完了8件のうち
   * 発火は4件で、**「畳んだ瞬間に親のターンが開いていたか」で8件が8件とも
   * 割れた**（親が先に閉じていた4件は発火していない）。そして委譲は既定で
   * `is_backgrounded: true` なので、**親が先に閉じる形が本番では普通である。**
   * ⟹ 拾えるのは一部である。**同じ断りを `note` の本文にも書いてある**
   * （片方だけ読んだ人が誤らないため）。**この直しはこの断りを覆さない** —
   * 発火した回は確実に作業者を継続させられるようになったが、発火しない回は
   * 今までどおり止まる。
   *
   * **入力は防御的に読む**（既存フックと同じく `as` で受けて型を仮定しない）。
   * `additionalContext` の組み立てで例外が出ても、起こし直さずに
   * `{ continue: true }` へ倒す（下の `catch`）。必ず `{ continue: true }`
   * 相当を返す。`#markProgressed()` などの既存の副作用は呼ばない
   * （挙動を変えるのは継続の合図だけで、それ以外の観測は変えない）。
   */
  async #onSubagentStop(record: AgentSubagentStopRecord): Promise<AgentContextOutcome> {
    if (typeof record.agentId === 'string') {
      const agentId = record.agentId;
      this.#tryObservation('作業者の道具の見張りの片付け', () => {
        this.#workerTools.settleAgent(agentId);
      });
    }
    try {
      // 配列でない・真偽値でない欄は `toAgentSubagentStopRecord`（`claude-provider.ts`）
      // が省いて渡す。ここでの読み方は、中立化する前に生入力から読んでいた形と同じ。
      // 生入力の読み取りの失敗は、中立化する前と同じくこの時点で投げ、下の
      // `catch` の note へ倒す（`AgentSubagentStopRecord.readError` の doc）。
      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const agentId = record.agentId;
      // **取れたときだけ載せる。** 取れない回に既定値の行を作らない
      // （AGENTS.md 地雷「取れない軸に0の行を作る」）。
      const stopHookActive = record.stopHookActive;

      // **当人が起こしたものだけを残す。** `id` が表に在り、その所有者が
      // いま畳もうとしている作業者と一致するものだけを数える。
      const mine = tasks.filter((task) => {
        const id = (task as { id?: unknown }).id;
        if (typeof id !== 'string' || agentId === undefined) return false;
        return this.#stopState.backgroundTaskOwner(id) === agentId;
      });

      if (mine.length === 0) {
        this.#noteOwnerLookupFailure(tasks);
        return { kind: 'continue' };
      }
      // **型のためのガード。** `mine.length > 0` は上の filter の条件から
      // `agentId` が文字列であることを含意するので、実際にはここへは来ない。
      if (agentId === undefined) return { kind: 'continue' };

      // **`status` で言い分ける。** ここが無かったのが直した穴である ——
      // `mine` は「**当人が起こしたもの**」であって「**まだ走っているもの**」では
      // ない。判定が `status` を1度も読んでいなかったので、配列に畳み終えた分が
      // 載る回には、**もう終わっている背景処理の完了を待たせる形で作業者を
      // 起こし直し**、進まないまま上限へ達して委譲がそこで止まっていた。
      //
      // **`'unknown'` は「走っている」側へ倒す**（`classifyBackgroundTaskStatus`
      // の doc）。倒す先を間違えると起こし直しが黙って効かなくなるので、
      // 分からなかったことは下の `note` に書く。
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

      // **当人のものが全部終わっていた —— 起こし直さない。**
      // `mine.length === 0` と同じ「触らない」側だが、**同じ顔にはしない** ——
      // SDK 自身が `background_tasks` を「in-flight background work」と言って
      // いる以上、畳み終えた分がここへ載るのは計器側の話である。1セッションに
      // 1回だけ日誌へ出す（`#noteSettledOnly`）。
      if (remaining.length === 0) {
        this.#noteSettledOnly(settled);
        return { kind: 'continue' };
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;
      const disclaimer =
        '⚠️ この行が出ないことは「空転が無かった」を意味しない — ' +
        'このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。';

      // **数に入れなかったものを黙って落とさない**（AGENTS.md「静かに失敗する道具」）。
      // 「残っている」の件数だけを出すと、`status` で言い分けたこと自体が消える。
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
      // **背景処理の完了まで、フックの中で待つ（Issue #3008）。** 待つ対象は `remaining`
      // （当人が起こした、まだ走っている背景処理）の id。回数の上限は外した——
      // `SUBAGENT_BACKGROUND_WAIT_MS` の doc が、時間の上限を置いた理由と、穴A（起こされる
      // たびに新しい背景処理を起こして畳む作業者）を回数で止めない理由を持つ。
      //
      // `remaining` の各要素の `id` は `mine` の filter（`typeof id === 'string'` かつ所有者が
      // 一致）を通っているので既に文字列のはずだが、**防御的にもう一度 `typeof` で絞る**
      // （この前提が崩れても、ここが例外で落ちない側へ倒す）。
      const remainingIds = remaining
        .map((task) => (task as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      const waitOutcome = await this.#waitForBackgroundTasks(remainingIds);

      // **待ちの途中でセッションが stop / 畳み / 世代交代した —— 起こし直さずに返す。**
      // 理由: 起こし直すと、畳まれつつあるセッションの中で作業者がモデルを1ターン回す。
      // その結果は誰にも届かない（マネージャーは resume で開き直す新しい世代で、古い世代の
      // 作業者の続きを受け取らない）ので、トークンを無駄にするだけである。**また、これは
      // 「打ち切り」ではない**——背景処理は終わっていないが、alteroid が打ち切ったのでは
      // ないので `recordCutOff` は通さない（通すと、新しい世代で「打ち切った作業者」の注記を
      // 誤って出す）。跡は note として残す。
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
        // **起こし直す — 背景処理が実際に終わった後の1回である。** 通算（観測専用）を +1 する。
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
            // **取れたときだけ載せる**（AGENTS.md 地雷「取れない軸に0の行を
            // 作る」。`record.agentType` は SDK 側の事情で無いことがある —
            // `runner-protocol.ts` の `note.stall.agentType` の doc）。
            ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
            ownedTaskCount: remaining.length,
            sessionTaskCount: tasks.length,
            // **スキーマは変えていない**（`stall.wakeupCount` は今までどおり「この
            // `agent_id` を起こし直した回数（今回を含む）」。値は `#subagentWakeupTotals`）。
            wakeupCount: newTotal,
            outcome: 'woken',
          },
        });

        // **終わった背景処理を、id・command・出力の置き場所つきで渡す。** 出力の置き場所は
        // `task_notification` の `output_file`（届いていれば）。取れなければ「取れなかった」と
        // 書く（作り物のパスを主張しない）。
        const snapshotCommands = new Map<string, string>();
        for (const task of remaining) {
          const t = task as { id?: unknown; command?: unknown };
          if (typeof t.id === 'string' && typeof t.command === 'string') {
            snapshotCommands.set(t.id, t.command);
          }
        }
        const finishedLines = remainingIds.map((id) => {
          // 畳もうとした瞬間の `command`（note と同じ出所）を先に、無ければ起こした瞬間の控え。
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

      // **待ちの上限（`SUBAGENT_BACKGROUND_WAIT_MS`）に達した —— 起こし直さず、打ち切る。**
      // `note` は毎回 emit する（日誌には全件残る）。`escalate` は間引く（#1385）——
      // `manager.ts` の `case 'note'` は `escalate === true` のときだけクローンの受信箱へ
      // report を積むので、毎回立てたままだと同じ agentId が何度も `SubagentStop` を
      // 送ってくるたびに同じ report が積まれ続ける。**間引きは知らせの間引きであって、
      // 実行の制限ではない**（`RunnerSubagentStopState.recordSubagentLimitReachedNote` の doc）。
      const total = this.#stopState.subagentWakeupTotal(agentId);
      const { count: limitNoteCount, shouldEscalate: shouldEscalateLimitNote } =
        this.#stopState.recordSubagentLimitReachedNote(agentId);

      const taskLines = this.#renderSubagentStopTaskLines(remaining);
      const limitReasonText =
        `**背景処理の完了を ${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分（待ちの上限）まで待ったが、` +
        `終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 ${total}回 起こし直し済み）。`;
      // **クローンが読んだとき「これが何回目か」「なぜ次がすぐ来ないか」が
      // 分かる1行**（#1385）。日誌には毎回このまま載るので、間引かれた回
      // （`escalate` が立たない回）も、日誌を辿れば抜け無く追える。
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
        // **Issue #1554: ここから下が新設した2行。** `#truncateSubagentStopText`
        // が切るのは末尾からなので、必ず `taskLines`（id / command。読み手が
        // いちばん要る具体的な材料）より後ろに置く——切られるならこちらが
        // 先に切られる側に倒す。
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
          // 同上（「取れたときだけ載せる」）。
          ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
          ownedTaskCount: remaining.length,
          sessionTaskCount: tasks.length,
          // 起こし直していないので、このイベント自身は積算に足されない。**この欄は
          // `wakeupCount`（起こし直した回数）のままで、間引きの回数（`limitNoteCount`）を
          // 運ばない**——スキーマの doc の意味を変えないため。
          wakeupCount: total,
          outcome: 'limit_reached',
        },
      });
      // **Issue #1554: 残っていた背景処理の id / command を、後で #1475 /
      // #1502 の注記（`#annotateCutOffWorker` / `#drainPendingCutOffNotifications`）
      // が名乗れるよう控える。** `remaining` の各要素は `mine` の filter を
      // 通っているので `id` は既に文字列のはず（防御的にもう一度 `typeof` で
      // 絞る——このファイルの他の箇所と同じ作法）。
      const cutOffTasks: CutOffBackgroundTaskSummary[] = remaining.flatMap((task) => {
        const t = task as { id?: unknown; command?: unknown };
        if (typeof t.id !== 'string') return [];
        return [{ id: t.id, ...(typeof t.command === 'string' ? { command: t.command } : {}) }];
      });
      this.#cutOffWorkers.recordCutOff(agentId, cutOffTasks);

      return { kind: 'continue' };
    } catch (error: unknown) {
      // フックが例外でセッションを止めてはいけない。記録そのものが失敗した
      // ことだけを、握れる範囲でもう一度 note として上げる。
      // **`additionalContext` の組み立てで例外が出たら、起こし直さずに
      // `{ continue: true }` へ倒す**（起こし直しよりも「必ず continue: true
      // 相当を返す」ことのほうを優先する）。
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
