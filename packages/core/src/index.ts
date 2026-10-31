export * from './schema.js';
export * from './store.js';
/** HTTP の要求ごとの時間（#5089）。DB の数え方はストアのプールが、窓の集計と日誌の行はデーモンが使う。 */
export { RequestTiming, currentRequestTiming, runWithRequestTiming } from './request-timing.js';
export {
  HTTP_TIMING_SLOW_MS,
  HttpTimingWindow,
  describeHttpTimingSample,
  type HttpTimingSample,
} from './http-timing.js';
export {
  addGrave,
  forgetDistillFailureCounts,
  parseDistillFailureCounts,
  readDistillFailureCount,
  removeGrave,
  serializeDistillFailureCounts,
} from './grave-queue.js';
export type { DistillFailureCounts } from './grave-queue.js';
/** `JobStore.listApprovals` は並び順を契約していないので、承認待ちの並びを決めるのはストアではなくこの比較である。 */
export { compareApprovalPagingKey, type ApprovalPagingKey } from './approval-cursor.js';
/** 一覧の継続点の共通の符号化。daemon の `/approvals` が使う。 */
export { encodeCursor, decodeCursor } from './cursor-codec.js';
/** 出所は SDK の `result.modelUsage` であって `usage` ではない: 後者はメインループぶんだけで、作業者の消費が落ちる。累積値なので足さずに差分を取る。 */
export * from './usage.js';
/** 台帳（自分で数えた推定値）とは足さない: こちらは claude.ai 側が言っている値。取れなかったものを 0 にしない。 */
export {
  accountUsageStateSchema,
  fetchAccountUsage,
  type AccountUsageState,
  type LimitsUnavailableCause,
} from './usage-snapshot.js';
export { type UsageProbeHandle, type UsageProbeQuery } from './usage-probe.js';
export {
  TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  describeTrialFailureFold,
  doubledTrialIntervalMs,
  runTokenTrial,
  selectTokenForTrial,
  type TokenTrialPort,
} from './token-trial.js';
/** 「使えない」は probe の `rejected` ではない: `rejected` も認証失敗も probe からは観測できず、`undecidable` に落ちる。 */
export {
  judgeTokenCandidate,
  probeTokenCandidate,
  type TokenCandidateVerdict,
} from './token-candidate.js';
export { usageTransitionOf } from './usage-limits.js';
/** PRD「権限境界」とは別の層: あちらは行為の一覧を持ってはいけないが、こちらは実行環境の境界（認証情報の配布範囲）である。 */
export {
  ACCESS_TOKEN_PREFIX,
  accessTokenRecordSchema,
  authAccountSchema,
  authIdentitySchema,
  decodeState,
  isAccountGranted,
  loginRequestSchema,
  sha256Hex,
  timingSafeEqualHex,
  type AccessTokenRecord,
  type AuthAccount,
  type AuthIdentity,
  type AuthStore,
  type CreateAccountWithIdentityOutcome,
  type GrantOutcome,
  type LoginRequest,
  type RevokeAccessTokenOutcome,
} from './auth.js';
export {
  createAuthProviderRegistry,
  createGoogleProvider,
  type AuthProvider,
  type OAuthProfile,
  type OAuthProvider,
} from './auth-providers.js';
export { createAuthService, type AuthService, type GrantResult } from './auth-service.js';
export type {
  AnswerApprovalVia,
  ClonePluginLoadObservation,
  CloneHost,
  PendingMessage,
} from './host.js';
export { PROGRESS_FORECAST_METHOD, summarizeProgress } from './progress.js';
export {
  DEFAULT_PROGRESS_WINDOW_HOURS,
  InvalidProgressWindowError,
  PROGRESS_WINDOW_HOURS_INVALID_MESSAGE,
  readProgress,
  readRepliesByConversation,
} from './progress-read.js';
export { describeGithubCi } from './progress-github.js';
export { describeProgress } from './progress-describe.js';
/** 器（storage-fs / storage-pg）もここを使う: 器ごとに書くと記憶の載せ方が食い違う。 */
export {
  deriveHumanTouchedAtFromJournal,
  deriveMemoryBootBackfillFromJournal,
  deriveMemoryFrontmatter,
  memoryProtectionRebuildDecision,
  nextDescribedState,
  renderMemoryDocuments,
  resolveMemoryDescriptionFreshness,
} from './memory.js';
export {
  buildActivityDigest,
  // 字面の生成元を1つに保つために出す: `apps/cli` が自前で組むと `manager_list`（`tools.ts`）と字面が割れる。
  describeManagerState,
  describeSessionMissingKind,
  describeUnobservedOutcome,
} from './digest.js';
/** `GET /conversations` と `conversation_read` が同じ規則を使う: 片方だけに実装を持たせると、直したほうと忘れたほうで見えるものがずれる。 */
export {
  computeSupersededIds,
  conversationMessages,
  countUnread,
  effectiveReadThrough,
  readConversationPage,
  encodeConversationCursor,
  decodeConversationCursor,
  readConversationWindow,
  readConversationWindowPage,
  readWithdrawnClientMessageIds,
  InvalidConversationCursorError,
  type ConversationCursor,
  type Exchange,
} from './conversation.js';
export { lookupConversation, describeMissingConversation } from './conversation-lookup.js';
export { deleteConversation, isConversationDeleted } from './conversation-delete.js';
export {
  countUnreadConversations,
  loadConversationReadView,
  verifyConversationReadStoreContract,
  type ConversationBaselineResult,
  type ConversationOutboundIndex,
  type ConversationOutboundIndexRead,
  type ConversationReadPosition,
  type ConversationReadRead,
} from './conversation-read.js';
/** 3実装（インメモリ / `storage-fs` / `storage-pg`）それぞれの歯が契約を呼ぶ: 1つで測って3つとも測ったことにしない。 */
export { verifyJournalStoreWithContract } from './journal-with-contract.js';
export { verifyJournalStoreDeletedConversationContract } from './journal-deleted-conversation-contract.js';
export { verifyJournalStoreWithdrawnContract } from './journal-withdrawn-contract.js';
export { verifyJournalStoreToolUseCountContract } from './journal-tool-use-count-contract.js';
export { verifyJournalStoreConversationIdsAfterContract } from './journal-conversation-ids-after-contract.js';
export { verifyJournalStoreOrderContract } from './journal-order-with-contract.js';
export { verifyConversationPageContract } from './conversation-page-contract.js';
export { verifyJournalStoreQueryEdgeContract } from './journal-query-edge-contract.js';
/** インメモリは読めない行を持てないので対象外（`UnreadableJournalEntryError` の doc）。 */
export { verifyJournalStoreUnreadableGetContract } from './journal-unreadable-get-contract.js';
export { verifyJournalStoreHumanActionContract } from './journal-human-action-contract.js';
export { verifyJournalStoreHorizonContract } from './journal-horizon-contract.js';
/** 判定条件を `journal_read` と `GET /journal` の2箇所に書き写さない。 */
export { journalWindowCrossesHorizon } from './journal-horizon.js';
/** `since` / `until` の扱いは3実装で食い違う（pg は時刻比較、fs・インメモリは文字列比較）ので、入口で正規化する。 */
export {
  isOffsetQualifiedTimeBoundary,
  normalizeJournalTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  describeOffsetRequiredTimeBoundary,
} from './journal-time.js';
/** どの欄を本文と見るかは `journal-search.ts` だけが持つ: 3実装へ欄の選び方を書き写さない。 */
export {
  JOURNAL_SEARCH_FIELDS,
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  matchesJournalSearch,
} from './journal-search.js';
/** `JournalStore.list()` を `limit` なしで呼ばない: pg 実装が `Number.MAX_SAFE_INTEGER` を渡し、窓の中身が多い日に全件をヒープへ載せて落ちる。ページ単位で読み、1ページぶんより多くを同時に持たない。 */
export { listPageByOverfetch } from './journal-page.js';
/** 日誌の器を包むときは口を並べて渡さずこれを通す: 並べると、器に足した任意の速い口を包みが黙って落とす（#5140）。 */
export { wrapJournalStore } from './journal-wrap.js';
export { verifyJournalStorePageContract } from './journal-page-contract.js';
export {
  conversationIdsAfterFromPages,
  countToolUsesByActorFromPages,
  scanJournalPages,
} from './journal-scan.js';
export {
  describeSelectionsViolation,
  describeQuestionLines,
  summarizeQuestions,
} from './approval-choices.js';
export {
  APPROVAL_TRACE_STATES,
  renderApprovalTrace,
  traceApproval,
  type ApprovalTrace,
} from './approval-trace.js';
export {
  BOOT_DEFERRED_INDEXES_EVENT_SOURCE,
  BOOT_FOOTPRINT_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_OBSERVED_EVENT_SOURCE,
} from './distill-gap.js';
export { verifyJournalStoreSearchContract } from './journal-search-contract.js';
export { verifyJournalStoreConversationIdContract } from './journal-conversation-id-contract.js';
export { verifyTranscriptArchiveContract } from './archive-contract.js';
export { isArchiveRefId } from './archive-ref.js';
export { assertArchivableSessionId } from './archive-session-id.js';
// Task（#5469 P2）。状態遷移・並び・行の操作は純関数で、メモリ・fs・pg の3実装が共有する
export {
  addTaskRow,
  editTaskRow,
  isTaskClosed,
  isTaskOfConversation,
  listTaskRows,
  moveTaskRow,
  prepareTask,
  setTaskRowKeep,
  setTaskRowStatus,
} from './task.js';
export type {
  SetTaskStatusOptions,
  EditTaskOptions,
  TaskEditPatch,
  TaskEditResult,
  TaskAddResult,
  TaskMoveResult,
  TaskSetKeepResult,
  TaskPlacement,
  TaskRow,
  TaskSetStatusResult,
} from './task.js';
export { verifyTaskStoreContract } from './task-store-contract.js';
export { verifyTaskRemoveForConversationContract } from './task-remove-for-conversation-contract.js';
export { TASK_TITLE_MAX, describeTaskPlacement } from './task-tools.js';
export { scheduleReplaceEntry } from './schedule-replace.js';
export { removeScheduleJournalFirst } from './schedule-remove.js';
export {
  removeArchiveChunkJournalFirst,
  removeArchiveJournalFirst,
  removeInboxChunkJournalFirst,
} from './removal-journal-first.js';
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
  classifyArchiveContinuityYielding,
  fingerprintArchiveBody,
  fingerprintArchiveBodyYielding,
  tallyArchiveContinuity,
  type ArchiveContinuity,
} from './archive-continuity.js';
/** 同じミリ秒に積んだ行の tie-break に `id` の字面順を使わない: PostgreSQL の collation に依存し、3本以上積むと1本目を直前だと誤認する。 */
export {
  archiveIdBase,
  archiveIdBranch,
  archiveIdCandidate,
  compareArchiveEntriesNewestFirst,
  matchArchiveIdStamp,
  sanitizeArchiveSessionId,
} from './archive-id.js';
export { memoryHeadingOf, memoryTitleOf, stripMemoryContent } from './memory-document.js';
/** `storage-fs` / `storage-pg` はパッケージが別なので、このバレルを経由しないと届かない。 */
export {
  clipWithEllipsis,
  codePointBoundary,
  countCodePoints,
  excerptLine,
  tailByCodePoints,
} from './excerpt.js';
export { denialActorTag, describeDenialFollowUp } from './denial-format.js';
export { describeWaitingKind } from './waiting-kind-format.js';
/** 並びを pg の `timestamptz` 順と揃えるため、オフセット付き ISO 時刻は文字列でなく実時刻で比べる。 */
export { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
export { ARCHIVE_REMOVED_BYTES_UNIT_NOTE } from './archive-removed-bytes.js';
/** 外へ出すのは純関数だけ: I/O をせず、本文（`body`）にも触れない。 */
export {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  ARCHIVE_REMOVE_MANY_LIMIT_MAX,
  selectArchiveRemovalTargets,
  type ArchiveRemoveManyFilter,
} from './archive-prune.js';
export { type SelfFacts } from './self.js';
export {
  resolveBuildRevision,
  reportRunnerRevision,
  buildRevisionSchema,
  type BuildRevision,
  type RunnerRevisionReport,
} from './revision.js';
export {
  INBOX_EVENT_TYPE_ORDER,
  summarizeInboxBacklog,
  describeInboxBacklogBreakdown,
  describeNoReadableInboxEvents,
  // 再定義せずここから import する: 描画が2箇所に分かれると字面がずれる。
  describeHumanOriginatedInboxAlert,
  matchesInboxRemoveManyFilter,
  type InboxBacklogBreakdown,
  type InboxRemoveManyFilter,
} from './inbox-backlog.js';
/** SSE を出す側が daemon と runner の3経路に分かれるので core に置く: `apps/*` の片側に置くと、もう片側から逆向きの依存になる。 */
export { DEFAULT_SSE_HEARTBEAT_MS, HEARTBEAT_FRAME, startSseHeartbeat } from './sse-heartbeat.js';
export {
  DAILY_REPORT_KIND,
  MEMORY_TIDY_KIND,
  RESERVED_SCHEDULE_KINDS,
  RESERVED_SCHEDULE_KIND_ENV_KEYS,
  SELF_INITIATIVE_KIND,
  type ReservedScheduleKind,
  createScheduler,
  dailyReportEntry,
  dailyReportEvent,
  localDate,
  localDayRange,
  memoryTidyEntry,
  missingDailyReportDates,
  parseTimeOfDay,
  selfInitiativeEntry,
  type ScheduleEntry,
  type ScheduleStatus,
  type Scheduler,
  type TimeOfDay,
} from './schedule.js';
export {
  WORKER_AGENT_NAME,
  WITHHELD_ENV_KEYS,
  createManagerPool,
  type ManagerDenial,
  type ManagerPool,
  type VacateResult,
  type ManagerSendResult,
  type ManagerSummary,
  decisionUnusedNote,
  guardArchiveRemoval,
  type RunnerPushHealth,
  type RunnerPluginLoadObservation,
  type RunnerPushOutcome,
  type WorkerToolEvent,
} from './manager.js';
export { DAEMON_FORCED_EXIT_MS } from './shutdown-grace.js';

/** 「落ちた」は停止の証明ではない: 引き取ってよいかは lease の期限で判定する。 */
export { LEASE_DRAIN_MS } from './lease.js';
/** デーモンは `RunnerRegistry` しか見ない: 固定 URL も runner のローカルパスも前提にしない。 */
export {
  createRunnerHost,
  placedManagerModels,
  RunnerPluginExtractError,
  resolveManagerModel,
  resolveWorkerModel,
  type RunnerChildUser,
  type RunnerHost,
  type RunnerManagerPeersAnnouncement,
} from './runner.js';
export { managerModelsOf, type ManagerModels } from './manager-models.js';
export { createLocalRunner } from './runner-local.js';
/** デーモンが落ちて /tmp に残ったクローンの MCP 設定（資格入り）の掃き。デーモン側が周期で呼ぶ */
export { liveCloneMcpConfigDirPaths } from './clone-mcp-config-file.js';
export {
  sweepCloneMcpConfigDirs,
  type CloneMcpConfigSweepOptions,
  type CloneMcpConfigSweepResult,
} from './clone-mcp-config-sweep.js';
export { DEFAULT_SCRATCH_SWEEP_INTERVAL_MS } from './scratch-sweep.js';
/** 伏せるのは上（記憶）へ到達する鍵だけで、下（外の世界）へ手を伸ばす鍵は配る。器を作り直さずに回せる形で持つ。 */
export {
  CREDENTIAL_NAME,
  credentialNamesShadowedByProfile,
  ROTATABLE_CREDENTIAL_KEYS,
  createCredentialStore,
  describeSkippedCredentialRow,
  fingerprintOf,
  type CredentialEntry,
} from './credentials.js';

/** 正本はデーモンが持つ。 */
export {
  CredentialEntryRejectedError,
  createCredentialService,
  type ApplyCredentialsResult,
  type CredentialService,
} from './credential-service.js';
export { applyAppScopedEnvVars, seedDefaultEnvVars } from './env-vars-boot.js';
export {
  DEFAULT_PROFILE_PATH,
  PROFILE_EVAL_TIMEOUT_MS,
  createProfileApplier,
  createProfileVessel,
  redactProfileFailure,
  type ProfileApplier,
} from './profile.js';
export {
  mcpServerNames,
  mcpServersFingerprintOf,
  mcpServersVersionOf,
  McpServersConflictError,
  mcpServersSchema,
  parseMcpServers,
  sortMcpServers,
  type McpServers,
  type StoredMcpServers,
  type WriteMcpServersOptions,
} from './mcp-servers.js';
export {
  computePluginContentSha256,
  isValidPluginName,
  resolveMarketplaceUrl,
  normalizePluginDescription,
  parsePluginInput,
  parsePluginSummary,
  parseStoredPlugin,
  PluginNameConflictError,
  pluginNamesCollide,
  pluginPreviewRequestSchema,
  pluginScopeSchema,
  pluginSummaryOf,
  sortPluginSummaries,
  type PluginInput,
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
} from './plugin-distribution-service.js';
export {
  defaultRunnerPluginsRoot,
  extractedPluginDirName,
  PLUGIN_SCOPES_FOR_CLONE,
  pruneExtractedPluginsAgainstStore,
  pruneRunnerPluginsOnBoot,
  runnerPluginsDirOptions,
} from './plugin-extract.js';
export {
  createPluginFetcher,
  PluginFetchError,
  type FetchedPlugin,
  type PluginFetcher,
} from './plugin-fetch.js';
export { createPluginPreviewStore, summarizeFetchedPlugin } from './plugin-preview.js';
export {
  createMcpServerService,
  type ApplyMcpServersResult,
  type McpServerService,
} from './mcp-server-service.js';
export {
  createDelegatedPermissionRuleService,
  delegatedPermissionRuleOf,
  type DelegatedPermissionRuleService,
  type PermissionRulesRunnerResult,
} from './delegated-permission-rules.js';
export {
  composeProfileScript,
  runnerDeclaredEnvNames,
  composedFingerprints,
  createProfileService,
  profileEntryVersionOf,
  ProfileInputError,
  ProfileRollbackFailedError,
  ProfileVersionMismatchError,
  type ApplyProfileResult,
  type ProfileService,
} from './profile-service.js';
export { nonBlankString } from './non-blank-string.js';
/** ここでは回さない: 検知も切替も持たず、器・設定・入出力の口だけを持つ。 */
export {
  agentTokenInputSchema,
  agentTokenSchema,
  agentTokenViewSchema,
  cooldownSourceSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  TokenPoolInputError,
  credentialOf,
  classifyTokenPolicyChange,
  classifyTokenPoolChange,
  TokenPoolVersionMismatchError,
  tokenAvailabilityAt,
  tokenRotationPolicySchema,
  activeAgentTokenSchema,
  tokenRotationSettingsSchema,
  type ActiveAgentToken,
  type AgentToken,
  type TokenCredential,
  type TokenPoolChange,
  type TokenPolicyChange,
  type TokenRotationSettings,
} from './token-pool.js';
/** `TokenPoolService` と `TokenRotator` は同じ鍵を共有する: `apps/daemon/src/index.ts` が1つ作って両方へ渡す。 */
export { createTokenPoolWriteLock } from './token-pool-write-lock.js';
export { createTokenPoolService, type TokenPoolService } from './token-pool-service.js';
/** 撒く先（runner / クローン）は外から渡す（`TokenSpreadPort`）: core が `apps/*` に依存しない。 */
export {
  createTokenRotator,
  tokenRestoreEntry,
  tokenRotationEntry,
  type TokenProbePort,
  type TokenReconsiderReason,
  type TokenRotationEntry,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenSpreadPort,
  type TokenSpreadResult,
  type TokenVerdictOrigin,
} from './token-rotator.js';
/** 同じ実体を経路ごとに別インスタンスで使う（`manager.ts` の rate_limit 用と `apps/daemon` の `token_rotation` 用）。 */
export { JOURNAL_FOLD_IDLE_GAP_MS, JournalFoldWindow, foldedRunText } from './journal-fold.js';
export {
  createRunnerRegistry,
  RunnerFenceError,
  RunnerHttpError,
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
  runnerExecutionResourcesSchema,
  runnerLivenessSchema,
  listRunnerManagers,
  runnerManagerStateSchema,
  runnerMcpServersFingerprintSchema,
  runnerPermissionRulesResultSchema,
  runnerMessageCommandSchema,
  runnerPlacementResourcesSchema,
  runnerProfileFingerprintSchema,
  runnerProfileResultSchema,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  type RunnerStagedAttachmentMeta,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  runnerResumeCommandSchema,
  runnerSessionOpenResultSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetMcpServersCommandSchema,
  runnerSetPermissionRulesCommandSchema,
  runnerSetCodexAuthCommandSchema,
  runnerTakeCodexAuthWriteBackCommandSchema,
  runnerCodexAuthWriteBackSchema,
  runnerSetProfileCommandSchema,
  runnerStartCommandSchema,
  unpushedWorkResultSchema,
  waitingKindSchema,
  type RunnerAnswerCommand,
  type RunnerAttachment,
  type RunnerRescueRefDeleteRequest,
  type RunnerRescueRefDeleteResult,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerOutboxContent,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerExecutionResources,
  type RunnerLegState,
  type RunnerManagerListing,
  type RunnerManagerState,
  type RunnerMcpServersFingerprint,
  type RunnerPermissionRulesResult,
  type RunnerPlacementResources,
  type RunnerPluginFingerprintEntry,
  type RunnerPluginsFingerprint,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  describePlacementDecision,
  type RunnerRequestStages,
  type RunnerRevisionStatus,
  type RunnerResumeResult,
  type RunnerSource,
  type RunnerResumeCommand,
  type RunnerSetCredentialsCommand,
  type RunnerStartCommand,
  type UnpushedWorkResult,
  HEARTBEAT_LOST_MS,
  REGISTRY_RETRY_BASE_MS,
  REGISTRY_RETRY_MAX_MS,
} from './runner-protocol.js';
/** `os` モジュールで代用しない（理由は `runner-resources.ts`）。 */
export { CGROUP_ROOT, readExecutionResources } from './runner-resources.js';
export {
  MCP_SERVER_NAME,
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
  type ToolContext,
} from './tools.js';
// runner の peer とマネージャーの道具が core の中で使うだけだが、image の検査（ci.yml）が焼いたイメージの中で本物の CLI と繋ぐために外へ出す。
export { createCloneToolRelayHost } from './clone-tool-relay-host.js';
export {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';
export { resolveCloneToolRelayChildEntry } from './clone-tools-transport.js';
export {
  DAILY_REPORT_RETRY_DELAYS_MS,
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  DAEMON_ATTACHMENT_USAGE_SOURCE,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  MAX_UTF8_BYTES_PER_CODE_POINT,
  createClone,
  placedClonePermissionMode,
  resolveCloneModel,
  staleObservedRecoveryForBlockedKey,
} from './clone.js';
export { DAEMON_RESERVED_EVENT_SOURCES, isReservedEventSource } from './daemon-self-notice.js';
export { placedEnvValue } from './placed-env.js';
export { ANTHROPIC_ROUTE_NONE_LINE } from './anthropic-route-env.js';
export type { AgentProviderId } from './agent-ports.js';
export { agentProviderOf } from './agent-provider-selection.js';
export {
  CODEX_PEER_CLOSED_REASON,
  PEER_PROVIDER_IDS,
  managerPeerModelsEnvKey,
  resolvePeerModelsOf,
} from './agent-provider-peers.js';
export { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
/** 能力の制限ではなく実行環境の設定である（理由は `permission-mode.ts`）。 */
export { DEFAULT_PERMISSION_MODE } from './permission-mode.js';

/** 本文を出さないための関門: 落としたことをログへ出す場所は層を問わずここを通す（素の `String(error)` や本文を1か所でも残すと、そこだけ無防備になる）。 */
export {
  droppedTraceLedgerSince,
  journalRowType,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  noteDroppedRecord,
  noteDroppedRunnerManagers,
  noteSessionMaterialUnreadable,
  reasonOf,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
  // 試験の準備（`vitest.quiet-traces.ts`）が、dist から core を読むパッケージの試験でも跡を溜めるための口（試験専用）
  setDefaultStderrSinkForTesting,
  // 標準エラーへ書けないときの挙動を試すために、書き先を投げる関数へ差し替える口（試験専用。`null` で既定へ戻す）
  setStderrSinkForTesting,
  writeStderrLine,
  writeStderrSync,
  type DroppedTraceOrigin,
} from './dropped-record.js';

export {
  createUnreadableRowOnce,
  unreadableRowKey,
  type UnreadableRowOnce,
} from './unreadable-row-once.js';

export { extractRowId, summarizeInvalidFields } from './invalid-row.js';
export { collapseErrorCause } from './error-cause.js';

/** 例外の文は `redactSecretsInText` ではなく `redactErrorText` を通す: `params:` 以降も落とさないと秘密が漏れる。 */
export { redactErrorText, redactSecretsInBody } from './denial-input-head.js';

/** テスト専用（本番の配線には出てこない）。帳面（`recentDroppedTraces()`）はプロセスの生存中ずっと共有されるので、前のテストの行と混ざらないよう断言の前に呼ぶ。 */
export { clearRecentTracesForTesting } from './dropped-record.js';

/** 観測だけで終了の挙動は変えない: `uncaughtException` ではなく `uncaughtExceptionMonitor` を使う理由は `uncaught-net.ts`。 */
export { installUncaughtNet } from './uncaught-net.js';

/** 何を残し何を消すかはここにしか書かない（CLI の `alteroid reset` と `POST /reset` が使う唯一の正本）。 */
export {
  describeResetTargets,
  RESET_CONFIRM_GROUPS,
  resetWorkspaceState,
} from './workspace-reset.js';

export { MemoryAttachmentStore } from './attachment-memory.js';
export {
  checkAndBindOutboundAttachments,
  conversationBindingKey,
  serializeAttachmentBinding,
} from './outbound-attachments.js';
export {
  ATTACHMENT_S3_ACCESS_KEY_ID_ENV,
  ATTACHMENT_S3_BUCKET_ENV,
  ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV,
  ATTACHMENT_ORPHAN_BLOB_GRACE_MS,
  MemoryAttachmentBlobStore,
  attachmentBlobKey,
  attachmentBlobPartBytesFor,
  attachmentBlobListPrefix,
  isAttachmentBlobKey,
  readAttachmentBlobConfig,
  type AttachmentBlobAbortResult,
  type AttachmentBlobSweepResult,
  type AttachmentBlobConfig,
  type AttachmentBlobStore,
} from './attachment-blob.js';
export {
  captureStderr,
  createMemoryStores,
  dropLastRowPerPage,
  failingJournalAppend,
} from './testing.js';

export { createSyntheticJournalStore } from './journal-scan.test-support.js';
export {
  createPeerSocketHost,
  DEFAULT_PEER_SOCKET_DIR,
  PEER_SOCKET_FILENAME,
  type PeerSocketHost,
} from './peer-socket-host.js';
export {
  createManagerToolsSocketHost,
  DEFAULT_MANAGER_TOOLS_SOCKET_DIR,
  MANAGER_TOOLS_MCP_SERVER_NAME,
  MANAGER_TOOLS_SOCKET_FILENAME,
  type ManagerToolsSocketHost,
} from './manager-tools.js';
export { parsePeerActor, PEER_MCP_SERVER_NAME } from './peer-broker.js';
/** 鍵・環境変数になる値の NUL は {@link NulNotAllowedError} で断り、それ以外の本文は {@link stripNul} で落として残す。 */
export { NulNotAllowedError, assertNoNul, hasNul, stripNul } from './nul-guard.js';
export { stripNulDeep, stripNulWellFormed } from './nul-guard.js';
export { InvalidCredentialNameError, assertValidCredentialEntries } from './credential-input.js';
export { assertValidActiveToken, prepareTokensForReplace } from './token-pool-input.js';
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
} from './codex-chatgpt-auth-service.js';
export {
  startCodexDeviceLogin,
  type CodexDeviceLogin,
  type CodexDeviceLoginOutcome,
} from './codex-device-login.js';
/** 消費の台帳は、鍵列の NUL も断らず落として残す。 */
export {
  stripNulFromUnmeteredRecord,
  stripNulFromUsageRecord,
  stripNulFromUsageQuery,
} from './usage-input.js';
export { verifyUsageNulContract } from './usage-nul-contract.js';
export { verifyUsageRunnerContract } from './usage-runner-contract.js';
export { verifyUsageResetsContract } from './usage-resets-contract.js';
export { prepareMcpServersForWrite } from './mcp-servers.js';
export { assertProfileRowWritable } from './profile-input.js';
export { preparePermissionGrantForPut } from './permission-grant-input.js';
export { verifySessionRegistryNulContract } from './session-registry-nul-contract.js';
export { verifySessionRegistryGraveQueueContract } from './session-registry-grave-queue-contract.js';
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
  compareIntegrationKeyOrder,
  integrationKeyFingerprint,
  integrationKeyLimits,
  integrationKeyRecordSchema,
  integrationSourceSchema,
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
  assertEventReceiptWritable,
  eventReceiptCutoff,
  type EventReceipt,
  type EventReceiptStore,
} from './event-receipt.js';
export { verifyEventReceiptStoreContract } from './event-receipt-contract.js';
export { attachmentTooLargeMessage } from './attachment-wording.js';
export {
  ATTACHMENT_EMPTY_MESSAGE,
  ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT,
  ATTACHMENT_UNBOUND_TTL_MS,
  AttachmentContentRemoveError,
  AttachmentRejectedError,
  ATTACHMENT_FROM_CLASSES,
  AttachmentCursorError,
  addToAttachmentUsage,
  attachmentExpiryFrom,
  classifyAttachmentFrom,
  decodeAttachmentCursor,
  emptyAttachmentUsage,
  encodeAttachmentCursor,
  integrationKeyIdOfUploader,
  matchesAttachmentListQuery,
  pageAttachmentMetas,
  withAttachmentKept,
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentDiskName,
  canBindAttachmentTo,
  isAttachmentImageMediaType,
  isBoundTo as isAttachmentBoundTo,
  attachmentBindKeyOf,
  attachmentBindTargetLabel,
  isAttachmentBound,
  isAttachmentExpired,
  isAttachmentPrunable,
  normalizeAttachmentName,
  prepareAttachment,
  prepareStreamedAttachment,
  planAttachmentStream,
  collectAttachmentStream,
  AttachmentStreamMeter,
  readAttachmentLimits,
  readIntegrationAttachmentNoticeBytes,
  applyAttachmentRequestTimeout,
  attachmentMaxBytes,
  attachmentBodyMaxBytes,
  attachmentBatchItemOf,
  validateAttachmentBatch,
  validateAttachmentInput,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentFromClass,
  type AttachmentListPage,
  type AttachmentListQuery,
  type AttachmentUsage,
  type AttachmentLimits,
  type TurnImageLimits,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentPutStreamInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from './attachment.js';
export { verifyAttachmentStoreContract } from './attachment-contract.js';
export { fetchManagerOutbox } from './manager-outbox-fetch.js';
export {
  attachmentCopiesDir,
  fetchAttachmentCopy,
  pruneAttachmentCopies,
  removeAttachmentCopy,
} from './attachment-fetch.js';
export {
  describeAttachmentAlreadyGoneRetraction,
  describeAttachmentForJournal,
} from './file-tools.js';
export {
  runnerAttachmentBodyLimit,
  RunnerAttachmentRejectedError,
  RunnerAttachmentStageError,
} from './runner-attachments.js';
export { guessMediaTypeFromPath } from './media-type-by-extension.js';
export { collectManagerOutbox, isOutboxFileId, prepareManagerOutbox } from './runner-outbox.js';
export { loadManagerAttachments } from './manager-attachments.js';
export {
  describeLoopStall,
  markStreamWrites,
  notePhase,
  startLoopStallWatch,
} from './loop-stall.js';
export {
  describeThreadpoolWait,
  measureThreadpoolWait,
  type ThreadpoolWait,
} from './threadpool-wait.js';
export {
  RUNNER_CLIENT_KEEP_ALIVE_MS,
  RUNNER_KEEP_ALIVE_TIMEOUT_MS,
  applyRunnerKeepAlive,
} from './runner-keep-alive.js';
