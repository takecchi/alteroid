import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * CLI は core を埋め込まない（architecture.md「脳は1インスタンス」）。
 * デーモンの居場所を知るために必要な最小限のパス解決だけをここに持つ。
 */
export function alteroidRoot(): string {
  const fromEnv = process.env.ALTEROID_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.alteroid');
}

export function stateDir(): string {
  return join(alteroidRoot(), 'state');
}
