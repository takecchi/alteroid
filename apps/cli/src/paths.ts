import { homedir } from 'node:os';
import { join } from 'node:path';

export function alteroidRoot(): string {
  const fromEnv = process.env.ALTEROID_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.alteroid');
}

export function stateDir(): string {
  return join(alteroidRoot(), 'state');
}
