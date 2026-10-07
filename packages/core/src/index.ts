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
 * 台帳（`Commitment`）の並び順・継続点（keyset cursor）の共通実装。
 *
 * **`commitment_list`（クローンの道具、`tools.ts`）と `GET /commitments`
 * （`apps/daemon/src/app.ts`）の両方が、`CommitmentStore.list` の契約
 * （未了は `at` 昇順・片付きは `closedAt` 降順で連結）に対して同じ位置の
 * 取り出し方・同じ比較を使う。** かつては2箇所に同じ実装（1バイト違わない
 * `commitmentPos` / `compareCommitmentPos`）が別々に書かれていて、
 * 「契約の一致を歯で見張る」つもりの doc が実際には見張りとして成立して
 * いなかった（片方の歯はもう片方の実装を一度も読まない）。ここへ寄せて
 * `apps/daemon/src/app.ts` はこれを import する側になった。
 */
export {
  commitmentPosition,
  compareCommitmentPosition,
  encodeCommitmentCursor,
  decodeCommitmentCursor,
  resolveCommitmentCursor,
  type CommitmentPosition,
  type CommitmentCursor,
} from './commitment-cursor.js';
/**
 * 承認待ち（`PendingApproval`）の並び順（keyset の比較）の共通実装。
 *
 * **`GET /approvals`（`apps/daemon/src/app.ts`）が、`(createdAt, id)` の比較で
 * 頁を繰る。**（クローンの道具 `approvals_list` の継続点は配線されないまま削った
 * ——`approval-cursor.ts` の doc、#1392。）`JobStore.listApprovals` は並び順を
 * 契約していない（`store.ts` の `JobStore`）ので、並びを決めているのはストアではなくこの比較のほうである。
 * 台帳（直上）が同じ実装を2箇所に持って「歯で見張る」形から寄せる形へ移った
 * のと同じ理由で、こちらは最初から1箇所に置く——`apps/daemon/src/app.ts` の
 * `ApprovalPagingKey` / `compareApprovalPagingKeyAsc` /
 * `compareApprovalPagingKey` をここへ移設し、app.ts は import する側になった
 * （移設の時点で中身は1バイトも変えていない）。
 */
export {
  compareApprovalPagingKeyAsc,
  compareApprovalPagingKey,
  type ApprovalPagingKey,
} from './approval-cursor.js';
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
/**
 * 冷却中の鍵を「ダメ元で」試す仕組み（Issue #1501）。記録の上で通る鍵が1本も
 * 無いときだけ、冷却中の鍵を間隔を置いて本物の最小の1ターンで試す。
 */
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
/**
 * 候補トークンを1本 probe で観測し、3値（使える／使えない／判定できない）で
 * 判定する。**「使えない」＝ probe が `rejected` を返す、ではない** — `rejected`
 * も認証失敗も probe からは観測できないので、その2つは `undecidable` に落ちる
 * （`token-candidate.ts` の doc）。
 */
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
/**
 * 上限の文言に書かれているリセット時刻を読む（#682）。**検知には使わない** ——
 * あちらは SDK の定数（`USAGE_LIMIT_ERROR_PREFIXES`）のままである。
 */
export { parseNoticeResetAt, type ParseNoticeResetOptions } from './usage-reset-text.js';
export {
  assistantFailureOf,
  isAnsweredResult,
  resultErrorLines,
  resultFailureOf,
  type SdkFailure,
  type SdkFailureVia,
} from './sdk-failure.js';
/**
 * 「文脈窓（コンテキストウィンドウ）に当たった」ことの検知（Issue #318 P4）。
 * プロバイダの生の文言を型合わせで分類する。根拠と弱さは
 * `context-window-failure.ts` の doc。
 */
