import type { InboxEvent } from './schema.js';

// daemon 側に置かない: core は apps/daemon に依存できないため
export const DAEMON_TOKEN_POOL_REOPENED_SOURCE = 'token-pool';

export const DAEMON_RUNNER_REGISTRY_SOURCE = 'runner-registry';

export const DAEMON_RESERVED_EVENT_SOURCES = [
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  DAEMON_RUNNER_REGISTRY_SOURCE,
] as const;

// 生の完全一致で比べない: `Token-Pool` や全角の綴りがすり抜けるため
export function normalizeEventSource(source: string): string {
  return source.normalize('NFKC').trim().toLowerCase();
}

export function isReservedEventSource(source: string): boolean {
  const normalized = normalizeEventSource(source);
  return DAEMON_RESERVED_EVENT_SOURCES.some((reserved) => reserved === normalized);
}

export function isDaemonSelfNotice(event: InboxEvent): boolean {
  return (
    event.type === 'external' &&
    DAEMON_RESERVED_EVENT_SOURCES.some((reserved) => reserved === event.source)
  );
}

export interface TokenPoolReopenedPayload {
  readonly text: string;
  readonly tokenId: string;
  readonly observedRecovery: boolean;
}

export function tokenPoolReopenedPayload(event: InboxEvent): TokenPoolReopenedPayload | undefined {
  if (event.type !== 'external' || event.source !== DAEMON_TOKEN_POOL_REOPENED_SOURCE) {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { text, tokenId, observedRecovery } = payload as Record<string, unknown>;
  if (
    typeof text !== 'string' ||
    typeof tokenId !== 'string' ||
    typeof observedRecovery !== 'boolean'
  ) {
    return undefined;
  }
  return { text, tokenId, observedRecovery };
}

export function staleObservedRecoveryForBlockedKey(args: {
  observedRecovery: boolean;
  reopenedTokenId: string;
  blockedResetsAt: number | undefined;
  blockedTokenId: string | undefined;
  now?: number;
}): boolean {
  if (!args.observedRecovery) return false;
  if (args.blockedResetsAt === undefined || args.blockedTokenId === undefined) return false;
  const now = args.now ?? Date.now();
  if (now >= args.blockedResetsAt) return false;
  return args.reopenedTokenId === args.blockedTokenId;
}

export function staleObservedRecoveryNoticeEvent(
  event: InboxEvent,
  blockedResetsAt: number | undefined,
  blockedTokenId: string | undefined,
  now?: number,
): boolean {
  const payload = tokenPoolReopenedPayload(event);
  if (payload === undefined) return false;
  return staleObservedRecoveryForBlockedKey({
    observedRecovery: payload.observedRecovery,
    reopenedTokenId: payload.tokenId,
    blockedResetsAt,
    blockedTokenId,
    ...(now === undefined ? {} : { now }),
  });
}
