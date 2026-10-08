/**
 * `codex app-server`（stdio・行区切り JSON-RPC）のプロトコルのうち、alteroid が触る
 * メソッド・欄だけを写した薄い手書きの型（#486 M7 段 S6）。
 *
 * **これは Codex 固有の語彙であり、中立の語彙（`agent-ports.ts` / `agent-events.ts` /
 * `agent-session.ts`）へ漏らさない。** 中立の側から見ればこのファイルは存在しない。
 * 使うのは `codex-*.ts` だけである（番人は `codex-protocol.test.ts`）。
 *
 * ## 本物との突き合わせ
 *
 * 型は手で書くが、**手で書いたものが本物のプロトコルとずれていないこと**は
 * `codex-protocol.test.ts` が機械で確かめる。相手は `codex app-server generate-json-schema`
 * の出力で、`packages/core/codex-schema/<版>/` にコミットしてある
 * （再生成は `pnpm --filter @alteroid/core codex:schema`）。突き合わせるのは次の4つ。
 *
 * 1. 触るメソッド名（`CODEX_CLIENT_REQUESTS` / `CODEX_SERVER_REQUESTS` /
 *    `CODEX_SERVER_NOTIFICATIONS`）が、スキーマの `ClientRequest` / `ServerRequest` /
 *    `ServerNotification` に実在し、params の型名が一致する
 * 2. 触る欄（`CODEX_SCHEMA_USES`）が、その定義の `properties` に実在し、必須かどうかが
 *    矛盾しない（送る型はスキーマの必須欄を落とさない／受ける型はスキーマが必須でない欄を
 *    必須と決めつけない）
 * 3. 触る列挙値（`CODEX_SCHEMA_ENUMS`）が、スキーマの列挙に実在する
 * 4. 型と表の同期は TypeScript が見る。`FieldMap<T>` は T の全欄を過不足なく要求する
 *    （欄を足して表を直し忘れれば typecheck が落ちる）
 *
 * **この型が写していないもの。** 載せていない欄は、本物にあっても手書き型には無い
 * （受け取った JSON にはそのまま残るが、型の上では見えない）。載せていないメソッドも同じ。
 * 版が上がって欄が増えるぶんには壊れない。欄が消える・必須になる・名前が変わると
 * 突き合わせが落ちる。
 *
 * ## ワイヤの形
 *
 * app-server は **`"jsonrpc":"2.0"` を送らず、要求しない**（生成スキーマの `JSONRPCMessage` /
 * `JSONRPCRequest` / `JSONRPCResponse` / `JSONRPCError` / `JSONRPCNotification` のどれにも
 * `jsonrpc` の欄が無い）。送るときは付けない。受け取ったときに付いていても読み飛ばす。
 */

/** 突き合わせ先の `@openai/codex` の版。`pnpm-workspace.yaml` の catalog と同じ exact 版。 */
export const CODEX_PROTOCOL_VERSION = '0.160.0';

// ---------------------------------------------------------------------------
// JSON-RPC（ワイヤの形）
// ---------------------------------------------------------------------------

export type CodexRequestId = string | number;

export interface CodexRpcRequest {
  readonly id: CodexRequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexRpcResponse {
  readonly id: CodexRequestId;
  readonly result: unknown;
}

export interface CodexRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface CodexRpcErrorResponse {
  readonly id: CodexRequestId;
  readonly error: CodexRpcErrorBody;
}

/** JSON-RPC 2.0 の標準のエラーコード（app-server への応答に使うぶんだけ）。 */
export const CODEX_RPC_ERROR_CODES = {
  methodNotFound: -32601,
  internalError: -32603,
} as const;

// ---------------------------------------------------------------------------
// 欄の表の型（型と突き合わせ表の同期用）
// ---------------------------------------------------------------------------

/**
 * 型 `T` の全欄を過不足なく要求し、各欄が必須か任意かを `T` と一致させる表。
 * 欄を足す・必須性を変えるのに表を直し忘れると typecheck が落ちる。
 */
export type FieldMap<T> = {
  readonly [K in keyof T]-?: Partial<Pick<T, K>> extends Pick<T, K> ? 'optional' : 'required';
};

// ---------------------------------------------------------------------------
// 列挙
// ---------------------------------------------------------------------------

/** `AskForApproval` のうち文字列の値（`{granular: …}` は使わない）。 */
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_TURN_STATUSES = ['completed', 'interrupted', 'failed', 'inProgress'] as const;
export type CodexTurnStatus = (typeof CODEX_TURN_STATUSES)[number];

/** `commandExecution` の承認への答え（受け入れ／このセッション中は受け入れ／拒否／ターンの中断）。 */
export const CODEX_COMMAND_APPROVAL_DECISIONS = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
] as const;
export type CodexCommandApprovalDecision = (typeof CODEX_COMMAND_APPROVAL_DECISIONS)[number];