export {
  CONTEXT_WINDOW_FAILURE_KINDS,
  classifyContextWindowFailure,
  describeContextWindowFailure,
  type ContextWindowFailure,
  type ContextWindowFailureKind,
} from './context-window-failure.js';
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
export type { AnswerApprovalVia, CloneHost, PostPersistOutcome } from './host.js';
export { Inbox } from './inbox.js';
export { isTerminalJobStatus } from './progress.js';
/** 作業の進捗の集計（Issue #2241 の 1）。台帳と委譲の行を数え直す純関数。 */
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
/**
 * 進捗を読む口の共有部分（#2241 の 3）。daemon の `/progress`・`/commitments` と道具 `progress_read` が使う。
 */
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
/**
 * 記憶をクローンの文脈へ載せる形。**器（storage-fs / storage-pg）もここを使う** —
 * 器ごとに書いた結果、実際に食い違ったことがある（`memory.ts` の冒頭）。
 */
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
  // **字面の生成元を1つに保つために出す。** `apps/cli` が同じ意味の字面を
  // 自前で組んでいて、`live === undefined`（取れていない）を表せていなかった。
  describeManagerState,
  // **同じ理由で出す（#579）。** `apps/cli` が `sessionMissingKind` の由来を
  // 自前で書くと、`manager_list`（`tools.ts`）と字面が割れる。
  describeSessionMissingKind,
  // **同じ理由で出す（#2428）。** `manager_list` の `unobservedOutcomeLine` が
  // 呼ぶ生成元。
  describeUnobservedOutcome,
  type DigestWindow,
} from './digest.js';
/**
 * 日誌を人間との会話へ畳み直す規則。
 *
 * **人間の口（`GET /conversations`）とクローンの道具（`conversation_read`）が
 * 同じ規則を使うために出してある。** 片方だけに実装を持たせると、直したほうと
 * 忘れたほうで見えるものがずれる — それは、この規則を足す動機になった欠陥
 * （層ごとに見えるものが違う）を新しく1つ作ることである。
 */
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
  searchExchanges,
  toMessage,
  InvalidConversationCursorError,
  type ConversationCursor,
  type ConversationMessage,
  type ConversationPage,
  type ConversationSummary,
  type Exchange,
} from './conversation.js';
/** 会話の既読の位置と基準時刻（保存の型・契約・読み出し）。全員で1組。 */
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
/**
 * `JournalStore` の `with` 絞りの契約（issue #418）。3実装（インメモリ /
 * `storage-fs` / `storage-pg`）それぞれの歯がこれを呼んで揃っていることを測る
 * — 1つで測って3つとも測ったことにしない（`persona-contract.test.ts` と
 * 同じ作法）。
 */
export {
  verifyJournalStoreWithContract,
  type JournalStoreWithContractSubject,
} from './journal-with-contract.js';
/**
 * `JournalStore` の `order` / `after` の契約（issue #432 の2本目）。3実装
 * （インメモリ / `storage-fs` / `storage-pg`）それぞれの歯がこれを呼んで
 * 揃っていることを測る — 1つで測って3つとも測ったことにしない
 * （`verifyJournalStoreWithContract` と同じ作法）。
 */
export {
  verifyJournalStoreOrderContract,
  type JournalStoreOrderContractSubject,
} from './journal-order-with-contract.js';
/**
 * 会話の一覧の頁送り（`readConversationPage`）の契約。3実装（インメモリ / `storage-fs` / `storage-pg`）
 * それぞれの歯がこれを呼んで揃っていることを測る（ストアに新しい口は足していない。日誌の継続点の上の組み立て）。
 */
export {
  verifyConversationPageContract,
  type ConversationPageContractSubject,
} from './conversation-page-contract.js';
/**
 * `JournalQuery` の退化した値（`types: []` / `limit: 0`）の契約（issue #425）。
 * 3実装（インメモリ / `storage-fs` / `storage-pg`）それぞれの歯がこれを
 * 呼んで揃っていることを測る — 1つで測って3つとも測ったことにしない
 * （`verifyJournalStoreWithContract` と同じ作法）。
 */
export {
  verifyJournalStoreQueryEdgeContract,
  type JournalStoreQueryEdgeContractSubject,
} from './journal-query-edge-contract.js';
/**
 * `JournalStore.get` の「在るが読めない」の契約（issue #3288）。読めない行を持てる実装
 * （`storage-fs` / `storage-pg`）の歯がこれを呼ぶ。インメモリは読めない行を持てないので対象外
 * （`UnreadableJournalEntryError` の doc）。
 */
export {
  verifyJournalStoreUnreadableGetContract,
  type JournalStoreUnreadableGetContractSubject,
} from './journal-unreadable-get-contract.js';
/**
 * `JournalStore.oldestAt()`（日誌の地平。issue #1510）の契約。3実装
 * （インメモリ / `storage-fs` / `storage-pg`）それぞれの歯がこれを呼んで
 * 揃っていることを測る — 1つで測って3つとも測ったことにしない
 * （`verifyJournalStoreWithContract` と同じ作法）。
 */
export {
  verifyJournalStoreHorizonContract,
  type JournalStoreHorizonContractSubject,
} from './journal-horizon-contract.js';
/**
 * 日誌の窓（`since`）が地平（`JournalStore.oldestAt()`）より前にかかるかの
 * 判定（issue #1510 の積み残し）。`journal_read`（`tools.ts`）と
 * `GET /journal`（`apps/daemon/src/app.ts`）が同じ関数を呼ぶ——判定条件を
 * 2箇所に書き写さない。
 */
