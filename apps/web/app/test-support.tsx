/**
 * 画面の回帰テスト用の足場。
 *
 * **`fetch` を差し替えるところまでで止めている。** api-client（SSE の解釈を含む）は
 * 本物を通したいので、偽物にするのは外の世界との境目1枚だけにする。
 */
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

import { ApiProvider } from '~/lib/api';

/**
 * jsdom に無い口を埋める。
 *
 * `scrollIntoView` はレイアウトを持たない jsdom には実装が無い。**製品側を
 * `?.()` で濁さない** — 本物のブラウザでは必ずあるものなので、無いのは
 * 試験環境の都合であり、その都合は試験環境で埋める。
 */
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => undefined;
}

/** 1つの経路に対する応答。`undefined` を返すと「その URL は知らない」。 */
export type Route = (url: string, init: RequestInit | undefined) => Response | undefined;

/**
 * 試験で使う接続先。
 *
 * **絶対 URL にする。** 既定の同一オリジン（`/api`）は相対 URL で、この実行環境の
 * `Request` は基準 URL を持たないため組み立てられない（ブラウザでは document を
 * 基準に解決される）。相対のまま試すと、経路ごとの挙動ではなく URL の組み立てを
 * 試すことになってしまう。
 */
export const TEST_BASE_URL = 'http://daemon.test';

/** その接続先を保存した状態にする。 */
export function storeTestBaseUrl(url: string = TEST_BASE_URL): void {
  localStorage.setItem('alteroid.apiBaseUrl', url);
}

/** JSON を返す。 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * SSE を返す。`frames` を順に流す。
 *
 * `delayMs` を入れているのは、**受信の途中で起きること**（`open` を受けて URL を
 * 揃える等）を再現するため。1フレームずつ間を空けないと、React が1回の描画で
 * まとめてしまい、途中で作り直しが起きるかどうかを試験できない。
 */
export function sse(frames: { event: string; data: unknown }[], delayMs = 5): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(
          encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export interface FetchStub {
  /** 実際に叩かれた URL（順番どおり）。 */
  calls: string[];
  /** 応答の仕方を差し替える（接続先を直したあとの挙動を作るため）。 */
  setRoute(route: Route): void;
}

/** `globalThis.fetch` を差し替える。後片付けは呼ぶ側（`afterEach`）。 */
export function stubFetch(initial: Route): FetchStub {
  const calls: string[] = [];
  let route = initial;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const response = route(url, init);
    if (response === undefined) {
      // 知らない URL は「繋がらない」。握り潰すと、経路の書き忘れが
      // 空の応答として通ってしまう。
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    return Promise.resolve(response);
  }) as typeof fetch;

  return {
    calls,
    setRoute: (next) => {
      route = next;
    },
  };
}

/**
 * 必要な provider 一式で包む。
 *
 * SWR のキャッシュはテストごとに作り直す（持ち越すと、前のテストの応答が
 * 次のテストで「もう読み込み済み」として出てしまう）。
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApiProvider>{children}</ApiProvider>
    </SWRConfig>
  );
}
