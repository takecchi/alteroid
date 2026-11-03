import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import { notePhase } from './loop-stall.js';

import { chunkIdsByChars } from './chunk-ids.js';

import { CLOSE_MANY_JOURNAL_ID_CHARS, CLOSE_MANY_LIMIT_MAX } from './task-set-status-many.js';

import { formatArrayLengthJa, formatIntRangeJa, formatStringLengthJa } from './tool-arg-checks.js';
import { opsTools } from './clone-tools-ops.js';
import { attachTools } from './clone-tools-attach.js';
import { managerTools } from './clone-tools-manager.js';
import { selfTools } from './clone-tools-self.js';
import { practiceTools } from './clone-tools-practice.js';
import { profileTools } from './clone-tools-profile.js';
import { taskTools } from './clone-tools-task.js';
import { scheduleTools } from './clone-tools-schedule.js';
import { usageTools } from './clone-tools-usage.js';
import { approvalTools } from './clone-tools-approval.js';
import { journalTools } from './clone-tools-journal.js';
import { memoryTools } from './clone-tools-memory.js';

import { CLONE_TOOL_NAMES, type CloneToolName } from './clone-tools-names.js';
import type { CloneToolsShared, ToolContext } from './clone-tools-context.js';

export const MCP_INPUT_VALIDATION_ERROR_MARKER =
  'Input validation error: Invalid arguments for tool ';

interface McpInputValidationFailure {
  readonly message: string;
  readonly fields: readonly string[];
}

// 形を決め打ちしない: `tool_response` は SDK の型で `unknown` であり、文字列化して印を探すだけにする
export function detectMcpInputValidationFailure(
  toolResponse: unknown,
): McpInputValidationFailure | undefined {
  const message = stringifyToolResponseForValidationCheck(toolResponse);
  if (!message.includes(MCP_INPUT_VALIDATION_ERROR_MARKER)) return undefined;
  const fields = [...new Set(extractValidationFields(message))];
  return { message, fields };
}

function extractValidationFields(message: string): string[] {
  // バックスラッシュを剥がしてから読む: オブジェクト経由だと本文が二重に JSON.stringify されて引用符がエスケープされるため
  const normalized = message.replace(/\\(.)/g, '$1');
  const fromDotPath = [...normalized.matchAll(/ at ([A-Za-z0-9_$.[\]]+)/g)].map(
    (match) => match[1]!,
  );
  const fromJsonPath: string[] = [];
  for (const pathMatch of normalized.matchAll(/"path"\s*:\s*\[([^\]]*)\]/g)) {
    const inner = pathMatch[1] ?? '';
    for (const stringMatch of inner.matchAll(/"([^"]*)"/g)) {
      fromJsonPath.push(stringMatch[1]!);
    }
  }
  return [...fromDotPath, ...fromJsonPath];
}

// 例外を投げない: `PostToolUse` フックで毎回呼ばれ、循環参照で道具の実行を巻き込まないため
function stringifyToolResponseForValidationCheck(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  try {
    return JSON.stringify(toolResponse) ?? '';
  } catch {
    return '';
  }
}

import { MCP_SERVER_NAME } from './mcp-server-name.js';

export { MCP_SERVER_NAME };
export {
  isFoldedTurnReport,
  describeHeldMessages,
  describeExternalOutputs,
  describeRescueStash,
  describeRescue,
} from './clone-tools-manager-describe.js';
export {
  describeReportDriftMark,
  describeTurnEnd,
  describeToolUseStall,
} from './clone-tools-manager-list.js';
export { renderPeerReach } from './clone-tools-self.js';
export { formatPracticeKindRangeJa } from './clone-tools-practice.js';
export {
  GITHUB_OBSERVATION_CLONE_OBSERVER,
  REMOVE_MANY_JOURNAL_ID_CHARS,
} from './clone-tools-task.js';
export { USAGE_AXES } from './clone-tools-usage.js';
export { describePermissionEvidence } from './clone-tools-approval.js';
export { GROUNDS_NOT_DELIVERED } from './clone-tools-journal.js';
export {
  MEMORY_GUARD_ENV,
  MEMORY_GUARD_VALUES,
  DEFAULT_MEMORY_GUARD,
  resolveMemoryGuard,
} from './clone-tools-memory.js';
export type { MemoryGuardValue } from './clone-tools-memory.js';
export {
  TOOL_USE_ID_META_KEY,
  toolUseIdFromExtra,
  toolUseIdProbeFromExtra,
} from './clone-tools-common.js';
export { CLONE_TOOL_NAMES } from './clone-tools-names.js';
export type { CloneToolName } from './clone-tools-names.js';
export type { ReplyAttachments, ToolContext } from './clone-tools-context.js';