export const CODEX_FILE_CHANGE_APPROVAL_DECISIONS = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
] as const;
export type CodexFileChangeApprovalDecision = (typeof CODEX_FILE_CHANGE_APPROVAL_DECISIONS)[number];

export const CODEX_PERMISSION_GRANT_SCOPES = ['turn', 'session'] as const;
export type CodexPermissionGrantScope = (typeof CODEX_PERMISSION_GRANT_SCOPES)[number];

export const CODEX_ELICITATION_ACTIONS = ['accept', 'decline', 'cancel'] as const;
export type CodexElicitationAction = (typeof CODEX_ELICITATION_ACTIONS)[number];

/** `Thread` 内の item の種類のうち alteroid が読み分けるもの（`ThreadItem` の `type`）。 */
export const CODEX_ITEM_TYPES = [
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'contextCompaction',
] as const;
export type CodexItemType = (typeof CODEX_ITEM_TYPES)[number];

/**
 * 固定版のスキーマ（`v2/ThreadItem`）の全 type を「道具の実行」と「そうでないもの」に分けた表。
 * **新しい種類が増えたとき、どちらでもないまま素通りさせない**ための番人（`codex-protocol.test.ts` が
 * スキーマの全 type がどちらかに入っていることを見る）。`toolAudit` を名乗る根拠もこの表である。
 */
export const CODEX_TOOL_ITEM_TYPES = [
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
  'sleep',
  'functionCallOutput',
] as const;
export type CodexToolItemType = (typeof CODEX_TOOL_ITEM_TYPES)[number];

/** 道具の実行ではない item（発言・推論・計画・入力・状態の遷移）。 */
export const CODEX_NON_TOOL_ITEM_TYPES = [
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'subAgentActivity',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
] as const;

export const CODEX_COMMAND_EXECUTION_STATUSES = [
  'inProgress',
  'completed',
  'failed',
  'declined',
] as const;
export type CodexCommandExecutionStatus = (typeof CODEX_COMMAND_EXECUTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface CodexClientInfo {
  name: string;
  title?: string | null;
  version: string;
}

export interface CodexInitializeCapabilities {
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface CodexInitializeParams {
  clientInfo: CodexClientInfo;
  capabilities?: CodexInitializeCapabilities | null;
}

export interface CodexInitializeResponse {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

export interface CodexUserInputText {
  type: 'text';
  text: string;
  text_elements?: unknown[];
}

/** 画像（URL 形。`data:<mime>;base64,...` を渡す）。スキーマの `UserInput` の `type: image` + `url`。 */
export interface CodexUserInputImage {
  type: 'image';
  url: string;
}

/** 送る入力。本文のテキストと、添付があれば画像。 */
export type CodexUserInput = CodexUserInputText | CodexUserInputImage;

// ---------------------------------------------------------------------------
// thread / turn
// ---------------------------------------------------------------------------

export interface CodexThread {
  id: string;
  cwd: string;
}

export interface CodexTurnError {
  message: string;
  additionalDetails?: string | null;
  /** 列挙の文字列か、`{ httpConnectionFailed: … }` のような1キーの object。中身は読まずに運ぶ。 */
  codexErrorInfo?: unknown;
}

export interface CodexTurn {
  id: string;
  status: CodexTurnStatus;
  items: CodexThreadItem[];
  error?: CodexTurnError | null;
}

export interface CodexThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandbox?: CodexSandboxMode | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
  ephemeral?: boolean | null;
  serviceName?: string | null;
}

export interface CodexThreadStartResponse {
  thread: CodexThread;
  model: string;
  approvalPolicy: CodexApprovalPolicy;
}

export interface CodexThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandbox?: CodexSandboxMode | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
}

export interface CodexThreadResumeResponse {
  thread: CodexThread;
  model: string;
  approvalPolicy: CodexApprovalPolicy;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexUserInput[];
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ---------------------------------------------------------------------------
// item（`item/started` / `item/completed` が運ぶ）
// ---------------------------------------------------------------------------

export interface CodexAgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
}

export interface CodexReasoningItem {
  type: 'reasoning';
  id: string;
  summary?: string[];
  content?: string[];
}

export interface CodexCommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  status: CodexCommandExecutionStatus;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
}

export interface CodexFileChangeItem {
  type: 'fileChange';
  id: string;
  status: CodexCommandExecutionStatus;
}

/**
 * 上の4つ以外の item（`userMessage` / `plan` / `mcpToolCall` / `webSearch` …）。
 * 種類は `CODEX_ITEM_TYPES` の範囲に限らない——知らない種類が来ても壊れないよう、
 * `type` は文字列で受ける。中身は読まずに運ぶ。
 */
