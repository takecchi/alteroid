/**
 * @alteroid/core — ドメイン層。
 *
 * クローンループ・型付きメッセージ・記憶/日誌/ジョブのストア IF。
 * ここに実装があるのは「脳」であり、常に1インスタンスだけがデーモン内で動く
 * （docs/architecture.md「脳は1インスタンス」）。
 */

export * from './schema.js';
export * from './store.js';
/**
 * ログイン（誰がこの API を叩いているか）と、alteroid を使ってよいかの2値。
 *
 * **PRD「権限境界」とは別の層である。** あちらはクローンが記憶を根拠に
 * 「何を人間へ確認するか」を決める話で、行為の一覧を持ってはいけない。
 * こちらは north_star 禁止2 が制限の表現方法として認めている
 * **実行環境の境界**（認証情報の配布範囲）そのものである。
 */
export {
  ACCESS_TOKEN_PREFIX,
  accessTokenRecordSchema,
  authAccountSchema,
  authIdentitySchema,
  authProviderIdSchema,
  createPkcePair,
  decodeState,
  encodeState,
  isAccessTokenUsable,
  isAccountGranted,
  isLoginRequestOpen,
  issueAccessTokenValue,
  loginRequestSchema,
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
  type AccessTokenRecord,
  type AuthAccount,
  type AuthIdentity,
  type AuthStore,
  type GrantOutcome,
  type LoginRequest,
  type LoginRequestStatus,
} from './auth.js';
export {
  GOOGLE_PROVIDER_ID,
  createAuthProviderRegistry,
  createGoogleProvider,
  type AuthProvider,
  type AuthProviderRegistry,
  type AuthorizationRequest,
  type ExchangeRequest,
  type OAuthProfile,
  type OAuthProvider,
  type OAuthProviderConfig,
  type PasswordProvider,
} from './auth-providers.js';
export {
  createAuthService,
  type AuthService,
  type AuthServiceOptions,
  type ClaimResult,
  type CompleteLoginError,
  type CompleteLoginResult,
  type GrantResult,
  type StartLoginInput,
  type StartLoginResult,
} from './auth-service.js';
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
  type TimerPromptInput,
} from './prompt.js';
export { buildActivityDigest, type DigestWindow } from './digest.js';
export { CRON_EXPRESSION_MAX, isCronExpression, parseCron, type CronSchedule } from './cron.js';
export {
  DAILY_REPORT_KIND,
  RESERVED_SCHEDULE_KINDS,
  SELF_INITIATIVE_KIND,
  createScheduler,
  dailyReportEntry,
  dailyReportEvent,
  describeScheduleSpec,
  localDate,
  localDayRange,
  missingDailyReportDates,
  parseTimeOfDay,
  scheduledRequestEntry,
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
/**
 * マネージャーの道具の鍵。**器を作り直さずに回せる形**で持つ（`credentials.ts`）。
 * 伏せるのは上（記憶）へ到達する鍵だけで、下（外の世界）へ手を伸ばす鍵は配る。
 */
export {
  CREDENTIAL_NAME,
  DEFAULT_CREDENTIAL_DIR,
  ROTATABLE_CREDENTIAL_KEYS,
  isWithheldCredentialName,
  createCredentialStore,
  fingerprintOf,
  type CredentialEntry,
  type CredentialFingerprint,
  type CredentialStore,
  type CredentialStoreOptions,
} from './credentials.js';
export {
  createRunnerRegistry,
  runnerAnswerCommandSchema,
  runnerCredentialFingerprintSchema,
  runnerCredentialSchema,
  runnerEventSchema,
  runnerManagerStateSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerSetCredentialsCommandSchema,
  runnerStartCommandSchema,
  runnerWaitingSchema,
  type RunnerAnswerCommand,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerRegistry,
  type RunnerResumeCommand,
  type RunnerSetCredentialsCommand,
  type RunnerStartCommand,
  type RunnerWaiting,
} from './runner-protocol.js';
export {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  MCP_SERVER_NAME,
  createCloneMcpServer,
  createCloneTools,
  qualifiedToolName,
  type ToolContext,
} from './tools.js';
export {
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  createClone,
  resolveCloneModel,
  type CloneOptions,
} from './clone.js';

/** テスト用ユーティリティ（本番の配線には出てこない）。 */
export { createMemoryStores, humanMessage } from './testing.js';
