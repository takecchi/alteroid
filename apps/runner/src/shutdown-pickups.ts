// 畳みの間も口を開けておき、デーモンが取りに来る要求だけを通す（#4699）。
// 預けた生ログ・出し箱の退避先・rescue の退避先は、SSE で参照を流したあとデーモンが HTTP で取りに来る。先に口を閉じると取りに来られず、器の入れ替えのたびに失われる。

const PICKUP_PATH = /^\/managers\/[^/]+\/(?:archive|outbox|rescue-files)\/[^/]+$/;

/** 畳みの間も通す要求か: 預けた生ログ・出し箱の退避先・rescue の退避先の取り出し（GET）と、取り終えた後の削除（DELETE）だけ。 */
export function isPickupRequest(method: string, pathname: string): boolean {
  return (method === 'GET' || method === 'DELETE') && PICKUP_PATH.test(pathname);
}

/** `@hono/node-server` が fetch に渡す Node の要求のうち、ここで使う分。 */
interface GateEnv {
  readonly incoming: { readonly socket: { destroy(): unknown } };
}

/**
 * 畳みの間は、取りに来る要求以外を通さない。
 * 応答を返さずに繋ぎを壊す（503 を返さない）: 口を閉じていた今までと同じく「繋がらない」に見せ、畳み中の runner へ start・resume・send が入らないようにするため。
 */
export function gateDuringShutdown(
  fetch: (request: Request, env: GateEnv) => Response | Promise<Response>,
  stopping: () => boolean,
): (request: Request, env: GateEnv) => Response | Promise<Response> {
  return (request, env) => {
    if (stopping() && !isPickupRequest(request.method, new URL(request.url).pathname)) {
      env.incoming.socket.destroy();
      return new Response(null, { status: 503 });
    }
    return fetch(request, env);
  };
}

const PICKUP_POLL_INTERVAL_MS = 50;

/**
 * 預けた物が取られ切るまで待つ。デーモンが繋がっていない（`subscribed` が偽）なら待たない: 取りに来る相手が居ないため。
 * 期限は絶対の時刻（`deadlineAt`）: 畳みにかかった時間の分だけ短くし、forced exit より先に終えるため。投げない（残りは呼び手が報告する）。
 */
export async function waitForPickups(options: {
  pending: () => number;
  subscribed: () => boolean;
  deadlineAt: number;
  now?: () => number;
  pollMs?: number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  while (options.pending() > 0 && options.subscribed() && now() < options.deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? PICKUP_POLL_INTERVAL_MS));
  }
  return options.pending();
}