export interface CodexOtherItem {
  type: string;
  id: string;
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexOtherItem;

// ---------------------------------------------------------------------------
// 通知（server → client）
// ---------------------------------------------------------------------------

export interface CodexThreadStartedNotification {
  thread: CodexThread;
}

export interface CodexTurnStartedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface CodexTurnCompletedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface CodexItemStartedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexAgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexTokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface CodexThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: CodexThreadTokenUsage;
}

/** `thread/compacted`（本物の型名は `ContextCompactedNotification`。新しい版では `contextCompaction` item に置き換わる側）。 */
export interface CodexThreadCompactedNotification {
  threadId: string;
  turnId: string;
}

export interface CodexErrorNotification {
  threadId: string;
  turnId: string;
  error: CodexTurnError;
  /** true なら codex が自分で再試行する（このターンはまだ終わっていない）。 */
  willRetry: boolean;
}

export interface CodexWarningNotification {
  message: string;
  threadId?: string | null;
}

export interface CodexServerRequestResolvedNotification {
  threadId: string;
  requestId: CodexRequestId;
}

export interface CodexModelReroutedNotification {
  threadId: string;
  turnId: string;
  fromModel: string;
  toModel: string;
  reason: string;
}

/** `RateLimitWindow`。 */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  /** Unix 秒。 */
  resetsAt?: number | null;
}

export const CODEX_RATE_LIMIT_REACHED_TYPES = [
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
] as const;
export type CodexRateLimitReachedType = (typeof CODEX_RATE_LIMIT_REACHED_TYPES)[number];

/** `RateLimitSnapshot`（読む欄だけ。ほかの欄は読まずに捨てる）。 */
export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: CodexRateLimitReachedType | null;
  spendControlReached?: boolean | null;
}

export interface CodexAccountRateLimitsUpdatedNotification {
  rateLimits: CodexRateLimitSnapshot;
}

export interface CodexAccountUpdatedNotification {
  authMode?: string | null;
  planType?: string | null;
}

/** `account/login/start` で始めたログインの決着（デバイスコードのログインでは、人間がブラウザで承認した／期限切れ等）。 */
export interface CodexAccountLoginCompletedNotification {
  success: boolean;
  loginId?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// 承認など（server → client の request と、その答え）
// ---------------------------------------------------------------------------

export interface CodexCommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
}

export interface CodexCommandExecutionApprovalResponse {
  decision: CodexCommandApprovalDecision;
}

export interface CodexFileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface CodexFileChangeApprovalResponse {
  decision: CodexFileChangeApprovalDecision;
}

export interface CodexPermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  /** 求められている権限（`fileSystem` / `network`）。中身は読まずに運ぶ。 */
  permissions: unknown;
  reason?: string | null;
}

export interface CodexPermissionsApprovalResponse {
  /** 許す権限。拒否は空の object を返す。 */
  permissions: Record<string, unknown>;
  scope?: CodexPermissionGrantScope | null;
}

export interface CodexUserInputQuestionOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: CodexUserInputQuestionOption[] | null;
}

export interface CodexToolUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  questions: CodexUserInputQuestion[];
}

export interface CodexToolUserInputAnswer {
  answers: string[];
}

export interface CodexToolUserInputResponse {
  /** 質問 id → 答え。 */
  answers: Record<string, CodexToolUserInputAnswer>;
}

/** `mcpServer/elicitation/request` の全モードに共通の欄（モードごとの欄は読まずに運ぶ）。 */
export interface CodexMcpElicitationParams {
  threadId: string;
  serverName: string;
  turnId?: string | null;
}

export interface CodexMcpElicitationResponse {
  action: CodexElicitationAction;
  content?: unknown;
}

// ---------------------------------------------------------------------------
// account / model
// ---------------------------------------------------------------------------

export interface CodexGetAccountParams {
  refreshToken?: boolean;
}

export interface CodexAccountApiKey {
  type: 'apiKey';
}

export interface CodexAccountChatgpt {
  type: 'chatgpt';
  email: string | null;
  planType: string;
}

/** `amazonBedrock` など、上の2つ以外。種類は文字列で受ける。 */
export interface CodexAccountOther {
  type: string;
}

export type CodexAccount = CodexAccountApiKey | CodexAccountChatgpt | CodexAccountOther;

export interface CodexGetAccountResponse {
  requiresOpenaiAuth: boolean;
  account?: CodexAccount | null;
}

export interface CodexLoginApiKeyParams {
  type: 'apiKey';
  apiKey: string;
}

export interface CodexLoginChatgptParams {
  type: 'chatgpt';
}

export interface CodexLoginChatgptDeviceCodeParams {
  type: 'chatgptDeviceCode';
}

export type CodexLoginAccountParams =
  CodexLoginApiKeyParams | CodexLoginChatgptParams | CodexLoginChatgptDeviceCodeParams;

