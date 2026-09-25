import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';

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
  AgentPreCompactRecord,
  AgentPreToolDecision,
  AgentPreToolRecord,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import { inspectBashCommand } from './bash-wait-guard.js';
import { cgroupEventsDeltaOf } from './cgroup-events.js';
import { buildManagerSessionOptions, foldClaudeMessage } from './claude-provider.js';
import { CONTEXT_USAGE_CATEGORY_LIMIT } from './context-usage.js';
import { denialInputShape, type DeniedRecord } from './denial-shape.js';
import {
  noteBackgroundFailure,
  noteMissingRecordSource,
  noteUnclassifiedFailure,
  noteUnclassifiedFailuresSummary,
  noteUnreadableRecord,
} from './dropped-record.js';
import { ROTATABLE_CREDENTIAL_KEYS } from './credentials.js';
import type { CredentialEntry, CredentialFingerprint, CredentialStore } from './credentials.js';
import { excerptLine } from './excerpt.js';
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
import { RunnerFenceError } from './runner-protocol.js';
import { readCgroupEventCounters, type CgroupEventCounters } from './runner-resources.js';
import {
  BACKGROUND_TASK_OWNER_LIMIT,
  RunnerSubagentStopState,
  SUBAGENT_WAKEUP_LIMIT_PER_AGENT,
  SUBAGENT_WAKEUP_LIMIT_PER_TASK,
} from './runner-subagent-stop-state.js';
import {
  recoverFromFailedResume,
  type ResumeRecoveryHost,
  type ResumeRecoveryOutcome,
} from './runner-resume-recovery.js';
import { RunnerResumeState } from './runner-resume-state.js';
import { RunnerTurnTally } from './runner-turn-tally.js';
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
  RunnerStartCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';
import { computeUnpushedWork } from './unpushed-work.js';
import type { ContextUsageObservation, JobStatus } from './schema.js';
// **クローン（`clone.ts`）と同じ判定を呼ぶ。** 「これは応答ではない」の見分けを
// 層ごとに書くと、片方だけが印を見落として非対称になる（実際に
// `result.errors[]` はここにしか無く、クローン側は読んでいなかった）。
//
// **印そのものを読むのは provider の写しである**（`claude-provider.ts` の
// `foldClaudeMessage`）。ここが受け取るのは、既に中立イベントへ載った印である。
import { assistantFailureOf, type SdkFailure } from './sdk-failure.js';
import { systemErrorFactsOf, type SystemErrorFacts } from './system-error.js';
import { classifyUsageNotice } from './usage-limits.js';
import { describeProbeError } from './usage-probe.js';
import { readSessionUsage } from './usage.js';

/**
 * manager-runner — SDK を隔離して走らせる層（roadmap M4）。
 *
 * **マネージャーと作業者は実装物ではない。** ここに書くのは配線だけ — 起こす・
 * 話しかける・出来事をデーモンへ返す・生ログを渡す。
 *
 * この層は**判断をしない**。「これは人間に聞くべきか」「この道具は許してよいか」は
 * 一切持たず、確認をそのままデーモン（＝クローン）へ上げる。ここに行為の一覧を
 * 置いた瞬間、権限境界が設定に化けて人による違いが潰れる（AGENTS.md 地雷3）。
 *
 * 2つの禁止（north_star）が効くのもここである:
 *
 * - `tools` を**渡さない**（preset 全部）。明示リストで絞れば能力の削除になる
 * - `maxTurns` を渡さない。暴走はターン数ではなく実行環境の境界で止める
 * - 同時セッション数に人工上限を設けない。上限はマシンリソースそのもの
 * - `permissionMode` は人間が開く Claude Code と同じ既定（`auto`）。層を下りた
 *   途端に `Read` や `grep` で止まるのは仕様ではなくデグレード。確認そのものの
 *   経路（`canUseTool` でデーモンへ回す）は残してあり、`default` へ戻せば効く
 */

/**
 * `SUBAGENT_WAKEUP_LIMIT_PER_TASK` / `SUBAGENT_WAKEUP_LIMIT_PER_AGENT` の
 * 定義は `runner-subagent-stop-state.ts` へ切り出した（Issue #1190 段1）。
 * 既存のテスト（`runner-subagent-stop.test.ts`）が `from './runner.js'` で
 * 直書きしているので、ここで再輸出して公開面を変えない。
 */
export { SUBAGENT_WAKEUP_LIMIT_PER_AGENT, SUBAGENT_WAKEUP_LIMIT_PER_TASK };

/** マネージャーのモデル帯の既定。変更には人間の承認が要る（AGENTS.md 地雷5）。 */
export const MANAGER_MODEL = 'opus';

/** 作業者のモデル帯の既定。SDK の既定はマネージャーの継承なので、必ず明示する。 */
export const WORKER_MODEL = 'sonnet';

/**
 * マネージャー / 作業者のモデル帯を人間が差し替えるための環境変数。
 *
 * **クローン（`ALTEROID_CLONE_MODEL`）と同じ性質のものである** — 設定ではなく
 * 人間の承認の置き場で、既定は動かさない（`model-tier.ts` に理由がある）。
 * 3層のうち1層にだけ置き場があるのは非対称で、**「クローンは人間が帯を選べるが
 * マネージャーは選べない」は人間の側の能力の欠落**になる。
 *
 * 読むのは**この層を実際に SDK へ渡す器**、すなわち runner である。デーモンにも
 * 同じ値が降りるが（`compose.yaml` の `x-shared-env` / Railway の Shared
 * Variables）、あちらが使うのは自己認識に載せる**宣言**のためだけで、実際に
 * セッションへ渡っているのはここで解いた値である。
 */
export const MANAGER_MODEL_ENV_KEY = 'ALTEROID_MANAGER_MODEL';
export const WORKER_MODEL_ENV_KEY = 'ALTEROID_WORKER_MODEL';

/** 環境変数を見てマネージャーのモデル帯を決める。空・空白なら既定（`opus`）。 */
export function resolveManagerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, MANAGER_MODEL_ENV_KEY, MANAGER_MODEL);
}

/** 環境変数を見て作業者のモデル帯を決める。空・空白なら既定（`sonnet`）。 */
export function resolveWorkerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, WORKER_MODEL_ENV_KEY, WORKER_MODEL);
}

/**
 * 人間が実際に値を置いた層だけを並べる（起動時に表へ出すための材料）。
 *
 * **「既定と違うもの」ではなく「置かれたもの」を返す。** `ALTEROID_MANAGER_MODEL=opus`
 * のように既定と同じ値を明示的に置いた場合も含める — ここが答えているのは
 * 「差し替えの承認がここに置かれているか」であって、値の比較ではない。
 */
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

/** 作業者層の本体はこの `agents` 定義1個だけ。独自のワーカープールを作らない。 */
export const WORKER_AGENT_NAME = 'worker';

/**
 * 失敗・中断した道具呼び出し（`PostToolUseFailure`）を `note` として日誌へ
 * 残すときの、`text` の固定の先頭（Issue #929）。**export するのは、後から
 * 機械的に拾えるようにするため** — 日誌の `note.text` をこの接頭辞で絞れば、
 * 成功の `tool_use` とは別の場所に埋もれている失敗の記録を数え上げられる。
 * `#onPostToolUseFailure` の doc に、この形を選んだ理由を書いてある。
 */
export const TOOL_USE_FAILURE_NOTE_PREFIX = 'tool_use_failure:';

/**
 * `PostToolUseFailureHookInput.error` を `note` の `text` へ残すときの上限
 * （Issue #929）。`clone.ts` の `TOOL_USE_ERROR_EXCERPT`（同じ値・同じ理由）
 * と揃えてある — `error` は道具・MCP サーバ・SDK が書く上限の無い自由文なので、
 * 切らずに残すと1件の巨大な失敗メッセージが日誌の1行を埋め尽くしうる。
 * `excerptLine` を通すので、切り詰めたときは省いた文字数と全体の長さが末尾に
 * 付き、「そこで切れている」と読む側から黙らずに分かる。
 */
const TOOL_USE_FAILURE_ERROR_EXCERPT = 500;

/**
 * runner の子プロセスへ渡さない環境変数。
 *
 * 記憶ストアの鍵（ローカルのパス / DB 接続情報）に加えて、**runner の制御面の鍵**も
 * 落とす。マネージャーが runner の API を叩けると、自分宛の許可確認に自分で
 * `allow` を返せてしまう — クローンも人間も通らずに権限境界を迂回できる
 * （「マネージャーから見たユーザーはクローン」という配線が崩れる）。
 *
 * ここは**二重の底**である。本命は実行環境の分離（別コンテナ・別 UID・鍵の非配布）で、
 * ここはその内側でもう一枚落としているだけ。**ここだけを頼りにしないこと。**
 */
export const WITHHELD_ENV_KEYS = [
  'ALTEROID_HOME',
  'ALTEROID_PORT',
  'ALTEROID_DATABASE_URL',
  'ALTEROID_RUNNER_TOKEN',
  'ALTEROID_RUNNER_TOKEN_SHA256',
  'ALTEROID_RUNNER_SOCKET',
] as const;

/**
 * SDK 子プロセス（マネージャーと作業者）を走らせる UID。
 *
 * **同じ UID で走らせると、子プロセスは runner の `/proc/1/environ` を読み、
 * 制御面の鍵も、Unix ソケットへの接続権も手に入れる。** 分けて初めて、
 * 「マネージャーは自分の許可確認に答えられない」が構造として成立する。
 *
 * 落とすには特権が要るので、runner 本体は root で走る（子だけを降ろす）。
 * 特権が無いのに設定されていたら、黙って同じ UID で走らせずに落とすこと —
 * 境界があるつもりで無い状態が、いちばん危ない。
 */
export interface RunnerChildUser {
  uid: number;
  gid: number;
  /** 子プロセスの `HOME`。root の home を渡すと書けずに落ちる。 */
  home?: string;
}

/**
 * SDK の権限モード。**既定は `auto`**（人間が開く Claude Code と同じ）。
 *
 * 人間が Claude Code を開けば `Read` や `grep` でいちいち止まらない。層を下りた
 * 瞬間にそれが止まるなら、それはデグレード（north_star 禁止1）であって仕様ではない。
 * `default` に戻せば従来どおり1件ずつクローンへ確認が回る（配線は残してある）。
 *
 * **判定の本体は `permission-mode.ts` にある**（クローンも同じ形を使う。
 * `model-tier.ts` と同じ理由で、層ごとに書き写さない）。ここに残すのは
 * 「マネージャーの置き場はこの環境変数である」という対応だけである。
 */
export const MANAGER_PERMISSION_MODES = PERMISSION_MODES;

export type ManagerPermissionMode = PermissionModeName;

export { DEFAULT_PERMISSION_MODE };

/** 権限モードを差し替える環境変数（実行環境の設定であって、能力の制限ではない）。 */
export const PERMISSION_MODE_ENV_KEY = 'ALTEROID_MANAGER_PERMISSION_MODE';

/** `ALTEROID_MANAGER_PERMISSION_MODE` を読む（不正な値は落とす）。 */
export function resolvePermissionMode(env: NodeJS.ProcessEnv): ManagerPermissionMode {
  return resolvePermissionModeFor(env, PERMISSION_MODE_ENV_KEY);
}

/**
 * マネージャーの auto-memory（SDK が自動で読み書きする記憶ディレクトリ）を
 * 開けるための環境変数。既定は閉じる、明示で開く（#1189）。
 *
 * **閉じるのが既定である理由。** auto-memory は人間の Claude Code では
 * 「書いた本人の次のセッション」に届くが、マネージャー層では書いた記憶が
 * クローンにも、次の器にも、当のマネージャー自身にも届かない
 * （マネージャーは使い捨てで、次に起こす器は同じ `~/.claude/projects/<cwd>/memory/`
 * を見ない）。届かない口を既定で開けておく理由が無く、実際に3人が独立に
 * 「書いたのに消えた」と誤認した（#1189 観測4件）。
 *
 * **それでも塞ぎきらず、環境変数で開けられる形にする。** north_star 禁止2
 * 「方針は設定で開けられなければならない」——ここを `ManagerSessionOptionsRequest`
 * の固定値にすると、人間が開きたいときに開けなくなる（能力の削除になる）。
 * 判定は `resolvePermissionModeFor` と同じ「空・空白は既定、'true'/'false' 以外は
 * 落とす」形にしてある——閉じた2値の環境変数だからで、`model-tier.ts` の
 * 「値を検証しない」とは事情が違う（あちらは SDK が増やす名前を人間が先取りできる
 * 必要がある。こちらは真偽値なので増えない）。
 */
export const MANAGER_AUTO_MEMORY_ENV_KEY = 'ALTEROID_MANAGER_AUTO_MEMORY';

/** `ALTEROID_MANAGER_AUTO_MEMORY` を読む。空・未設定なら既定で閉じる（不正な値は落とす）。 */
export function resolveManagerAutoMemoryEnabled(env: NodeJS.ProcessEnv): boolean {
  const given = env[MANAGER_AUTO_MEMORY_ENV_KEY]?.trim();
  if (given === undefined || given.length === 0) return false;
  if (given === 'true') return true;
  if (given === 'false') return false;
  throw new Error(
    `${MANAGER_AUTO_MEMORY_ENV_KEY} の値が不正: ${given}（使えるのは true / false。既定は false）`,
  );
}

/**
 * 貸し出し期限の自己失効を見張る間隔（roadmap M5 PR4）。
 *
 * **環境変数の設定項目にしないこと。** `runner-protocol.ts` の `HEARTBEAT_INTERVAL_MS`
 * などと同じ論法 — つまみとして外へ出すと、そこが実質の運用パラメータになる。
 * `lease.ts` の `LEASE_TTL_MS`（既定10分）に対して十分に細かく見張れる長さであれば
 * よく、厳密さは要らない（見張りが1周遅れても、次の周で必ず気づく）。
 */
const LEASE_WATCH_INTERVAL_MS = 10_000;

