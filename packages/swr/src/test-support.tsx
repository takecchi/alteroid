import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

import { ApiProvider } from './api';

export type Route = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response> | undefined;

// 絶対 URL にする: 相対 URL は、この実行環境の `Request` が基準 URL を持たず組み立てられないため
export const TEST_BASE_URL = 'http://daemon.test';

export function storeTestBaseUrl(url: string = TEST_BASE_URL): void {
  localStorage.setItem('alteroid.apiBaseUrl', url);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 1フレームずつ間を空ける（`delayMs`）: 空けないと React が1回の描画にまとめ、途中の作り直しを試験できない
// 「別の経路が終わってから届かせる」を `delayMs` で作らない: 時計への賭けで、遅い環境では追い越されて筋書きの前で落ちる。順序は枠ごとの `after` で指す
export function sse(
  frames: {
    event: string;
    data: unknown;
    after?: PromiseLike<unknown>;
  }[],
  options: {
    delayMs?: number;
    keepOpen?: boolean;
    signal?: AbortSignal | null;
  } = {},
): Response {
  const { delayMs = 5, keepOpen = false, signal } = options;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = signal?.aborted === true;
      const stop = () => {
        aborted = true;
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // 既に閉じている
        }
      };
      signal?.addEventListener('abort', stop, { once: true });

      // 中断が来たら `after` の待ちも打ち切る: 解決されないまま `keepOpen` の枠を待ち続けると、後片付けの済んだテストに居残るため
      const abortedPromise = new Promise<void>((resolve) => {
        if (signal === null || signal === undefined) return;
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });

      for (const frame of frames) {
        if (frame.after !== undefined) {
          await Promise.race([frame.after, abortedPromise]);
          if (aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (aborted) return;
        controller.enqueue(
          encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`),
        );
      }
      if (!keepOpen && !aborted) controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export interface FetchStub {
  calls: string[];
  entries: { url: string; authorization: string | null; request: Request | undefined }[];
  setRoute(route: Route): void;
}

export function stubFetch(initial: Route): FetchStub {
  const calls: string[] = [];
  const entries: FetchStub['entries'] = [];
  let route = initial;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const headers =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    entries.push({
      url,
      authorization: headers.get('authorization'),
      request: input instanceof Request ? input : undefined,
    });
    const response = route(url, init);
    if (response === undefined) {
      // 知らない URL は「繋がらない」にする: 握り潰すと、経路の書き忘れが空の応答として通るため
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    return Promise.resolve(response);
  }) as typeof fetch;

  return {
    calls,
    entries,
    setRoute: (next) => {
      route = next;
    },
  };
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    // キャッシュはテストごとに作り直す: 持ち越すと、前のテストの応答が「読み込み済み」として出るため
    // `focusThrottleInterval: 0`: 既定のままだとマウント直後の focus で再取得が起きず、取り直しの失敗を試験で作れない
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>
      <ApiProvider>{children}</ApiProvider>
    </SWRConfig>
  );
}