export interface CodexLoginApiKeyResponse {
  type: 'apiKey';
}

export interface CodexLoginChatgptResponse {
  type: 'chatgpt';
  authUrl: string;
  loginId: string;
}

export interface CodexLoginChatgptDeviceCodeResponse {
  type: 'chatgptDeviceCode';
  loginId: string;
  userCode: string;
  verificationUrl: string;
}

export type CodexLoginAccountResponse =
  CodexLoginApiKeyResponse | CodexLoginChatgptResponse | CodexLoginChatgptDeviceCodeResponse;

export interface CodexCancelLoginParams {
  loginId: string;
}

export const CODEX_CANCEL_LOGIN_STATUSES = ['canceled', 'notFound'] as const;
export type CodexCancelLoginStatus = (typeof CODEX_CANCEL_LOGIN_STATUSES)[number];

export interface CodexCancelLoginResponse {
  status: CodexCancelLoginStatus;
}

export interface CodexModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
}

export interface CodexModelListResponse {
  data: CodexModel[];
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// メソッドの表
// ---------------------------------------------------------------------------

/** client → server の request（メソッド名 → params / result）。 */
export interface CodexClientRequestMap {
  initialize: { params: CodexInitializeParams; result: CodexInitializeResponse };
  'thread/start': { params: CodexThreadStartParams; result: CodexThreadStartResponse };
  'thread/resume': { params: CodexThreadResumeParams; result: CodexThreadResumeResponse };
  'turn/start': { params: CodexTurnStartParams; result: CodexTurnStartResponse };
  'turn/interrupt': { params: CodexTurnInterruptParams; result: Record<string, never> };
  'account/read': { params: CodexGetAccountParams; result: CodexGetAccountResponse };
  'account/login/start': { params: CodexLoginAccountParams; result: CodexLoginAccountResponse };
  'account/login/cancel': { params: CodexCancelLoginParams; result: CodexCancelLoginResponse };
  'model/list': { params: CodexModelListParams; result: CodexModelListResponse };
}
export type CodexClientRequestMethod = keyof CodexClientRequestMap;

/** server → client の通知（メソッド名 → params）。 */
export interface CodexServerNotificationMap {
  'thread/started': CodexThreadStartedNotification;
  'turn/started': CodexTurnStartedNotification;
  'turn/completed': CodexTurnCompletedNotification;
  'item/started': CodexItemStartedNotification;
  'item/completed': CodexItemCompletedNotification;
  'item/agentMessage/delta': CodexAgentMessageDeltaNotification;
  'thread/tokenUsage/updated': CodexThreadTokenUsageUpdatedNotification;
  'thread/compacted': CodexThreadCompactedNotification;
  error: CodexErrorNotification;
  warning: CodexWarningNotification;
  'serverRequest/resolved': CodexServerRequestResolvedNotification;
  'model/rerouted': CodexModelReroutedNotification;
  'account/updated': CodexAccountUpdatedNotification;
  'account/rateLimits/updated': CodexAccountRateLimitsUpdatedNotification;
  'account/login/completed': CodexAccountLoginCompletedNotification;
}
export type CodexServerNotificationMethod = keyof CodexServerNotificationMap;

/** server → client の request（メソッド名 → params / 答え）。承認など、人間（＝クローン）の判断が要るもの。 */
export interface CodexServerRequestMap {
  'item/commandExecution/requestApproval': {
    params: CodexCommandExecutionApprovalParams;
    result: CodexCommandExecutionApprovalResponse;
  };
  'item/fileChange/requestApproval': {
    params: CodexFileChangeApprovalParams;
    result: CodexFileChangeApprovalResponse;
  };
  'item/permissions/requestApproval': {
    params: CodexPermissionsApprovalParams;
    result: CodexPermissionsApprovalResponse;
  };
  'item/tool/requestUserInput': {
    params: CodexToolUserInputParams;
    result: CodexToolUserInputResponse;
  };
  'mcpServer/elicitation/request': {
    params: CodexMcpElicitationParams;
    result: CodexMcpElicitationResponse;
  };
}
export type CodexServerRequestMethod = keyof CodexServerRequestMap;

/** 型に載せていない server → client の request（既定では `-32601` で断る。載せるのは次の段以降）。 */
export const CODEX_UNHANDLED_SERVER_REQUEST_METHODS = [
  'item/tool/call',
  'attestation/generate',
  'account/chatgptAuthTokens/refresh',
] as const;

export const CODEX_CLIENT_NOTIFICATION_INITIALIZED = 'initialized';

// ---------------------------------------------------------------------------
// 突き合わせ表（codex-protocol.test.ts が生成スキーマと照らす）
// ---------------------------------------------------------------------------

/** メソッド名 → スキーマの定義名（`#/definitions/` 以下。v2 は `v2/` 付き）。 */
export const CODEX_CLIENT_REQUESTS = {
  initialize: { params: 'InitializeParams', result: 'InitializeResponse' },
  'thread/start': { params: 'v2/ThreadStartParams', result: 'v2/ThreadStartResponse' },
  'thread/resume': { params: 'v2/ThreadResumeParams', result: 'v2/ThreadResumeResponse' },
  'turn/start': { params: 'v2/TurnStartParams', result: 'v2/TurnStartResponse' },
  'turn/interrupt': { params: 'v2/TurnInterruptParams', result: 'v2/TurnInterruptResponse' },
  'account/read': { params: 'v2/GetAccountParams', result: 'v2/GetAccountResponse' },
  'account/login/start': { params: 'v2/LoginAccountParams', result: 'v2/LoginAccountResponse' },
  'account/login/cancel': {
    params: 'v2/CancelLoginAccountParams',
    result: 'v2/CancelLoginAccountResponse',
  },
  'model/list': { params: 'v2/ModelListParams', result: 'v2/ModelListResponse' },
} as const satisfies Record<CodexClientRequestMethod, { params: string; result: string }>;

export const CODEX_SERVER_NOTIFICATIONS = {
  'thread/started': 'v2/ThreadStartedNotification',
  'turn/started': 'v2/TurnStartedNotification',
  'turn/completed': 'v2/TurnCompletedNotification',
  'item/started': 'v2/ItemStartedNotification',
  'item/completed': 'v2/ItemCompletedNotification',
  'item/agentMessage/delta': 'v2/AgentMessageDeltaNotification',
  'thread/tokenUsage/updated': 'v2/ThreadTokenUsageUpdatedNotification',
  'thread/compacted': 'v2/ContextCompactedNotification',
  error: 'v2/ErrorNotification',
  warning: 'v2/WarningNotification',
  'serverRequest/resolved': 'v2/ServerRequestResolvedNotification',
  'model/rerouted': 'v2/ModelReroutedNotification',
  'account/updated': 'v2/AccountUpdatedNotification',
  'account/rateLimits/updated': 'v2/AccountRateLimitsUpdatedNotification',
  'account/login/completed': 'v2/AccountLoginCompletedNotification',
} as const satisfies Record<CodexServerNotificationMethod, string>;

export const CODEX_SERVER_REQUESTS = {
  'item/commandExecution/requestApproval': {
    params: 'CommandExecutionRequestApprovalParams',
    result: 'CommandExecutionRequestApprovalResponse',
  },
  'item/fileChange/requestApproval': {
    params: 'FileChangeRequestApprovalParams',
    result: 'FileChangeRequestApprovalResponse',
  },
  'item/permissions/requestApproval': {
    params: 'PermissionsRequestApprovalParams',
    result: 'PermissionsRequestApprovalResponse',
  },
  'item/tool/requestUserInput': {
    params: 'ToolRequestUserInputParams',
    result: 'ToolRequestUserInputResponse',
  },
  'mcpServer/elicitation/request': {
    params: 'McpServerElicitationRequestParams',
    result: 'McpServerElicitationRequestResponse',
  },
} as const satisfies Record<CodexServerRequestMethod, { params: string; result: string }>;

/**
 * 欄の突き合わせ1件。
 *
 * - `def`: スキーマの定義名
 * - `variant`: 定義が `oneOf` / `anyOf` の判別共用体のとき、どの枝か（`{ key: 'type', value: 'text' }`）。
 *   無ければ定義そのものの `properties` を見る
 * - `direction`: `send` は alteroid が送る型（スキーマの必須欄を表で `required` にしていること）、
 *   `receive` は受ける型（表で `required` にした欄はスキーマでも必須であること）
 * - `fields`: 触る欄（`FieldMap<T>` が T の全欄との同期を typecheck で保証する）
 */
export interface CodexSchemaUse {
  readonly def: string;
  readonly variant?: { readonly key: string; readonly value: string };
  readonly direction: 'send' | 'receive';
  readonly fields: Readonly<Record<string, 'required' | 'optional'>>;
}

function use<T>(
  def: string,
  direction: 'send' | 'receive',
  fields: FieldMap<T>,
  variant?: { key: string; value: string },
): CodexSchemaUse {
  return variant === undefined ? { def, direction, fields } : { def, direction, fields, variant };
}

export const CODEX_SCHEMA_USES: readonly CodexSchemaUse[] = [
  use<CodexInitializeParams>('InitializeParams', 'send', {
    clientInfo: 'required',
    capabilities: 'optional',
  }),
  use<CodexClientInfo>('ClientInfo', 'send', {
    name: 'required',
    title: 'optional',
    version: 'required',
  }),
  use<CodexInitializeCapabilities>('InitializeCapabilities', 'send', {
    experimentalApi: 'optional',
    optOutNotificationMethods: 'optional',
  }),
  use<CodexInitializeResponse>('InitializeResponse', 'receive', {
    userAgent: 'required',
    platformFamily: 'required',
    platformOs: 'required',
  }),
  use<CodexThreadStartParams>('v2/ThreadStartParams', 'send', {
    cwd: 'optional',
    model: 'optional',
    approvalPolicy: 'optional',
    sandbox: 'optional',
    baseInstructions: 'optional',
    developerInstructions: 'optional',
    config: 'optional',
    ephemeral: 'optional',
    serviceName: 'optional',
  }),
  use<CodexThreadStartResponse>('v2/ThreadStartResponse', 'receive', {
    thread: 'required',
    model: 'required',
    approvalPolicy: 'required',
  }),
  use<CodexThreadResumeParams>('v2/ThreadResumeParams', 'send', {
    threadId: 'required',
    cwd: 'optional',
    model: 'optional',
    approvalPolicy: 'optional',
    sandbox: 'optional',
    baseInstructions: 'optional',
    developerInstructions: 'optional',
    config: 'optional',
  }),
  use<CodexThreadResumeResponse>('v2/ThreadResumeResponse', 'receive', {
    thread: 'required',
    model: 'required',
    approvalPolicy: 'required',
  }),
  use<CodexThread>('v2/Thread', 'receive', { id: 'required', cwd: 'required' }),
  use<CodexTurnStartParams>('v2/TurnStartParams', 'send', {
    threadId: 'required',
    input: 'required',
    cwd: 'optional',
    model: 'optional',
    approvalPolicy: 'optional',
  }),
  use<CodexUserInputText>(
    'v2/UserInput',
    'send',
    { type: 'required', text: 'required', text_elements: 'optional' },
    { key: 'type', value: 'text' },
  ),
  use<CodexTurnStartResponse>('v2/TurnStartResponse', 'receive', { turn: 'required' }),
  use<CodexTurn>('v2/Turn', 'receive', {
    id: 'required',
    status: 'required',
    items: 'required',
    error: 'optional',
  }),
  use<CodexTurnError>('v2/TurnError', 'receive', {
    message: 'required',
    additionalDetails: 'optional',
    codexErrorInfo: 'optional',
  }),
  use<CodexTurnInterruptParams>('v2/TurnInterruptParams', 'send', {
    threadId: 'required',
    turnId: 'required',
  }),
  use<CodexAgentMessageItem>(
    'v2/ThreadItem',
    'receive',
    { type: 'required', id: 'required', text: 'required' },
    { key: 'type', value: 'agentMessage' },
  ),
  use<CodexReasoningItem>(
    'v2/ThreadItem',
    'receive',
    { type: 'required', id: 'required', summary: 'optional', content: 'optional' },
    { key: 'type', value: 'reasoning' },
  ),
  use<CodexCommandExecutionItem>(
    'v2/ThreadItem',
    'receive',
    {
      type: 'required',
      id: 'required',
      command: 'required',
      status: 'required',
      aggregatedOutput: 'optional',
      exitCode: 'optional',
    },
    { key: 'type', value: 'commandExecution' },
  ),
  use<CodexFileChangeItem>(
    'v2/ThreadItem',
    'receive',
    { type: 'required', id: 'required', status: 'required' },
    { key: 'type', value: 'fileChange' },
  ),
  use<CodexThreadStartedNotification>('v2/ThreadStartedNotification', 'receive', {
    thread: 'required',
  }),
  use<CodexTurnStartedNotification>('v2/TurnStartedNotification', 'receive', {
    threadId: 'required',
    turn: 'required',
  }),
  use<CodexTurnCompletedNotification>('v2/TurnCompletedNotification', 'receive', {
    threadId: 'required',
    turn: 'required',
  }),
  use<CodexItemStartedNotification>('v2/ItemStartedNotification', 'receive', {
    threadId: 'required',
    turnId: 'required',
    item: 'required',
  }),
  use<CodexItemCompletedNotification>('v2/ItemCompletedNotification', 'receive', {
    threadId: 'required',
    turnId: 'required',
    item: 'required',
  }),
  use<CodexAgentMessageDeltaNotification>('v2/AgentMessageDeltaNotification', 'receive', {
    threadId: 'required',
    turnId: 'required',
    itemId: 'required',
    delta: 'required',
  }),
  use<CodexTokenUsageBreakdown>('v2/TokenUsageBreakdown', 'receive', {
    inputTokens: 'required',
    cachedInputTokens: 'required',
    outputTokens: 'required',
    reasoningOutputTokens: 'required',
    totalTokens: 'required',
  }),
  use<CodexThreadTokenUsage>('v2/ThreadTokenUsage', 'receive', {
    total: 'required',
    last: 'required',
    modelContextWindow: 'optional',
  }),
  use<CodexThreadTokenUsageUpdatedNotification>(
    'v2/ThreadTokenUsageUpdatedNotification',
    'receive',
    {
      threadId: 'required',
      turnId: 'required',
      tokenUsage: 'required',
    },
  ),
  use<CodexThreadCompactedNotification>('v2/ContextCompactedNotification', 'receive', {
    threadId: 'required',
    turnId: 'required',
  }),
  use<CodexErrorNotification>('v2/ErrorNotification', 'receive', {
    threadId: 'required',
    turnId: 'required',
    error: 'required',
    willRetry: 'required',
  }),
  use<CodexWarningNotification>('v2/WarningNotification', 'receive', {
    message: 'required',
    threadId: 'optional',
  }),
  use<CodexServerRequestResolvedNotification>('v2/ServerRequestResolvedNotification', 'receive', {
    threadId: 'required',
    requestId: 'required',
  }),
  use<CodexModelReroutedNotification>('v2/ModelReroutedNotification', 'receive', {
    threadId: 'required',
    turnId: 'required',
    fromModel: 'required',
    toModel: 'required',
    reason: 'required',
  }),
  use<CodexAccountUpdatedNotification>('v2/AccountUpdatedNotification', 'receive', {
    authMode: 'optional',
    planType: 'optional',
  }),
  use<CodexAccountRateLimitsUpdatedNotification>(
    'v2/AccountRateLimitsUpdatedNotification',
    'receive',
    { rateLimits: 'required' },
  ),
  use<CodexRateLimitSnapshot>('v2/RateLimitSnapshot', 'receive', {
    limitId: 'optional',
    limitName: 'optional',
    primary: 'optional',
    secondary: 'optional',
    rateLimitReachedType: 'optional',
    spendControlReached: 'optional',
  }),
  use<CodexRateLimitWindow>('v2/RateLimitWindow', 'receive', {
    usedPercent: 'required',
    windowDurationMins: 'optional',
    resetsAt: 'optional',
  }),
  use<CodexCommandExecutionApprovalParams>('CommandExecutionRequestApprovalParams', 'receive', {
    threadId: 'required',
    turnId: 'required',
    itemId: 'required',
    approvalId: 'optional',
    command: 'optional',
    cwd: 'optional',
    reason: 'optional',
  }),
  use<CodexCommandExecutionApprovalResponse>('CommandExecutionRequestApprovalResponse', 'send', {
    decision: 'required',
  }),
  use<CodexFileChangeApprovalParams>('FileChangeRequestApprovalParams', 'receive', {
    threadId: 'required',
    turnId: 'required',
    itemId: 'required',
    reason: 'optional',
    grantRoot: 'optional',
  }),
  use<CodexFileChangeApprovalResponse>('FileChangeRequestApprovalResponse', 'send', {
    decision: 'required',
  }),
  use<CodexPermissionsApprovalParams>('PermissionsRequestApprovalParams', 'receive', {
    threadId: 'required',
    turnId: 'required',
    itemId: 'required',
    cwd: 'required',
    permissions: 'required',
    reason: 'optional',
  }),
  use<CodexPermissionsApprovalResponse>('PermissionsRequestApprovalResponse', 'send', {
    permissions: 'required',
    scope: 'optional',
  }),
  use<CodexToolUserInputParams>('ToolRequestUserInputParams', 'receive', {
    threadId: 'required',
    turnId: 'required',
    itemId: 'required',
    isBlocking: 'required',
    questions: 'required',
  }),
  use<CodexUserInputQuestion>('ToolRequestUserInputQuestion', 'receive', {
    id: 'required',
    header: 'required',
    question: 'required',
    isOther: 'optional',
    isSecret: 'optional',
    options: 'optional',
  }),
  use<CodexUserInputQuestionOption>('ToolRequestUserInputOption', 'receive', {
    label: 'required',
    description: 'required',
  }),
  use<CodexToolUserInputAnswer>('ToolRequestUserInputAnswer', 'send', { answers: 'required' }),
  use<CodexToolUserInputResponse>('ToolRequestUserInputResponse', 'send', { answers: 'required' }),
  use<CodexMcpElicitationParams>('McpServerElicitationRequestParams', 'receive', {
    threadId: 'required',
    serverName: 'required',
    turnId: 'optional',
  }),
  use<CodexMcpElicitationResponse>('McpServerElicitationRequestResponse', 'send', {
    action: 'required',
    content: 'optional',
  }),
  use<CodexGetAccountParams>('v2/GetAccountParams', 'send', { refreshToken: 'optional' }),
  use<CodexGetAccountResponse>('v2/GetAccountResponse', 'receive', {
    requiresOpenaiAuth: 'required',
    account: 'optional',
  }),
  use<CodexAccountChatgpt>(
    'v2/Account',
    'receive',
    { type: 'required', email: 'required', planType: 'required' },
    { key: 'type', value: 'chatgpt' },
  ),
  use<CodexAccountApiKey>(
    'v2/Account',
    'receive',
    { type: 'required' },
    { key: 'type', value: 'apiKey' },
  ),
  use<CodexLoginApiKeyParams>(
    'v2/LoginAccountParams',
    'send',
    { type: 'required', apiKey: 'required' },
    { key: 'type', value: 'apiKey' },
  ),
  use<CodexLoginChatgptParams>(
    'v2/LoginAccountParams',
    'send',
    { type: 'required' },
    { key: 'type', value: 'chatgpt' },
  ),
  use<CodexLoginChatgptDeviceCodeParams>(
    'v2/LoginAccountParams',
    'send',
    { type: 'required' },
    { key: 'type', value: 'chatgptDeviceCode' },
  ),
  use<CodexLoginApiKeyResponse>(
    'v2/LoginAccountResponse',
    'receive',
    { type: 'required' },
    { key: 'type', value: 'apiKey' },
  ),
  use<CodexLoginChatgptResponse>(
    'v2/LoginAccountResponse',
    'receive',
    { type: 'required', authUrl: 'required', loginId: 'required' },
    { key: 'type', value: 'chatgpt' },
  ),
  use<CodexLoginChatgptDeviceCodeResponse>(
    'v2/LoginAccountResponse',
    'receive',
    { type: 'required', loginId: 'required', userCode: 'required', verificationUrl: 'required' },
    { key: 'type', value: 'chatgptDeviceCode' },
  ),
  use<CodexCancelLoginParams>('v2/CancelLoginAccountParams', 'send', { loginId: 'required' }),
  use<CodexCancelLoginResponse>('v2/CancelLoginAccountResponse', 'receive', {
    status: 'required',
  }),
  use<CodexAccountLoginCompletedNotification>('v2/AccountLoginCompletedNotification', 'receive', {
    success: 'required',
    loginId: 'optional',
    error: 'optional',
  }),
  use<CodexModelListParams>('v2/ModelListParams', 'send', {
    cursor: 'optional',
    limit: 'optional',
    includeHidden: 'optional',
  }),
  use<CodexModelListResponse>('v2/ModelListResponse', 'receive', {
    data: 'required',
    nextCursor: 'optional',
  }),
  use<CodexModel>('v2/Model', 'receive', {
    id: 'required',
    model: 'required',
    displayName: 'required',
    isDefault: 'required',
    hidden: 'required',
  }),
];

/** 列挙の突き合わせ1件。`values` の全部が、スキーマの定義の文字列の列挙に在ること。 */
export interface CodexSchemaEnum {
  readonly def: string;
  readonly values: readonly string[];
}

export const CODEX_SCHEMA_ENUMS: readonly CodexSchemaEnum[] = [
  { def: 'v2/AskForApproval', values: CODEX_APPROVAL_POLICIES },
  { def: 'v2/SandboxMode', values: CODEX_SANDBOX_MODES },
  { def: 'v2/TurnStatus', values: CODEX_TURN_STATUSES },
  { def: 'CommandExecutionApprovalDecision', values: CODEX_COMMAND_APPROVAL_DECISIONS },
  { def: 'FileChangeApprovalDecision', values: CODEX_FILE_CHANGE_APPROVAL_DECISIONS },
  { def: 'PermissionGrantScope', values: CODEX_PERMISSION_GRANT_SCOPES },
  { def: 'McpServerElicitationAction', values: CODEX_ELICITATION_ACTIONS },
  { def: 'v2/CommandExecutionStatus', values: CODEX_COMMAND_EXECUTION_STATUSES },
  { def: 'v2/PatchApplyStatus', values: CODEX_COMMAND_EXECUTION_STATUSES },
  { def: 'v2/RateLimitReachedType', values: CODEX_RATE_LIMIT_REACHED_TYPES },
  { def: 'v2/CancelLoginAccountStatus', values: CODEX_CANCEL_LOGIN_STATUSES },
];

// ---------------------------------------------------------------------------
// 型ガード・小さな道具
// ---------------------------------------------------------------------------

/** 通知（メソッド名と params）を型の付いた形に絞る。知らないメソッドは `false`。 */
export function isCodexServerNotificationMethod(
  method: string,
): method is CodexServerNotificationMethod {
  return Object.hasOwn(CODEX_SERVER_NOTIFICATIONS, method);
}

export function isCodexServerRequestMethod(method: string): method is CodexServerRequestMethod {
  return Object.hasOwn(CODEX_SERVER_REQUESTS, method);
}