export { journalWindowCrossesHorizon } from './journal-horizon.js';
/**
 * `journal_read` / `conversation_read` / `GET /journal` の `since` / `until` を
 * 正規化する唯一の共通の口（issue #1515）。3実装（インメモリ / `storage-fs` /
 * `storage-pg`）の `JournalQuery.since`/`.until` の扱いが食い違っていた
 * （pg は時刻比較、fs・インメモリは文字列比較）ことへの、入口側の直し方。
 */
export {
  isReadableJournalTimeBoundary,
  isOffsetQualifiedTimeBoundary,
  normalizeJournalTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  describeOffsetRequiredTimeBoundary,
} from './journal-time.js';
/**
 * 日誌を語で探す（`JournalQuery.q`。issue #250）ときの、照合の唯一の正本。
 * **どの欄を本文と見るか**を `journal-search.ts` が持ち、3実装（インメモリ /
 * `storage-fs` は `matchesJournalSearch`、`storage-pg` は
 * `JOURNAL_SEARCH_FIELDS` から SQL の式）がそこから組み立てる —— 欄の選び方を
 * 実装側へ書き写さない。
 */
export {
  JOURNAL_SEARCH_FIELDS,
  JOURNAL_SEARCH_UNCOVERED_LIST,
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  JOURNAL_SEARCH_UNSEARCHABLE_TYPES,
  journalSearchValues,
  matchesJournalSearch,
  type JournalSearchTarget,
} from './journal-search.js';
/**
 * 日誌をページ単位で読み継ぐ足場（issue #1283）。`JournalStore.list()` を
 * `limit` なしで呼ぶと pg 実装が `Number.MAX_SAFE_INTEGER` を渡す
 * （`journal.ts` の `limit ?? Number.MAX_SAFE_INTEGER`）ので、窓の中身が
 * 多い日に1クエリで全件をヒープへ載せて落ちる（実測: ある1日で約247万行・
 * 約1.4GB）。**この足場自身も1ページぶんより多くを同時に持たない**——
 * 呼び出し側（`digest.ts` / `distill-gap.ts`）が畳んだ結果だけを残す形に
 * すれば、ヒープは有界のまま保てる（`journal-scan.ts` の doc）。
 */
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
/**
 * 承認待ちの質問を選択肢で答える部品（issue #2525）。道具・クローン・デーモンの
 * HTTP の口が同じ検査・同じ畳み方を通るために公開する。
 */
export {
  describeQuestionsViolation,
  describeSelectionsViolation,
  describeQuestionLines,
  foldSelections,
  summarizeQuestions,
} from './approval-choices.js';
/**
 * 承認の答えとその後の行動を対で読む口（issue #847 の案B）。デーモンの
 * `GET /approvals/:id/trace` と CLI が、クローンの `approval_trace` と同じ
 * 関数を通るために公開する（`approval-trace.ts` の doc）。
 */
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
/**
 * 蒸留が間に合わなかった区間（＝記憶へ移らなかった区間）の検出（issue #564 の (b)）。
 * **「蒸留を始めた」ではなく「蒸留が成功で終わった」記録で数える** — 開始で数えると、
 * 始めたが完了しなかった回（まさに検出したい形）が「蒸留した」として落ちる
 * （`distill-gap.ts` の doc）。判定の基準はそこ1本に閉じる。
 */
