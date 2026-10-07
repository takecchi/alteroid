// 型を手で書き写さず生成 spec から導く: `apps/daemon/openapi.json` と二重管理になりずれるため。
import type { JournalEntry, paths, TopologySnapshot } from '@alteroid/api-client';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<T> = T extends { responses: { 200: infer R } } ? Json<R> : never;

export type { ChatStreamEvent, JournalEntry, TopologySnapshot } from '@alteroid/api-client';

export type JournalEntryType = JournalEntry['type'];

export type ManagerSummary = Ok<paths['/managers']['get']>['managers'][number];
export type ManagerStatus = ManagerSummary['status'];
export type ManagerDenial = NonNullable<ManagerSummary['denials']>[number];
export type UnreadableJob = NonNullable<Ok<paths['/managers']['get']>['unreadable']>[number];

export type PendingApproval = Ok<paths['/approvals']['get']>['approvals'][number];
export type ApprovalQuestion = NonNullable<PendingApproval['questions']>[number];
export type ApprovalSelection = NonNullable<PendingApproval['selections']>[number];
export type UnreadableApproval = NonNullable<Ok<paths['/approvals']['get']>['unreadable']>[number];

export type UnreadableInboxEvent = NonNullable<Ok<paths['/inbox']['get']>['unreadable']>[number];

export type Commitment = Ok<paths['/commitments']['get']>['entries'][number];
export type UnreadableCommitment = Ok<paths['/commitments']['get']>['unreadable'][number];

export type ApprovalAnswerResult = Ok<paths['/approvals/answer']['post']>['results'][number];

export type AnsweredApprovalDate = Ok<paths['/approvals/answered-dates']['get']>['dates'][number];

export type DailyReport = Ok<paths['/reports']['get']>['reports'][number];

export type Progress = Ok<paths['/progress']['get']>;
export type ProgressForecast = Progress['forecast'];
export type ProgressForecastBasis = ProgressForecast['basis'];

export type ScheduleEntry = Ok<paths['/schedule']['get']>['entries'][number];
export type UnreadableSchedule = NonNullable<Ok<paths['/schedule']['get']>['unreadable']>[number];
export type ScheduleSpec = NonNullable<ScheduleEntry['spec']>;

export type MemorySummary = Ok<paths['/memory']['get']>['documents'][number];
export type MemoryDocument = Ok<paths['/memory/{slug}']['get']>['document'];

export type PracticeSummary = Ok<paths['/practices']['get']>['practices'][number];
export type UnreadablePractice = NonNullable<Ok<paths['/practices']['get']>['unreadable']>[number];
export type Practice = Ok<paths['/practices/{slug}']['get']>['practice'];

export type PracticeVersionSummary = Ok<
  paths['/practices/{slug}/versions']['get']
>['versions'][number];
export type PracticeVersion = Ok<paths['/practices/{slug}/versions/{version}']['get']>['version'];

export type ConversationsResponse = Ok<paths['/conversations']['get']>;
export type ConversationSummary = ConversationsResponse['conversations'][number];
export type ConversationDetail = Ok<paths['/conversations/{id}']['get']>;
export type ConversationMessage = ConversationDetail['messages'][number];
export type AttachmentLimits = Ok<paths['/attachments/limits']['get']>;
export type MessageAttachment = NonNullable<ConversationMessage['attachments']>[number];

export type RunnerSummary = Ok<paths['/runners']['get']>['runners'][number];
export type DaemonRevision = Ok<paths['/runners']['get']>['daemonRevision'];

export type RunnerPushHealth = NonNullable<RunnerSummary['pushHealth']>;
export type RunnerPushOutcome = NonNullable<RunnerPushHealth['profile']>;

export type Health = Ok<paths['/health']['get']>;

export type UsageAggregate = Ok<paths['/usage']['get']>;
export type UsageRow = UsageAggregate['rows'][number];
export type UsageTurnRow = UsageAggregate['turnRows'][number];
export type UsageUnmeteredRow = NonNullable<UsageAggregate['unmeteredRows']>[number];
export type UsageLayer = UsageRow['layer'];
export type UsageSite = UsageRow['site'];
export type AccountUsageState = UsageAggregate['account'];
export type UnrecordedManager = UsageAggregate['unrecordedManagers'][number];

export type TokensState = Ok<paths['/tokens']['get']>;
export type AgentTokenView = TokensState['tokens'][number];
export type TokenRotationSettings = NonNullable<TokensState['settings']>;
export type TokensSettingsUnreadable = NonNullable<TokensState['settingsUnreadable']>;
export type TokensRowsUnreadable = NonNullable<TokensState['rowsUnreadable']>;
export type TokenAvailability = 'disabled' | 'invalidated' | 'cooling' | 'ready';
export type TokenRecovery = NonNullable<AgentTokenView['recovery']>;
export type TokenRotationEntry = Extract<JournalEntry, { type: 'token_rotation' }>;

export type AccessState = Ok<paths['/access']['get']>;
export type AccessAccount = AccessState['accounts'][number];
export type AccessRowsUnreadable = NonNullable<AccessState['rowsUnreadable']>;

export type PermissionGrantsState = Ok<paths['/permission-grants']['get']>;
export type PermissionGrant = PermissionGrantsState['grants'][number];
export type PermissionGrantsRowsUnreadable = NonNullable<PermissionGrantsState['rowsUnreadable']>;

export type CredentialsState = Ok<paths['/credentials']['get']>;
export type EnvVarView = CredentialsState['credentials'][number];
export type EnvVarScope = EnvVarView['scope'];
export type EnvVarUpdateResult = Ok<paths['/credentials']['put']>;

export type ProfileState = Ok<paths['/profile']['get']>;
export type ProfileEntryView = ProfileState['entries'][number];
export type ProfileScope = ProfileEntryView['scope'];
export type ProfileUpdateResult = Ok<paths['/profile/{name}']['put']>;

export type McpServersState = Ok<paths['/mcp-servers']['get']>;
export type McpServers = McpServersState['mcpServers'];
export type McpServerEntry = McpServers[string];
export type McpServersUpdateResult = Ok<paths['/mcp-servers']['put']>;

export type DroppedState = Ok<paths['/dropped']['get']>;

export type ArchiveListState = Ok<paths['/archive']['get']>;
export type ArchiveEntry = ArchiveListState['entries'][number];
export type ArchiveSessionsState = Ok<paths['/archive/sessions']['get']>;
export type ArchiveSessionSummary = ArchiveSessionsState['sessions'][number];
export type ArchiveRemoveResult = Ok<paths['/archive/{id}']['delete']>;

export type InboxRemoveManyRequestBody = NonNullable<
  paths['/inbox/remove']['post']['requestBody']
>['content']['application/json'];
export type InboxEventType = InboxRemoveManyRequestBody['types'][number];
export type InboxRemoveManyResult = Ok<paths['/inbox/remove']['post']>;

export type InboxBacklog = Ok<paths['/inbox']['get']>;

export type TopologySnapshotManager = TopologySnapshot['managers'][number];

export type IntegrationKeysState = Ok<paths['/integration-keys']['get']>;
export type IntegrationKeyView = IntegrationKeysState['keys'][number];
export type IntegrationKeyIssued = Ok<paths['/integration-keys']['post']>;
export type IntegrationKeyInput = NonNullable<
  paths['/integration-keys']['post']['requestBody']
>['content']['application/json'];
