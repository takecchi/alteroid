import type { AgentCloneDriver } from './agent-clone-session.js';
import type { AgentProviderId } from './agent-ports.js';
import { CodexCloneDriver } from './codex-clone-driver.js';

/**
 * クローン層の provider id から駆動役を作る（#486 S8）。
 *
 * **`claude` は `undefined` を返す** —— `createClone` が既定の `ClaudeCloneDriver` を組む
 * （既定の経路は1文字も変えない）。`codex` だけ `CodexCloneDriver` を渡す。
 */
export function cloneDriverFor(id: AgentProviderId): AgentCloneDriver | undefined {
  return id === 'codex' ? new CodexCloneDriver() : undefined;
}