export interface RunnerHostOptions {
  /** 安定した識別子。デーモンが `manager_id → runner_id` を台帳に残す。 */
  runnerId: string;
  /** 出来事の出口。デーモンが繋いでいなければ溜めておく（呼び出し側の責任）。 */
  emit: (event: RunnerEvent) => void;
  /** この runner の作業ディレクトリ（cwd を省いた委譲の既定）。 */
  workspacePath: string;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  /** 主にテスト用。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** `WITHHELD_ENV_KEYS` に足して伏せる鍵。 */
  withheldEnvKeys?: readonly string[];
  /** SDK 子プロセスを別 UID で走らせる（コンテナ構成の既定）。 */
  childUser?: RunnerChildUser;
  /**
   * 権限モード。省略すると `env` の `ALTEROID_MANAGER_PERMISSION_MODE`、
   * それも無ければ `auto`。
   */
  permissionMode?: ManagerPermissionMode;
  /**
   * マネージャーの道具の鍵（`GH_TOKEN` など）。
   *
   * 渡すと、鍵は `env` のスナップショットではなく**こちらが持つ現在値**が配られる。
   * 走行中に差し替えても新しいマネージャーには即座に、既に走っているマネージャーにも
   * 器（ファイル）越しに次の `git` / `gh` 呼び出しから届く（`credentials.ts`）。
   */
  credentials?: CredentialStore;
  /**
   * 実行環境プロファイル（`.zprofile` 相当）の器。
   *
   * 渡すと、デーモンから降りてきたシェルスクリプトを置き、**SDK 子プロセスの
   * env とすべての Bash 実行に効かせる**。渡さなければプロファイルは使えない
   * （＝差し替えの口が 501 を返す）。**runner が自分で記憶ストアを読みに行く形に
   * しないこと** — 読みに行けるということは鍵があるということである。
   */
  profile?: ProfileVessel;
  /**
   * 貸し出し期限（lease）の自己失効を有効にする（roadmap M5 PR4）。**既定は
   * false。**
   *
   * `true` のとき、`lease` を伴って起こされたセッションは、`noteDaemonContact()`
   * が最後に呼ばれてから `lease.ttlMs` を過ぎたら自分で畳む
   * （`RunnerSession#selfFence`）。これが lease の歯である — デーモンと連絡が
   * 取れなくなった runner がこの猶予を過ぎても居座ると、「もう動いていない」を
   * 引き取る側が片側だけで言えなくなる（`lease.ts` の doc）。
   *
   * **既定を false にしてある理由。** 同一プロセスの `runner-local` では
   * 「デーモンだけが消える」ことが構造的に起こり得ない（デーモンと runner が
   * 同じプロセスなので、デーモンが死ねば runner も一緒に死ぬ）。既定で有効にすると、
   * HTTP の接触という概念そのものが無い構成で走っているセッションを理由なく畳む
   * ことになる。**コンテナで走る器（`apps/runner/src/index.ts`）だけが `true` を
   * 渡す。**
   */
  enforceLease?: boolean;
  /**
   * `spawnClaudeCodeProcess` の実体をテストから差し替える（#1334 段1）。
   * **主にテスト用**（`queryFn` と同じ理由）。既定は本物（`spawnAsUser`）。
   * `RunnerSessionOptions.spawnClaudeCodeProcessFn` の doc を見よ。
   */
  spawnClaudeCodeProcessFn?: (options: SpawnClaudeCodeProcessOptions) => DelegationProcessHandle;
  /**
   * `pids.events` / `memory.events` を読む実体をテストから差し替える
   * （Issue #1517「最小の形」1）。**主にテスト用**（`queryFn` と同じ理由）。
   * `RunnerSessionOptions.readCgroupEventCountersFn` の doc を見よ。
   */
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  /**
   * `#finish()` が `closed` を emit する直前に取る未 push の観測の実体を
   * テストから差し替える（Issue #1266 候補(2)）。**主にテスト用**
   * （`readCgroupEventCountersFn` と同じ理由）。
   * `RunnerSessionOptions.finishUnpushedWorkFn` の doc を見よ。
   */
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
}

export interface RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  /** いま配っている鍵の指紋。**値は出さない。** */
  credentials(): CredentialFingerprint[];
  /**
   * 鍵を差し替える。器を作り直さずに鍵を回すための唯一の口である。
   *
   * **`CLAUDE_CODE_OAUTH_TOKEN` の指紋が変わったときだけ、生きている全
   * セッションへ「ターンの境界で畳んで開き直せ」の印を立てる**（`#childEnv()`
   * が起動時にしか読まれない穴の直し。詳しくは `AGENT_TOKEN_CREDENTIAL_NAME`
   * の doc）。**指紋が同じなら何もしない** —— `#connectTo` / `#reattach`
   * （再接続の追いつかせ）は繋ぎ直しのたびに同じ値を降ろすので、無条件に
   * 畳むと再接続のたびにセッションが畳まれてしまう。
   */
  setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  /** いま置いてある実行環境プロファイルの指紋。**本文は出さない。** */
  profile(): RunnerProfileFingerprint | undefined;
  /** 実行環境プロファイルを差し替える。**置く前に評価して、結果を返す。** */
  setProfile(script: string): Promise<RunnerProfileResult>;
  /**
   * いま置いてある MCP の登録の指紋（#325 段3）。**値は出さない。** 置いていなければ
   * `undefined`（空の登録を置いた＝外した場合も同じ）。
   */
  mcpServers(): RunnerMcpServersFingerprint | undefined;
  /**
   * MCP の登録を差し替える（#325 段3）。**置く前に `parseMcpServers` を通す** ——
   * 不正なら投げ、前の登録が残る。空の `{}` は「外す」。
   *
   * **メモリにだけ持つ。** プロファイルや鍵と違ってファイルへ落とさないのは、
   * 走行中のプロセスが読み直す経路（`gh` シム・`BASH_ENV`）が無く、効くのは
   * セッションを組む瞬間だけだからである。器を作り直せば消えるが、デーモンが
   * 名乗りのたびに降ろし直す（`manager.ts` の `#pushMcpServers`）。
   *
   * **走っているセッションには届かない**（SDK の `mcpServers` は `query()` の
   * 起動時に1度だけ渡る）。次に開くセッション —— 新しい委譲と、resume・開き直し ——
   * から効く。
   */
  setMcpServers(input: unknown): RunnerMcpServersFingerprint | undefined;
  start(command: RunnerStartCommand): Promise<void>;
  /** `RunnerFenceError` を投げうる（世代が古い。呼び出し側は 409 へ変換すること）。 */
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<boolean>;
  /**
   * `delivered: false` = その確認は runner 側に無い。`decision` は確定した
   * allow/deny（#322。`decideAnswer` の doc）。同一プロセスなので常に付く。
   */
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome>;
  stop(managerId: string): Promise<void>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  /**
   * この managerId の作業ツリーが抱えている、未 push の実装と未コミットの
   * 変更を数える（Issue #1039）。セッションが無ければ `undefined`。
   *
   * ⛔ ネットワークを一切使わない。出す粒度は有無・件数・枝名と、origin
   * remote の host/path まで（host/path は Issue #1376 B2。userinfo・クエリ・
   * 資格は出さない。`unpushedWorkResultSchema` の doc）。
   */
  unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined>;
  /** 全セッションを畳む。プロセスが消えるときだけ呼ぶ。 */
  shutdown(): Promise<void>;
  /**
   * デーモンから制御面への接触があったことを知らせる（貸し出し期限の自己失効の
   * 時計を進める）。
   *
   * **呼ぶのは認証済みの制御面の呼びだけにすること。** `apps/runner/src/app.ts`
   * の `/livez` は無認証なので、そこから呼ぶと誰でも貸し出し期限を延ばせてしまう
   * （＝自己失効が機能しなくなる）。
   */
  noteDaemonContact(): void;
  /**
   * 委譲の Claude Code プロセスの pid（#1334 段1。孤児の回収が「どのセッションが
   * 生きているか」を判定する材料）。
   *
   * - `live`: **このプロセス自身**がいま生きている（起きて、まだ `exit`/`error`
   *   が来ていない）pid
   * - `knownTerminated`: **その pid を起こした委譲（`managerId`）自身が、いま
   *   この runner に生きたセッションとして残っていない** pid
   *
   * **⚠️ 2026-09（レビュー指摘・#1334）で意味を直した。** 直す前は「このプロセスが
   * `exit` した」＝即 `knownTerminated` だった。だがプロセスの寿命とセッションの
   * 寿命は一致しない —— マネージャーがターンを終えて次の指示を待つ（`done`）間も
   * その CLI プロセスは生き続ける一方、**作業者（並列で走る委譲）の1回の
   * 呼び出しは、その委譲自身がまだ生きていても普通にプロセスを終える。** 旧い
   * 定義だと、後者の pid が終わった瞬間に、その孫（`nohup` で起こしたサーバ等）
   * まで「終端済み」として撃ってよい対象に化けていた——**委譲そのものは
   * 何も終わっていないのに**、である。
   *
   * **いまは「そのプロセスを spawn したときの `managerId` が、いま `#sessions`
   * に居るか」だけで判定する**（`delegationSessionPids()` の実装）。**判定は
   * 呼ぶたびにその場で行う**——固定された「終端済み」集合を持たないので、
   * 一度こう判定されても、その `managerId` が resume で `#sessions` へ戻れば
   * 次の呼び出しからは `knownTerminated` に出なくなる（resume で同じ委譲に
   * 新しいプロセスが立っても、古いプロセスの孤児を誤って撃たないため）。
   *
   * **どちらも「このrunnerプロセスが自分で起こした」ものだけを持つ。** 器の
   * 作り直し（runner プロセスの再起動）を跨いでは持ち越さない——起動直後は
   * 両方とも空集合である。
   */
  delegationSessionPids(): { live: ReadonlySet<number>; knownTerminated: ReadonlySet<number> };
}

/**
 * {@link RunnerHost.delegationSessionPids} が pid の所有者（`managerId`）を
 * 覚えておく件数の上限。**無限には覚えない**——長時間走る runner が委譲を
 * 何千回起こしても、メモリが際限なく育たないようにする。超えたら古いもの
 * （`Map` の挿入順で先頭）から忘れる。
 *
 * **忘れた分は「不明」側へ倒れる。** 所有者が分からなければ
 * `delegationSessionPids()` はその pid を `knownTerminated` に入れない
 * （`apps/runner/src/tasks.ts` の `reapDecisionFor` は「終端済みと分かっている」
 * ものだけを撃ってよいとする）ので、忘れたセッションの残骸は（生きた委譲が
 * 0本という条件が別に成り立たない限り）撃たれずに残り続ける——保守的な側へ
 * 倒れる欠落であって、誤って撃つ側の欠落ではない。
 */
const PID_OWNER_MANAGER_ID_CAP = 4096;

/**
 * 回るとセッションの畳み直しの引き金になる鍵の名前。
 *
 * **`ROTATABLE_CREDENTIAL_KEYS`（`credentials.ts`）に載っている名前のうち、
 * ここだけを見る。** `GH_TOKEN` / `GITHUB_TOKEN` が変わっても、走行中の
 * マネージャーは次の呼び出し（`gh` シム経由）から新しい値を読むので（`git` /
 * `gh` は呼ばれるたびに器のファイルを読み直す）、セッションを畳む必要が無い
 * ——畳む理由になるのは「起動時にしか読まれない」鍵、すなわち SDK 子プロセスの
 * env 経由でしか渡らない `CLAUDE_CODE_OAUTH_TOKEN` だけである
 * （`credentials.ts` の同名エントリの doc「いま走っているターンには届かない」）。
 *
 * **型で `ROTATABLE_CREDENTIAL_KEYS` に縛ってある。** 裸のリテラルのままだと、
 * `credentials.ts` 側で名前が変わる／消えるときに、こちらは何も言わずに
 * 古い名前のまま指紋を比べ続ける——比べる対象が実在しない名前になり、
 * `fingerprintFor` は常に `undefined` を返すので `before === after` が恒真になり、
 * **畳み直しが二度と起きなくなるのに、テストも typecheck も緑のまま**という
 * いちばん静かな壊れ方をする。`(typeof ROTATABLE_CREDENTIAL_KEYS)[number]` を
 * 型注釈に付けることで、名前が消えた瞬間にこの1行が typecheck で落ちるように
 * してある。
 */
const AGENT_TOKEN_CREDENTIAL_NAME: (typeof ROTATABLE_CREDENTIAL_KEYS)[number] =
  'CLAUDE_CODE_OAUTH_TOKEN';

/** `fingerprints()` の並びから名前で1件だけ引く。無ければ `undefined`。 */
function fingerprintFor(
  fingerprints: readonly CredentialFingerprint[],
  name: string,
): string | undefined {
  return fingerprints.find((fingerprint) => fingerprint.name === name)?.sha256;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  return new Host(options);
}

