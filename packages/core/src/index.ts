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
  buildDistillPrompt,
  buildManagerSystemPrompt,
  buildWorkerPrompt,
} from './prompt.js';
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
