import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLONE_TOOLS_TRANSPORT_ENV_KEY = 'ALTEROID_CLONE_TOOLS_TRANSPORT';

export const CLONE_TOOLS_TRANSPORTS = ['sdk', 'stdio'] as const;

export type CloneToolsTransport = (typeof CLONE_TOOLS_TRANSPORTS)[number];

export const DEFAULT_CLONE_TOOLS_TRANSPORT: CloneToolsTransport = 'sdk';

export function resolveCloneToolsTransport(
  env: NodeJS.ProcessEnv = process.env,
): CloneToolsTransport {
  const given = env[CLONE_TOOLS_TRANSPORT_ENV_KEY]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_CLONE_TOOLS_TRANSPORT;
  if ((CLONE_TOOLS_TRANSPORTS as readonly string[]).includes(given)) {
    return given as CloneToolsTransport;
  }
  // 未知の値を黙って sdk / stdio へ倒さない: 綴り間違いに気づけないまま経路が変わる、または変わらないため
  throw new Error(
    `${CLONE_TOOLS_TRANSPORT_ENV_KEY} の値が不正: ${given}` +
      `（使えるのは ${CLONE_TOOLS_TRANSPORTS.join(' / ')}。既定は ${DEFAULT_CLONE_TOOLS_TRANSPORT}）`,
  );
}

export function resolveCloneToolsTransportFor(
  required: CloneToolsTransport | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CloneToolsTransport {
  return required ?? resolveCloneToolsTransport(env);
}

export const DEFAULT_CLONE_TOOL_RELAY_SOCKET_DIR = '/run/alteroid/clone-tool-relay';

export const CLONE_TOOL_RELAY_SOCKET_FILENAME = 'relay.sock';

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