export {
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
/**
 * `JournalStore` の `q`（本文を語で探す）の契約（issue #250）。3実装
 * （インメモリ / `storage-fs` / `storage-pg`）それぞれの歯がこれを呼んで
 * 揃っていることを測る — 1つで測って3つとも測ったことにしない
 * （`verifyJournalStoreWithContract` と同じ作法）。
 */
export {
  verifyJournalStoreSearchContract,
  type JournalStoreSearchContractSubject,
} from './journal-search-contract.js';
/**
 * `TranscriptArchive` の契約（#698）。3実装（インメモリ / `storage-fs` /
 * `storage-pg`）それぞれの歯がこれを呼んで揃っていることを測る — 1つで測って
 * 3つとも測ったことにしない（`verifyJournalStoreSearchContract` と同じ作法）。
 */
export { verifyTranscriptArchiveContract } from './archive-contract.js';
/** アーカイブの sessionId の入口の検査（issue #2233。3実装とも同じ例外で断る）。 */
export { InvalidArchiveSessionIdError, assertArchivableSessionId } from './archive-session-id.js';
export { verifyCommitmentFoldContract } from './commitment-fold-contract.js';
export { verifyCommitmentTieOrderContract } from './commitment-tie-order-contract.js';
export { verifyMcpServerStoreContract } from './mcp-server-contract.js';
export { verifyPluginStoreContract } from './plugin-store-contract.js';
export { verifyProfileStoreContract } from './profile-store-contract.js';
/**
 * `PermissionGrantStore` の契約（Issue #863。doc は `store.ts`）。3実装
 * （インメモリ / `storage-fs` / `storage-pg`）それぞれの歯がこれを呼んで
 * 揃っていることを測る — 1つで測って3つとも測ったことにしない
 * （`verifyMcpServerStoreContract` と同じ作法）。
 */
export { verifyPermissionGrantStoreContract } from './permission-grant-contract.js';
export { verifyPracticeStoreContract } from './practice-contract.js';
export { verifyListOrderContract } from './list-order-contract.js';
export { verifyApprovalConversationFilterContract } from './approval-conversation-filter-contract.js';
export { compareCodeUnits } from './code-unit-order.js';
export { verifyStoreIsolationContract } from './store-isolation-contract.js';
/**
 * `archive()` が積む瞬間に判定する、直前の退避との連続性(#698)。畳まない
 * 設計の門——`TranscriptArchive` interface（`store.ts`）と3実装が使う。
 */
export {
  classifyArchiveContinuity,
  describeArchiveContinuityForJournal,
  fingerprintArchiveBody,
  tallyArchiveContinuity,
  type ArchiveBodyFingerprint,
  type ArchiveContinuity,
} from './archive-continuity.js';
/**
 * `archive()` の id（`${sanitize(sessionId)}-${stamp}.jsonl`。#905 の枝番付き
 * id も含む）を解析する純関数（#908）。fs / pg の両方が「同じミリ秒に積んだ
 * 行のうち、どれが直前か」の tie-break にこれを使う——`id` の字面順
 * （PostgreSQL の collation にも依存する）で tie-break すると、3本以上
 * 積んだときに1本目を直前だと誤認する（#908 本体）。
 */
export {
  archiveIdBranch,
  compareArchiveEntriesNewestFirst,
  matchArchiveIdStamp,
  type ArchiveIdStampMatch,
} from './archive-id.js';
/**
 * `TranscriptArchive.readTail`（pg・fs・インメモリの3実装）と `clone.ts` の
 * `tailOf` が共有する、コードポイント単位の「末尾を切る」唯一の出所
 * （issue #1829）。`storage-fs` / `storage-pg` はパッケージが別なので、
 * ここ（`@alteroid/core` の公開バレル）を経由しないと届かない。
 */
export { codePointBoundary, countCodePoints, tailByCodePoints } from './excerpt.js';
/**
 * オフセット付き ISO 時刻を実時刻で比べる唯一の出所（issue #2451）。`storage-fs` と
 * インメモリの許可の記録・台帳・受信箱の並びが、pg の `timestamptz` 順と揃うように使う。
 */
export { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
export {
  ARCHIVE_REMOVED_BYTES_UNIT_NOTE,
  describeArchiveRemovedBytesUnit,
} from './archive-removed-bytes.js';
/**
 * `archive` を絞り込んで一括で tombstone する対象を選ぶ純関数（#698）。
 *
 * **外へ出しているのは純関数だけである。** `TranscriptArchive.list()` で
 * 取った `ArchiveEntry[]` を渡す形なので、ここから出るものは I/O を
 * しない・本文（`body`）にも触れない（`archive-prune.ts` の doc）。
 */
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
/**
 * クローンの自己認識。正典（`docs/*.md`）の全文はビルド時に焼き込まれる
 * （`packages/core/scripts/write-canon.mjs`）。要約を手書きしないこと — docs と
 * 二重管理になる。
 */
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
/**
 * いま走っているプロセスの版（コミット sha）。デーモンと runner は別 Service で
 * 別々にデプロイされるので、両方が自分の版を名乗れることでその窓のずれが見える。
 */
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
/**
 * クローンのターンの入口へ載せる「いまの全体」（doc は `situation.ts`）。
 *
 * **外へ出しているのは純関数だけである。** `clone.ts` が `ManagerPool` を読んで
 * 渡す形なので、ここから出るものは I/O をしない——歯（テスト）が `ManagerPool` の
 * 足場を組まずに分岐へ直接当てられる（`runner-swap-notice.ts` と同じ作法）。
 */
export {
  countManagerSituation,
  countRunnerStates,
  describeSituation,
  describeSituationUnavailable,
  type ManagerSituationCounts,
} from './situation.js';
/**
 * 受信箱（`InboxStore`）の滞留の内訳（doc は `inbox-backlog.ts`）。
 *
 * **内訳と絞り込みの側は純関数だけである。** `peekPending()` で取った行を
 * 渡す形なので、そちらから出るものは I/O をしない。
 *
 * **⚠️ 例外が1つある — `removeInboxEventsAndStopDelivery` は I/O をする**
 * （issue #1049）。ここには「外へ出しているのは純関数だけである」と書いてあったが、
 * **この1本でそれは成り立たなくなった。** 消し込みの経路をわざとここへ置いている
 * ——器から消す操作とクローンの配達を止める操作を**1つの呼びから分けられない**
 * 形にするためで、`tools.ts`（クローンの道具）と `apps/daemon/src/app.ts`
 * （人間の HTTP）の両方がこの1本を通す。⟹ **純粋さより、2箇所に割れないこと
 * を採った**（割れたまま残すと、片方だけ直っている形が再生産される。それが
 * #1049 そのものだった）。
 */
export {
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
  INBOX_BACKLOG_LOUD_THRESHOLD,
  INBOX_EVENT_TYPE_ORDER,
  inboxBacklogDedupeKey,
  inboxBacklogSourceFor,
  summarizeInboxBacklog,
  describeInboxBacklogBreakdown,
  describeNoReadableInboxEvents,
  // #783 段0 の最後の欠落（HTTP `GET /inbox` / CLI `alteroid inbox show`）が
  // クローンの道具（`manager_list`）と同じ文言を出すための2つ。**再定義せず
  // ここから import する**——`inboxBacklogDedupeKey` の doc「なぜ1箇所に
  // 閉じるか」と同じ理由（描画が2箇所に分かれると、いつか字面がずれる）。
  describeHumanOriginatedInboxAlert,
  matchesInboxRemoveManyFilter,
  removeInboxEventsAndStopDelivery,
  type InboxBacklogBreakdown,
  type InboxDeliveryStopper,
  type InboxRemoveManyFilter,
} from './inbox-backlog.js';
/**
 * 「この委譲から、この合図より後に報告が届いている」の判定と文面
 * （doc は `superseded.ts`）。**外へ出しているのは純関数だけである。**
 */
export {
  countSupersedingReports,
  describeSuperseded,
  type SupersededDecision,
} from './superseded.js';
export { CRON_EXPRESSION_MAX, isCronExpression, parseCron, type CronSchedule } from './cron.js';
/**
 * SSE のコメント行 heartbeat。**SSE を出す側が3経路（デーモンの `POST /chat` と
 * `GET /journal/stream`、runner の `GET /events`）に分かれているので、ここに置く。**
 * `apps/*` の片側に置くと、もう片側がそれを読むために逆向きの依存を作ることになる
 * （`./sse-heartbeat.ts` の「なぜ `packages/core` に在るか」）。
 */
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
  type RunnerPushOutcome,
  resolveWorkspacePolicy,
  type WorkerToolEvent,
  type WorkspacePolicy,
} from './manager.js';
export { WORKER_TOOL_RUNNING_AFTER_MS } from './runner-worker-tool-watch.js';
/**
 * 貸し出し期限（lease）— 引き取ってよいかを片側だけで言えるようにする材料
 * （roadmap M5 PR4）。**「落ちた」は停止の証明ではない**という一点のための層である。
 */
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
/**
 * manager-runner 側（SDK を隔離して走らせる層）と、その境界。
 * デーモンは `RunnerRegistry` しか見ない — 固定 URL も runner のローカルパスも
 * 前提にしない（docs/architecture.md「プロセス境界」）。
 */
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
  type RunnerPeerOptions,
} from './runner.js';
export { createLocalRunner, type LocalRunnerOptions } from './runner-local.js';
/**
 * マネージャーの道具の鍵。**器を作り直さずに回せる形**で持つ（`credentials.ts`）。
 * 伏せるのは上（記憶）へ到達する鍵だけで、下（外の世界）へ手を伸ばす鍵は配る。
 */
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

