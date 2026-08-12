import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

/**
 * WebUI の器。
 *
 * ここに脳は無いどころか、API も無い。**デーモンの HTTP API をそのまま前へ通す
 * だけ**である（`/api/*` → デーモン）。画面が使えることと CLI が使えることを
 * 別々に実装すると、必ず片方が遅れて能力の差になる（north_star 禁止1）。増やす
 * のは器であって、機能ではない。
 *
 * 同一オリジンで配信するのはブラウザの都合である。デーモンは CORS ヘッダを一切
 * 返さない＝別オリジンの画面からは読めない。ここで CORS を開けて回るのではなく、
 * 画面とプロキシを同じオリジンに置いて、境界の形を変えずに届かせる。
 */
export interface WebAppOptions {
  /** デーモンの接続先（例: `http://127.0.0.1:4517`）。 */
  daemonOrigin: string;
  /** 画面の静的ファイル（index.html / styles.css / main.js）の置き場。 */
  assetsDir: string;
  /** 差し替え可能な fetch。テストが偽のデーモンを立てるためだけにある。 */
  fetchImpl?: typeof fetch;
}

interface Asset {
  file: string;
  type: string;
}

/** 配信するのはこれだけ。パスは列挙であり、リクエストからは組み立てない。 */
const ASSETS: Record<string, Asset> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/main.js': { file: 'main.js', type: 'text/javascript; charset=utf-8' },
  '/main.js.map': { file: 'main.js.map', type: 'application/json; charset=utf-8' },
};

/**
 * デーモンへ渡すリクエストヘッダ。
 *
 * **`content-type` を書き換えないこと。** デーモンは本文の無い POST に
 * `application/json` を要求していて、それが「ブラウザの単純リクエストで他人が
 * クローンのターンを起こせない」という境界そのものである（apps/daemon/src/app.ts
 * の `deliberateClient`）。ここで気を利かせて付け足すと、その境界がこのプロキシの
 * 内側で消える。**画面が名乗ったものをそのまま通す。**
 */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept'] as const;

/** デーモンから返すレスポンスヘッダ。`content-length` は通さない（本文を中継し直すため）。 */
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-disposition'] as const;

export function createWebApp(options: WebAppOptions): Hono {
  const { daemonOrigin, assetsDir } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const app = new Hono();

  app.all('/api/*', async (c) => {
    const url = new URL(c.req.url);
    // `/api/managers/x/transcript?limit=1` → `/managers/x/transcript?limit=1`
    const target = `${daemonOrigin}${url.pathname.slice('/api'.length)}${url.search}`;

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }

    // 本文は小さい JSON しか来ない（流れるのは応答側の SSE）。読み切ってから
    // 渡すことで、undici の duplex ストリームを持ち出さずに済ませる。
    let body: ArrayBuffer | undefined;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const raw = await c.req.arrayBuffer();
      if (raw.byteLength > 0) body = raw;
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: c.req.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error: unknown) {
      return c.json({ error: `デーモンに繋がりません: ${String(error)}` }, 502);
    }

    const responseHeaders = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    // SSE（`POST /chat`）は本文をそのまま繋ぐ。ここで読み切ると、クローンの
    // 返答が終わるまで画面に一文字も出なくなる。
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  });

  for (const [path, asset] of Object.entries(ASSETS)) {
    app.get(path, async (c) => {
      let content: string;
      try {
        content = await readFile(join(assetsDir, asset.file), 'utf8');
      } catch {
        return c.text(`${asset.file} が見つかりません（pnpm build は済んでいますか）`, 404);
      }
      // 作り直したものが古いまま見えるほうが害が大きいので握らせない。
      return c.body(content, 200, {
        'content-type': asset.type,
        'cache-control': 'no-store',
      });
    });
  }

  return app;
}
