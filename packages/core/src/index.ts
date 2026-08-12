/**
 * @alteroid/core — ドメイン層。
 *
 * クローンループ・型付きメッセージ・記憶/日誌/ジョブのストア IF。
 * ここに実装があるのは「脳」であり、常に1インスタンスだけがデーモン内で動く
 * （docs/architecture.md「脳は1インスタンス」）。
 */

export * from './schema.js';
export * from './store.js';
export type { CloneHost } from './host.js';
export { Inbox } from './inbox.js';
export {
  buildCloneSystemPrompt,
  buildDailyReportPrompt,
  buildDistillPrompt,
  buildExternalEventPrompt,
  buildManagerSystemPrompt,
  buildSelfInitiativePrompt,
  buildTimerPrompt,
  buildWorkerPrompt,
} from './prompt.js';
export { buildActivityDigest, type DigestWindow } from './digest.js';
export {
  DAILY_REPORT_KIND,
  SELF_INITIATIVE_KIND,
  createScheduler,
  dailyReportEntry,
  dailyReportEvent,
  localDate,
  localDayRange,
  missingDailyReportDates,
  parseTimeOfDay,
  selfInitiativeEntry,
  startOfLocalDay,
  type ScheduleEntry,
  type ScheduleStatus,
  type Scheduler,
  type SchedulerOptions,
  type TimeOfDay,
} from './schedule.js';
export {
  MANAGER_MODEL,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WITHHELD_ENV_KEYS,
  createManagerPool,
  type ManagerDecision,
  type ManagerMoveOptions,
  type ManagerMoveResult,
  type ManagerPool,
  type ManagerPoolOptions,
  type ManagerSendOptions,
  type ManagerSendResult,
  type ManagerStartInput,
  type ManagerSummary,
} from './manager.js';
/**
 * manager-runner 側（SDK を隔離して走らせる層）と、その境界。
 * デーモンは `RunnerRegistry` しか見ない — 固定 URL も runner のローカルパスも
 * 前提にしない（docs/architecture.md「プロセス境界」）。
 */
export {
  createRunnerHost,
  type RunnerChildUser,
  type RunnerHost,
  type RunnerHostOptions,
} from './runner.js';
export { createLocalRunner, type LocalRunnerOptions } from './runner-local.js';
export { measureCapacity, type CapacityIo } from './capacity.js';
/**
 * 期限付きで待つ（M5）。応答しない1台に、生存判定と配置を止めさせないための線。
 */
export { DeadlineError, isDeadlineError, withDeadline } from './deadline.js';
export {
  runnerAnswerCommandSchema,
  runnerCapacitySchema,
  runnerEventSchema,
  runnerHealthSchema,
  runnerLeaseSchema,
  runnerManagerStateSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerStartCommandSchema,
  runnerWaitingSchema,
  type RunnerAnswerCommand,
  type RunnerCapacity,
  type RunnerClient,
  type RunnerEvent,
  type RunnerHealth,
  type RunnerLease,
  type RunnerManagerState,
  type RunnerResumeCommand,
  type RunnerStartCommand,
  type RunnerWaiting,
} from './runner-protocol.js';
/**
 * 名簿 — 登録・生存判定・資源による配置（M5）。**上限はここにも無い。**
 */
export {
  createRunnerRegistry,
  type RunnerHealthState,
  type RunnerRegistry,
  type RunnerRegistryOptions,
  type RunnerSelectInput,
} from './runner-registry.js';
/** workspace の運用選択と、runner を跨いだ移送の可否（M5）。 */
export {
  DEFAULT_WORKSPACE_POLICY,
  describeLoss,
  isPortable,
  locatorFor,
  pinnedRunnerId,
  relocate,
  workspaceLocatorKindSchema,
  workspacePolicySchema,
  type Relocation,
  type WorkspaceLocatorKind,
  type WorkspacePolicy,
} from './workspace.js';
export {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  MCP_SERVER_NAME,
  createCloneMcpServer,
  createCloneTools,
  qualifiedToolName,
  type ToolContext,
} from './tools.js';
export { CLONE_MODEL, createClone, type CloneOptions } from './clone.js';

/** テスト用ユーティリティ（本番の配線には出てこない）。 */
export { createMemoryStores, humanMessage } from './testing.js';
