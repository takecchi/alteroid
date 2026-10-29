import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveCloneToolRelayChildEntry(callerModuleUrl: string): string {
  // 1本の相対パスにしない: 本番はバンドルで dist/ に並び、vitest は src/ から読むため
  const candidates = [
    new URL('./clone-tool-relay-child.js', callerModuleUrl),
    new URL('../dist/clone-tool-relay-child.js', callerModuleUrl),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(
    'clone-tool-relay-child.js が見つからない' +
      `（試した場所: ${candidates.map((candidate) => fileURLToPath(candidate)).join(', ')}）。` +
      '`pnpm build`（`pnpm --filter @alteroid/core build`）を先に走らせること。',
  );
}