export function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const SELF_JOURNALING_CLONE_TOOLS = [
  'github_observation_record',
  'memory_write',
  'memory_append',
  'memory_delete',
  'memory_frontmatter_set',
  'memory_section_move',
  'journal_write',
  'ask_human',
  'request_permission',
  'approval_withdraw',
  'daily_report_write',
  'schedule_create',
  'schedule_remove',
  'task_add',
  'task_move',
  'task_set_status',
  'task_set_status_many',
  'task_keep',
  'task_say',
  'inbox_remove_many',
  'profile_write',
  'profile_remove',
  'practice_write',
  'practice_remove',
  'manager_start',
  'manager_send',
  'manager_stop',
  'archive_remove',
  'archive_remove_many',
  'file_delete',
] as const satisfies readonly CloneToolName[];

export const TRACELESS_CLONE_TOOLS = [
  'memory_list',
  'memory_read',
  'memory_outline',
  'memory_section_read',
  'journal_read',
  'conversation_read',
  'attachment_fetch',
  'file_put',
  'file_list',
  'file_keep',
  'reply_attach',
  'approvals_list',
  'approval_trace',
  'usage_read',
  'schedule_list',
  'task_list',
  'progress_read',
  'profile_read',
  'practice_list',
  'practice_read',
  'practice_history',
  'token_list',
  'permission_grant_list',
  'account_list',
  'self_read',
  'self_status',
  'self_dropped',
  'manager_list',
  'manager_report',
  'manager_transcript',
  'runner_list',
] as const satisfies readonly CloneToolName[];

type SelfJournalingCloneTool = (typeof SELF_JOURNALING_CLONE_TOOLS)[number];
type TracelessCloneTool = (typeof TRACELESS_CLONE_TOOLS)[number];

type AssertTrue<T extends true> = T;

export type _AssertCloneToolPartitionIsExhaustive = AssertTrue<
  [Exclude<CloneToolName, SelfJournalingCloneTool | TracelessCloneTool>] extends [never]
    ? true
    : false
>;

export type _AssertCloneToolPartitionIsExclusive = AssertTrue<
  [Extract<SelfJournalingCloneTool, TracelessCloneTool>] extends [never] ? true : false
>;

const SELF_JOURNALING_CLONE_TOOL_NAMES: ReadonlySet<string> = new Set(
  SELF_JOURNALING_CLONE_TOOLS.map((name) => qualifiedToolName(name)),
);

// 名簿に無い道具は false（日誌に残す側）へ倒す: 記録が重複するほうが静かに消えるより軽いため
export function cloneToolJournalsItself(tool: string): boolean {
  return SELF_JOURNALING_CLONE_TOOL_NAMES.has(tool);
}

// 迷ったら true（秘密を運ぶ側）へ倒す: false の誤りは鍵が日誌と要約に写って取り返しが付かないため
const SELF_JOURNALING_TOOL_CARRIES_SECRETS: Record<SelfJournalingCloneTool, boolean> = {
  memory_write: false,
  memory_append: false,
  memory_delete: false,
  memory_frontmatter_set: false,
  memory_section_move: false,
  journal_write: false,
  ask_human: false,
  request_permission: false,
  approval_withdraw: false,
  daily_report_write: false,
  schedule_create: false,
  schedule_remove: false,
  task_add: false,
  task_move: false,
  task_set_status: false,
  task_set_status_many: false,
  task_keep: false,
  task_say: false,
  inbox_remove_many: false,
  profile_write: true,
  profile_remove: false,
  practice_write: false,
  practice_remove: false,
  manager_start: false,
  manager_send: false,
  manager_stop: false,
  archive_remove: false,
  archive_remove_many: false,
  // 名前・種類・大きさ・sha256 だけを書く（中身は書かない。資格のファイルはそもそも置き場へ入れない）
  file_delete: false,
  github_observation_record: false,
};

const SECRET_BEARING_CLONE_TOOL_NAMES: ReadonlySet<string> = new Set(
  (Object.keys(SELF_JOURNALING_TOOL_CARRIES_SECRETS) as SelfJournalingCloneTool[])
    .filter((name) => SELF_JOURNALING_TOOL_CARRIES_SECRETS[name])
    .map((name) => qualifiedToolName(name)),
);

