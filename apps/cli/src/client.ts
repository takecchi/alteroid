import type { AppType } from '@alteroid/daemon';
import { hc } from 'hono/client';

/**
 * デーモンへの型付きクライアント（hono/client）。
 * 型だけを共有し、core の実装は持ち込まない。
 *
 * `content-type` を常に付けるのは、デーモン側が本文の無い POST（会話終了・定期
 * ジョブの手動起動・停止）に `application/json` を要求するからである。ブラウザの
 * 単純リクエストで他人がクローンのターンを起こせないようにするための境界であり、
 * 意図した呼び出し側であるこのクライアントは、そこを素通りできる必要がある。
 *
 * `headers` には認証（`authorization: Bearer …`）が入る。手元のデーモンなら
 * 実行環境の持ち主のトークン、別のデーモンなら `alteroid login` で得た
 * アクセストークンで、どちらを出すかは `target.ts` が決める。
 */
export function createClient(base: string, headers: Record<string, string> = {}) {
  return hc<AppType>(base, { headers: { 'content-type': 'application/json', ...headers } });
}

export type DaemonClient = ReturnType<typeof createClient>;
