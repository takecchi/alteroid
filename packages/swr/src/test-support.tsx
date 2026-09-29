/**
 * 通信の層（`ApiProvider` と SWR の hooks）を試験するための足場。
 *
 * **`fetch` を差し替えるところまでで止めている。** api-client（SSE の解釈を含む）は
 * 本物を通したいので、偽物にするのは外の世界との境目1枚だけにする。
 *
 * 画面側の足場（jsdom に無い口を埋めるもの・金額の網）は
 * `apps/web/app/test-support.tsx` に在り、そちらがこのファイルを丸ごと
 * 再エクスポートしている——画面のテストは今までどおり `~/test-support` だけを
 * 見ればよい。
 */
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

import { ApiProvider } from './api';

/**
 * 1つの経路に対する応答。`undefined` を返すと「その URL は知らない」。
 *
 * `Promise` を返せるようにしてあるのは、**まだ返事が来ていない要求**を作るため
 * （切り替えた後に古い相手の応答が届く、という順番を試験できる）。
 */
export type Route = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response> | undefined;

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
 *
 * **「別の経路が終わってから届かせる」を `delayMs` で作らないこと。** それは
 * 時計への賭けであって順序の指定ではない — 待つ相手（画面の往復・SWR の再取得）
 * が遅い実行環境では追い越され、テストが**筋書きの前で**落ちる（実際に CI で
 * 2本落ちた）。順序が要るときは枠ごとの `after` に待つものを渡す。
 */
export function sse(
  frames: {
    event: string;
    data: unknown;
    /**
     * この枠を流す前に待つもの。**テスト側が解決する**ので、届く順序が実行環境
     * の速さから切り離される（`delayMs` と違って追い越されない）。
     *
     * 中断（`signal`）が来たらこの待ちも打ち切る — 解決されないまま
     * `keepOpen` の枠を待ち続けると、後片付けの済んだテストの中に居残る。
     */
    after?: PromiseLike<unknown>;
  }[],
  options: {
    delayMs?: number;
    /**
     * 流し終えても閉じない。**まだ考えているクローン**を再現するために要る
     * （人間が受信をやめる場面は、終わっていないストリームでしか試せない）。
     */
    keepOpen?: boolean;
    /**
     * 中断の合図。**本物の `fetch` と同じように、中断されたら本文を打ち切る。**
     * 渡さないと、受信をやめても読み手が待ち続け、実際とは違う筋書きになる。
     */
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

      // 中断されたことを `await` の相手にできる形で持つ（`after` の待ちを
      // 打ち切るために要る）。中断が来なければ解決しない。
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
  /** 実際に叩かれた URL（順番どおり）。 */
  calls: string[];
  /**
   * 叩かれた記録。**資格情報を付けているかを確かめる**ために header も控える
   * （鍵を捨てたはずなのに付け続けていないか、は URL だけでは見えない）。
   *
   * **`request` は本物の `Request`（来たときだけ）。** 本文（`supersedes` の
   * ような、送った JSON の中身）を確かめたいテストは `entry.request?.clone()
   * .json()` で読む——`clone()` するのは、この後さらに読む相手（本物の
   * fetch 実装は無いのでここでは無い）がいても本文を取り合わないため。
   * `openapi-fetch` は常に `Request` を組み立てて `fetch` へ渡す
   * （`openapi-fetch@0.17.0` の `baseFetch` の呼び出し箇所）ので、この
   * リポジトリの経路（`ApiProvider` 経由）ではほぼ常に `Request` になるが、
   * 素の `init` で来る呼び方（SSE 側の手組みの `fetch` 呼び出し）もあるので
   * 型は `undefined` を許す。
   */
  entries: { url: string; authorization: string | null; request: Request | undefined }[];
  /** 応答の仕方を差し替える（接続先を直したあとの挙動を作るため）。 */
  setRoute(route: Route): void;
}

/** `globalThis.fetch` を差し替える。後片付けは呼ぶ側（`afterEach`）。 */
export function stubFetch(initial: Route): FetchStub {
  const calls: string[] = [];
  const entries: FetchStub['entries'] = [];
  let route = initial;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    // `Request` で来ることも、素の init で来ることもある（SSE は後者）。
    const headers =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    entries.push({
      url,
      authorization: headers.get('authorization'),
      request: input instanceof Request ? input : undefined,
    });
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
    entries,
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
 *
 * **`focusThrottleInterval: 0`**（issue #2138 の2 の試験で足した）——既定値
 * （5000ms）のままだと、マウント直後に `window.dispatchEvent(new
 * Event('focus'))` で `revalidateOnFocus` を起こそうとしても、SWR 内部の
 * スロットル（`nextFocusRevalidatedAt = マウント時刻 + focusThrottleInterval`）
 * に阻まれて再取得が起きない。**一度取れた後に取り直しが失敗する**（`data`
 * が残ったまま `error` が立つ）状態を試験で作るには、この既定を0にして
 * フォーカスのたびに再取得できるようにする必要がある——`dedupingInterval: 0`
 * と同じ理由（試験で何かを待つ理由を無くす）。
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>
      <ApiProvider>{children}</ApiProvider>
    </SWRConfig>
  );
}
