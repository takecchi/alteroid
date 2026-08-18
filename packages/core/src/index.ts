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
 * 利用状況の台帳（alteroid 自身が使った分）。
 *
 * 出所は SDK の `result.modelUsage` であって `usage` ではない（後者はメイン
 * ループぶんだけで、**作業者の消費が落ちる**）。累積値なので足さずに差分を取る。
 * 数字を見せる口はすべて `USAGE_ESTIMATE_NOTICE` を一緒に運ぶ。
 */
export * from './usage.js';
/**
 * アカウント全体の残り（claude.ai 側が言っている値）と、上限に当たった / 当たりそうの検知。
 *
 * **台帳とは別物なので足さない。** こちらは向こうが言っている値で、台帳は自分で
 * 数えた推定値である。取れなかったものを 0 にしないこと（`AccountUsageState` が
 * 「まだ取っていない / 取れなかった / この構成では取れない」を区別して持つ）。
 */
export {
  ACCOUNT_USAGE_READ_TIMEOUT_MS,
  accountUsageSchema,
  accountUsageStateSchema,
  extraUsageSchema,
  fetchAccountUsage,
  hasAccountUsageDetail,
  isNotLoggedIn,
  isSubscriptionImpossible,
  secondsToEpochMs,
  toAccountUsage,
  usageWindowKindSchema,
  usageWindowSchema,
  type AccountUsage,
  type AccountUsageState,
  type ExtraUsage,
  type UsageWindow,
  type UsageWindowKind,
} from './usage-snapshot.js';
export {
  USAGE_PROBE_TIMEOUT_MS,
  idleUsagePrompt,
  runUsageProbe,
  settleWithin,
  type UsageProbeHandle,
  type UsageProbeOptions,
  type UsageProbeQuery,
} from './usage-probe.js';
export {
  classifyUsageNotice,
  describeUsageNotice,
  rateLimitFactsSchema,
  toRateLimitFacts,
  usageLimitKindSchema,
  usageLimitNoticeSchema,
  usageTransitionOf,
  type RateLimitFacts,
  type UsageLimitKind,
  type UsageLimitNotice,
} from './usage-limits.js';
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
export type { CloneSystemPromptInput } from './prompt.js';
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
/**
 * クローンの自己認識。正典（`docs/*.md`）の全文はビルド時に焼き込まれる
 * （`scripts/write-canon.mjs`）。要約を手書きしないこと — docs と二重管理になる。
 */
export {
  CANON_DOCUMENTS,
  CANON_REVISION,
  REPOSITORY_URL,
  buildSelfKnowledge,
  canonDocument,
  canonNames,
  type CanonDocument,
  type SelfFacts,
} from './self.js';
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
  type ManagerDenial,
  type ManagerPool,
  type ManagerPoolOptions,
  type ManagerSendOptions,
  type ManagerSendResult,
  type ManagerAbortResult,
  type ManagerStartInput,
  type ManagerStopActor,
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
/**
 * 実行環境プロファイル（`.zprofile` 相当）。**環境変数を器に増やす代わりの口**で、
 * 用途が増えるたびに実装を直さずに済ませるためにある（`profile.ts`）。
 */
export {
  DEFAULT_PROFILE_PATH,
  PROFILE_EVAL_TIMEOUT_MS,
  PROFILE_FILE_ENV_KEY,
  PROFILE_SOURCED_ENV_KEY,
  createProfileApplier,
  createProfileVessel,
  evaluateProfile,
  normalizeProfileScript,
  renderProfileFile,
  type EvaluateProfileOptions,
  type ProfileApplier,
  type ProfileApplierOptions,
  type ProfileApplyResult,
  type ProfileEvaluation,
  type PreparedProfile,
  type ProfileFingerprint,
  type ProfileSpawn,
  type ProfileVessel,
  type ProfileVesselOptions,
  type StagedProfile,
} from './profile.js';
export {
  createProfileService,
  type ApplyProfileResult,
  type ProfileService,
  type ProfileServiceOptions,
} from './profile-service.js';
export {
  createRunnerRegistry,
  isRetryableRunnerError,
  RunnerHttpError,
  runnerAnswerCommandSchema,
  runnerCredentialFingerprintSchema,
  runnerCredentialSchema,
  runnerEventSchema,
  runnerExecutionResourcesSchema,
  runnerManagerStateSchema,
  runnerMessageCommandSchema,
  runnerPlacementResourcesSchema,
  runnerProfileFingerprintSchema,
  runnerProfileResultSchema,
  runnerResumeCommandSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetProfileCommandSchema,
  runnerStartCommandSchema,
  runnerWaitingSchema,
  type RunnerAnswerCommand,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEntry,
  type RunnerEvent,
  type RunnerExecutionResources,
  type RunnerLiveness,
  type RunnerManagerState,
  type RunnerPlacementResources,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerRegistryOptions,
  type RunnerSource,
  type RunnerResumeCommand,
  type RunnerSetCredentialsCommand,
  type RunnerSetProfileCommand,
  type RunnerStartCommand,
  type RunnerWaiting,
} from './runner-protocol.js';
/**
 * 実行環境の資源の読み方（cgroup v2）。**`os` モジュールで代用しないこと**
 * （理由と実測は `runner-resources.ts` にある）。
 */
export {
  CGROUP_ROOT,
  readExecutionResources,
  type ExecutionResourcesOptions,
} from './runner-resources.js';
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

/**
 * 何かを落としたときに stderr へ残す跡（記録の書き込み失敗と、受信箱を閉じた
 * 後に届いた合図）。
 *
 * **本文を出さないための関門である。** 落としたことをログへ出す場所は、層を問わず
 * ここを通すこと（素の `String(error)` や本文を1か所でも残すと、そこだけ将来の
 * ストア実装や新しい起点に無防備なまま置き去りになる）。
 */
export {
  inboxEventShape,
  journalEntryShape,
  noteDroppedInboxEvent,
  noteDroppedRecord,
  reasonOf,
} from './dropped-record.js';

/** テスト用ユーティリティ（本番の配線には出てこない）。 */
export {
  captureStderr,
  createMemoryStores,
  failingJobWrite,
  failingJournalAppend,
  humanMessage,
} from './testing.js';
