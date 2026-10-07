import type { AgentCloneDriver } from './agent-clone-session.js';
import type { AgentProviderId } from './agent-ports.js';
import { CodexCloneDriver } from './codex-clone-driver.js';

export function cloneDriverFor(id: AgentProviderId): AgentCloneDriver | undefined {
  return id === 'codex' ? new CodexCloneDriver() : undefined;
}
