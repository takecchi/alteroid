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

/**
 * `window.matchMedia` も jsdom には無い。**`useIsMobile`（`useSyncExternalStore` で
 * `matchMedia('(max-width: 767px)')` を見る）を通る画面を描くと、無いままでは
 * `window.matchMedia is not a function` で落ちる。** `AuthedShell` を描く既存・将来の
 * テストを守るため、`scrollIntoView` と同じ方針（製品側を `?.()` で濁さない・
 * 試験環境の都合はここで埋める）で、**module のトップレベルで無条件に**埋める。
 * 既定は広い画面（`matches: false` 側）にしてある — 狭い画面のテストだけが
 * 下の `setViewportWidth` を呼べばよい。
 *
 * 対応するのは本アプリが使う `(max-width: Npx)` / `(min-width: Npx)` の2つだけ。
 * それ以外の書き方が来たら**黙って `false` を返さず投げる** — 静かに素通りさせると、
 * 対応していないクエリを使うテストが「通ってしまうのに実物は動かない」状態を作る。
 */

/** 既定の幅（広い画面）。狭い画面を試したテストはここへ戻す。 */
export const DEFAULT_VIEWPORT_WIDTH = 1280;
let viewportWidth = DEFAULT_VIEWPORT_WIDTH;
/**
 * `matchMedia(...).addEventListener('change', ...)` で登録された分。
 *
 * **どのクエリのものかを一緒に覚えておく。** 配る `change` の `matches` を
 * 本物と同じ値にするために要る。全員に同じ値を配る形にすると、いまは
 * 誰も event の中身を読んでいないので通ってしまい、読む相手が現れた日に
 * 「試験の足場だけが嘘をついている」状態になる。
 */
type MediaChangeListener = (event: MediaQueryListEvent) => void;

const mediaChangeListeners = new Set<{ query: string; listener: MediaChangeListener }>();

function evaluateMediaQuery(query: string): boolean {
  const max = /^\(max-width:\s*(\d+)px\)$/.exec(query);
  if (max !== null) return viewportWidth <= Number(max[1]);
  const min = /^\(min-width:\s*(\d+)px\)$/.exec(query);
  if (min !== null) return viewportWidth >= Number(min[1]);
  throw new Error(`test-support: 対応していない matchMedia クエリ: ${query}`);
}

function createMediaQueryList(query: string): MediaQueryList {
  return {
    get matches() {
      return evaluateMediaQuery(query);
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: MediaChangeListener) => {
      if (type !== 'change') return;
      mediaChangeListeners.add({ query, listener });
    },
    removeEventListener: (type: string, listener: MediaChangeListener) => {
      if (type !== 'change') return;
      for (const entry of mediaChangeListeners) {
        if (entry.query === query && entry.listener === listener)
          mediaChangeListeners.delete(entry);
      }
    },
    dispatchEvent: () => true,
    // 使っていない旧 API。呼ばれたら気づけるよう例外にする。
    addListener: () => {
      throw new Error('test-support: matchMedia の旧 API（addListener）は埋めていない');
    },
    removeListener: () => {
      throw new Error('test-support: matchMedia の旧 API（removeListener）は埋めていない');
    },
  } as MediaQueryList;
}

if (typeof window !== 'undefined') {
  window.matchMedia = ((query: string) => createMediaQueryList(query)) as typeof window.matchMedia;
}

/**
 * 幅を変えて、以後の `matchMedia` をその幅で評価させる。
 *
 * **登録済みのリスナーへ `change` を配る。** `useIsMobile` は
 * `useSyncExternalStore` で購読しているので、配らないと再評価が走らず
 * 「回転しても（幅が変わっても）追いつく」ことを試験できない。
 *
 * **後始末はテスト側の責務。** このモジュールはテストをまたいで状態
 * （`viewportWidth`）を持ち越すので、狭い画面にしたテストは `afterEach` で
 * `setViewportWidth(DEFAULT_VIEWPORT_WIDTH)` を呼んで戻すこと。専用の reset
 * 関数は用意していない — 「既定へ戻すのに使う値」と「テストが試したい値」を
 * 同じ1つの関数で表せるので、2本目の口を増やさない。
 */
export function setViewportWidth(width: number): void {
  viewportWidth = width;
  for (const { query, listener } of mediaChangeListeners) {
    // 本物と同じく、そのクエリを新しい幅で評価した結果を載せる。
    listener({ matches: evaluateMediaQuery(query), media: query } as MediaQueryListEvent);
  }
}

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
   */
  entries: { url: string; authorization: string | null }[];
  /** 応答の仕方を差し替える（接続先を直したあとの挙動を作るため）。 */
  setRoute(route: Route): void;
}

/** `globalThis.fetch` を差し替える。後片付けは呼ぶ側（`afterEach`）。 */
export function stubFetch(initial: Route): FetchStub {
  const calls: string[] = [];
  const entries: { url: string; authorization: string | null }[] = [];
  let route = initial;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    // `Request` で来ることも、素の init で来ることもある（SSE は後者）。
    const headers =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    entries.push({ url, authorization: headers.get('authorization') });
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
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApiProvider>{children}</ApiProvider>
    </SWRConfig>
  );
}
