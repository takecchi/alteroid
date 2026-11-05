import { join } from 'node:path';
import { defaultRoot } from '@alteroid/storage-fs';

export function alteroidRoot(): string {
  return defaultRoot();
}

export function stateDir(): string {
  return join(alteroidRoot(), 'state');
}
