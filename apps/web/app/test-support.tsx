
import { waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { Providers as SwrProviders } from '@alteroid/swr/test-support';

import { WebDisplayTextProvider } from '~/lib/display-text';

export * from '@alteroid/swr/test-support';

// 桁数を決め打ちしない: formatUsd は $1 を境に小数 4 桁と 2 桁を使い分け、桁で書くとどちらか片方の側を見落とすため
const MONEY_TEXT = /\$[\d,]+(?:\.\d+)?/g;

// 「$0.00 が無いこと」で測らない: formatUsd(0) は "$0.0000" で "$0.00" という全文は原理的に出ず、toBeNull() が入力が何であっても真になるため
// 件数で測らず集合で測る: 同じ金額は軸ごとに何度も描かれ、件数は画面の作りが変わるだけで動くため
export function renderedMoneyTexts(): Set<string> {
  return new Set(document.body.textContent?.match(MONEY_TEXT) ?? []);
}

// 製品側を ?.() で濁さない: 本物のブラウザでは必ずあり、無いのは試験環境の都合のため
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => undefined;
}

if (
  typeof HTMLDialogElement !== 'undefined' &&
  HTMLDialogElement.prototype.showModal === undefined
) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
}
if (typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype.close === undefined) {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement): void {
    this.removeAttribute('open');
  };
}

// コールバックを呼ばない no-op のままにする: jsdom は本物のレイアウトを持たず、virtua は offsetParent が非 null の要素だけを扱うので、実寸を捏造しても素通りされるため
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}

// 対応していないクエリは黙って false を返さず投げる: 静かに素通りさせると、通ってしまうのに実物は動かない状態を作るため

export const DEFAULT_VIEWPORT_WIDTH = 1280;
let viewportWidth = DEFAULT_VIEWPORT_WIDTH;
// どのクエリのものかを一緒に覚える: 全員に同じ値を配る形にすると、読む相手が現れた日に試験の足場だけが嘘をついている状態になるため
type MediaChangeListener = (event: MediaQueryListEvent) => void;

const mediaChangeListeners = new Set<{ query: string; listener: MediaChangeListener }>();

const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';
let touchOnly = false;

function evaluateMediaQuery(query: string): boolean {
  if (query === TOUCH_ONLY_QUERY) return touchOnly;
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
    // 旧 API は例外にする: 呼ばれたら気づけるため
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

// 登録済みのリスナーへ change を配る: useIsMobile は useSyncExternalStore で購読しており、配らないと再評価が走らないため
// 専用の reset 関数は用意しない: 「既定へ戻すのに使う値」と「試したい値」を同じ1つの関数で表せるため
export function setViewportWidth(width: number): void {
  viewportWidth = width;
  for (const { query, listener } of mediaChangeListeners) {
    listener({ matches: evaluateMediaQuery(query), media: query } as MediaQueryListEvent);
  }
}

export function setTouchOnly(value: boolean): void {
  touchOnly = value;
  for (const { query, listener } of mediaChangeListeners) {
    if (query === TOUCH_ONLY_QUERY) {
      listener({ matches: touchOnly, media: query } as MediaQueryListEvent);
    }
  }
}

// 伏せ字のテストは必ずこれを通す: 包み忘れると ui の部品は伏せずに出るため
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SwrProviders>
      <WebDisplayTextProvider>{children}</WebDisplayTextProvider>
    </SwrProviders>
  );
}

export function queryShownConversation(conversationId: string): Element | null {
  return document.querySelector(`header[data-conversation-id="${conversationId}"]`);
}

export async function findShownConversation(conversationId: string): Promise<Element> {
  return waitFor(() => {
    const element = queryShownConversation(conversationId);
    if (element === null) throw new Error(`会話 ${conversationId} の見出しが出ていない`);
    return element;
  });
}

// delayMs（時計）で「前の描画が済んだ後」を作らない: open の直後に別のフレームを時計で流すと、2つの描画を1本の findBy（既定1000ms）の中でこなすことになり、遅い実行環境で予算を食うため
export function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function untilOpenSettled(
  router: { state: { location: { pathname: string } } },
  conversationId: string,
): Promise<void> {
  await waitFor(() => {
    const actual = router.state.location.pathname;
    if (actual !== `/chat/${conversationId}`) {
      throw new Error(`URL がまだ新しい会話へ付け替わっていない: ${actual}`);
    }
  });
}

export function TestDataRouter({
  children,
  onRouter,
}: {
  children: ReactNode;
  onRouter?: (router: ReturnType<typeof createMemoryRouter>) => void;
}) {
  const [router] = useState(() => {
    const created = createMemoryRouter(
      [
        { path: '/', element: children },
        { path: '/elsewhere', element: <p>別の画面</p> },
      ],
      { initialEntries: ['/'] },
    );
    onRouter?.(created);
    return created;
  });
  return <RouterProvider router={router} />;
}