export function cloneToolCarriesSecrets(tool: string): boolean {
  return SECRET_BEARING_CLONE_TOOL_NAMES.has(tool);
}

// 定数は `task-set-status-many.ts` に在る。外へ出していた名前はここから変えない
export { CLOSE_MANY_LIMIT_MAX, CLOSE_MANY_JOURNAL_ID_CHARS };
import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';

export { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX };

// `task-set-status-many.ts` から使うため `chunk-ids.ts` へ移した（`tools.ts` を import すると循環する）。外へ出す名前はここから変えない
export { chunkIdsByChars };

/**
 * ここへ組み込みツールを書き足さない: `allowedTools` は確認を省く側の一覧で、使える道具の一覧ではないため
 *
 * [sdk-verbatim Options.allowedTools]
 * > To restrict which tools are available, use the `tools` option instead.
 */
export const CLONE_ALLOWED_TOOLS = CLONE_TOOL_NAMES.map(qualifiedToolName);

// 断り文の部品は `tool-arg-checks.ts` へ切り出してある（道具と HTTP が同じ関数を共有するため）。既存の import 元（この文書）を変えないよう、書式の関数だけここから再公開する
export { formatIntRangeJa, formatStringLengthJa, formatArrayLengthJa };

export function createCloneTools(context: ToolContext) {
  const { stores } = context;
  // ここで1回だけ解決しない: `memoryCause` はターンごとに変わりうるため、道具ハンドラの中でその都度呼ぶ
  // 倒れ先を作らない: 既定へ倒すと日誌の `cause` が嘘になるため落とす。届かなかった値そのものは書かない: 記憶の本文が例外メッセージへ漏れるため
  if (typeof context.memoryCause !== 'function') {
    throw new Error(
      'memoryCause が届いていない。ToolContext を組む側で明示すること' +
        '（既定値へ倒すと、呼び手が名乗らなかったことを「蒸留の走行だった」として' +
        '日誌に記録することになる）。',
    );
  }
  const memoryCause = context.memoryCause;
  // `conversationId` も倒れ先を作らない: 関数が無いことと `undefined` を返すことは別で、落とすのは前者だけ
  if (typeof context.conversationId !== 'function') {
    throw new Error(
      'conversationId が届いていない。ToolContext を組む側で明示すること' +
        '（既定値へ倒すと、ask_human が積む承認が会話 id を持てなくなり、' +
        '承認への回答を受けたターンのクローンの返答が会話に紐づかなくなる）。',
    );
  }
  const getConversationId = context.conversationId;
  const getWorkConversationId = context.workConversationId ?? getConversationId;

  const shared: CloneToolsShared = {
    stores,
    memoryCause,
    getConversationId,
    getWorkConversationId,
  };

  return [
    ...memoryTools(context, shared),
    ...journalTools(context, shared),
    ...approvalTools(context, shared),
    ...usageTools(context, shared),
    ...scheduleTools(context, shared),
    ...taskTools(context, shared),
    ...profileTools(context, shared),
    ...practiceTools(context, shared),
    ...selfTools(context, shared),
    ...managerTools(context, shared),
    ...attachTools(context, shared),
    ...opsTools(context, shared),
  ];
}

export function createCloneMcpServer(context: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のクローン自身の道具。記憶（人間がいつでも読み書きする Markdown）、' +
      '日誌（追記専用）、人間への確認、継続中の依頼（時間起点の仕込み）、' +
      '実行環境プロファイル（`.zprofile` 相当）、自分自身（alteroid）の正典と実行時の状態、' +
      'マネージャーへの委譲。',
    tools: withToolPhases(createCloneTools(context)),
  });
}

/**
 * ループの停止の見張り（#4485）に、どの自作ツールを処理していたかを残す。自作ツールはデーモンと同じプロセスで走るので、
 * 中の同期処理はループを塞ぐ。入口と出口の2つを打ち、止まった窓の印でどちらの間かを読めるようにする。
 */
export function withToolPhases<
  T extends { name: string; handler: (args: never, extra: unknown) => Promise<unknown> },
>(tools: readonly T[]): T[] {
  return tools.map((definition) => {
    const handler = (async (args: never, extra: unknown) => {
      notePhase(`clone-tool:${definition.name}`);
      try {
        return await definition.handler(args, extra);
      } finally {
        notePhase(`clone-tool-done:${definition.name}`);
      }
    }) as T['handler'];
    return { ...definition, handler };
  });
}
