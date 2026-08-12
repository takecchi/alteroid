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
 */
/**
 * 鍵が要るデーモンなら、CLI も名乗る。
 *
 * **鍵を置いた瞬間に CLI が使えなくなる、をやらない。** 守るのは外から叩かれる
 * ことであって、持ち主が自分の道具を使えなくなることではない（それは能力の
 * 削除になる — north_star 禁止1）。
 */
function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.ALTEROID_API_TOKEN?.split(',')[0]?.trim();
  if (token === undefined || token.length === 0) return {};
  return { authorization: `Bearer ${token}` };
}

export function createClient(base: string, env: NodeJS.ProcessEnv = process.env) {
  return hc<AppType>(base, {
    headers: { 'content-type': 'application/json', ...authHeaders(env) },
  });
}

export type DaemonClient = ReturnType<typeof createClient>;