class Host implements RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  /**
   * 実行環境プロファイル。
   *
   * **起こすたびに評価し直さない。** 評価はプロセスを1本起こす操作なので、
   * マネージャーを起こす経路に挟むと、人間の書いたスクリプト次第で委譲そのものが
   * 遅くなる（返ってこないスクリプトなら止まる）。差し替えの口で1度だけ評価し、
   * 結果を持つ。走行中のコマンドへも `BASH_ENV` 経由で届く（非対話の bash が
   * 起きるたびに読み直す）。**ただし全部には届かない** — マネージャーが Bash
   * ツールで打つそのシェル自体は、実測ではプロファイルを読んでいない
   * （`profile.ts` のモジュール doc）。確実な経路は `gh` シムだけである。
   */
  readonly #profile: ProfileApplier | undefined;
  readonly #sessions = new Map<string, RunnerSession>();
  /**
   * デーモンから降りてきた MCP の登録（#325 段3）と、その指紋。**置いていなければ
   * `undefined`。** 値は `#buildOptions` へ渡す以外に外へ出さない。
   */
  #mcpServers: { servers: McpServers; fingerprint: RunnerMcpServersFingerprint } | undefined;
  readonly #enforceLease: boolean;
  /**
   * 制御面（認証済みの呼び）から最後に接触があった時刻。
   *
   * **起動直後は「今」を起点にする。** 何も知らない時刻をゼロや過去に見積もると、
   * デーモンが1度も繋いでいない起動直後のセッションまで即座に自己失効しうる
   * （`lease.ts` の `instanceSince` と同じ「知らない時刻を過去に見積もらない」
   * という判断）。
   */
  #lastDaemonContact = Date.now();
  /** 貸し出し期限の自己失効を見張る1本。**`shutdown()` で必ず畳む。** */
  #leaseWatcher: ReturnType<typeof setInterval> | null = null;
  /**
   * 委譲の Claude Code プロセスの pid 帳（#1334 段1）。
   * {@link RunnerHost.delegationSessionPids} の doc を見よ。
   *
   * `#pidOwnerManagerId` は「その pid を spawn したのはどの `managerId` か」を
   * 覚える帳——`knownTerminated` はここから**呼ばれるたびに**導く（固定した
   * 集合として持たない）。持てば「一度終端した」を覚え続けることになり、
   * resume で同じ `managerId` の委譲が `#sessions` へ戻っても古い pid が
   * 「終端済み」のままになる（レビュー指摘）。
   */
  readonly #liveDelegationPids = new Set<number>();
  readonly #pidOwnerManagerId = new Map<number, string>();
  readonly #spawnClaudeCodeProcessFn:
    ((options: SpawnClaudeCodeProcessOptions) => DelegationProcessHandle) | undefined;
  readonly #readCgroupEventCountersFn: (() => Promise<CgroupEventCounters>) | undefined;
  readonly #finishUnpushedWorkFn:
    ((options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>) | undefined;

  constructor(options: RunnerHostOptions) {
    this.runnerId = options.runnerId;
    this.workspacePath = options.workspacePath;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn ?? query;
    this.#env = options.env ?? process.env;
    this.#withheldEnvKeys = [...WITHHELD_ENV_KEYS, ...(options.withheldEnvKeys ?? [])];
    this.#childUser = options.childUser;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode ?? resolvePermissionMode(this.#env);
    this.#enforceLease = options.enforceLease ?? false;
    this.#spawnClaudeCodeProcessFn = options.spawnClaudeCodeProcessFn;
    this.#readCgroupEventCountersFn = options.readCgroupEventCountersFn;
    this.#finishUnpushedWorkFn = options.finishUnpushedWorkFn;
    if (this.#enforceLease) {
      const watcher = setInterval(() => this.#checkLeaseExpiry(), LEASE_WATCH_INTERVAL_MS);
      // 見張りでプロセスの終了を引き延ばさない（このリポジトリの既存のタイマーが
      // 全部そうしている）。
      watcher.unref?.();
      this.#leaseWatcher = watcher;
    }
    this.#profile =
      options.profile === undefined
        ? undefined
        : createProfileApplier({
            vessel: options.profile,
            baseEnv: () => this.#baseChildEnv(),
            // **器が約束している分だけを検査する**（既定）。Host が env から落とす
            // 一覧（`#withheldEnvKeys`）とは役割が違う — あちらは配るときの最後の
            // 一枚で、こちらは「器が書いた `unset` が本当に効いたか」の実測である。
            // 読むのは SDK 子プロセスと同じ主体である。root で読めても意味がない
            // （降りた先では読めないプロファイルを「置けた」と報告することになる）。
            ...(this.#childUser === undefined
              ? {}
              : { spawnFn: (spawnOptions) => this.#spawnAsChildUser(spawnOptions) }),
          });
  }

  credentials(): CredentialFingerprint[] {
    return this.#credentials?.fingerprints() ?? [];
  }

  /** 制御面から接触があった。貸し出し期限の自己失効の時計を進める。 */
  noteDaemonContact(): void {
    this.#lastDaemonContact = Date.now();
  }

  delegationSessionPids(): { live: ReadonlySet<number>; knownTerminated: ReadonlySet<number> } {
    // **呼び出し元へは写しを返す。** `apps/runner/src/tasks.ts` はこれを
    // `reclaim.reap.liveSessionPidsOf()` 等から毎回呼び直すだけの想定で、
    // 書き換える理由は無いはずだが、内部の集合そのものへの参照を渡すと
    // 「渡した後に書き換えられない」という前提が呼び出し側の実装に依存してしまう。
    //
    // **`knownTerminated` はここで毎回、その場で導く。** pid 自身が `exit` した
    // かどうかではなく、**その pid を spawn した `managerId` が、いまこの
    // `#sessions`（＝生きた委譲のマップ）に残っているか**だけで決める——
    // 残っていれば（`done` でターンの間に挟まっているだけ・resume で戻ってきた
    // 等）、その pid が指す委譲は終端していないので `knownTerminated` には
    // 入れない。`live` にまだ在る pid はここでは弾く必要が無い——弾かなくても
    // 「所有者は `#sessions` に居る」がほぼ必ず成り立つが、念のため二重に見る。
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

  /** 委譲の Claude Code プロセスが起きた（{@link RunnerSessionOptions.onDelegationProcessSpawned}）。 */
  #noteDelegationProcessSpawned(pid: number, managerId: string): void {
    this.#liveDelegationPids.add(pid);
    // **挿入順を今に更新してから覚える**（`Map` は挿入順を保つ——`delete` して
    // からの `set` で「いま覚えた」扱いに更新する。pid が再利用された場合の
    // 所有者の付け替えも兼ねる）。
    this.#pidOwnerManagerId.delete(pid);
    this.#pidOwnerManagerId.set(pid, managerId);
    // **上限を超えたら、挿入順で古いものから忘れる**（`Map` は挿入順を保つ）。
    // 忘れた分の帰結は {@link PID_OWNER_MANAGER_ID_CAP} の doc を見よ。
    while (this.#pidOwnerManagerId.size > PID_OWNER_MANAGER_ID_CAP) {
      const oldestPid = this.#pidOwnerManagerId.keys().next().value;
      if (oldestPid === undefined) break;
      this.#pidOwnerManagerId.delete(oldestPid);
    }
  }

  /** 委譲の Claude Code プロセスが終わった（{@link RunnerSessionOptions.onDelegationProcessExited}）。 */
  #noteDelegationProcessExited(pid: number): void {
    this.#liveDelegationPids.delete(pid);
    // **ここでは `knownTerminated` 側を1文字も触らない。** そちらは
    // `delegationSessionPids()` が呼ばれるたびに、pid の所有者（`managerId`）が
    // いま `#sessions` に居るかどうかから導く——**このプロセス自身が終わった
    // ことは、その委譲そのものが終端したことを意味しない**（レビュー指摘。
    // `RunnerHost.delegationSessionPids` の doc）。所有者の記録
    // （`#pidOwnerManagerId`）は消さずに残す——消すと、後でこの委譲が本当に
    // 終端したときに、この pid を `knownTerminated` へ回す手がかりが無くなる。
  }

  /**
   * 貸し出し期限が切れたセッションを自分で畳む（roadmap M5 PR4 の自己失効）。
   *
   * **`lease` を伴わずに起こされたセッションは見ない**（`leaseTtlMs` が
   * `undefined`）。`enforceLease` が有効でも、世代の約束をしていないセッションを
   * 理由なく畳まない。
   */
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
        /*
         * **畳むのに失敗したことを黙って落とさない。**
         *
         * `selfFence` → `#finish` は生ログの退避（実 I/O）を挟むので落ちうる。ここは
         * `setInterval` のコールバックなので、握らないと unhandled rejection になって
         * **器のログにしか出ない**（デーモンには何も届かない）。しかも落ちた場合は
         * セッションが畳まれていない可能性があり、**引き取る側は「相手は自分で畳んだ」
         * という前提で期限を数えている** — つまりここは前提が崩れた瞬間そのものなので、
         * 上へ言うのが唯一の出口である。
         */
        .catch((error: unknown) => {
          this.#emit({
            type: 'note',
            managerId,
            text: `貸し出し期限の自己失効に失敗した（このセッションは畳まれていない可能性がある）: ${String(error)}`,
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
    // **差し替える前の指紋を控える。** `this.#credentials.set(...)` が投げたら
    // ここで確定した `before` は使われないまま終わる —— 例外はそのまま呼び出し
    // 元へ伝播させる（`POST /credentials` の応答を壊さない）。
    const before = fingerprintFor(this.#credentials.fingerprints(), AGENT_TOKEN_CREDENTIAL_NAME);
    const fingerprints = await this.#credentials.set(entries);
    const after = fingerprintFor(fingerprints, AGENT_TOKEN_CREDENTIAL_NAME);
    // **🔴 比べるのは指紋（sha256）だけ。値は一度も読まない。**
    //
    // **変わったときだけ畳む。** 在る→無い（`value: ''` で env 行へ戻す）・
    // 無い→在るも「変わった」に含まれる —— `fingerprintFor` は無ければ
    // `undefined` を返すので、`undefined !== 'hash'` はどちらの向きでも
    // 真になる。**同じ指紋（再接続の追いつかせが同じ値を降ろした場合を含む）
    // では何もしない**（`RunnerHost.setCredentials` の doc）。
    if (before !== after) {
      for (const session of this.#sessions.values()) session.recycleForToken();
    }
    return fingerprints;
  }

  profile(): RunnerProfileFingerprint | undefined {
    return this.#profile?.fingerprint();
  }

  /**
   * プロファイルを置き換える。**置く前に1度評価する。**
   *
   * 評価せずに置くと、構文を間違えたスクリプトが `BASH_ENV` に載り、以後
   * すべてのコマンドが壊れた環境で走る。しかも失敗はコマンドの出力に紛れるので、
   * 人間は「なぜか動かない」としか分からない。**壊れているなら置かずに、
   * 理由を返す**（前のプロファイルはそのまま残る）。
   */
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
    // **検査の正本を1つにする。** デーモンの器（`McpServerStore.write`）も同じ関数を
    // 通しているが、ここは制御面の入口なので、届いたものを信じずにもう一度通す
    // （文言に値は載らない —— `parseMcpServers` の doc）。
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

  /**
   * プロファイルを重ねる前の env。鍵まで載せた状態で評価する。
   *
   * 素の `process.env` で評価すると、プロファイルの中で `gh` を叩くような書き方
   * （`eval "$(gh auth token)"` 等）が評価時だけ失敗する。実際に配る env と
   * 同じものを渡す。
   */
  #baseChildEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  /** 子プロセスを別 UID で起こす（プロファイルの評価も同じ主体で行う）。 */
  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  #create(managerId: string, request: string, cwd: string): RunnerSession {
    const session = new RunnerSession({
      managerId,
      request,
      cwd: cwd.length > 0 ? cwd : this.workspacePath,
      emit: this.#emit,
      queryFn: this.#queryFn,
      env: this.#env,
      withheldEnvKeys: this.#withheldEnvKeys,
      ...(this.#childUser === undefined ? {} : { childUser: this.#childUser }),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      permissionMode: this.#permissionMode,
      profileEnv: () => this.#profile?.env() ?? {},
      mcpServers: () => this.#mcpServers?.servers,
      onClosed: () => this.#sessions.delete(managerId),
      onDelegationProcessSpawned: (pid) => this.#noteDelegationProcessSpawned(pid, managerId),
      onDelegationProcessExited: (pid) => this.#noteDelegationProcessExited(pid),
      ...(this.#spawnClaudeCodeProcessFn === undefined
        ? {}
        : { spawnClaudeCodeProcessFn: this.#spawnClaudeCodeProcessFn }),
      ...(this.#readCgroupEventCountersFn === undefined
        ? {}
        : { readCgroupEventCountersFn: this.#readCgroupEventCountersFn }),
      ...(this.#finishUnpushedWorkFn === undefined
        ? {}
        : { finishUnpushedWorkFn: this.#finishUnpushedWorkFn }),
    });
    this.#sessions.set(managerId, session);
    return session;
  }

  async start(command: RunnerStartCommand): Promise<void> {
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    try {
      // **新しいセッションなので拒む判定は起きない。** `checkFence` は
      // 「まだ世代を覚えていない」ときは無条件に覚えるだけである
      // （`RunnerSession#checkFence` の doc）。
      session.checkFence(command.lease);
      session.begin(command.request);
    } catch (error) {
      this.#sessions.delete(command.managerId);
      throw error;
    }
  }

  /**
   * 中断されたセッションの続きへ戻す。**`RunnerFenceError` を投げうる。**
   *
   * 既に同じ manager が走っているなら（デーモンだけが再起動した場合）、何もせず
   * 追加の一言だけを流す。**走っているものを resume で作り直さない** — 手を
   * 動かしている最中のマネージャーを二重に起こすことになる。
   *
   * **世代の検査はこの短絡の手前に置く。** 古い世代の resume が来たら
   * `checkFence` が投げ、その時点でまだ何もしていない（`push` を呼ぶ前）ので、
   * 走っているセッションは1文字も影響を受けない。新しい世代なら世代だけ
   * 覚え直し、同じ短絡（作り直さずに一言だけ流す）へそのまま合流する。
   */
  async resume(command: RunnerResumeCommand): Promise<void> {
    const alive = this.#sessions.get(command.managerId);
    if (alive) {
      alive.checkFence(command.lease);
      if (command.message !== undefined) alive.push(command.message);
      return;
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    // **この Host インスタンスにとっては初めて見るセッション**（器の入れ替え・
    // デーモンの再起動後の resume）なので、比べる前の世代が無い。拒む判定は
    // 起きず、覚えるだけになる（`start` と同じ形）。
    session.checkFence(command.lease);
    session.resume(command.sessionId, command.entries, command.message);
  }

  async send(managerId: string, text: string): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (!session) return false;
    session.push(text);
    return true;
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

  async shutdown(): Promise<void> {
    // **見張りを先に畳む。** 畳み残すと、この後 `#sessions.clear()` で空になった
    // 名簿を、止まったはずの見張りが叩き続ける（名簿は空なので実害は無いが、
    // テストならタイマーが残ってハングする — `runner-protocol.ts` の `Registry#stop`
    // と同じ理由）。
    if (this.#leaseWatcher !== null) clearInterval(this.#leaseWatcher);
    this.#leaseWatcher = null;
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.stop('runner が停止した。')),
    );
    this.#sessions.clear();
  }
}

/**
 * 解決済みの確認を覚えておく件数。**セッション1本ぶんの上限**である。
 *
 * 帳面はセッションと一緒に消えるので、寿命は元から有限。ここで件数にも蓋を
 * するのは、1本が異常に長く走ったときのためで、達したら `note` で上へ言う。
 */
const RESOLVED_MEMORY_LIMIT = 512;

/**
 * 上へ降ろした拒否を覚えておく件数。**セッション1本ぶんの上限**である。
 *
 * 同じ拒否は2つの経路で届く（走行中の合図と `result` の記録）ので、`tool_use_id`
 * で二度目を落とす。帳面はセッションと一緒に消えるので寿命は元から有限で、
 * 件数の蓋は1本が異常に多く拒否されたときのため。達したら `note` で上へ言う。
 */
const DENIED_MEMORY_LIMIT = 512;

/**
 * `CUT_OFF_WORKERS_LIMIT` / `PENDING_CUT_OFF_NOTIFICATIONS_LIMIT`（#901）の
 * 定義は `runner-cut-off-workers.ts` へ切り出した（Issue #1190 段0）。どちらも
 * 元から `export` していなかったので（テストからの直参照が無い）、再輸出は
 * していない。
 */

/**
 * `#onSubagentStop` が `note` の `text` へ積む文字数の上限（#357）。
 *
 * **黙って落とさない**（AGENTS.md「静かに失敗する道具」）。超えたら切り、
 * 切ったこと自体を末尾に書く。日誌1行が背景処理の一覧で際限なく伸びるのを
 * 防ぐための締め切りであって、観測そのものを狭める意図ではない。
 */
const SUBAGENT_STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * `#onStop` が `note` の `text` へ積む文字数の上限（#861）。
 *
 * **値は `SUBAGENT_STOP_NOTE_TEXT_LIMIT` と同じだが、別の定数にしてある。**
 * 片方を動かしたときに、もう片方が黙って一緒に動かないためである —— 2つの
 * フックが積む一覧は長さの事情が違う（あちらは「当人が起こした分」だけに
 * 絞られるが、こちらは**セッション全体の在庫**が載る）。
 *
 * **黙って落とさない**（AGENTS.md「静かに失敗する道具」）。超えたら切り、
 * 切ったこと自体を末尾に書く。
 */
const STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * **所有者を控えられる**背景処理の種類（`BackgroundTaskSummary.type`）の名簿
 * （#570 / #861）。
 *
 * ## ⭐ ここが測るのは「性質」であって「実例」ではない
 *
 * 所有者を控える経路は `#recordBackgroundTaskOwner` ただ1本で、そこが読むのは
 * `PostToolUse` の `tool_response.backgroundTaskId` **だけ**である。⟹ 「所有者を
 * 引けないのが正常」かどうかを決めているのは、**その背景処理を起こした道具の出力が
 * このキーを持つか**という性質であって、`type` の綴りではない。
 *
 * **実測（SDK 0.3.269 同梱の型定義。`grep -Fc -- 'backgroundTaskId' sdk-tools.d.ts`
 * が 4185行中 1件）**: このキーを持つ出力は `BashOutput` ただ1つである。背景処理を
 * 作る他の道具はどれも別のキーで id を返す。
 *
 * | 背景処理を作る道具の出力 | id のキー | 表に載るか | `type` |
 * | --- | --- | --- | --- |
 * | `BashOutput`（`Bash` の `run_in_background`） | `backgroundTaskId` | **載る** | `shell` |
 * | `AgentOutput`（`Task`。`status: "async_launched"`） | `agentId` | 載らない | `subagent` |
 * | `AgentOutput`（`Task`。`status: "remote_launched"`） | `taskId` | 載らない | ⚠️ 未測定 |
 * | `MonitorOutput`（`Monitor`） | `taskId` | 載らない | `monitor` |
 * | `WorkflowOutput`（`Workflow`） | `taskId` | 載らない | `workflow` |
 *
 * **⚠️ 表のうち実測は「id のキー」の列だけである**（型定義を直接読んだ）。`type` の列は
 * 下の逐語（友好名の例）から読んだもので、**フックの実物の JSON では確かめていない。**
 * 遠隔の `Task` の行を「未測定」にしてあるのは、`WorkflowOutput.taskType` の逐語が
 * 遠隔ぶんを `'remote_agent'` と名乗る一方、その値が `BackgroundTaskSummary.type` の
 * 友好名でどう出るかがどこにも書かれていないためである。**どちらに出ても判定は変わらない**
 * —— この名簿は引ける側だけを数えるので、`shell` 以外はすべて「控えられないのが正常」へ倒れる。
 *
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
 *
 * ## ⚠️ なぜ `type !== 'subagent'` では足りなかったか（この名簿を置いた理由）
 *
 * PR #594 は「表に無いのが正常」な実例として `subagent`（委譲そのもの）**だけ**を
 * 除外した。しかし上の表のとおり、その性質を持つ種類は `subagent` のほかにもある
 * （`monitor` / `workflow` / 遠隔の `Task`）。⟹ 除外は**性質ではなく実例の1つ**を
 * 測っており、`Monitor` / `Workflow` を1度でも起こしたセッションでは、**設計どおりに
 * 動いているのに「所有者を引く経路が壊れた」という診断が出る。**
 * ⭐ しかも遠隔の `Task` は、その除外が守ろうとした当の道具である。
 *
 * **どちらの道具もマネージャーと作業者の手元に在る** ——
 * `buildManagerSessionOptions`（`claude-provider.ts`）は `tools` を渡さない（preset 全部）、
 * 作業者の `AgentDefinition` にも `tools` を書かない（親の全ツールを継承）。
 *
 * ## ⛔ ここへ「引けなかった種類」を足さないこと
 *
 * これは**引ける側**の名簿である。新しい道具が背景処理を作るようになっても、その出力が
 * `backgroundTaskId` を返さない限りここは増えない。増えるのは
 * `#recordBackgroundTaskOwner` が読むキーを増やしたときだけである。
 * **名簿と現物がずれたら赤くなる歯が在る**（`background-task-owner-roster.test.ts`）。
 */
export const OWNER_RECORDABLE_TASK_TYPES: ReadonlySet<string> = new Set(['shell']);

/**
 * その背景処理の**所有者を控えられる種類か**（`OWNER_RECORDABLE_TASK_TYPES`）。
 *
 * **`false` は「壊れている」ではなく「控えられないのが正常」である。**
 * `#noteOwnerLookupFailure` と `#stopTaskOwnerKind` の両方から引く ——
 * 片方だけ直すと、同じ問いに2つの答えが出る。
 */
function isOwnerRecordableTaskType(type: unknown): boolean {
  return typeof type === 'string' && OWNER_RECORDABLE_TASK_TYPES.has(type);
}

/**
 * `BackgroundTaskSummary.status` のうち「**もう終わっている**」を表す語。
 *
 * **語彙の出所は SDK の型である。** `BackgroundTaskSummary.status` そのものは
 * `status: string`（自由文字列）で語彙を名乗っていないが、同じ `TaskState` の
 * status を運ぶ `SDKTaskUpdatedMessage.patch.status` は語彙を型で持っている
 * （逐語。`patch` の doc が「Wire-safe subset of TaskState fields that changed」と
 * 言っているとおり、こちらが `TaskState` 側の語彙である）:
 *
 * [sdk-verbatim SDKTaskUpdatedMessage.patch.status]
 * > status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
 *
 * ⟹ 6語を「終わった」（ここ）と「走っている」（`LIVE_BACKGROUND_TASK_STATUSES`）へ
 * 割る。**語彙が増えたら `runner-subagent-stop.test.ts` の型の歯が `pnpm typecheck`
 * を落とす** —— 逐語の印（上）は文言が変わったときにしか落ちないので、語彙が
 * *増えた* ときに落ちる口を別に置いてある。
 */
const SETTLED_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
]);

/**
 * `BackgroundTaskSummary.status` のうち「**まだ終わっていない**」を表す語
 * （出所は `SETTLED_BACKGROUND_TASK_STATUSES` の doc）。
 *
 * `paused` をこちら側へ置いてあるのは意図である —— 止まっているだけで、
 * 畳めば置き去りになるほうだからである。
 */
const LIVE_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
]);

/**
 * 背景タスク1件の `status` を「走っている／終わった／**分からない**」の3つへ
 * 言い分ける（#570 の追跡）。
 *
 * **3つ目を潰さないことが本題である。** `BackgroundTaskSummary.status` は
 * `string` なので、SDK が語彙を足した・改名した回にここへ落ちる。そのとき
 * `'settled'` へ倒すと**起こし直しが黙って効かなくなる**（能力が消える）ので、
 * `'unknown'` は呼び出し側で「走っている」と同じ扱いにし、**分からなかったこと
 * 自体を `note` に書く**。この repo の門が「落ちた（exit 1）」と「走っていない
 * （exit 3）」を別の数字で出すのと同じ作法である。
 */
function classifyBackgroundTaskStatus(status: unknown): 'live' | 'settled' | 'unknown' {
  if (typeof status !== 'string') return 'unknown';
  if (SETTLED_BACKGROUND_TASK_STATUSES.has(status)) return 'settled';
  if (LIVE_BACKGROUND_TASK_STATUSES.has(status)) return 'live';
  return 'unknown';
}

/** 返事を待って止まっている1件（許可確認 or 質問）。 */
interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
  /**
   * **runner がこの確認を SDK から受け取った時刻**（ISO8601, UTC）。
   *
   * 値の持ち主はここ（`#onPermission` が組み立てる瞬間）1つだけである。
   * `state()` もデーモン向けの `ask` イベントも、ここで確定した値をそのまま
   * 運ぶだけで**取り直さない**——デーモン再起動後の引き取り（`state()` 経由）
   * のたびに取り直すと、待っている時間の長さという、この値を持たせた理由
   * そのものが消える（#334）。
   */
  askedAt: string;
  settle: (answer: { message: string; decision?: 'allow' | 'deny' }) => void;
  /** 同じ確認が再送されたときに同じ結果を返すための約束（SDK は再送しうる）。 */
  result: Promise<PermissionResult>;
}

/** `spawnClaudeCodeProcess`（SDK の型 `SpawnOptions`）と同じ形。ここだけで書き写す理由は `spawnAsUser` の doc を見よ。 */
type SpawnClaudeCodeProcessOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
};

/**
 * `spawnClaudeCodeProcess` が返す実体（#1334 段1）。
 *
 * **SDK の `SpawnedProcess` 型そのものは `pid` を持たない**（呼び出し側が
 * プロセスの素性を覗く経路にしないため、と読める）。だがここでは「起きた／
 * 終わったこと」を pid で追跡する必要があるので、**本物の実装（`spawnAsUser`
 * が返す Node の `ChildProcess`）が実際に持っている `pid` を、型の側でも
 * 見えるようにしておく**——`SpawnedProcess` の約束（`stdin` / `stdout` / `kill`
 * / `on` / `once` / `off`）はそのまま引き継ぐ交差型である。
 */
type DelegationProcessHandle = SpawnedProcess & { pid?: number };

interface RunnerSessionOptions {
  managerId: string;
  request: string;
  cwd: string;
  emit: (event: RunnerEvent) => void;
  queryFn: typeof query;
  env: NodeJS.ProcessEnv;
  withheldEnvKeys: readonly string[];
  childUser?: RunnerChildUser;
  credentials?: CredentialStore;
  permissionMode: ManagerPermissionMode;
  /**
   * プロファイル由来の env（評価済みの差分＋`BASH_ENV` などの所在）。
   *
   * **関数で受ける。** 走行中に差し替わるので、値で渡すと後から起こした
   * マネージャーだけが古い環境で走る。
   */
  profileEnv: () => Record<string, string>;
  /**
   * デーモンから降りてきた MCP の登録（#325 段3）。置いていなければ `undefined`。
   *
   * **関数で受ける**（`profileEnv` と同じ理由）。値で渡すと、セッションを作った後に
   * 降りた登録が、そのセッションの resume・開き直しにも届かない。
   */
  mcpServers: () => McpServers | undefined;
  onClosed: () => void;
  /**
   * 委譲の Claude Code プロセス（`spawnClaudeCodeProcess`）が起きた／終わった
   * ことを知らせる（#1334 段1）。**`childUser` が無ければ呼ばれない**——
   * `spawnClaudeCodeProcess` 自体が SDK へ渡らないため（`#buildOptions` の
   * `childUser === undefined` 分岐）。孤児の回収（`apps/runner/src/tasks.ts`）が
   * 「このセッション pid は生きた委譲のものか、終端した委譲のものか」を判定する
   * 材料は、ここで届く pid だけである。
   */
  onDelegationProcessSpawned?: (pid: number) => void;
  onDelegationProcessExited?: (pid: number) => void;
  /**
   * `spawnClaudeCodeProcess` の実体をテストから差し替える（#1334 段1）。
   *
   * **主にテスト用。** 既定は本物の `spawnAsUser`（`detached: true`＝新しい
   * セッションの長として起こす）。本物は特権（UID を降ろす）を要る実プロセス
   * 生成なので、CI のテストからは直接固定できない——差し替え口を挟むことで、
   * 「起きた／終わった」をこの層の外へ知らせる配線（pid 追跡）だけを、実
   * プロセス無しで固定できるようにしてある。
   */
  spawnClaudeCodeProcessFn?: (options: SpawnClaudeCodeProcessOptions) => DelegationProcessHandle;
  /**
   * `pids.events` / `memory.events` を読む実体をテストから差し替える
   * （Issue #1517「最小の形」1）。**主にテスト用**（`queryFn` /
   * `spawnClaudeCodeProcessFn` と同じ理由）。既定は本物
   * （`runner-resources.ts` の `readCgroupEventCounters`、既定の
   * `/sys/fs/cgroup` を読む）。
   */
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  /**
   * `#finish()` が `closed` を emit する直前に取る未 push の観測の実体を
   * テストから差し替える（Issue #1266 候補(2)）。**主にテスト用**
   * （`readCgroupEventCountersFn` と同じ理由——既定は本物の
   * `this.unpushedWork(options)` で、内側の `computeUnpushedWork` は
   * `cwd` の下を実際に読みに行く実 I/O（`fs`）を含む。`vi.useFakeTimers()`
   * の下で走る歯は、フェイクタイマーが進めるのは fake timer のコールバック
   * だけで実 I/O の完了は実時間でしか進まないため、`vi.advanceTimersByTimeAsync`
   * 直後の assertion が `#finish()` の完了より先に走ってしまう
   * （`readCgroupEventCountersFn` の doc・`runner-fence.test.ts` の同じ注記と
   * 同型の実測）——そちらはこれを速い偽物へ差し替える。
   */
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
}

/**
 * `RunnerSession#finish()` が `closed` を emit する直前に取る未 push の観測
 * （Issue #1266 候補(2)）へ渡す期限。
 *
 * `manager.ts` の `UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS`（Issue #1266 の
 * (4)）と同じ値・同じ理由——実測に基づく値ではなく、安全側に短く取った
 * 未検証の既定値である。**値を共有する定数にはしていない**——`manager.ts`
 * から `runner.ts` を import する既存の向き（`tools.ts` が `manager.ts` を
 * import する側なのと同じ形。あちらの `MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS`
 * も同じ理由で値を重複させている）を、逆向きの import を増やさずに守る
 * ための重複であって、新しい値の判断ではない。
 */
const FINISH_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

/**
 * `RunnerSession#finish()` が `closed` イベントへ運ぶ、未 push の観測1回分の
 * 結果（Issue #1266 候補(2)）。`manager.ts` の `ManagerUnpushedWork` と同じ
 * 形——`runner-protocol.ts` の `closed.unpushedWork` のワイヤー形にそのまま
 * 対応する（`manager.ts` を import せずに同じ形を作るため、ここで独立に
 * 定義している。`runner.ts` → `manager.ts` の逆向き import を増やさない）。
 */
type FinishUnpushedWorkOutcome =
  | { readonly kind: 'ok'; readonly result: UnpushedWorkResult }
  | { readonly kind: 'unavailable'; readonly reason: string };

class RunnerSession {
  readonly #id: string;
  readonly #request: string;
  readonly #cwd: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  readonly #profileEnv: () => Record<string, string>;
  readonly #mcpServers: () => McpServers | undefined;
  readonly #onClosed: () => void;
  readonly #onDelegationProcessSpawned: (pid: number) => void;
  readonly #onDelegationProcessExited: (pid: number) => void;
  readonly #spawnClaudeCodeProcessFn: (
    options: SpawnClaudeCodeProcessOptions,
  ) => DelegationProcessHandle;
  readonly #readCgroupEventCountersFn: () => Promise<CgroupEventCounters>;
  /**
   * `#finish()` が `closed` を emit する直前に取る未 push の観測の実体
   * （Issue #1266 候補(2)）。既定は `this.unpushedWork(options)`（本物の
   * `computeUnpushedWork`）——`RunnerSessionOptions.finishUnpushedWorkFn` の
   * doc を見よ。
   */
  readonly #finishUnpushedWorkFn: (options?: {
    signal?: AbortSignal;
  }) => Promise<UnpushedWorkResult>;
  /**
   * このセッションが**この runner プロセスの中で**開いたときの cgroup の
   * 累計カウンタ（Issue #1517「最小の形」1）。**コンストラクタで一度だけ
   * 読む**——`start`（新しい委譲）と `resume`（この `Host` インスタンスに
   * とって初めて見るセッション）のどちらも `Host#create` が新しい
   * `RunnerSession` を作るので、どちらの経路でも「開いたとき」が指す時点は
   * 一致する。
   *
   * **`Promise` のまま持つ。** コンストラクタは同期なので、fs 読み取り
   * （非同期）を待たずに構築を終える——`#finish()` 側で待つ。読めなかった
   * 軸は `CgroupEventCounters` の欄が省かれるだけで、この `Promise` 自体は
   * 拒否しない（`readCgroupEventCounters` は例外を投げない）。
   */
  readonly #openedCgroupEvents: Promise<CgroupEventCounters>;

  readonly #input: SDKUserMessage[] = [];
  readonly #pending: PendingRequest[] = [];
  /**
   * **解けた確認と、そのときの結果。**
   *
   * `#pending` は「いま待っている」ものしか持たない。解けた瞬間に消えるので、
   * それだけを見て重複を判定すると、**解決後の再送が新しい確認になる** —
   * クローンへ二度目が届き、その再送は SDK 側で既に中断済みなので即 `settle` し、
   * デーモンは `waiting` からそれを消す。答えたクローンには「待っていない」と
   * 返る。「解決した」という事実が runner 側に残っていないことが原因である。
   *
   * だから覚える。再送には**同じ結果をそのまま返す**（`ask` は出さない）。
   * 帳面はセッションと一緒に消え、件数にも上限がある（`RESOLVED_MEMORY_LIMIT`）。
   */
  readonly #resolved = createRecentMap<PermissionResult>({
    limit: RESOLVED_MEMORY_LIMIT,
    // **忘れたことを黙らない。** 忘れた id の再送はもう一度クローンへ出るので、
    // ここが記録に無いと「なぜ二度届いたのか」を誰も辿れない。
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
  /**
   * 上へ降ろした拒否の `tool_use_id`。
   *
   * 同じ1件が**走行中の合図**（`system/permission_denied`）と**ターン終わりの
   * 記録**（`result.permission_denials`）の両方に載る。しかも `result` が
   * 累積かどうかは SDK の型に書かれていない（`modelUsage` には「累積」と明記が
   * あるが、こちらには無い）ので、**どちらでも壊れないように id で落とす**。
   *
   * **値は「その id について、入力を持つ記録を既に降ろしたか」である。**
   * `true` を置くだけだと「降ろした」しか覚えられず、**入力を持たない
   * `via: 'live'` が先に鍵を立てたとき、入力を持つ `via: 'result'` を
   * 区別できずに捨てる**（それが直している穴である）。`false` のまま残って
   * いる id にだけ、後から形を1度足す（`#noteDenial`）。
   */
  readonly #denied = createRecentMap<DeniedRecord>({
    limit: DENIED_MEMORY_LIMIT,
    // **忘れたことを黙らない。** 忘れた id が `result` にもう一度載っていれば、
    // 同じ拒否が新しい拒否として上がる（デーモン側の件数も二重に増える）。
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
  /**
   * resume/seed の状態4フィールド（`#seed` / `#resumeAttempt` / `#sessionId` /
   * `#progressed`）の器（Issue #1190 案X で `runner-resume-state.ts` へ
   * 切り出した。前例は PR #1551 / #1523）。**SDK セッションをいつ開く／畳むか・
   * `#emit` するかどうかの判断はこれまでどおりここ（`RunnerSession`）が持ち、
   * この器は状態だけを持つ。** 何を持っているか・切り出しの理由と限界は
   * `RunnerResumeState` 自身の doc を見よ。
   */
  readonly #resumeState = new RunnerResumeState();
  /**
   * 開いている入力ストリームの世代。
   *
   * resume に失敗して新しいセッションを開くと、前の `#inputStream` がまだ
   * `#input` を待っている。世代を進めて畳まないと、新しいセッション宛の指示を
   * 死んだストリームが横取りする。
   */
  #generation = 0;

  /**
   * いま開いている作業者への委譲（Task）の `task_id` 集合。
   *
   * `task_started` で追加、`task_notification` で削除する。**`skip_transcript:
   * true` の `task_started`（SDK の JSDoc 曰く ambient = activity ではない task）も
   * 間引かずに数える** — 何を除外してよいかの判断を誰も持っていないので、
   * 数える側では絞らない。
   */
  #openTasks = new Set<string>();

  /**
   * いま開いている委譲区間（`worker_wait` の集計。`runner-protocol.ts` の
   * `worker_wait` イベントと同じ形で溜める。`sources` だけ `Map` にしてあるのは
   * 途中で加算し続けるため）。
   *
   * `#openTasks` が 0→1 になった瞬間に開く。**閉じるのは `#openTasks` が空に
   * なった瞬間ではない** — 最後の完了通知そのものを契機に回ったターン（実際に
   * 仕事をする回）を数え落とさないため、`#windowClosing` を立てて次の `result`
   * でそのターンを数えてから閉じる（`#closeWorkerWaitWindow`）。
   */
  #window: {
    openedAt: string;
    tasks: number;
    turns: number;
    byCause: { input: number; notification: number; continuation: number };
    toolless: number;
    notifications: number;
    submits: number;
    sources: Map<string, number>;
  } | null = null;

  /**
   * `#openTasks` が空になった。**その場では `#window` を閉じない。**
   *
   * 次の `result` でそのターンを数えてから `#closeWorkerWaitWindow` を呼ぶ。
   * `#onTaskStarted` が閉じ待ちの間に次の委譲が始まったのを見つけたら、
   * 閉じずに取り消す（同じ区間として続ける）。
   */
  #windowClosing = false;

  /**
   * **起こし直しの上限で打ち切った作業者を追う2フィールドの器**（Issue #1190
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
  readonly #inputWaiters = new Set<() => void>();
  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #status: JobStatus = 'running';
  /**
   * SDK が失敗として出したのに、枠の文言としては分類できなかった回の帳面
   * （Issue #393。`種別 → 件数`）。
   *
   * **セッション1本ぶんである。** プロセス単位で畳むと、器が入れ替わって新しい
   * 失敗が始まっても「前に見たから」で黙る（`noteUnclassifiedFailure` の doc）。
   *
   * **これは計器であって、何も分岐させない。** 分類できたときに `usage_notice`
   * を出す判断も、回し手へ渡すものも、1文字も変えていない。
   */
  readonly #unclassifiedFailures = new Map<string, number>();
  /**
   * いま起こしっぱなしの背景処理（`agent-events.ts` の
   * `AgentBackgroundTasksEvent`）。**REPLACE 意味論**——SDK の JSDoc が
   * 「missed bookend cannot wedge a stale running indicator」と言っている [sdk-verbatim SDKBackgroundTasksChangedMessage]
   * とおり、届いた `tasks` で丸ごと入れ替える。加算・削除の差分計算はしない。
   *
   * **空へ戻すのは「器（CLI プロセス）が本当に入れ替わったとき」だけ**
   * ——契機は3つに限る:
   *
   * 1. フィールド初期化（このデフォルト値）——新しい `RunnerSession`
   *    インスタンス＝新しい器
   * 2. `#open()` が実際に SDK セッションを開いた／開き直したとき
   *    （`#open()` のコメント）
   * 3. `init`（`session_started`）が来て、`event.sessionId` が直前の
   *    `#resumeState.sessionId` と違っていたとき（`case 'session_started'` の
   *    コメント）
   *
   * **⚠️ 以前はここに「`session_started` で必ず空に戻す」と書いてあったが、
   * それは誤りだった。** `init` はターンの頭ごとに来る（`SDKSystemMessage`
   * の JSDoc）のであって、器の (re)start の合図ではない——器の (re)start を
   * 言っているのは `SDKBackgroundTasksChangedMessage` の JSDoc のほうで、
   * こちらは「背景タスクの level 信号が per-process である」ことの説明に
   * すぎない。**この2つの JSDoc は別のことを言っている**——逐語は
   * `case 'session_started'` のコメントに置いた。誤読の結果、ターンの頭
   * ごとに在り高が0へ落ち、そのターン中に `background_tasks_changed` が
   * 来なければ `awaitingBackground` が付かず、報告が畳まれずクローンを
   * 起こしていた（実測: K 本並列に出すと K-1 回よけいに起こす）。
   *
   * 読むのは `result` の枝（`awaitingBackground` を報告に載せるかどうかの
   * 判定）だけ。**`worker_wait` の区間の開閉には使わない**
   * （`claude-provider.ts` の `foldSystemMessage` の doc）。
   */
  #liveBackgroundTasks: readonly { id: string; taskType: string }[] = [];
  #transcriptPath: string | undefined;
  #stopped = false;
  /**
   * 最後に受け取った世代番号（fencing token）。
   *
   * **`undefined` は「まだ lease を伴わずに起こされた」ことを表す。** そのときは
   * 判定しない（`lease.ts` の `undecidable` と同じ形 — 材料が無いことを
   * 「古くない」と読まない。ただし判定しない以上、拒む理由も無いので実質は
   * 「常に受ける」になる）。名乗らない古いデーモンとも繋がるための任意フィールドと
   * 対になっている（`runnerLeaseSchema` の doc）。
   */
  #fence: number | undefined;
  /**
   * いまの貸し出し期限（ミリ秒）。`Host` の自己失効の見張りが読む。
   *
   * **lease を伴わずに起こされたセッションは `undefined` のまま。** 自己失効は
   * 期限を約束されたセッションだけに効く（`RunnerHostOptions.enforceLease` の doc）。
   */
  #leaseTtlMs: number | undefined;

  /**
   * 認証トークンが差し替わったので、次のターンの境界で SDK セッションを畳んで
   * 開き直す（PR #454 がクローン側で塞いだのと同じ穴の、マネージャー側の直し）。
   *
   * **印だけを持つ。** 立てた時点ではセッションに触らない —— 触ると、そのとき
   * 走っていたターンを殺すか、失敗として報告するかのどちらかになる
   * （`clone.ts` の `#recycleForToken` の doc と同じ理由。あちらは
   * `recycleSessionForToken()` が呼ぶ側で、こちらは `Host#setCredentials` が
   * 呼ぶ側という違いだけで、印の意味は同じである）。
   *
   * **畳んでよいのは `#atTokenRecycleBoundary()` が真を返すときだけ。** 1つでも
   * 条件が欠けていれば、この印を立てたまま次の境界まで待つ（下ろさない）。
   *
   * **これは「畳みたい」という意図であって、「いま自分から閉じた」という
   * 事実ではない。** `#read` が「畳み直しのために閉じたのか」を判定する印は
   * 別に持つ（`#endedInputForTokenRotation`）——2つを1つに潰すと、この印が
   * 立ったままの状態で SDK が**自分の理由で**（クラッシュ・resume 不能など）
   * ストリームを閉じたときに、`#read` がそれを「畳み直しが起きた」と誤認し、
   * 嘘の `note`（「認証トークンが差し替わったので…」）を出したうえで、
   * 実際には効いていない開き直りを行うことになる（レビュー指摘。種類の違う
   * ものを1つの計器で見分けていた形）。
   */
  #recycleForToken = false;

  /**
   * **`#inputStream` が、まさにいま `recycleForToken` の意図に基づいて
   * 自分から入力ストリームを終えた**、という事実の印。
   *
   * **`#recycleForToken`（「畳みたい」という意図）とは意味が違う。** `#read` は
   * `for await` が正常終了した理由を、こちらの印**だけ**で判定する——
   * 「自分から閉じた」(a) と「SDK が自分の理由で閉じた」(b) は、どちらも
   * `for await` の正常終了として同じ形で観測されるが、(a) のときだけ
   * `#reopenForTokenRotation` へ進んでよい。`#recycleForToken` を見て判定すると、
   * 意図がまだ残っている（境界条件が揃わず `#inputStream` はまだ `return`
   * していない）状態で (b) が起きたときに誤判定する。
   *
   * **`#inputStream` が立て、`#read` が読んで下ろす。** 立てるのは
   * `#atTokenRecycleBoundary()` を認めて `return` する、まさにその1行のみ。
   */
  #endedInputForTokenRotation = false;

  constructor(options: RunnerSessionOptions) {
    this.#id = options.managerId;
    this.#request = options.request;
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn;
    this.#env = options.env;
    this.#withheldEnvKeys = options.withheldEnvKeys;
    this.#childUser = options.childUser;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode;
    this.#profileEnv = options.profileEnv;
    this.#mcpServers = options.mcpServers;
    this.#onClosed = options.onClosed;
    this.#onDelegationProcessSpawned = options.onDelegationProcessSpawned ?? (() => undefined);
    this.#onDelegationProcessExited = options.onDelegationProcessExited ?? (() => undefined);
    this.#spawnClaudeCodeProcessFn =
      options.spawnClaudeCodeProcessFn ??
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
    return this.#leaseTtlMs;
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
   */
  checkFence(lease: RunnerLease | undefined): void {
    if (lease === undefined) return;
    if (this.#fence !== undefined && lease.fence < this.#fence) {
      throw new RunnerFenceError({
        managerId: this.#id,
        expected: this.#fence,
        given: lease.fence,
      });
    }
    this.#fence = lease.fence;
    this.#leaseTtlMs = lease.ttlMs;
  }

  begin(request: string): void {
    this.push(request);
    this.#open();
  }

  /**
   * 前のセッションの続きから開く。
   *
   * `message` を必ず流すのは、**resume が「開き直す」だけでは仕事が進まない**
   * からである。人間の不在で止まってよいのは承認待ちの仕事だけで（PRD「自律」）、
   * 器が落ちたことを理由に止まったままにはしない。
   */
  resume(sessionId: string, entries: unknown[] | undefined, message: string | undefined): void {
    this.#resumeState.beginResume(sessionId, entries as SessionStoreEntry[] | undefined);
    if (message !== undefined) this.push(message);
    this.#open(sessionId);
  }

  state(): RunnerManagerState {
    return {
      managerId: this.#id,
      status: this.#status,
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
    };
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
   * **ただしこれは型にもテストにも書かれておらず、たまたま設計がそうなっている
   * だけの前提である。** 固定しているのは `runner-wakeup.test.ts` の
   * 「`task_notification` を受けても `byCause.input` は増えない」の1本のみ。
   */
  push(text: string): void {
    if (this.#stopped) return;
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#status = 'running';
    this.#wakeInput();
  }

  /**
   * 返事の宛先は `requestId` で指す。推測しない（取り違えは拒否を承認に変える）。
   *
   * **確定した allow/deny を同期的に返す（#322）。** `decideAnswer` を
   * `#onPermission` の `.then()`（SDK へ実際に返す `PermissionResult` を組み立てる
   * 側）と共有しているので、ここが返す値と SDK へ返る値は常に同じ計算から出る
   * ——2箇所に式を書くと、Issue #322 が候補2（`manager.ts` で `inferDecision` を
   * 呼び直す）を却下した理由（「runner.ts 側が変わったときに黙ってずれる」）を
   * 場所を変えて再現する。
   */
  answer(answer: RunnerAnswerCommand): RunnerAnswerOutcome {
    const pending = this.#pending.find((request) => request.id === answer.requestId);
    if (!pending) return { delivered: false };
    const decision = decideAnswer(pending.kind, answer.decision, answer.message);
    pending.settle({
      message: answer.message,
      ...(answer.decision === undefined ? {} : { decision: answer.decision }),
    });
    return { delivered: true, decision };
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
    const spawnFn =
      this.#childUser === undefined
        ? (spawnOptions: {
            command: string;
            args: string[];
            cwd?: string;
            env: Record<string, string | undefined>;
            signal: AbortSignal;
          }) =>
            spawn(spawnOptions.command, spawnOptions.args, {
              ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
              env: spawnOptions.env,
              signal: spawnOptions.signal,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
        : (spawnOptions: {
            command: string;
            args: string[];
            cwd?: string;
            env: Record<string, string | undefined>;
            signal: AbortSignal;
          }) => this.#spawnAsChildUser(spawnOptions);
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
    const path = this.#transcriptPath;
    if (path === undefined) return { status: 'no-path' };
    try {
      return { status: 'ok', body: await readFile(path, 'utf8') };
    } catch (error) {
      return { status: 'unreadable', error };
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    // **器の入れ替えと `manager_stop` はここを通る**（`Host#shutdown` / `Host#stop`
    // → `stop()`）。`result` を待っていると、この経路で畳まれたぶんは台帳に1行も
    // 残らない。生ログと同じで、渡し損ねたら二度と取れない。
    await this.#flushUsage();

    // **`worker_wait` も同じ理由で取りこぼさない。** この経路は `#finish` を
    // 通らないので、ここで閉じないと開いたままの区間が黙って消える
    // （`#finish` の doc と同じ判断）。`settled` は渡さない — 中で
    // `#openTasks` の状態から導く（`#closeWorkerWaitWindow` の doc）。
    this.#closeWorkerWaitWindow();

    // **分類できなかった失敗の件数も、同じ理由でここで出す（Issue #393）。**
    // 直上の `worker_wait` とまったく同じ穴である —— `#finish` にだけ置くと、
    // **器の入れ替えと `manager_stop` で畳まれたセッションのぶんが黙って消える。**
    // 初出の1行は既に出ているので存在は残るが、**量が失われる**。
    noteUnclassifiedFailuresSummary(this.#unclassifiedFailures, this.#id);

    // 止まる前に全文を返す。runner のディスクは器と一緒に消えるので、ここで
    // 渡し損ねると manager_id から生ログへ降りる経路が切れる。
    await this.#shipArchive();
    // **`#finish` と同じ理由でここにも置く（#323）。** この経路は `closed` すら
    // 出さないので、置かないと「マネージャーが既に書いた本文」が器と一緒に消える
    // — 直上の `#shipArchive` / `#flushUsage` / `#closeWorkerWaitWindow` が
    // ここに並んでいるのと同じ穴である。
    this.#flushUnreported(reason, this.#status);
    this.#settleAll(reason);
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    await this.#reader?.catch(() => undefined);
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
    if (this.#stopped) return;
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
    if (this.#query === null) return;
    this.#recycleForToken = true;
    this.#wakeInput();
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  #open(resume?: string): void {
    if (this.#query) return;
    // **ここが「器（CLI プロセス）を実際に開く／開き直す」唯一の場所である**
    // ——SDK の `SDKBackgroundTasksChangedMessage` の JSDoc が言う
    // 「whenever the session's CLI process (re)starts」[sdk-verbatim SDKBackgroundTasksChangedMessage] に正確に対応するのは
    // ここであって、次に来る `init`（`case 'session_started'`）ではない
    // （`init` はターンの頭ごとに来るだけで、器の (re)start を意味しない
    // ——詳しくは `#liveBackgroundTasks` の doc）。`#recoverFromFailedResume`
    // が `#openTasks.clear()` を「前のセッションの task_id を持ち越さない」
    // ために置いているのと同じ理由で、ここでも前の器の在り高を持ち越さない。
    this.#liveBackgroundTasks = [];
    const generation = this.#generation;
    const q = this.#queryFn({ prompt: this.#inputStream(), options: this.#buildOptions(resume) });
    this.#query = q;
    this.#reader = this.#read(q, generation);
  }

  #buildOptions(resume?: string): Options {
    return buildManagerSessionOptions({
      // 既定は `opus`。人間が `ALTEROID_MANAGER_MODEL` に置いていればそれを使う
      // （設定ではなく承認の置き場。`model-tier.ts`）。**ここが正本である** —
      // デーモン側の自己認識に出るのは同じ env から解いた宣言であって、
      // 実際にセッションへ渡っているのはこの値である。
      model: resolveManagerModel(this.#env),
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
      env: this.#childEnv(),
      // 既定は閉じる。人間が `ALTEROID_MANAGER_AUTO_MEMORY=true` を置いたときだけ
      // 開く（north_star 禁止2「方針は設定で開けられなければならない」）。
      managerAutoMemoryEnabled: resolveManagerAutoMemoryEnabled(this.#env),
      // 人間の MCP 連携の登録（#325 段3）。**開くたびに読む** —— 走行中に降りた登録は
      // このセッションには届かないが、次の resume・開き直しからは効く。
      ...(() => {
        const mcpServers = this.#mcpServers();
        return mcpServers === undefined ? {} : { mcpServers };
      })(),
      // 生ログはデーモンへ預ける。runner は永続化の器を持たない（記憶ストアの
      // 鍵を runner に置かないため）。
      sessionStore: this.#sessionStore(),
      ...(resume === undefined ? {} : { resume }),
      // 子プロセスを別 UID へ降ろす。**能力は1つも削らない** — 道具も preset も
      // そのままで、変えるのは実行する主体だけである（実行環境の境界）。
      ...(this.#childUser === undefined
        ? {}
        : { spawnClaudeCodeProcess: (options) => this.#spawnDelegationProcess(options) }),
      canUseTool: (toolName, input, extra) => this.#onPermission(toolName, input, extra),
      // **上の5本と違い、これだけが実際にブロックする**（#894 段1・案(A)）。
      // 理由は `#onPreToolUse` の doc を見よ。
      onPreToolUse: (record) => this.#onPreToolUse(record),
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
    });
  }

  /**
   * 生ログの預け先。**runner は DB を知らない。**
   *
   * `append` は上へ流すだけ（永続化はデーモン）。`load` は resume 時にデーモンが
   * 渡してきた素材を返す — runner のディスクに前回の生ログが残っている前提を
   * 置かないための口である（器は作り直される）。
   */
  #sessionStore(): SessionStore {
    return {
      append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
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
      load: async (key: SessionKey) => {
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
   * 複数回呼びうる**（マネージャー本体に加えて、並列で走る作業者ごとに1回ずつ）。
   * だから pid 追跡は「セッションが1本開いた／閉じた」ではなく「委譲プロセスが
   * 1本起きた／終わった」の粒度で行う——`runner-2` で観測された「3本並列の作業者」
   * のような形でも、それぞれが独立したセッション ID を持つようにするためである。
   */
  #spawnDelegationProcess(options: SpawnClaudeCodeProcessOptions): DelegationProcessHandle {
    const child = this.#spawnClaudeCodeProcessFn(options);
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
  #wakeInput(): void {
    const waiters = [...this.#inputWaiters];
    this.#inputWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  async *#inputStream(): AsyncGenerator<SDKUserMessage> {
    const generation = this.#generation;
    for (;;) {
      // **世代の確認を `shift` より先に。** 逆にすると、畳まれる直前の死んだ
      // ストリームが新しいセッション宛の1通を引き抜いてから終わる。
      if (generation !== this.#generation) return;
      const next = this.#input.shift();
      if (next !== undefined) {
        // **`worker_wait` の `byCause.input` の材料。** 実際に消費した入力だけを
        // 数える（積んだ時点ではなく、SDK が読み取った時点）。
        this.#turnTally.incrementInputsSinceResult();
        yield next;
        continue;
      }
      if (this.#stopped) return;
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
      if (this.#recycleForToken && this.#atTokenRecycleBoundary()) {
        this.#recycleForToken = false;
        this.#endedInputForTokenRotation = true;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#inputWaiters.add(resolve);
      });
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
      this.#status !== 'running' &&
      this.#pending.length === 0 &&
      this.#liveBackgroundTasks.length === 0 &&
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
  async #read(q: Query, generation: number): Promise<void> {
    try {
      for await (const message of q) {
        // **provider の綴りを読むのはここまでである**（`claude-provider.ts` の
        // `foldClaudeMessage`）。ここから下へ流れるのは中立イベントだけで、
        // 次の provider を足しても `#apply` は1本のままになる（#486）。
        for (const event of foldClaudeMessage(message)) await this.#apply(event);
      }
      if (this.#stopped || generation !== this.#generation) return;
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
      if (this.#endedInputForTokenRotation) {
        this.#endedInputForTokenRotation = false;
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
      if (generation !== this.#generation) return;
      // **`String(error)` の手前で分類を取る（#713）。** 語そのものは `reason` にも
      // 残る（Node の `Error` は `message` に `syscall` と `code` を織り込む）が、
      // **文字列になった時点で「機械が判定できる形」ではなくなる。** 受け取る側が
      // 枠（429）と器の資源（`EAGAIN`）を分けるのに文字列を解釈し始めると、
      // `runner-protocol.ts` が `reasonType` の doc で禁じている形になる。だから
      // **発生点で分類を作り、`reason` とは別の欄で並べて運ぶ**（`system-error.ts`）。
      //
      // **`reason` は1文字も変えない。** ここを変えると、この一文を読んでいる
      // 既存の受け手（受信箱・日誌・`closed_failed` の合成通知）が一斉に変わる。
      const systemError = systemErrorFactsOf(error);
      const reason = String(error);
      if (!this.#stopped) {
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
      }
      await this.#finish('failed', `マネージャーのセッションが落ちた: ${reason}`, {
        systemError,
      });
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
    this.#generation += 1;
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    this.#query = null;
    this.#reader = null;
    this.#resumeState.armResumeAttempt(sessionId);
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        '認証トークンが差し替わったので、ターンの境界でセッションを畳んで' +
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
      this.#openTasks.clear();
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
      // 引き継ぎの一言を横取りする。
      this.#generation += 1;
      try {
        this.#query?.close();
      } catch {
        // 既に閉じている
      }
      this.#query = null;
      this.#reader = null;
      // 新しいセッションは resume しないので、素材は本文へ畳んで渡す
      // （`sessionId` / `seed` の解放は `RunnerResumeState.discardForRecreate`）。
      this.#resumeState.discardForRecreate();
      // **前の器へ向けた入力を捨てない。** 一言も落とさずに引き継ぎへ折り込む
      // （落とすと、人間やクローンがちょうど送った指示だけが消える）。
      return this.#input
        .splice(0)
        .map((message) => String(message.message.content))
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
          this.#liveBackgroundTasks = [];
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
        this.#liveBackgroundTasks = event.tasks;
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
        if (this.#recycleForToken) this.#wakeInput();
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

        // **`#window` が非 null なのは、区間が開いている（`#openTasks` が非空）か
        // 閉じ待ち（`#windowClosing`）のときだけ**である。委譲の外で起きたターン
        // （人間・クローンと直接話しているだけの回）は数えない。
        if (this.#window !== null) {
          const window = this.#window;
          window.turns += 1;
          // **契機は排他で1件だけ数える。** 3つの合計が `turns` と必ず一致する
          // （`runner-wakeup.test.ts` がこの不変を固定する）。
          if (inputsThisTurn > 0) {
            window.byCause.input += 1;
          } else if (notificationsThisTurn > 0) {
            window.byCause.notification += 1;
          } else {
            window.byCause.continuation += 1;
          }
          if (toolsThisTurn === 0) window.toolless += 1;
          window.notifications += notificationsThisTurn;
          window.submits += submitsThisTurn;
          for (const [source, count] of sourcesThisTurn) {
            window.sources.set(source, (window.sources.get(source) ?? 0) + count);
          }
          // **最後の完了通知そのものを契機に回ったこのターンを数え終えてから閉じる。**
          // `#openTasks` が空になった瞬間に閉じないのはこのためである
          // （`#windowClosing` の doc）。`settled` は渡さない — この時点で
          // `#openTasks` は必ず空なので（`#windowClosing` はそのときにしか立たない）、
          // 中で導く `settled` は自動的に `true` になる。
          if (this.#windowClosing) this.#closeWorkerWaitWindow();
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
              this.#unclassifiedFailures,
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
        this.#status = this.#pending.length > 0 ? 'waiting_human' : 'done';
        // **ここがターンの境界になった。** 認証トークンの畳み直しの印が立って
        // いれば、入力待ちで止まっている `#inputStream` を起こす
        // （`clone.ts` の `#finishTurn` と同じ理由 —— 起こさないと、次に
        // 入力が届くまで古いトークンのまま走り続ける）。
        //
        // **無条件に起こしてよい。** 境界条件（`#atTokenRecycleBoundary()`）の
        // 判定は `#inputStream` 側が持つので、ここで起こしても条件が揃って
        // いなければ（確認待ちが残っている・背景処理が生きている等）そのまま
        // 待ちへ戻るだけである。
        if (this.#recycleForToken) this.#wakeInput();
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
          failure === undefined && this.#status === 'done' && this.#liveBackgroundTasks.length > 0
            ? {
                count: this.#liveBackgroundTasks.length,
                // **診断用の写しであって判定には使わない**（doc のとおり）。
                breakdown: summarizeBackgroundTasks(this.#liveBackgroundTasks),
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
          status: this.#status,
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

  /** `task_started`。`#openTasks` が 0→1 になった瞬間に区間を開く。 */
  #onTaskStarted(event: AgentDelegationStarted): void {
    // provider が id を名乗らなければ、取りこぼすより偽の id で数える方を選ぶ
    // （他の道具の `brief`/`randomUUID` 系の判断と同じ）。**代用値をここで作るのは、
    // 何で埋めるかが層の判断だからである**（`agent-events.ts` の doc）。
    const taskId = event.taskId ?? randomUUID();
    // **#1373: `#openTasks` の開閉とは無関係に、このターンで開いた作業者を
    // 別勘定で数える。** `RunnerTurnTally` の `#openedWorkersThisTurn` の doc を参照。
    this.#turnTally.addOpenedWorker(taskId);
    if (this.#openTasks.size === 0 && this.#window !== null) {
      // 閉じ待ちの間に次の委譲が始まった。**同じ区間として続ける** — ここで
      // 新しい区間を開き直すと、閉じていない集計を上書きして消してしまう。
      this.#windowClosing = false;
    }
    const window =
      this.#window ??
      (this.#window = {
        openedAt: new Date().toISOString(),
        tasks: 0,
        turns: 0,
        byCause: { input: 0, notification: 0, continuation: 0 },
        toolless: 0,
        notifications: 0,
        submits: 0,
        sources: new Map(),
      });
    this.#openTasks.add(taskId);
    window.tasks += 1;
  }

  /**
   * `task_notification`。開いている委譲から1件外し、全部片付いたら閉じ待ちにする。
   *
   * **併せて #901 を見る。** `task_id` が「打ち切った」と控えられていれば
   * （＝起こし直しの上限で打ち切られていて、まだ同期の `Task` 結果として
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
   * パスを主張しない——配達側が「取れなかった」と書く）。
   */
  #onTaskNotification(event: AgentDelegationNotified): void {
    const taskId = event.taskId;
    const had = taskId !== undefined && this.#openTasks.delete(taskId);
    // **`worker_wait.notifications` の材料。** 対応する `task_started` を見て
    // いなくても（`had` が false でも）数える — 通知そのものは事実である。
    this.#turnTally.incrementNotificationsSinceResult();
    // **本当に 1→0 の遷移のときだけ閉じ待ちにする。** 対応の無い通知（本来
    // 起きない想定だが防御的に見る）で誤って閉じ待ちを立てない。
    if (had && this.#openTasks.size === 0) this.#windowClosing = true;

    if (event.status === 'failed') {
      const limitNamed =
        event.summary !== undefined && classifyUsageNotice(event.summary) !== undefined;
      this.#turnTally.recordFailedWorkerNotification(limitNamed);
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
      }
    }
  }

  /**
   * 開いている委譲区間を1件の `worker_wait` として降ろし、閉じる。
   *
   * **`#window` が null なら何もしない。** `#finish` / `stop` / 引き継ぎの
   * どこから呼んでも安全に重ねられるようにするための無害化である。
   *
   * **`settled` は引数で受け取らず、ここで `#openTasks` の状態から導く。**
   * 呼び出し側に真偽値を持たせると、`#finish` / `stop` / 引き継ぎの3経路が
   * 固定で `false` を渡すことになり、**「委譲した作業者全員から完了通知を
   * 受け切った直後に、次の `result` が来ないままセッションが畳まれた」場合まで
   * `false`（＝受け切れなかった）と偽って報告する。** これはこの PR が答えたい
   * 問い（最後の完了通知の後、SDK はマネージャーを起こすのか）のど真ん中で
   * 起きる — 「起こさない」という当たりの仮説が成り立つ場合に限って、**全区間
   * に偽の印が付く**ことになる。`#openTasks.size === 0` は「呼ばれた時点で
   * 委譲した全員から通知を受け切っているか」をそのまま表すので、これを直接
   * 使う（呼び出し側の意図の言い換えを挟まない）。
   *
   * `sources` は**取れた分だけ載せる**。`RunnerTurnTally` の `#submitSources`
   * が1件も無ければフィールドごと省く — 取れない軸に0の行を作らない
   * （AGENTS.md 地雷）。
   */
  #closeWorkerWaitWindow(): void {
    const window = this.#window;
    if (window === null) return;
    const settled = this.#openTasks.size === 0;
    this.#window = null;
    this.#windowClosing = false;
    const sources = Object.fromEntries(window.sources);
    this.#emit({
      type: 'worker_wait',
      managerId: this.#id,
      openedAt: window.openedAt,
      tasks: window.tasks,
      turns: window.turns,
      byCause: window.byCause,
      toolless: window.toolless,
      notifications: window.notifications,
      submits: window.submits,
      ...(Object.keys(sources).length > 0 ? { sources } : {}),
      settled,
    });
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
    const toolUseId = denial.toolUseId ?? `${tool}:${digestOf(brief(input, 120))}`;
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
    const q = this.#query;
    if (q === null) return undefined;
    const startedAt = Date.now();
    try {
      const usage = await q.getContextUsage();
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
   * 台帳へ入るのは `result.modelUsage` だけなので（`#dispatch`）、**`result` を
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
    const models = await readSessionUsage(this.#query);
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
   * 報告は `#dispatch` の `message.type === 'result'` の枝でしか作られない。
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
   */
  async #finish(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    this.#stopped = true;
    // **量をここで1行にまとめる。終わり口はここだけではない（Issue #393）。**
    // もう1本は `stop()`（器の入れ替えと `manager_stop` が通る道）で、**あちらは
    // ここを通らない** —— だから同じ呼び出しが両方に在る（`stop()` の中の
    // `#closeWorkerWaitWindow` の隣に、同じ理由で並べてある）。
    //
    // **片方だけにすると、存在は残るが量だけが失われる。** 初出の1行は経路に
    // 関係なく出るので、**落ちていることに気づく手がかりが出力に無い。**
    // 数え上げの持ち主は `noteUnclassifiedFailuresSummary` の doc に在り、
    // そこは「すべての終わり口」ではなく現物の2本を名指ししている。
    noteUnclassifiedFailuresSummary(this.#unclassifiedFailures, this.#id);
    // **`close()` より先に読む。** 閉じた後の control channel からは何も取れない。
    // ここを通るのはクラッシュ・`lost`・`failed`、つまり `result` が出ないまま
    // 終わる経路そのものである。
    await this.#flushUsage();
    // **取りこぼしを作らない。** window が開いたまま（か閉じ待ちのまま）
    // 畳まれるなら降ろしてから閉じる。`settled` は渡さない — その時点の
    // `#openTasks` から導く（`#closeWorkerWaitWindow` の doc）。委譲した全員
    // から通知を受け切っていたのに `result` が来ないまま閉じた回は
    // `settled: true` になる（`turns` が最後の1回を含まないだけである）。
    this.#closeWorkerWaitWindow();
    this.#settleAll(reason);
    // 読み取りが終わっても入力側を起こして本体を閉じる。怠ると閉じられない
    // Query と起きない `#inputStream` が残る。
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    this.#status = status;
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
        reason: `確かめようとして例外が飛んだ: ${String(error)}`,
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
    toolName: string,
    input: Record<string, unknown>,
    extra: { signal: AbortSignal; requestId?: string; toolUseID?: string },
  ): Promise<PermissionResult> {
    // 確認を出せている＝セッションは開いて手を動かしている。
    this.#markProgressed();
    // SDK は同じ確認を再送しうる。id を SDK 側の識別子に揃えて、再送では新しい
    // 待ちを積まずに同じ結果を返す（二重に消費されると片方が永久に返らない）。
    const id = extra.requestId ?? extra.toolUseID ?? randomUUID();
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;
    // **解けた後の再送も同じ扱いにする。** ここを `#pending` だけで見ていたのが
    // 「答えたのに待っていないと言われる」の原因だった（`#resolved` の注記）。
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) return resolved;

    const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
    const summary =
      kind === 'question' ? describeQuestions(input) : `${toolName} の実行許可: ${brief(input)}`;
    // **ここで1度だけ取る（#334）。** `state()` も `ask` イベントもこの値を
    // そのまま運ぶだけにする——経路ごとに取り直すと、同じ確認が経路によって
    // 違う「待ち始めた時刻」を名乗る。
    const askedAt = new Date().toISOString();

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{ message: string; decision?: 'allow' | 'deny' }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // **`decideAnswer` が決定の唯一の実装である（#322）。** `Session#answer()`
      // が同じ関数を同じ引数（`kind` / `decision` / `message`）で呼んでいるので、
      // クローンへ即座に返す値（`Pool#send` の `answered.decision`）と、SDK へ
      // 実際に返る `behavior` は常に同じ計算から出る。
      const decision = decideAnswer(kind, answer.decision, answer.message);
      const outcome: PermissionResult =
        decision === 'deny'
          ? { behavior: 'deny', message: answer.message }
          : kind === 'question'
            ? { behavior: 'allow', updatedInput: withAnswers(input, answer.message) }
            : { behavior: 'allow' };
      // **解けたことを覚えるのはここ1箇所。** 回答でも中断でも停止でも、解けた
      // 事実は同じように残る（経路ごとに覚え忘れる隙を作らない）。
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
        if (this.#status === 'waiting_human' && this.#pending.length === 0) {
          this.#status = 'running';
        }
        this.#emit({ type: 'settled', managerId: this.#id, requestId: id });
        settle(value);
      },
    };

    this.#pending.push(request);
    this.#status = 'waiting_human';

    // マネージャー側で中断されたら宙吊りにしない。
    const onAbort = () =>
      request.settle({ message: 'マネージャー側で中断された。', decision: 'deny' });
    if (extra.signal.aborted) {
      onAbort();
    } else {
      extra.signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => extra.signal.removeEventListener('abort', onAbort);
    }

    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary, askedAt });

    return result;
  }

  /**
   * `Bash` へ渡すコマンドが「無限に待つだけの形」なら実行そのものを止める
   * （#894 段1・案(A)）。
   *
   * ## なぜここだけが実際にブロックする
   *
   * このクラスの他のフック（`#onPostToolUse` 以下・`#onSubagentStop` /
   * `#onStop` 等）はすべて観測専用で、`{ continue: true }` を返すだけである。
   * ここは違う —— #894 が実測したのは「システムプロンプトへ逐語で書いても
   * 守られない」ということそのものなので、対策を「もっと強く書く」側へは
   * 倒さず、**能力そのものを弾く**側へ倒す（Issue #894 の候補(a)）。判定の
   * 中身（何を弾き、何を通すか）は `bash-wait-guard.ts` の
   * `inspectBashCommand` の doc を見よ —— ここは SDK への配線と、弾いた
   * ことを日誌へ残す役目だけを持つ。
   *
   * ## `Bash` 以外・`command` が文字列でない入力は素通しする
   *
   * `inspectBashCommand` は `Bash` の呼び出しだけを見る判定器であって、
   * 他のツールの入力の形を知らない。**ここで弾くのは `Bash` だけである** —
   * 他のツールまで巻き込むと、この PreToolUse が「何でも弾きうる門」に
   * 見えてしまい、地雷表「確認が要る行為の一覧を作る」に近づく。
   *
   * ## 拒否は中立の `{ kind: 'deny' }` で返す
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
   */
  async #onPreToolUse(record: AgentPreToolRecord): Promise<AgentPreToolDecision> {
    if (record.toolName !== 'Bash') return { kind: 'continue' };

    const toolInput = record.toolInput as
      { command?: unknown; run_in_background?: unknown } | null | undefined;
    const command = toolInput?.command;
    if (typeof command !== 'string') return { kind: 'continue' };

    // **`run_in_background` はコマンド文字列に現れない。** 背景へ置いたことを
    // 判定器へ渡せる経路はここだけである（`bash-wait-guard.ts` の
    // `isBackgroundedGhRunWatch` の doc）。**`=== true` で受ける** —— 欠けていても
    // 形が崩れていても `false`（＝前景）になり、通す側へ倒れる。
    const verdict = inspectBashCommand(command, {
      backgrounded: toolInput?.run_in_background === true,
    });
    if (!verdict.blocked) return { kind: 'continue' };

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `Bash の呼び出しを弾いた（${actor}・形=${verdict.form}）。${verdict.reason}`,
    });

    return { kind: 'deny', reason: verdict.reason };
  }

  /**
   * マネージャーと作業者の全ツール実行をデーモンの日誌へ（監査）。
   *
   * **併せて、背景タスクの所有者を控える**（#570。`#backgroundTaskOwners`）。
   * ここでしか取れない —— `SubagentStop` の `background_tasks[]` に所有者の欄が
   * 無く、作業者の生ログ側にも構造化された形では出ないためである（実測: 生ログ
   * に出るのは `Command running in background with ID: …` という**自由文**だけ）。
   */
  async #onPostToolUse(record: AgentToolAuditRecord): Promise<AgentContextOutcome> {
    if (typeof record.transcriptPath === 'string') this.#transcriptPath = record.transcriptPath;
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
   * マネージャーへ全件配達する。1件も無ければ `null`。
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
   * `Task` の結果が、起こし直しの上限で打ち切った作業者のものなら、マネージャーへ
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
      text: `Task の結果に注記した（#901）: agent_id=${agentId} は起こし直しの上限で打ち切られていた`,
    });
    return [
      `⚠️ この作業者（agent_id=${agentId}）は、自分で起こした背景処理を残したまま` +
        '畳もうとする回が起こし直しの上限に達したため、alteroid が打ち切った。' +
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
          `agent_id=${agentId} は起こし直しの上限で打ち切られていた`,
      });
    }
    return agentIds
      .map((agentId) =>
        [
          `⚠️ 作業者（agent_id=${agentId}）は、自分で起こした背景処理を残したまま` +
            '畳もうとする回が起こし直しの上限に達したため、alteroid が打ち切った。' +
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
   */
  async #onPostToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    if (typeof record.transcriptPath === 'string') this.#transcriptPath = record.transcriptPath;
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
        ? excerptLine(record.error, TOOL_USE_FAILURE_ERROR_EXCERPT)
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
   * 終わっていない形で残っている）は、予算を2段で見て2つに割る**
   * （#570 の追跡の続き。単位を「作業者」から「作業者 × 背景処理」へ
   * 変えたのがこの PR の本体——詳細は `SUBAGENT_WAKEUP_LIMIT_PER_TASK` /
   * `SUBAGENT_WAKEUP_LIMIT_PER_AGENT` の doc）:
   *
   * 1. **通し上限未満、かつ、残っている背景処理の少なくとも1本が1本あたりの
   *    上限未満 —— 起こし直す。** 通算（`#subagentWakeupTotals`）を +1、
   *    残っている**全件**の per-task カウント（`#subagentWakeups`）も +1
   *    したうえで `note` を出し、`hookSpecificOutput.additionalContext` を
   *    返す。本文には (a) 残っている背景処理の件数と各件の
   *    type/status/description（`command` があれば要点）に加えて、**その
   *    背景処理では何回目か**（`#renderSubagentStopTaskLines`） (b) 「その
   *    完了通知は親のセッションへ届く。あなたは自動では再開しない」 (c) どう
   *    すればよいか（前景で待ち直す／諦めるなら「背景処理を残したまま終える」
   *    と報告に明記する。**黙って畳まない**） (d) この作業者の通算が何回目・
   *    通し上限は何回かを必ず入れる。
   * 2. **どちらかの上限に達していたら —— 起こし直さない。**
   *    `additionalContext` は返さず（＝ `{ continue: true }` のみ）、
   *    `note` を出す。理由（`limitReason`）は「通し上限に達した
   *    （`'per-agent'`）」と「残っている背景処理はどれも1本あたりの上限に
   *    達した（`'per-task'`）」の2つに割り、両方成り立つときは通し上限の
   *    ほうが重い歯なので `'per-agent'` を名乗る。`manager.ts` の
   *    `case 'note'` はこれを見て、日誌には毎回書く。**クローンの受信箱へは
   *    間引いて上げる**（#1385。`escalate: true` を立てるのは、この
   *    agentId で `limit_reached` の `note` を出した通算回数が 1・3・9・27…
   *    のときだけ——`#subagentLimitReachedNotes` /
   *    `shouldEscalateSubagentLimitReachedNote` の doc。**上限に達したまま
   *    畳もうとするたびに同じ report が積まれ続けるのを防ぐためで、
   *    `note` 自体は間引かない**（日誌には全件残る）。
   *
   * **同じ背景処理を残したまま2回目の `SubagentStop` が来た**（＝ 起こし
   * 直しても作業者が進まなかった）ときは、`note` の「この背景処理では n
   * 回目」の数字が変わることで「起こし直しても進まなかった」と「起こし
   * 直して初めて進んだ」を区別できるようにしてある。**通算の側
   * （`#subagentWakeupTotals`）は、対象が別の背景処理へ変わっても
   * 増え続ける**——「毎回違う背景処理を起こして空転する」を捕まえるのは
   * こちらの役目（穴A。`SUBAGENT_WAKEUP_LIMIT_PER_AGENT` の doc）。
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

      // **予算の判定は2段になる（この PR の本体）。**
      // 1段目（per-task）: 残っている各背景処理を、それぞれの `id` で
      // `#subagentWakeups` を引いて「1本あたりの上限未満か」を見る。
      // 2段目（per-agent）: この作業者の通算を `#subagentWakeupTotals` で見る。
      // **起こし直す条件は両方 —— 通し上限未満、かつ、残っている背景処理の
      // うち少なくとも1本が1本あたりの上限未満であること。**
      //
      // `remaining` の各要素の `id` は `mine` の filter（`typeof id ===
      // 'string'` かつ所有者が一致）を通っているので既に文字列のはずだが、
      // **防御的にもう一度 `typeof` で絞る**（この前提が崩れても、ここが
      // 例外で落ちない側へ倒す）。
      const remainingIds = remaining
        .map((task) => (task as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      const perTaskCount = (id: string): number => this.#stopState.subagentWakeupCount(agentId, id);
      const total = this.#stopState.subagentWakeupTotal(agentId);
      const underPerTask = remainingIds.filter(
        (id) => perTaskCount(id) < SUBAGENT_WAKEUP_LIMIT_PER_TASK,
      );
      const shouldWake = total < SUBAGENT_WAKEUP_LIMIT_PER_AGENT && underPerTask.length > 0;
      // **両方の上限に同時に達したときは `'per-agent'` を名乗る**
      // （`SUBAGENT_WAKEUP_LIMIT_PER_AGENT` の doc「優先順位」）—— 通し上限の
      // ほうが重い歯なので、通し上限に達している回はそちらを理由にする。
      const limitReason: 'per-agent' | 'per-task' =
        total >= SUBAGENT_WAKEUP_LIMIT_PER_AGENT ? 'per-agent' : 'per-task';

      if (shouldWake) {
        // **起こし直す —— 通算を +1、残っている全件の per-task カウントも
        // +1 する。** 「全件」（`underPerTask` だけではない）なのは、その回に
        // 「待たされた」のは残っている背景処理の全部だからである —— 上限未満の
        // 1本だけを対象に選んでも、他の背景処理が同じ回に一緒に残っていた
        // という事実は変わらない。
        const newTotal = this.#stopState.recordSubagentWakeup(agentId, remainingIds);

        // **加算の後で組み立てる。** 各行に載る「この背景処理では何回目か」
        // は、この加算を終えた後の値でなければ「今回を含む」にならない。
        const taskLines = this.#renderSubagentStopTaskLines(agentId, remaining);

        const noteLines = [
          `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
            `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
            `**起こし直した**（この作業者の通算 ${newTotal}回目 / 通し上限 ` +
            `${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}）。${stopHookActiveText}`,
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
            // **スキーマは変えていない**（`runner-protocol.ts` /
            // `schema.ts` の `stall.wakeupCount` は今までどおり「この
            // `agent_id` を起こし直した回数（今回を含む）」）。単位を
            // 背景処理にしたのはこのイベント自体の判定であって、この欄が
            // 運ぶ値は `#subagentWakeupTotals`（`agent_id` の通算）である。
            wakeupCount: newTotal,
            outcome: 'woken',
          },
        });

        const contextLines = [
          `あなたが自分で起こした背景処理が ${remaining.length}件、残ったまま畳もうとした ` +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。`,
          ...taskLines,
          ...(unknownText === '' ? [] : [unknownText]),
          'この完了通知は**親のセッション**（マネージャー）へ届く。**あなたは自動では再開しない** — ' +
            'このまま黙って畳むと、委譲がここで止まる。',
          'どうすればよいか: 前景で待ち直す（出力ファイルの行数が増えるかを見る、等）。' +
            '諦めて畳むなら、報告に「背景処理を残したまま終える」と明記すること。' +
            'どちらでもよいが、黙って畳まないこと。',
          `これはこの作業者の通算 ${newTotal}回目（通し上限 ${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}）。` +
            `各背景処理には別々に1本あたりの上限（${SUBAGENT_WAKEUP_LIMIT_PER_TASK}回）があり、` +
            '達した背景処理はその背景処理としては自動では起こされなくなる。' +
            `通し上限（${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}回）に達すると、` +
            'この作業者はどの背景処理についても自動では起こされなくなる。',
        ];
        const additionalContext = this.#truncateSubagentStopText(contextLines.join('\n'));

        return { kind: 'addContext', text: additionalContext };
      }

      // **起こし直さない —— 理由は2つに割れる（`limitReason`）。**
      // `note` は今までどおり毎回 emit する（日誌には全件残る）。
      // `escalate` は間引く（#1385）—— `manager.ts` の `case 'note'` は
      // `escalate === true` のときだけクローンの受信箱へ report を積むので、
      // 毎回立てたままだと同じ agentId が上限に達したまま何度も
      // `SubagentStop` を送ってくるたびに同じ report が積まれ続ける。
      // **間引きの規則は `RunnerSubagentStopState.recordSubagentLimitReachedNote`
      // の doc（`manager.ts` の `shouldEscalateDenial` と同じ、1・3・9・27…）。**
      // **ここでは何も加算していないので、`#renderSubagentStopTaskLines` が
      // 読む値は現在値のままである。**
      const { count: limitNoteCount, shouldEscalate: shouldEscalateLimitNote } =
        this.#stopState.recordSubagentLimitReachedNote(agentId);

      const taskLines = this.#renderSubagentStopTaskLines(agentId, remaining);
      const limitReasonText =
        limitReason === 'per-agent'
          ? `**この作業者の通し上限（${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}回）に達したため、` +
            `起こし直さなかった**（既に ${total}回 起こし直し済み）。`
          : `**残っている背景処理はどれも1本あたりの上限（${SUBAGENT_WAKEUP_LIMIT_PER_TASK}回）に` +
            `達したため、起こし直さなかった**（この作業者の通算 ${total}回 / 通し上限 ` +
            `${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}）。`;
      // **クローンが読んだとき「これが何回目か」「なぜ次がすぐ来ないか」が
      // 分かる1行**（#1385）。日誌には毎回このまま載るので、間引かれた回
      // （`escalate` が立たない回）も、日誌を辿れば抜け無く追える。
      const limitNoteCountText =
        `上限に達してから ${limitNoteCount}回目（1・3・9…回目だけクローンへ上げる）。` +
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
          // 起こし直していないので、このイベント自身は積算に足されない
          // （既存のスキーマ・doc のまま —— `#onSubagentStop` の doc の
          // 「上限に達していたら」節）。**この欄は `wakeupCount`（起こし
          // 直した回数）のままで、間引きの回数（`limitNoteCount`）を運ばない
          // ——スキーマの doc「この `agent_id` を起こし直した回数」の意味を
          // 変えないため。**
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
          text: `SubagentStop の観測に失敗した: ${String(error)}`,
        });
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
      return { kind: 'continue' };
    }
  }

  /**
   * `remaining`（当人が起こした背景処理のうち、まだ終わっていないもの）の
   * 各要素を、人間が読める1行へ変換する（`#onSubagentStop`）。
   *
   * **末尾に「この背景処理では何回目か」を付ける**（この PR の本体 ——
   * 単位が背景処理になったことが出力から読めないと、この PR で足した軸が
   * 観測から消える。AGENTS.md 地雷「取れない軸に0の行を作る」の裏面）。
   * 値は呼び出し時点の `#subagentWakeups` をそのまま読むだけで、**この
   * 関数自身は加算しない**（副作用を持たない）—— 起こし直す分岐は呼ぶ前に
   * 加算を終えているので「今回を含む」回数になり、起こし直さない分岐は
   * 加算していないのでそのまま現在値になる。**どちらの意味になるかは
   * 呼び出し側の責務であり、この関数の doc としてはどちらも「呼び出し時点の
   * 値」としか言えない。**
   *
   * `id` が取れない（`mine` の filter を通っているので実際には起きない
   * はずだが、防御的に想定する）要素には回数を付けない——取れない軸に
   * 0の行を作らないため。
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
  #renderSubagentStopTaskLines(agentId: string, tasks: readonly unknown[]): string[] {
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
      const perTaskSuffix =
        typeof t.id === 'string'
          ? `（この背景処理では ${this.#stopState.subagentWakeupCount(agentId, t.id)}` +
            `回目 / 1本あたりの上限 ${SUBAGENT_WAKEUP_LIMIT_PER_TASK}）`
          : '';
      // **`id` と `command` を `description` より前に置く**（直上の doc）。
      return `- id=${id}${command} type=${type} status=${status} description=${description}${perTaskSuffix}`;
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
      text.slice(0, SUBAGENT_STOP_NOTE_TEXT_LIMIT) +
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
          text: `Stop の観測に失敗した: ${String(error)}`,
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
    return text.slice(0, STOP_NOTE_TEXT_LIMIT) + `…（上限 ${STOP_NOTE_TEXT_LIMIT} 文字で切った）`;
  }

  /** 要約に潰される前に全文を上げる（監査は日誌＋アーカイブで担保する）。 */
  async #onPreCompact(record: AgentPreCompactRecord): Promise<void> {
    const path = record.transcriptPath;
    if (typeof path === 'string' && path.length > 0) this.#transcriptPath = path;
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

  /** 待たせたまま消えない。止まっている確認は理由付きで全部解く。 */
  #settleAll(reason: string): void {
    for (const request of [...this.#pending]) {
      request.settle({ message: reason, decision: 'deny' });
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
  const workerNote =
    workerRejections.length > 0
      ? `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`
      : failedWorkerNotifications > 0
        ? `\n（このターンでは作業者 ${String(failedWorkerNotifications)} 体が失敗で終わった${
            failedWorkerNotificationsNamingLimit > 0
              ? `（うち ${String(failedWorkerNotificationsNamingLimit)} 体は枠(429)を名乗った）`
              : ''
          }。本体も当たったかは SDK からは分からない）`
        : openedWorkers > 0
          ? `\n（このターンでは作業者が ${String(openedWorkers)} 体開いていた。どちらが当たったかは SDK からは分からない）`
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

/** 否定として読み取る語。日本語は語境界が無いので素直に部分一致で見る。 */
const DENIAL_PHRASES = [
  'やめ',
  'だめ',
  '駄目',
  '不可',
  '中止',
  '却下',
  'しないで',
  '止めて',
  '待って',
  '許可しない',
  '承認しない',
];

/** 英語側は語境界で見る（`nothing` の `no` を否定と読まないため）。 */
const DENIAL_WORDS = /\b(deny|denied|no|nope|don't|do not|stop|cancel)\b/i;

/**
 * `decision` を付け忘れた回答の読み取り。
 *
 * 迷ったら通さない — ではなく、**否定が読み取れたときだけ拒否**する。ここで
 * 保守的に倒すと、クローンが承認したつもりの仕事が黙って止まる（デグレード）。
 *
 * 日本語を語境界（`\s` や `\b`）で探してはいけない。「それはやめて」の「やめ」の
 * 前に区切りは無く、探せていないことが**承認**として表に出る。
 */
export function inferDecision(message: string): 'allow' | 'deny' {
  if (DENIAL_PHRASES.some((phrase) => message.includes(phrase))) return 'deny';
  return DENIAL_WORDS.test(message) ? 'deny' : 'allow';
}

/**
 * 確認の最終的な決定を計算する、**唯一の実装**（#322）。
 *
 * `Session#answer()`（クローンへ即座に返す値）と `#onPermission` の
 * `answered.then()`（SDK へ実際に返す `PermissionResult` を組み立てる側）の
 * **両方がこの関数を呼ぶ。** 式を2箇所に書くと、Issue #322 が候補2
 * （`manager.ts` で `inferDecision` を呼び直す）を却下した理由と同じ形の穴に
 * なる——場所を `runner.ts` の中に留めても、実装が2つあれば「runner.ts 側が
 * 変わったときに黙ってずれる」は再現する。
 *
 * - `AskUserQuestion`（`kind === 'question'`）は **decision を一切見ず常に
 *   allow**（既存の挙動そのまま。質問への回答に allow/deny という概念が無い）
 * - それ以外（`kind === 'permission'`）は明示の `decision` を優先し、
 *   無ければ `inferDecision(message)` に倒す
 */
export function decideAnswer(
  kind: 'question' | 'permission',
  decision: 'allow' | 'deny' | undefined,
  message: string,
): 'allow' | 'deny' {
  if (kind === 'question') return 'allow';
  return decision ?? inferDecision(message);
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

export function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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