/**
 * 置いて配るまでの1本道（`credential-service.ts`）。**正本はデーモンが持つ。**
 */
export {
  CredentialEntryRejectedError,
  createCredentialService,
  resolveCredentialRows,
  type ApplyCredentialsResult,
  type CredentialService,
  type CredentialServiceOptions,
} from './credential-service.js';
/**
 * alteroid 自身の運用設定（TZ・自律のスケジュール等）を、環境変数の袋（DB正本）へ
 * 播種・反映する（2026-09-14）。
 */
export {
  APP_ENV_VAR_DEFAULTS,
  applyAppScopedEnvVars,
  ENV_BASE_MIGRATION_MARKER,
  migrateEnvBaseCredentialsOnce,
  seedDefaultEnvVars,
} from './env-vars-boot.js';
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
/**
 * 人間の MCP 連携の登録（`.mcp.json` の `mcpServers` と同じ形）。記憶ストアに置き、
 * SDK の `Options.mcpServers` で渡す（#325。`mcp-servers.ts`）。
 */
export {
  isReservedMcpServerName,
  mcpHttpServerConfigSchema,
  mcpServerConfigSchema,
  mcpServerNames,
  mcpServerNameSchema,
  mcpServersFingerprintOf,
  mcpServersSchema,
  mcpSseServerConfigSchema,
  mcpStdioServerConfigSchema,
  parseMcpServers,
  sortMcpServers,
  type McpServerEntryConfig,
  type McpServers,
  type StoredMcpServers,
} from './mcp-servers.js';
/**
 * 人間が入れた plugin（skill を含む）の保存の形と検査（`plugins.ts`）。
 * 保存だけで、展開・配布・API・CLI は後の PR。
 */
