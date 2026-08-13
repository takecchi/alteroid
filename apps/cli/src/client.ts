import type { AppType } from '@alteroid/daemon';
import { hc } from 'hono/client';

import { authHeaders } from './auth.js';

/**
 * デーモンへの型付きクライアント（hono/client）。
 * 型だけを共有し、core の実装は持ち込まない。
 *
 * `content-type` を常に付けるのは、デーモン側が本文の無い POST（会話終了・定期
 * ジョブの手動起動・停止）に `application/json` を要求するからである。ブラウザの
 * 単純リクエストで他人がクローンのターンを起こせないようにするための境界であり、
 * 意図した呼び出し側であるこのクライアントは、そこを素通りできる必要がある。
 */
export function createClient(base: string, env: NodeJS.ProcessEnv = process.env) {
  return hc<AppType>(base, {
    headers: { 'content-type': 'application/json', ...authHeaders(env) },
  });
}

export type DaemonClient = ReturnType<typeof createClient>;
