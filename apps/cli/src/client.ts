import type { AppType } from '@alteroid/daemon';
import { hc } from 'hono/client';

export function createClient(
  base: string,
  headers: Record<string, string> = {},
  fetchImpl?: typeof fetch,
) {
  return hc<AppType>(base, {
    // content-type を常に付ける: デーモンが本文の無い POST にも `application/json` を要求するため
    headers: { 'content-type': 'application/json', ...headers },
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

export type DaemonClient = ReturnType<typeof createClient>;