export {
  computePluginContentSha256,
  isValidPluginName,
  OFFICIAL_MARKETPLACE,
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
/** 記憶ストアの plugin を runner へ配る1本道（`mcp-server-service.ts` の写し）。 */
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
/**
 * MCP の登録を置いて runner へ配る1本道（#325 段3。`profile-service.ts` の写し）。
 */
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
/**
 * 認証トークンのプール（Issue #393「PR1 プールの器」）。**回さない。** 検知も
 * 切替もここには無い——器・設定・入出力の口だけを持つ。
 */
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
/**
 * `TokenPoolService` と `TokenRotator` が共有する、トークンの表への書き込み
 * の鍵（Issue #2200）。`apps/daemon/src/index.ts` が1つ作って両方へ渡す。
 */
export { createTokenPoolWriteLock, type TokenPoolWriteLock } from './token-pool-write-lock.js';
export {
  createTokenPoolService,
  type ReplaceResult,
  type TokenPoolService,
  type TokenPoolServiceOptions,
  type TokenPoolView,
  type TokenRowsUnreadable,
} from './token-pool-service.js';
/**
 * 回し手（Issue #393 PR3）。**デーモンの中の1本。** 撒く先（runner / クローン）は
 * 外から渡す（`TokenSpreadPort`）——core が `apps/*` に依存しない形にしてある。
 */
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
/**
 * 日誌の「同じ合図の連なり」を書く時点で畳む窓（issue #1311）。**`apps/daemon`
 * が `token_rotation` の畳みにそのまま使う**——`manager.ts` の rate_limit 用
 * （`#rateLimitJournalFoldFor`）と同じ実体を、経路ごとに別インスタンスで使う。
 */
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
  runnerResumeCommandSchema,
  runnerSessionOpenResultSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetMcpServersCommandSchema,
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
/**
 * `manager_stop` が「running を畳むと何が失われるか」を実物の数字で言うための
 * 下請け（Issue #1039）。`git` の起動は呼び出し側（`runner.ts`）が別 UID で
 * 行うので、ここは純粋な探索・判定ロジックだけを持つ。
 */
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
/**
 * 実行環境の資源の読み方（cgroup v2）。**`os` モジュールで代用しないこと**
 * （理由と実測は `runner-resources.ts` にある）。
 */
export {
  CGROUP_ROOT,
  readExecutionResources,
  type ExecutionResourcesOptions,
} from './runner-resources.js';
/**
 * `request_permission` / 以降許可の PreToolUse フックが共有する純粋な照合器
 * （Issue #863）。
 */
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
  // **字面の生成元を1つに保つために出す（#2428）。** `apps/cli` の `/managers` が
  // `manager_list`（`tools.ts`）と同じ判定・同じ字面の ⚠ を出すため。
  describeReportDriftMark,
  describeToolUseStall,
  describeTurnEnd,
  isFoldedTurnReport,
  qualifiedToolName,
  resolveMemoryGuard,
  type MemoryGuardValue,
  type ToolContext,
} from './tools.js';
// クローンの道具の中継（#486 48(a)）。デーモンは `clone.ts` の中から使うだけだが、
// image の検査（ci.yml）が焼いたイメージの中で本物の CLI と繋ぐために外へ出す。
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
export type { AgentProviderId } from './agent-ports.js';
export {
  DEFAULT_AGENT_PROVIDER_ID,
  agentProviderOf,
  placedAgentProvider,
} from './agent-provider-selection.js';
export {
  RETIRED_LAYER_PROVIDER_ENV_KEYS,
  retiredLayerProviderNotices,
} from './retired-provider-env.js';
export {
  MANAGER_PEERS_ENV_KEY,
  isPeerAllowed,
  parsePeers,
  resolvePeers,
  type PeersResolution,
} from './agent-provider-peers.js';
/** `type: 'exchange'` の本文が持つ種類の接頭辞（issue #1332）。本文の先頭に固定の印を置き、前方一致で復元する（`exchange-kind.ts` の doc）。 */
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
/**
 * 権限モードの判定（クローンとマネージャーで同じもの）。**能力の制限ではなく
 * 実行環境の設定である**（`permission-mode.ts` に理由がある）。
 */
