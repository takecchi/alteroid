import type { AppType } from '@alteroid/daemon';
import { hc } from 'hono/client';

/**
 * デーモンへの型付きクライアント（hono/client）。
 * 型だけを共有し、core の実装は持ち込まない。
 */
export function createClient(base: string) {
  return hc<AppType>(base);
}

export type DaemonClient = ReturnType<typeof createClient>;
