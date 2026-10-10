export * from './schema.js';
export * from './store.js';
/** 台帳の並び順・継続点の実装は1つにする: `commitment_list` と `GET /commitments` が別々に持つと、契約の一致を見張れない。 */
export {
  commitmentPosition,
  compareCommitmentPosition,
  encodeCommitmentCursor,
  decodeCommitmentCursor,
  resolveCommitmentCursor,
  type CommitmentPosition,
  type CommitmentCursor,
} from './commitment-cursor.js';
/** `JobStore.listApprovals` は並び順を契約していないので、承認待ちの並びを決めるのはストアではなくこの比較である。 */
export {
  compareApprovalPagingKeyAsc,
  compareApprovalPagingKey,
  type ApprovalPagingKey,
} from './approval-cursor.js';
/** 出所は SDK の `result.modelUsage` であって `usage` ではない: 後者はメインループぶんだけで、作業者の消費が落ちる。累積値なので足さずに差分を取る。 */
export * from './usage.js';
/** 台帳（自分で数えた推定値）とは足さない: こちらは claude.ai 側が言っている値。取れなかったものを 0 にしない。 */
export {
  ACCOUNT_USAGE_READ_TIMEOUT_MS,
  accountUsageSchema,
  accountUsageStateSchema,
  classifyLimitsUnavailable,
  describeLimitsUnavailable,
  extraUsageSchema,
  fetchAccountUsage,
  hasAccountUsageDetail,
  isNotLoggedIn,
  limitsUnavailableCauseSchema,
  secondsToEpochMs,
  toAccountUsage,
  usageWindowKindSchema,
  usageWindowSchema,
  type AccountUsage,
  type AccountUsageState,
  type ExtraUsage,
  type LimitsUnavailableCause,
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
  TOKEN_TRIAL_BACKOFF_CAP_MS,
  TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  TOKEN_TRIAL_PROMPT_TEXT,
  TOKEN_TRIAL_SYSTEM_PROMPT,
  TOKEN_TRIAL_TIMEOUT_MS,
  describeTrialFailureFold,
  doubledTrialIntervalMs,
  runTokenTrial,
  selectTokenForTrial,
  type RunTokenTrialOptions,
  type SelectTokenForTrialInput,
  type TokenTrialPort,
  type TokenTrialQuery,
} from './token-trial.js';
/** 「使えない」は probe の `rejected` ではない: `rejected` も認証失敗も probe からは観測できず、`undecidable` に落ちる。 */
export {
  EXHAUSTED_UTILIZATION,
  judgeTokenCandidate,
  probeTokenCandidate,
  type TokenCandidateVerdict,
} from './token-candidate.js';
export {
  classifyUsageNotice,
  describeUsageNotice,
  knownLimitRecoveryPrefixes,
  limitRecoveryOf,
  limitRecoveryOfAssistantError,
  limitRecoverySchema,
  longestMatchingPrefix,
  matchedUsageLimitPrefix,
  mergeRateLimitFacts,
  rateLimitFactsSchema,
  toRateLimitFacts,
  usageLimitKindSchema,
  usageLimitNoticeSchema,
  usageTransitionOf,
  type LimitRecovery,
  type RateLimitFacts,
  type UsageLimitKind,
  type UsageLimitNotice,
} from './usage-limits.js';
/** リセット時刻を読むだけで、検知には使わない: 検知は SDK の定数（`USAGE_LIMIT_ERROR_PREFIXES`）のままにする。 */
export { parseNoticeResetAt, type ParseNoticeResetOptions } from './usage-reset-text.js';
export {
  assistantFailureOf,
  isAnsweredResult,
  resultErrorLines,
  resultFailureOf,
  turnFailureKindOf,
  type SdkFailure,
  type SdkFailureVia,
} from './sdk-failure.js';
export {
  CONTEXT_WINDOW_FAILURE_KINDS,
  classifyContextWindowFailure,
  describeContextWindowFailure,
  type ContextWindowFailure,
  type ContextWindowFailureKind,
} from './context-window-failure.js';
/** PRD「権限境界」とは別の層: あちらは行為の一覧を持ってはいけないが、こちらは実行環境の境界（認証情報の配布範囲）である。 */
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
  isDeclaredOwner,
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
  type CreateAccountWithIdentityOutcome,
  type GrantOutcome,
  type LoginRequest,
  type LoginRequestStatus,
  type OwnerOutcome,
  type RevokeAccessTokenOutcome,
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
  type LogoutResult,
  type StartLoginInput,
  type StartLoginResult,
} from './auth-service.js';
export type { AgentPluginLoad } from './agent-events.js';
export type {
  AnswerApprovalVia,
  ClonePluginLoadObservation,
  CloneHost,
  InterruptOutcome,
  InterruptTarget,
  PendingMessage,
  PendingMessageState,
  PostPersistOutcome,
} from './host.js';
export { Inbox } from './inbox.js';
export { isTerminalJobStatus } from './progress.js';
export {
  MIN_CLOSED_IN_WINDOW,
  PROGRESS_FORECAST_METHOD,
  PROGRESS_FORECAST_NOTICE,
  summarizeProgress,
} from './progress.js';
export type {
  ProgressAgeBuckets,
  ProgressBacklog,
  ProgressCommitmentRow,
  ProgressCommitments,
  ProgressForecast,
  ProgressForecastBasis,
  ProgressInProgress,
  ProgressSummary,
  ProgressThroughput,
  ProgressUnavailableReason,
  ProgressWindow,
  SummarizeProgressInput,
} from './progress.js';
export {
  buildCommitmentDerivations,
  DEFAULT_PROGRESS_WINDOW_HOURS,
  InvalidProgressWindowError,
  PROGRESS_WINDOW_HOURS_INVALID_MESSAGE,
  readProgress,
  readUnreadableJobsForCommitments,
} from './progress-read.js';
export type { ProgressView, ReadProgressOptions } from './progress-read.js';
export {
  GITHUB_OBSERVATION_SCAN_LIMIT,
  describeGithubCi,
  PROGRESS_GITHUB_NOT_OBSERVED,
  summarizeGithubObservations,
} from './progress-github.js';
export type {
  GithubObservationCi,
  GithubObservationFailed,
  GithubObservationOk,
  GithubRepoObservation,
  ProgressGithub,
} from './progress-github.js';
export { describeProgress } from './progress-describe.js';
export { formatElapsedAgo } from './format-elapsed.js';
/** 器（storage-fs / storage-pg）もここを使う: 器ごとに書くと記憶の載せ方が食い違う。 */
export {
  assertNeverMemoryCreatedAt,
  assertNeverMemoryDescriptionDrift,
  assertNeverMemoryDescriptionFreshness,
  assertNeverMemoryFrontmatterState,
  assertNeverMemoryProtectionStatus,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryCreatedAtFromJournal,
  deriveMemoryFrontmatter,
  describeMemoryProtectionStatus,
  describeMemoryTidyTargets,
  memoryProtectionAllowsFullReplace,
  memoryProtectionRebuildDecision,
  nextDescribedState,
  parseMemoryFrontmatter,
  renderMemoryDocument,
  renderMemoryDocuments,
  renderMemoryListing,
  resolveMemoryDescriptionFreshness,
  resolveMemoryDocKind,
  type MemoryListingEntry,
  type MemoryPart,
  type RenderedMemory,
  type RenderMemoryDocumentsOptions,
} from './memory.js';
export type { CloneSystemPromptInput } from './prompt.js';
export {
  buildCloneSystemPrompt,
  buildDailyReportPrompt,
  buildDistillPrompt,
  buildExternalEventPrompt,
  EXTERNAL_EVENT_FRAMING,
  externalViaLine,
  externalAttachmentSection,
  buildManagerSystemPrompt,
  buildSelfInitiativePrompt,
  buildTimerPrompt,
  buildWorkerPrompt,
  type TimerPromptInput,
} from './prompt.js';
export {
  buildActivityDigest,
  // 字面の生成元を1つに保つために出す: `apps/cli` が自前で組むと `manager_list`（`tools.ts`）と字面が割れる。
  describeManagerState,
  describeSessionMissingKind,
  describeUnobservedOutcome,
  type DigestWindow,
} from './digest.js';
/** `GET /conversations` と `conversation_read` が同じ規則を使う: 片方だけに実装を持たせると、直したほうと忘れたほうで見えるものがずれる。 */
export {
  CONVERSATION_PREVIEW,
  bySpeaker,
  collectConversations,
  computeSupersededIds,
  conversationMessages,
  countUnread,
  effectiveReadThrough,
  humanExchanges,
  preview,
  reachedStart,
  readConversationPage,
  encodeConversationCursor,
  decodeConversationCursor,
  readConversationWindow,
  readWithdrawnClientMessageIds,
  searchExchanges,
  toMessage,
  InvalidConversationCursorError,
  type ConversationCursor,
  type ConversationMessage,
  type ConversationPage,
  type ConversationSummary,
  type Exchange,
} from './conversation.js';
export {
  lookupConversation,
  describeMissingConversation,
  CONVERSATION_CANDIDATE_LIMIT,
  type ConversationLookup,
} from './conversation-lookup.js';
export {
  deleteConversation,
  isConversationDeleted,
  CONVERSATION_DELETE_REMAINS,
  type DeleteConversationDeps,
  type DeleteConversationResult,
} from './conversation-delete.js';
export {
  EMPTY_CONVERSATION_READ_VIEW,
  UNREAD_CONVERSATION_COUNT_CAP,
  countUnreadConversations,
  loadConversationReadView,
  verifyConversationReadStoreContract,
  type ConversationBaselineResult,
  type ConversationOutboundIndex,
  type ConversationOutboundIndexRead,
  type UnreadConversationCount,
  type ConversationReadPosition,
  type ConversationReadRead,
  type ConversationReadView,
} from './conversation-read.js';
/** 3実装（インメモリ / `storage-fs` / `storage-pg`）それぞれの歯が契約を呼ぶ: 1つで測って3つとも測ったことにしない。 */
export {
  verifyJournalStoreWithContract,
  type JournalStoreWithContractSubject,
} from './journal-with-contract.js';
export {
  verifyJournalStoreDeletedConversationContract,
  type JournalStoreDeletedConversationContractSubject,
} from './journal-deleted-conversation-contract.js';
export {
  verifyJournalStoreWithdrawnContract,
  type JournalStoreWithdrawnContractSubject,
} from './journal-withdrawn-contract.js';
export {
  verifyJournalStoreOrderContract,
  type JournalStoreOrderContractSubject,
} from './journal-order-with-contract.js';
export {
  verifyConversationPageContract,
  type ConversationPageContractSubject,
} from './conversation-page-contract.js';
export {
  verifyJournalStoreQueryEdgeContract,
  type JournalStoreQueryEdgeContractSubject,
} from './journal-query-edge-contract.js';
/** インメモリは読めない行を持てないので対象外（`UnreadableJournalEntryError` の doc）。 */
export {
  verifyJournalStoreUnreadableGetContract,
  type JournalStoreUnreadableGetContractSubject,
} from './journal-unreadable-get-contract.js';
export {
  verifyJournalStoreHorizonContract,
  type JournalStoreHorizonContractSubject,
} from './journal-horizon-contract.js';
/** 判定条件を `journal_read` と `GET /journal` の2箇所に書き写さない。 */
export { journalWindowCrossesHorizon } from './journal-horizon.js';
/** `since` / `until` の扱いは3実装で食い違う（pg は時刻比較、fs・インメモリは文字列比較）ので、入口で正規化する。 */
export {
  isReadableJournalTimeBoundary,
  isOffsetQualifiedTimeBoundary,
  normalizeJournalTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  describeOffsetRequiredTimeBoundary,
} from './journal-time.js';
/** どの欄を本文と見るかは `journal-search.ts` だけが持つ: 3実装へ欄の選び方を書き写さない。 */
export {
  JOURNAL_SEARCH_FIELDS,
  JOURNAL_SEARCH_UNCOVERED_LIST,
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  JOURNAL_SEARCH_UNSEARCHABLE_TYPES,
  journalSearchValues,
  matchesJournalSearch,
  type JournalSearchTarget,
} from './journal-search.js';
/** `JournalStore.list()` を `limit` なしで呼ばない: pg 実装が `Number.MAX_SAFE_INTEGER` を渡し、窓の中身が多い日に全件をヒープへ載せて落ちる。ページ単位で読み、1ページぶんより多くを同時に持たない。 */
export { listPageByOverfetch } from './journal-page.js';
export {
  verifyJournalStorePageContract,
  type JournalStorePageContractSubject,
} from './journal-page-contract.js';
export {
  JOURNAL_SCAN_PAGE_SIZE,
  scanJournalPages,
  type JournalScanOptions,
  type JournalScanPageHandler,
  type JournalScanResult,
} from './journal-scan.js';
export {
  describeQuestionsViolation,
  describeSelectionsViolation,
  describeQuestionLines,
  foldSelections,
  summarizeQuestions,
} from './approval-choices.js';
export {
  APPROVAL_TRACE_ACTION_LIMIT,
  APPROVAL_TRACE_SCAN_LIMIT,
  APPROVAL_TRACE_STATES,
  describeTraceAction,
  renderApprovalTrace,
  stampAnsweredApproval,
  traceApproval,
  type ApprovalTrace,
  type ApprovalTraceRenderOptions,
  type ApprovalTraceState,
} from './approval-trace.js';
/** 「蒸留を始めた」ではなく「蒸留が成功で終わった」記録で数える: 開始で数えると、始めたが完了しなかった回（検出したい形）が落ちる。 */
export {
  BOOT_FOOTPRINT_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_EVENT_SOURCE,
  DISTILL_GAP_ACTIVITY_SCAN_LIMIT,
  DISTILL_GAP_NOTICE_HEAD,
  DISTILL_SUCCEEDED_DECISION_PREFIX,
  countsAsUndistilledActivity,
  deriveDistillGapFromJournal,
  describeDistillGap,
  distillSucceededEntry,
  isDistillSucceededEntry,
  type DistillGap,
  type DistillReason,
} from './distill-gap.js';
export {
  verifyJournalStoreSearchContract,
  type JournalStoreSearchContractSubject,
} from './journal-search-contract.js';
export { verifyTranscriptArchiveContract } from './archive-contract.js';
export { InvalidArchiveSessionIdError, assertArchivableSessionId } from './archive-session-id.js';
export { verifyCommitmentFoldContract } from './commitment-fold-contract.js';
export { verifyCommitmentTieOrderContract } from './commitment-tie-order-contract.js';
export { verifyCommitmentEditIfMatchContract } from './commitment-edit-if-match-contract.js';
export { verifyCommitmentRemoveForConversationContract } from './commitment-remove-for-conversation-contract.js';
export { verifyCommitmentEditUnreadableContract } from './commitment-edit-unreadable-contract.js';
export { verifyMcpServerStoreContract } from './mcp-server-contract.js';
export { verifyPluginStoreContract } from './plugin-store-contract.js';
export { verifyProfileStoreContract } from './profile-store-contract.js';
export { verifyPermissionGrantStoreContract } from './permission-grant-contract.js';
export { verifyPracticeStoreContract } from './practice-contract.js';
export { verifyListOrderContract } from './list-order-contract.js';
export { verifyApprovalConversationFilterContract } from './approval-conversation-filter-contract.js';
export { compareCodeUnits } from './code-unit-order.js';
export { verifyStoreIsolationContract } from './store-isolation-contract.js';
export {
  classifyArchiveContinuity,
  describeArchiveContinuityForJournal,
  fingerprintArchiveBody,
  tallyArchiveContinuity,
  type ArchiveBodyFingerprint,
  type ArchiveContinuity,
} from './archive-continuity.js';
/** 同じミリ秒に積んだ行の tie-break に `id` の字面順を使わない: PostgreSQL の collation に依存し、3本以上積むと1本目を直前だと誤認する。 */
export {
  archiveIdBranch,
  compareArchiveEntriesNewestFirst,
  matchArchiveIdStamp,
  type ArchiveIdStampMatch,
} from './archive-id.js';
/** `storage-fs` / `storage-pg` はパッケージが別なので、このバレルを経由しないと届かない。 */
export { codePointBoundary, countCodePoints, tailByCodePoints } from './excerpt.js';
/** 並びを pg の `timestamptz` 順と揃えるため、オフセット付き ISO 時刻は文字列でなく実時刻で比べる。 */
export { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
export {
  ARCHIVE_REMOVED_BYTES_UNIT_NOTE,
  describeArchiveRemovedBytesUnit,
} from './archive-removed-bytes.js';
/** 外へ出すのは純関数だけ: I/O をせず、本文（`body`）にも触れない。 */
export {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  ARCHIVE_REMOVE_MANY_LIMIT_MAX,
  matchesArchiveRemoveManyFilter,
  selectArchiveRemovalTargets,
  type ArchiveRemoveManyFilter,
  type ArchiveRemovalSelection,
  type ArchiveRemovalSelectionOptions,
} from './archive-prune.js';
/** 正典（`docs/*.md`）はビルド時に焼き込む。要約を手書きしない: docs と二重管理になる。 */
export {
  CANON_DOCUMENTS,
  CANON_REVISION,
  REPOSITORY_URL,
  buildSelfKnowledge,
  canonDocument,
  canonNames,
  describeCloneRuntime,
  type CanonDocument,
  type CloneRuntimeFacts,
  type SelfFacts,
} from './self.js';
export {
  describeProviderGaps,
  type LayerProviders,
  type ProviderGapSubject,
} from './provider-gaps.js';
export { DEFAULT_LAYER_PROVIDERS } from './layer-providers.js';
export {
  resolveBuildRevision,
  describeBuildRevision,
  describeRevisionStatus,
  reportRunnerRevision,
  buildRevisionSchema,
  type BuildRevision,
  type RevisionSource,
  type RunnerRevisionReport,
} from './revision.js';
export {
  countManagerSituation,
  countRunnerStates,
  describeSituation,
  describeSituationUnavailable,
  type ManagerSituationCounts,
} from './situation.js';
/** `removeInboxEventsAndStopDelivery` だけは I/O をする: 器から消す操作とクローンの配達を止める操作を1つの呼びから分けない（2箇所に割れると片方だけ直った形が残る）。 */
export {
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
  INBOX_BACKLOG_LOUD_THRESHOLD,
  INBOX_EVENT_TYPE_ORDER,
  inboxBacklogDedupeKey,
  inboxBacklogSourceFor,
  summarizeInboxBacklog,
  describeInboxBacklogBreakdown,
  describeNoReadableInboxEvents,
  // 再定義せずここから import する: 描画が2箇所に分かれると字面がずれる。
  describeHumanOriginatedInboxAlert,
  matchesInboxRemoveManyFilter,
  removeInboxEventsAndStopDelivery,
  type InboxBacklogBreakdown,
  type InboxDeliveryStopper,
  type InboxRemoveManyFilter,
} from './inbox-backlog.js';
export {
  countSupersedingReports,
  describeSuperseded,
  type SupersededDecision,
} from './superseded.js';
export { CRON_EXPRESSION_MAX, isCronExpression, parseCron, type CronSchedule } from './cron.js';
/** SSE を出す側が daemon と runner の3経路に分かれるので core に置く: `apps/*` の片側に置くと、もう片側から逆向きの依存になる。 */
export {
  DEFAULT_SSE_HEARTBEAT_MS,
  HEARTBEAT_FRAME,
  startSseHeartbeat,
  type SseHeartbeatStream,
} from './sse-heartbeat.js';
export {
  DAILY_REPORT_KIND,
  MEMORY_TIDY_KIND,
  RESERVED_SCHEDULE_KINDS,
  RESERVED_SCHEDULE_KIND_ENV_KEYS,
  SELF_INITIATIVE_KIND,
  type ReservedScheduleKind,
  createScheduler,
  describeReservedScheduleKindEnvKeys,
  dailyReportEntry,
  dailyReportEvent,
  describeScheduleSpec,
  localDate,
  localDayRange,
  memoryTidyEntry,
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
  type ManagerAwaitingBackground,
  type ManagerDecision,
  type ManagerDenial,
  type ManagerPool,
  type ManagerPoolOptions,
  type VacateHandshakeSkipReason,
  type VacateResult,
  type ManagerSendOptions,
  type ManagerSendResult,
  type ManagerAbortResult,
  type ManagerStartInput,
  type ManagerStopActor,
  type ManagerSummary,
  type ManagerTranscript,
  type ManagerUnpushedWork,
  describeDenialFollowUp,
  guardArchiveRemoval,
  type ArchiveRemovalGuard,
  type SessionMissingKind,
  type TokenGenerationUnknownReason,
  type RunnerFleetOverview,
  type RunnerManagerEntry,
  type RunnerOverview,
  type RunnerPushHealth,
  type RunnerPluginLoadObservation,
  type RunnerManagerPeers,
  type RunnerPushOutcome,
  resolveWorkspacePolicy,
  type WorkerToolEvent,
  type WorkspacePolicy,
} from './manager.js';
export { WORKER_TOOL_RUNNING_AFTER_MS } from './runner-worker-tool-watch.js';
/** 「落ちた」は停止の証明ではない: 引き取ってよいかは lease の期限で判定する。 */
export {
  LEASE_DRAIN_MS,
  LEASE_MARGIN_MS,
  LEASE_TTL_MS,
  describeVerdict,
  grantLease,
  judgeLease,
  mayClaim,
  releaseLease,
  touchLease,
  type LeaseSighting,
  type LeaseVerdict,
} from './lease.js';
/** デーモンは `RunnerRegistry` しか見ない: 固定 URL も runner のローカルパスも前提にしない。 */
export {
  MANAGER_MODEL_ENV_KEY,
  WORKER_MODEL_ENV_KEY,
  createRunnerHost,
  placedManagerModels,
  RunnerPluginExtractError,
  resolveManagerModel,
  resolveWorkerModel,
  type RunnerChildUser,
  type RunnerHost,
  type RunnerHostOptions,
  type RunnerHostPeerOptions,
  type RunnerManagerPeersAnnouncement,
  type RunnerManagerToolsOptions,
  type RunnerPeerOptions,
} from './runner.js';
export { managerModelsOf, type ManagerModels } from './manager-models.js';
export { createLocalRunner, type LocalRunnerOptions } from './runner-local.js';
/** 伏せるのは上（記憶）へ到達する鍵だけで、下（外の世界）へ手を伸ばす鍵は配る。器を作り直さずに回せる形で持つ。 */
export {
  CREDENTIAL_NAME,
  DEFAULT_CREDENTIAL_DIR,
  credentialNamesShadowedByProfile,
  ROTATABLE_CREDENTIAL_KEYS,
  POOL_OWNED_CREDENTIAL_NAMES,
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  isWithheldCredentialName,
  createCredentialStore,
  describeSkippedCredentialRow,
  fingerprintOf,
  type CredentialEntry,
  type CredentialFingerprint,
  type CredentialStore,
  type CredentialStoreOptions,
} from './credentials.js';

/** 正本はデーモンが持つ。 */
export {
  CredentialEntryRejectedError,
  createCredentialService,
  resolveCredentialRows,
  type ApplyCredentialsResult,
  type CredentialService,
  type CredentialServiceOptions,
} from './credential-service.js';
export {
  APP_ENV_VAR_DEFAULTS,
  applyAppScopedEnvVars,
  ENV_BASE_MIGRATION_MARKER,
  migrateEnvBaseCredentialsOnce,
  seedDefaultEnvVars,
} from './env-vars-boot.js';
export {
  DEFAULT_PROFILE_PATH,
  PROFILE_EVAL_TIMEOUT_MS,
  PROFILE_FILE_ENV_KEY,
  PROFILE_SOURCED_ENV_KEY,
  createProfileApplier,
  createProfileVessel,
  evaluateProfile,
  normalizeProfileScript,
  redactProfileFailure,
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
  isReservedMcpServerName,
  mcpHttpServerConfigSchema,
  mcpServerConfigSchema,
  mcpServerNames,
  mcpServerNameSchema,
  mcpServersFingerprintOf,
  mcpServersVersionOf,
  McpServersConflictError,
  mcpServersSchema,
  mcpSseServerConfigSchema,
  mcpStdioServerConfigSchema,
  parseMcpServers,
  sortMcpServers,
  type McpServerEntryConfig,
  type McpServers,
  type StoredMcpServers,
  type WriteMcpServersOptions,
} from './mcp-servers.js';
export {
  computePluginContentSha256,
  isValidPluginName,
  OFFICIAL_MARKETPLACE,
  OFFICIAL_MARKETPLACE_URL,
  resolveMarketplaceUrl,
  normalizePluginDescription,
  parsePluginInput,
  parsePluginSummary,
  parseStoredPlugin,
  pluginDirName,
  pluginSummarySchema,
  pluginFileSchema,
  pluginInputSchema,
  PluginNameConflictError,
  pluginNamesCollide,
  pluginNameSchema,
  pluginRelativePathSchema,
  pluginRepoUrlSchema,
  pluginScopeSchema,
  pluginSourceSchema,
  pluginSourceShaSchema,
  pluginSummaryOf,
  PLUGIN_LIMITS,
  sortPluginSummaries,
  storedPluginSchema,
  validatePluginFilePath,
  isPluginScopeForRunner,
  parseRunnerPlugin,
  PLUGIN_SCOPES_FOR_RUNNER,
  pluginsFingerprintOf,
  type PluginFile,
  type PluginFingerprintEntry,
  type PluginInput,
  type PluginSource,
  type PluginSummary,
  type RunnerPlugin,
  type StoredPlugin,
} from './plugins.js';
export {
  decodeRunnerPlugin,
  encodeRunnerPlugin,
  RUNNER_PLUGIN_BODY_LIMIT_BYTES,
  RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES,
} from './runner-plugin-wire.js';
export {
  createPluginDistributionService,
  type ApplyPluginsResult,
  type PluginDistributionService,
  type PluginDistributionServiceOptions,
  type PluginsRunnerResult,
} from './plugin-distribution-service.js';
export {
  defaultRunnerPluginsRoot,
  extractedPluginDirName,
  extractPluginsForScopes,
  PLUGIN_SCOPES_FOR_CLONE,
  pruneExtractedPluginDirs,
  pruneExtractedPluginsAgainstStore,
  pruneRunnerPluginsOnBoot,
  runnerPluginsDirOptions,
  type ExtractForScopesResult,
  type PluginExtractFailure,
  type PluginScope,
  type PrunePluginsResult,
  type RemovedItem,
} from './plugin-extract.js';
export {
  createPluginFetcher,
  PluginFetchError,
  type FetchedPlugin,
  type PluginFetcher,
  type PluginFetcherOptions,
  type PluginFetchErrorKind,
  type PluginRequest,
  type SkippedEntry,
} from './plugin-fetch.js';
export {
  createPluginPreviewStore,
  PLUGIN_PREVIEW_TTL_MS,
  summarizeFetchedPlugin,
  type PluginPreviewStore,
  type PluginPreviewStoreOptions,
  type PluginPreviewSummary,
} from './plugin-preview.js';
export {
  createMcpServerService,
  type ApplyMcpServersResult,
  type McpServerService,
  type McpServerServiceOptions,
  type McpServersRunnerResult,
} from './mcp-server-service.js';
export {
  composeProfileScript,
  composedFingerprints,
  createProfileService,
  profileScopeAppliesTo,
  ProfileInputError,
  ProfileRollbackFailedError,
  type ApplyProfileResult,
  type ComposedFingerprint,
  type ProfileComposeTarget,
  type ProfileService,
  type ProfileServiceOptions,
} from './profile-service.js';
export { nonBlankString } from './non-blank-string.js';
/** ここでは回さない: 検知も切替も持たず、器・設定・入出力の口だけを持つ。 */
export {
  agentTokenInputSchema,
  agentTokenSchema,
  agentTokenViewSchema,
  cooldownSourceSchema,
  DEFAULT_TOKEN_COOLDOWN_MS,
  DEFAULT_TOKEN_ROTATION_POLICY,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  TokenPoolInputError,
  credentialOf,
  markTokenUnusable,
  classifyTokenPolicyChange,
  classifyTokenPoolChange,
  markTokenUsable,
  normalizeTokenPool,
  toAgentTokenView,
  tokenAvailabilityAt,
  tokenRecoveryOf,
  tokenRotationPolicySchema,
  activeAgentTokenSchema,
  tokenRotationSettingsSchema,
  type ActiveAgentToken,
  type AgentToken,
  type AgentTokenInput,
  type AgentTokenView,
  type AuthoritativeCooldownSource,
  type CooldownSource,
  type NormalizeTokenPoolOptions,
  type TokenCredential,
  type TokenPoolChange,
  type TokenPolicyChange,
  type TokenFailureObservation,
  type TokenRotationPolicy,
  type TokenRotationSettings,
} from './token-pool.js';
export {
  cooldownDeadlineFrom,
  cooldownUntilFrom,
  decideTokenRotation,
  earliestRememberedCooldown,
  observationFreshness,
  selectNextToken,
  type ObservationFreshness,
  type SelectNextTokenOptions,
  type TokenRotationDecision,
  type TokenRotationObservation,
  type TokenRotationSignal,
  type TokenSelection,
} from './token-rotation.js';
/** `TokenPoolService` と `TokenRotator` は同じ鍵を共有する: `apps/daemon/src/index.ts` が1つ作って両方へ渡す。 */
export { createTokenPoolWriteLock, type TokenPoolWriteLock } from './token-pool-write-lock.js';
export {
  createTokenPoolService,
  type ReplaceResult,
  type TokenPoolService,
  type TokenPoolServiceOptions,
  type TokenPoolView,
  type TokenRowsUnreadable,
} from './token-pool-service.js';
/** 撒く先（runner / クローン）は外から渡す（`TokenSpreadPort`）: core が `apps/*` に依存しない。 */
export {
  createTokenRotator,
  describeTokenRestore,
  describeTokenRotation,
  tokenRestoreEntry,
  tokenRotationEntry,
  type TokenProbePort,
  type TokenReconsiderReason,
  type TokenRestoreOutcome,
  type TokenRotationEntry,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenRotatorObservation,
  type TokenRotatorOptions,
  type TokenSpreadPort,
  type TokenSpreadResult,
  type TokenVerdictOrigin,
} from './token-rotator.js';
/** 同じ実体を経路ごとに別インスタンスで使う（`manager.ts` の rate_limit 用と `apps/daemon` の `token_rotation` 用）。 */
export {
  JOURNAL_FOLD_IDLE_GAP_MS,
  JOURNAL_FOLD_MAX_SPAN_MS,
  JOURNAL_FOLD_MAX_SUPPRESSED,
  JournalFoldWindow,
  foldedRunText,
  type JournalFoldRun,
  type JournalFoldVerdict,
} from './journal-fold.js';
export {
  assertNeverRunnerLegStatus,
  createRunnerRegistry,
  isFencedRunnerError,
  isRetryableRunnerError,
  RunnerFenceError,
  RunnerHttpError,
  RunnerMcpServersUnsupportedError,
  RunnerPluginsUnsupportedError,
  RUNNER_PLUGIN_RETAIN_MAX_NAMES,
  runnerPluginFileWireSchema,
  runnerPluginFingerprintEntrySchema,
  runnerPluginsFingerprintSchema,
  runnerRetainPluginsCommandSchema,
  runnerSetPluginCommandSchema,
  runnerAnswerCommandSchema,
  runnerRescueRefDeleteRequestSchema,
  runnerRescueRefDeleteResultSchema,
  runnerAnswerResultSchema,
  runnerCredentialFingerprintSchema,
  runnerCredentialSchema,
  runnerEventSchema,
  RUNNER_CAPABILITIES,
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
  runnerExecutionResourcesSchema,
  runnerLeaseSchema,
  runnerLivenessSchema,
  listRunnerManagers,
  runnerManagerStateSchema,
  runnerMcpServersFingerprintSchema,
  runnerMessageCommandSchema,
  runnerPlacementResourcesSchema,
  runnerProfileFingerprintSchema,
  runnerProfileResultSchema,
  runnerAttachmentSchema,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  type RunnerStagedAttachmentMeta,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  runnerOutboxFileSchema,
  runnerOutboxRejectedFileSchema,
  type RunnerOutboxFile,
  type RunnerOutboxRejectedFile,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  runnerManagerPeerSchema,
  runnerManagerPeerClosedSchema,
  type RunnerManagerPeer,
  type RunnerManagerPeerClosed,
  runnerResumeCommandSchema,
  runnerSessionOpenResultSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetMcpServersCommandSchema,
  runnerSetCodexAuthCommandSchema,
  runnerTakeCodexAuthWriteBackCommandSchema,
  runnerCodexAuthWriteBackSchema,
  runnerSetProfileCommandSchema,
  runnerStartCommandSchema,
  runnerWaitingSchema,
  unpushedWorkResultSchema,
  unpushedWorkTreeSchema,
  waitingKindSchema,
  type RunnerAnswerCommand,
  type RunnerAttachment,
  type RunnerRescueRefDeleteRequest,
  type RunnerRescueRefDeleteResult,
  type RunnerAnswerOutcome,
  type RunnerAnswerResult,
  type RunnerClient,
  type RunnerOutboxContent,
  type RunnerCredentialFingerprint,
  type RunnerEntry,
  type RunnerEvent,
  type RunnerExecutionResources,
  type RunnerLease,
  type RunnerLegState,
  type RunnerLiveness,
  type RunnerManagerListing,
  type RunnerManagerState,
  type RunnerMcpServersFingerprint,
  type PidsSaturation,
  type PidsSaturationBasis,
  type PidsSaturationSign,
  describePidsSaturation,
  pidsSaturationFrom,
  type RunnerPlacementResources,
  type RunnerPluginFingerprintEntry,
  type RunnerPluginsFingerprint,
  type RunnerRetainPluginsCommand,
  type RunnerSetPluginCommand,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerRegistryOptions,
  type RunnerRevisionStatus,
  type RunnerResumeResult,
  type RunnerSessionOpenResult,
  type RunnerSource,
  type RunnerResumeCommand,
  type RunnerSetCredentialsCommand,
  type RunnerSetMcpServersCommand,
  type RunnerSetProfileCommand,
  type RunnerStartCommand,
  type RunnerWaiting,
  type UnpushedWorkResult,
  type UnpushedWorkTree,
  type WaitingKind,
} from './runner-protocol.js';
/** `git` の起動は呼び出し側（`runner.ts`）が別 UID で行うので、ここは純粋な探索・判定ロジックだけを持つ。 */
export {
  computeUnpushedWork,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_WORKTREES,
  findGitDirs,
  type ComputeUnpushedWorkOptions,
  type FindGitDirsResult,
  type ProcessSpawnFn,
} from './unpushed-work.js';
/** `os` モジュールで代用しない（理由は `runner-resources.ts`）。 */
export {
  CGROUP_ROOT,
  readExecutionResources,
  type ExecutionResourcesOptions,
} from './runner-resources.js';
export {
  containsShellMetacharacters,
  describePermissionRuleBreadth,
  matchPermissionRule,
  parsePermissionRule,
  validatePermissionRequest,
  type ParsedPermissionRule,
  type PermissionRequestCandidate,
  type PermissionRequestValidation,
  type PermissionRuleBreadth,
  type PermissionRuleBreadthLevel,
  type PermissionRuleKind,
  type PermissionRuleParseResult,
} from './permission-rule.js';
export {
  PERMISSION_GRANT_STALE_DAYS,
  assessPermissionGrantStaleness,
  type PermissionGrantStaleness,
  type PermissionGrantStalenessInput,
} from './permission-staleness.js';
export {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  DEFAULT_MEMORY_GUARD,
  MCP_SERVER_NAME,
  MEMORY_GUARD_ENV,
  MEMORY_GUARD_VALUES,
  REMOVE_MANY_JOURNAL_ID_CHARS,
  REMOVE_MANY_LIMIT_DEFAULT,
  REMOVE_MANY_LIMIT_MAX,
  chunkIdsByChars,
  createCloneMcpServer,
  createCloneTools,
  // 字面の生成元を1つに保つために出す: `apps/cli` が自前で組むと `manager_list`（`tools.ts`）と字面が割れる。
  describeReportDriftMark,
  describeToolUseStall,
  describeTurnEnd,
  isFoldedTurnReport,
  qualifiedToolName,
  resolveMemoryGuard,
  type MemoryGuardValue,
  type ToolContext,
} from './tools.js';
// デーモンは `clone.ts` の中から使うだけだが、image の検査（ci.yml）が焼いたイメージの中で本物の CLI と繋ぐために外へ出す。
export {
  createCloneToolRelayHost,
  DEFAULT_REGISTRATION_TIMEOUT_MS,
  type CloneToolRelayHost,
} from './clone-tool-relay-host.js';
export {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';
export {
  CLONE_TOOLS_TRANSPORT_ENV_KEY,
  DEFAULT_CLONE_TOOL_RELAY_SOCKET_DIR,
  resolveCloneToolRelayChildEntry,
} from './clone-tools-transport.js';
export {
  ALWAYS_REDELIVER,
  DAILY_REPORT_RETRY_DELAYS_MS,
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_HUMAN_PRIORITY_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  MAX_UTF8_BYTES_PER_CODE_POINT,
  createClone,
  isDaemonSelfNotice,
  placedCloneModel,
  placedClonePermissionMode,
  resolveCloneModel,
  isHumanOriginated,
  resolveCloneHumanPriority,
  resolveClonePermissionMode,
  staleObservedRecoveryForBlockedKey,
  staleObservedRecoveryNoticeEvent,
  tokenPoolReopenedPayload,
  type CloneOptions,
  type RedeliveryGate,
  type TokenPoolReopenedPayload,
  ApprovalAlreadySettledError,
  InvalidApprovalSelectionsError,
} from './clone.js';
export {
  DAEMON_RESERVED_EVENT_SOURCES,
  isReservedEventSource,
  normalizeEventSource,
} from './daemon-self-notice.js';
export { placedModelTier, resolveModelTier } from './model-tier.js';
export {
  ANTHROPIC_ROUTE_NONE_LINE,
  describeAnthropicRoute,
  describeToolSearch,
  inspectAnthropicRoute,
  inspectToolSearch,
  type AnthropicRouteInspection,
  type AnthropicRouteLayer,
  type ToolSearchInspection,
} from './anthropic-route-env.js';
export type { AgentProviderId } from './agent-ports.js';
export {
  DEFAULT_AGENT_PROVIDER_ID,
  agentProviderOf,
  placedAgentProvider,
} from './agent-provider-selection.js';
export {
  MANAGER_PEERS_ENV_KEY,
  RETIRED_LAYER_PROVIDER_ENV_KEYS,
  retiredLayerProviderNotices,
} from './retired-provider-env.js';
export {
  CODEX_PEER_CLOSED_REASON,
  MANAGER_PEER_CODEX_MODELS_ENV_KEY,
  PEER_PROVIDER_IDS,
  managerPeerModelsEnvKey,
  parsePeerModels,
  resolvePeerModels,
  resolvePeerModelsOf,
  resolvePeerOpening,
  samePeerOpening,
  type PeerClosed,
  type PeerCredentialPresence,
  type PeerDefaultModelsOf,
  type PeerModelsSource,
  type PeerOpening,
} from './agent-provider-peers.js';
export {
  EXCHANGE_KIND_DECISION_PREFIX,
  EXCHANGE_KIND_FAILURE_PREFIX,
  EXCHANGE_KIND_GAUGE_PREFIX,
  EXCHANGE_KIND_PREFIXES,
  EXCHANGE_KIND_RECOVERY_PREFIX,
  EXCHANGE_KIND_REPLY_PREFIX,
  EXCHANGE_KIND_THINNING_PREFIX,
  inferExchangeKindFromText,
  type ExchangeKind,
} from './exchange-kind.js';
/** 能力の制限ではなく実行環境の設定である（理由は `permission-mode.ts`）。 */
export {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  placedPermissionMode,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';

/** 本文を出さないための関門: 落としたことをログへ出す場所は層を問わずここを通す（素の `String(error)` や本文を1か所でも残すと、そこだけ無防備になる）。 */
export {
  approvalShape,
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  inboxEventShape,
  journalEntryShape,
  journalRowType,
  noteDroppedInboxEvent,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  noteDroppedRecord,
  noteDroppedRunnerManagers,
  noteSessionMaterialUnreadable,
  noteUncaught,
  reasonOf,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
  writeStderrSync,
  type DroppedJournalRowReason,
  type DroppedTraceOrigin,
} from './dropped-record.js';

export {
  createUnreadableRowOnce,
  unreadableRowKey,
  type UnreadableRowOnce,
} from './unreadable-row-once.js';

export { collapseErrorCause } from './error-cause.js';

/** 例外の文は `redactSecretsInText` ではなく `redactErrorText` を通す: `params:` 以降も落とさないと秘密が漏れる。 */
export { redactErrorText, redactSecretsInBody, redactSecretsInText } from './denial-input-head.js';

/** テスト専用（本番の配線には出てこない）。帳面（`recentDroppedTraces()`）はプロセスの生存中ずっと共有されるので、前のテストの行と混ざらないよう断言の前に呼ぶ。 */
export { clearRecentTracesForTesting } from './dropped-record.js';

/** 観測だけで終了の挙動は変えない: `uncaughtException` ではなく `uncaughtExceptionMonitor` を使う理由は `uncaught-net.ts`。 */
export { installUncaughtNet } from './uncaught-net.js';

/** 何を残し何を消すかはここにしか書かない（CLI の `alteroid reset` と `POST /reset` が使う唯一の正本）。 */
export {
  describeResetTargets,
  RESET_CONFIRM_GROUPS,
  resetWorkspaceState,
  type ResetWorkspaceStateOptions,
  type WorkspaceResetSummary,
} from './workspace-reset.js';

export { MemoryAttachmentStore } from './attachment-memory.js';
export {
  ATTACHMENT_S3_ACCESS_KEY_ID_ENV,
  ATTACHMENT_S3_BUCKET_ENV,
  ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV,
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_ORPHAN_BLOB_GRACE_MS,
  MemoryAttachmentBlobStore,
  S3_MAX_OBJECT_BYTES,
  S3_MAX_UPLOAD_PARTS,
  S3_MIN_PART_BYTES,
  attachmentBlobKey,
  attachmentBlobPartBytesFor,
  attachmentBlobListPrefix,
  isAttachmentBlobKey,
  readAttachmentBlobConfig,
  type AttachmentBlobSweepResult,
  type AttachmentBlobConfig,
  type AttachmentBlobConfigResult,
  type AttachmentBlobStore,
} from './attachment-blob.js';
export {
  captureStderr,
  createMemoryStores,
  failingJobWrite,
  failingJournalAppend,
  humanMessage,
} from './testing.js';

export {
  createSyntheticJournalStore,
  type SyntheticJournalStore,
  type SyntheticJournalStoreOptions,
} from './journal-scan.test-support.js';
export {
  createPeerSocketHost,
  DEFAULT_PEER_SOCKET_DIR,
  PEER_SOCKET_FILENAME,
  PEER_TOKEN_TIMEOUT_MS,
  type PeerSocketHost,
} from './peer-socket-host.js';
export {
  createManagerToolsMcpServer,
  createManagerToolsSocketHost,
  DEFAULT_MANAGER_TOOLS_SOCKET_DIR,
  MANAGER_TOOLS_MCP_SERVER_NAME,
  MANAGER_TOOLS_SOCKET_FILENAME,
  OUTPUT_RECORD_TOOL_NAME,
  type ManagerToolsSocketHost,
  type OutputRecordInput,
} from './manager-tools.js';
export {
  createPeerBroker,
  describePeerTurnResult,
  parsePeerActor,
  peerActorOf,
  PEER_MCP_SERVER_NAME,
  PEER_SYSTEM_PROMPT_APPEND,
  PEER_TOOL_NAMES,
  PEER_APPROVAL_DECISIONS,
  type PeerApprovalDecision,
  type PeerApprovalRecord,
  type PeerBackgroundStarted,
  type PeerCallResult,
  type PeerPendingApproval,
  type PeerBroker,
  type PeerBrokerDeps,
  type PeerTurnEvent,
  type PeerTurnResult,
  type PeerUsageReport,
} from './peer-broker.js';
/** 鍵・環境変数になる値の NUL は {@link NulNotAllowedError} で断り、それ以外の本文は {@link stripNul} で落として残す。 */
export { NulNotAllowedError, assertNoNul, hasNul, stripNul } from './nul-guard.js';
export { stripNulDeep, stripNulWellFormed } from './nul-guard.js';
export { InvalidCredentialNameError, assertValidCredentialEntries } from './credential-input.js';
export {
  DuplicateTokenIdError,
  assertValidActiveToken,
  prepareTokensForReplace,
} from './token-pool-input.js';
export {
  verifyCredentialSeedOnceContract,
  verifyCredentialVaultContract,
} from './credential-contract.js';
export { verifyTokenPoolContract } from './token-pool-contract.js';
export { verifyCodexChatgptAuthContract } from './codex-chatgpt-auth-contract.js';
export * from './codex-chatgpt-auth.js';
export {
  createCodexChatgptAuthService,
  type CodexChatgptAuthService,
  type CodexChatgptAuthServiceOptions,
  type CodexLoginView,
} from './codex-chatgpt-auth-service.js';
export { RunnerCodexAuthUnsupportedError } from './runner-protocol.js';
export {
  CODEX_DEVICE_LOGIN_TIMEOUT_MS,
  startCodexDeviceLogin,
  type CodexDeviceLogin,
  type CodexDeviceLoginOptions,
  type CodexDeviceLoginOutcome,
  type CodexDeviceLoginStarted,
} from './codex-device-login.js';
/** 消費の台帳は、鍵列の NUL も断らず落として残す。 */
export {
  USAGE_NUL_ONLY_TOKEN_ID,
  stripNulFromUnmeteredRecord,
  stripNulFromUsageRecord,
  stripNulFromUsageQuery,
  stripNulFromUsageSnapshot,
} from './usage-input.js';
export { verifyUsageNulContract } from './usage-nul-contract.js';
export { verifyUsageRunnerContract } from './usage-runner-contract.js';
export { prepareMcpServersForWrite } from './mcp-servers.js';
export { assertProfileRowWritable } from './profile-input.js';
export { preparePermissionGrantForPut } from './permission-grant-input.js';
export { verifySessionRegistryNulContract } from './session-registry-nul-contract.js';
export { verifyPersonaNulContract } from './persona-nul-contract.js';
export { verifyScheduleNulContract } from './schedule-nul-contract.js';
export { verifyScheduleIfMatchContract } from './schedule-if-match-contract.js';
export { verifyMcpServersIfMatchContract } from './mcp-servers-if-match-contract.js';
export { verifyScheduleUnreadableContract } from './schedule-unreadable-contract.js';
export { verifyJobNulContract } from './job-nul-contract.js';
export { prepareApprovalForWrite, prepareJobForWrite } from './job-input.js';
export {
  prepareAccessTokenForWrite,
  prepareAccountForWrite,
  prepareIdentityForWrite,
  prepareLoginRequestForWrite,
} from './auth-input.js';
export { verifyAuthNulContract } from './auth-nul-contract.js';

export {
  DEFAULT_INTEGRATION_MAX_BODY_BYTES,
  DEFAULT_INTEGRATION_RATE_PER_MINUTE,
  INTEGRATION_KEY_LAST_USED_THROTTLE_MS,
  INTEGRATION_KEY_PREFIX,
  INTEGRATION_SOURCE_PATTERN,
  compareIntegrationKeyOrder,
  integrationKeyFingerprint,
  integrationKeyLimits,
  integrationKeyRecordSchema,
  integrationSourceSchema,
  isIntegrationKeyUsable,
  issueIntegrationKeyValue,
  looksLikeIntegrationKey,
  prepareIntegrationKeyForWrite,
  resolveIntegrationKey,
  type IntegrationKeyRecord,
  type IntegrationKeyStore,
  type IntegrationLimits,
  type RevokeIntegrationKeyOutcome,
  type UnreadableIntegrationKey,
} from './integration-key.js';
export { verifyIntegrationKeyStoreContract } from './integration-key-contract.js';
export {
  EVENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  EVENT_RECEIPT_RETENTION_MS,
  assertEventReceiptWritable,
  eventReceiptCutoff,
  type EventReceipt,
  type EventReceiptStore,
} from './event-receipt.js';
export { verifyEventReceiptStoreContract } from './event-receipt-contract.js';
export {
  attachmentTooLargeMessage,
  attachmentTooManyMessage,
  attachmentTotalTooLargeMessage,
} from './attachment-wording.js';
export {
  ATTACHMENT_IMAGE_MEDIA_TYPES,
  ATTACHMENT_DISK_NAME_MAX_BYTES,
  ATTACHMENT_MAX_FILE_BYTES_DEFAULT,
  ATTACHMENT_MAX_FILE_BYTES_ENV,
  ATTACHMENT_MAX_IMAGE_BYTES_DEFAULT,
  ATTACHMENT_MAX_IMAGE_BYTES_ENV,
  ATTACHMENT_MAX_PER_MESSAGE_DEFAULT,
  ATTACHMENT_MAX_PER_MESSAGE_ENV,
  ATTACHMENT_MAX_TOTAL_BYTES_DEFAULT,
  ATTACHMENT_MAX_TOTAL_BYTES_ENV,
  ATTACHMENT_MAX_TURN_IMAGES_DEFAULT,
  ATTACHMENT_MAX_TURN_IMAGES_ENV,
  ATTACHMENT_MAX_TURN_IMAGE_BYTES_DEFAULT,
  ATTACHMENT_MAX_TURN_IMAGE_BYTES_ENV,
  ATTACHMENT_EMPTY_MESSAGE,
  ATTACHMENT_NAME_MAX_LENGTH,
  ATTACHMENT_RETENTION_DAYS_DEFAULT,
  ATTACHMENT_RETENTION_DAYS_ENV,
  ATTACHMENT_RETENTION_DAYS_MAX,
  ATTACHMENT_UNBOUND_TTL_MS,
  ATTACHMENT_UPLOADED_BY_CLONE,
  AttachmentRejectedError,
  ATTACHMENT_FROM_CLASSES,
  AttachmentCursorError,
  addToAttachmentUsage,
  attachmentExpiryFrom,
  classifyAttachmentFrom,
  decodeAttachmentCursor,
  emptyAttachmentUsage,
  encodeAttachmentCursor,
  matchesAttachmentListQuery,
  pageAttachmentMetas,
  withAttachmentKept,
  DEFAULT_ATTACHMENT_LIMITS,
  DEFAULT_TURN_IMAGE_LIMITS,
  turnImageLimitsOf,
  attachmentDiskName,
  canBindAttachmentTo,
  isAttachmentImageMediaType,
  isBoundTo as isAttachmentBoundTo,
  attachmentBindKeyOf,
  attachmentBindTargetLabel,
  isAttachmentBound,
  isAttachmentExpired,
  isAttachmentPrunable,
  normalizeAttachmentMediaType,
  normalizeAttachmentName,
  prepareAttachment,
  prepareStreamedAttachment,
  planAttachmentStream,
  collectAttachmentStream,
  AttachmentStreamMeter,
  readAttachmentLimits,
  readRunnerAttachmentStageLimit,
  ATTACHMENT_REQUEST_TIMEOUT_MS,
  applyAttachmentRequestTimeout,
  attachmentMaxBytes,
  attachmentBodyMaxBytes,
  attachmentBatchItemOf,
  isLargeAttachment,
  ATTACHMENT_MAX_LARGE_FILE_BYTES_DEFAULT,
  ATTACHMENT_MAX_LARGE_FILE_BYTES_ENV,
  sniffAttachmentImageType,
  validateAttachmentBatch,
  validateAttachmentInput,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentFromClass,
  type AttachmentListPage,
  type AttachmentListQuery,
  type AttachmentUsage,
  type AttachmentUsageBucket,
  type AttachmentImageMediaType,
  type AttachmentLimits,
  type AttachmentBatchItem,
  type TurnAttachmentLimits,
  type TurnImageLimits,
  type AttachmentLimitsConfig,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentPutStreamInput,
  type AttachmentStreamPlan,
  type AttachmentRejection,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from './attachment.js';
export { verifyAttachmentStoreContract } from './attachment-contract.js';
export {
  fetchManagerOutbox,
  outboxFetchDeadlineMs,
  outboxFetchTotalDeadlineMs,
  OUTBOX_DELETE_TIMEOUT_MS,
  OUTBOX_FETCH_FILE_TIMEOUT_MS,
  OUTBOX_FETCH_TOTAL_TIMEOUT_MS,
  type FetchManagerOutboxInput,
  type ManagerReportFiles,
} from './manager-outbox-fetch.js';
export {
  resolveTurnAttachments,
  resolveTurnAttachmentGroups,
  type ResolvedTurnAttachments,
} from './attachment-turn.js';
export {
  ATTACHMENT_COPY_MAX_AGE_MS,
  attachmentCopiesDir,
  fetchAttachmentCopy,
  pruneAttachmentCopies,
  removeAttachmentCopy,
  type AttachmentCopy,
  type AttachmentFetchResult,
} from './attachment-fetch.js';
export {
  composeAttachmentInput,
  defaultRunnerAttachmentsRoot,
  placeRunnerAttachments,
  placedAttachmentNoticeLine,
  pruneStaleAttachmentDirs,
  removeManagerAttachments,
  runnerAttachmentBodyLimit,
  RunnerAttachmentRejectedError,
  RunnerAttachmentStageError,
  StagedAttachmentLedger,
  stageRunnerAttachment,
  RUNNER_ATTACHMENT_STALE_MS,
  type PlacedAttachment,
  type StageRunnerAttachmentOptions,
  type StagedAttachmentEntry,
} from './runner-attachments.js';
export {
  collectManagerOutbox,
  defaultRunnerOutboxRoot,
  defaultRunnerOutboxStagedRoot,
  guessOutboxMediaType,
  isOutboxFileId,
  openStagedOutboxFile,
  prepareManagerOutbox,
  removeManagerOutbox,
  pruneStaleOutboxRoots,
  removeOutboxContentsAsChild,
  type OutboxContentsRemover,
  type OutboxRemovalOptions,
  removeStagedOutboxFile,
  RUNNER_OUTBOX_ENV,
  RunnerOutboxUnsafeError,
  type CollectedManagerOutbox,
  type StagedOutboxFile,
} from './runner-outbox.js';
export {
  attachmentRefsOf,
  loadManagerAttachments,
  estimateAttachmentBodyBytes,
  ManagerAttachmentsRefusedError,
  type LoadedManagerAttachments,
  type StagedManagerAttachment,
} from './manager-attachments.js';
export {
  describeManagerPeers,
  peerProviderLabel,
  type ManagerPeersView,
} from './manager-peers-format.js';