export {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  placedPermissionMode,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';

/**
 * 何かを落としたときに stderr へ残す跡（記録の書き込み失敗と、受信箱を閉じた
 * 後に届いた合図）。
 *
 * **本文を出さないための関門である。** 落としたことをログへ出す場所は、層を問わず
 * ここを通すこと（素の `String(error)` や本文を1か所でも残すと、そこだけ将来の
 * ストア実装や新しい起点に無防備なまま置き去りになる）。
 */
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

/**
 * 壊れた行を「ストアのインスタンスごとに1行につき1回だけ」stderr へ知らせる
 * ための追跡器（issue #2191）。`packages/storage-fs` / `packages/storage-pg`
 * の `PermissionGrantStore` 実装が共有する（置き場所の理由は
 * `unreadable-row-once.ts` の doc）。
 */
export {
  createUnreadableRowOnce,
  unreadableRowKey,
  type UnreadableRowOnce,
} from './unreadable-row-once.js';

/**
 * `Error.prototype.cause` の連鎖を1行へ畳む（Issue #1229）。stderr の跡
 * （`reasonOf`）にもクローンへ返す本文（`tools.ts` の
 * `formatJournalNotRecordedMessage`）にも安全に使える——理由は
 * `error-cause.ts` の doc を見よ。
 */
export { collapseErrorCause } from './error-cause.js';

/**
 * 文字列に含まれる秘密の伏せ字（issue #2415）。`redactSecretsInText` は
 * `buildDenialInputHead` の伏せ字そのもの、`redactErrorText` はそれに `params:`
 * 以降を落とす規則を足した、例外の文用。`denial-input-head.ts` の doc を見よ。
 */
export { redactErrorText, redactSecretsInBody, redactSecretsInText } from './denial-input-head.js';

/**
 * `dropped-record.ts` のテスト専用フック（本番の配線には出てこない）。
 *
 * **`captureStderr`（`testing.ts` から export 済み）と対で使う。** 帳面
 * （`recentDroppedTraces()`）はプロセス（＝テストファイル）の生存中ずっと
 * 1つを共有するので、前のテストが積んだ行と混ざらないよう、断言の前に
 * 呼ぶこと（`dropped-record.ts` の doc）。`apps/daemon` のテスト
 * （`GET /dropped`）が、この帳面を daemon 側から検証するために使う。
 */
export { clearRecentTracesForTesting } from './dropped-record.js';

/**
 * 未捕捉の例外・未処理の Promise 拒否に**観測だけの網**を張る（#438）。
 *
 * **終了の挙動は1ビットも変えない。** なぜ `uncaughtException` ではなく
 * `uncaughtExceptionMonitor` なのか（実測の表つき）は `uncaught-net.ts` に在る。
 */
export { installUncaughtNet } from './uncaught-net.js';

/**
 * ワークスペースのリセット（「トークン情報以外を全部消す」）。CLI の
 * `alteroid reset` と `POST /reset`（`apps/daemon/src/app.ts`）が使う唯一の
 * 正本 — 何を残し何を消すかはここにしか書かない（`workspace-reset.ts` の doc）。
 */
export {
  describeResetTargets,
  RESET_CONFIRM_GROUPS,
  resetWorkspaceState,
  type ResetWorkspaceStateOptions,
  type WorkspaceResetSummary,
} from './workspace-reset.js';

/** テスト用ユーティリティ（本番の配線には出てこない）。 */
export { MemoryAttachmentStore } from './attachment-memory.js';
export {
  captureStderr,
  createMemoryStores,
  failingJobWrite,
  failingJournalAppend,
  humanMessage,
} from './testing.js';

/**
 * pg の日誌の形（`LIMIT` の後で読めない行を捨てる）を再現する偽のストア。
 * 日誌の走査・画面のテストが共有する唯一の写し（Issue #2640）。
 */
export {
  createSyntheticJournalStore,
  type SyntheticJournalStore,
  type SyntheticJournalStoreOptions,
} from './journal-scan.test-support.js';
// マネージャー層の peer 専用ソケット（#486 S7）。runner が PEERS の開いたときだけ作る。
export {
  createPeerSocketHost,
  DEFAULT_PEER_SOCKET_DIR,
  PEER_SOCKET_FILENAME,
  PEER_TOKEN_TIMEOUT_MS,
  type PeerSocketHost,
} from './peer-socket-host.js';
export {
  createPeerBroker,
  PEER_MCP_SERVER_NAME,
  PEER_SYSTEM_PROMPT_APPEND,
  PEER_TOOL_NAMES,
  type PeerBroker,
  type PeerBrokerDeps,
  type PeerTurnResult,
  type PeerUsageReport,
} from './peer-broker.js';
/**
 * ストアの入口の NUL・不正入力の断り方（issue #2927。teto の判断、2026-10-05）。
 * 鍵・環境変数になる値の NUL は {@link NulNotAllowedError} で断り、それ以外の本文は
 * {@link stripNul} で落として残す。3実装（インメモリ / fs / pg）が同じ部品を呼ぶ。
 */
export { NulNotAllowedError, assertNoNul, hasNul, stripNul } from './nul-guard.js';
export { stripNulDeep, stripNulWellFormed } from './nul-guard.js';
export { InvalidCredentialNameError, assertValidCredentialEntries } from './credential-input.js';
export {
  DuplicateTokenIdError,
  assertValidActiveToken,
  prepareTokensForReplace,
} from './token-pool-input.js';
/** `CredentialVaultStore` / `TokenPoolStore` の入口の契約（issue #2927）。3実装が呼ぶ。 */
export {
  verifyCredentialSeedOnceContract,
  verifyCredentialVaultContract,
} from './credential-contract.js';
export { verifyTokenPoolContract } from './token-pool-contract.js';
/** 消費の台帳の入口の NUL の扱い（issue #2927。鍵列も断らず落として残す。teto の判断、2026-10-05）。 */
export {
  USAGE_NUL_ONLY_TOKEN_ID,
  stripNulFromUnmeteredRecord,
  stripNulFromUsageRecord,
  stripNulFromUsageQuery,
  stripNulFromUsageSnapshot,
} from './usage-input.js';
export { verifyUsageNulContract } from './usage-nul-contract.js';
export { verifyUsageRunnerContract } from './usage-runner-contract.js';
/** 残りのストアの入口の NUL の扱い（issue #2927 PR-A2。teto の判断、2026-10-05）。 */
export { prepareMcpServersForWrite } from './mcp-servers.js';
export { assertProfileRowWritable } from './profile-input.js';
export { preparePermissionGrantForPut } from './permission-grant-input.js';
export { verifySessionRegistryNulContract } from './session-registry-nul-contract.js';
export { verifyPersonaNulContract } from './persona-nul-contract.js';
export { verifyScheduleNulContract } from './schedule-nul-contract.js';
export { verifyScheduleIfMatchContract } from './schedule-if-match-contract.js';
export { verifyScheduleUnreadableContract } from './schedule-unreadable-contract.js';
export { verifyJobNulContract } from './job-nul-contract.js';
export { prepareApprovalForWrite, prepareJobForWrite } from './job-input.js';
/** auth（accounts・identities・accessTokens・loginRequests）の入口の NUL の扱い（issue #3011）。 */
export {
  prepareAccessTokenForWrite,
  prepareAccountForWrite,
  prepareIdentityForWrite,
  prepareLoginRequestForWrite,
} from './auth-input.js';
export { verifyAuthNulContract } from './auth-nul-contract.js';

/** 連携の鍵（外のサービスへ渡す、固定の1 source で外部イベントを送るだけの鍵）。 */
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
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  DEFAULT_TURN_IMAGE_LIMITS,
  turnImageLimitsOf,
  attachmentDiskName,
  canBindAttachmentTo,
  isAttachmentImageMediaType,
  isBoundTo as isAttachmentBoundTo,
  isAttachmentExpired,
  isAttachmentPrunable,
  normalizeAttachmentMediaType,
  normalizeAttachmentName,
  prepareAttachment,
  readAttachmentLimits,
  sniffAttachmentImageType,
  validateAttachmentBatch,
  validateAttachmentInput,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentImageMediaType,
  type AttachmentLimits,
  type TurnAttachmentLimits,
  type TurnImageLimits,
  type AttachmentLimitsConfig,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentRejection,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from './attachment.js';
export { verifyAttachmentStoreContract } from './attachment-contract.js';
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
  RUNNER_ATTACHMENT_STALE_MS,
  type PlacedAttachment,
} from './runner-attachments.js';
export {
  attachmentRefsOf,
  loadManagerAttachments,
  estimateAttachmentBodyBytes,
  ManagerAttachmentsRefusedError,
  type LoadedManagerAttachments,
} from './manager-attachments.js';
