/**
 * 画面の回帰テスト用の足場。
 *
 * ここが持つのは jsdom に無い口を埋めるもの（`scrollIntoView` / `<dialog>` /
 * `ResizeObserver` / `matchMedia`）と、画面に描かれた金額の網である。
 * `fetch` の差し替えは下の再エクスポートの先（`@alteroid/swr/test-support`）が持つ。
 */

/*
 * 通信の層の足場（`stubFetch` / `sse` / `json` / `Providers` など）は
 * `@alteroid/swr` の側に在る（その層のテストも同じものを使うため）。
 * 画面のテストは今までどおりここから import すればよい。
 */
import { waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { Providers as SwrProviders } from '@alteroid/swr/test-support';

import { WebDisplayTextProvider } from '~/lib/display-text';

export * from '@alteroid/swr/test-support';

/**
 * 金額の字面（`$` ＋ 数字）。**桁数を決め打ちしない。**
 *
 * `formatUsd` は `$1` を境に小数 4 桁と 2 桁を使い分けるので、桁で書くと
 * **どちらか片方の側を見落とす**（この網がまさにそれで壊れていた。下の doc）。
 */
const MONEY_TEXT = /\$[\d,]+(?:\.\d+)?/g;

/**
 * いま画面に描かれている**金額の全文**を、重複を畳んだ集合で返す。
 *
 * ## ⭐ なぜ「`$0.00` が無いこと」で測ってはいけないか（#935）
 *
 * `formatUsd`（`@alteroid/core/usage`）は `$1` 未満を**小数4桁**で書くので、
 * `formatUsd(0)` は `"$0.0000"` である。**`"$0.00"` という全文は原理的に出ない。**
 * ⟹ `queryByText('$0.00')`（完全一致）は何があっても 0 件を返し、
 * `toBeNull()` は**入力が何であっても真**になる。
 * ⛔ **「金額を出さない」を、出ないことが分かっている1つの字面で測らないこと。**
 *
 * ## この形が測っているもの
 *
 * 要素の構造ではなく `document.body` の**本文全体**へ当てる。⟹ 金額が
 * `<p>` 単独で出ても、文の途中（`合計 $0.0000`）に紛れ込んでも同じように拾う
 * （要素単位の完全一致だと、囲みの `div` に他の文字が混ざった瞬間に取り逃がす）。
 *
 * ## ⛔ 件数で測らないこと。集合で測ること
 *
 * 同じ金額は軸ごとに何度も描かれるので、**件数は画面の作りが変わるだけで動く。**
 * 集合なら「どの金額が出ているか」だけが残る:
 *
 * ```ts
 * expect(renderedMoneyTexts()).toEqual(new Set());            // 1つも出さない
 * expect(renderedMoneyTexts()).toEqual(new Set(['$0.0123'])); // これだけ出す
 * ```
 *
 * ⛔ `.size).toBeGreaterThan(0)` のような「入力が1件でもあれば常に真」の形へ
 * 崩さないこと —— それは上の `$0.00` と同じ穴である。
 *
 * ## ⚠️ この網が自分では測れないこと
 *
 * **網が壊れて常に空集合を返すようになっても、陰性対照は緑のままである**
 * （空で緑は、正しい緑と同じ顔をする）。⟹ **金額を出す側のテストでも同じ関数を
 * 使い、集合が空でないことを測ること。** そちらが赤くなることだけが、この網が
 * 生きている証拠である（`usage.test.tsx` / `dashboard.test.tsx` に1本ずつ在る）。
 */
export function renderedMoneyTexts(): Set<string> {
  return new Set(document.body.textContent?.match(MONEY_TEXT) ?? []);
}

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
 * `<dialog>` の `showModal` / `close` も jsdom（30.0.1、2026-09-24 実測）には
 * 無い——呼ぶと `TypeError: ... .showModal is not a function` で例外になる
 * （`d.showModal` が `undefined` のまま、`show` すら生えていない）。
 * `settings.tsx` の `ResetWorkspace` / `ShutdownDaemon` はどちらも
 * `dialogRef.current?.showModal()` で確認ダイアログを開く作りなので、無いまま
 * だと確認ダイアログを開く操作そのものがテストで再現できない。
 *
 * **`open` 属性の反映（IDL 属性としての `open` の読み書き）は jsdom が既に
 * 持っている**（HTML 標準の反映属性の一般実装）。ここで足すのは `showModal`
 * `close` という2つのメソッドだけで、`::backdrop` やフォーカストラップ・
 * `Escape` キーでの自動クローズ・`cancel`/`close` イベント順序までは真似ない
 * ——この画面の試験が要るのは「開いた状態で中身が読めるか」「閉じたら
 * 開いていないか」までなので、そこだけ埋める。
 */
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

/**
 * `ResizeObserver` も jsdom には無い。**`virtua`（日誌画面の仮想スクロール、
 * `routes/journal.tsx`）がマウント時に `new ResizeObserver(...)` を呼ぶため、
 * 無いままでは `ResizeObserver is not a constructor` で描画そのものが例外に
 * なる**（実測、2026-08-23: `<Virtualizer>` を素の jsdom へ `render()` すると
 * この例外が `render()` の呼び出し元まで同期的に伝播する）。
 *
 * ⚠️ **これは「クラッシュを防ぐだけ」の足場であり、実測はしない。** 呼ばれた
 * `observe()` のコールバックを一度も呼ばない no-op である。**理由は
 * `matchMedia` と違って偽装できないから** — jsdom は本物のレイアウトを
 * 持たず、`offsetParent` が常に `null`・`getBoundingClientRect()` が常に
 * ゼロを返す。virtua のコールバック処理は `target.offsetParent` が非 null の
 * 要素だけを扱うので、コールバックを合成して呼んでも（＝実寸を捏造しても）
 * 素通りされる（実験で確認済み: `clientHeight`/`offsetHeight` を固定値で
 * 上書きしても結果は変わらなかった）。**結果として、`virtua` は jsdom では
 * 中身（日誌の行）を1行も描画しない。** 行の中身を `screen.getByText` で
 * アサートするテストは、この足場では書けない — `journal.test.tsx` の冒頭
 * コメントと `.claude/skills/mutation-testing/SKILL.md`「足場が触る対象と、
 * 歯が測る対象が重なる」を参照。**対応していない入力を投げる形（`matchMedia`
 * と同じ作法）はここでは採らない** — `ResizeObserver` に「対応していない
 * クエリ」に相当する分岐が無く、投げる先が無いため。
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
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
 * 画面のテストの描画を包む。`@alteroid/swr/test-support` の `Providers` に、本番の root（`App`）と
 * 同じ `WebDisplayTextProvider` を足したもの（上の `export *` より、この宣言が優先される）。
 * **包み忘れると ui の部品は伏せずに出る**ので、伏せ字のテストは必ずこれを通す。
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SwrProviders>
      <WebDisplayTextProvider>{children}</WebDisplayTextProvider>
    </SwrProviders>
  );
}

/**
 * チャットの見出し（`ChatHeader` の `<header>`）が、いまその会話を見せているか。
 *
 * 見出しは会話 ID を画面の字面として出さない（利用者に意味が無い）。だが「いま
 * どの会話が出ているか」を待つ試験は多いので、`data-conversation-id` を目印にする。
 */
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

/**
 * **次のフレームを流してよい時を、テストが決める**ための門。`sse` の枠の `after` に
 * `promise` を渡し、前提が画面に出たのを見てから `open()` する。
 *
 * **`delayMs`（時計）で「前の描画が済んだ後」を作らないこと。** 新しい会話で `open` の
 * 直後に別のフレームを時計で流すと、画面は `open` が起こす描画（会話 id の確定・URL の
 * 付け替え・履歴と一覧の取得）と次のフレームの描画を、1本の `findBy`（既定1000ms）の中で
 * まとめてこなすことになり、遅い実行環境（全体実行の負荷）で予算を食う（#2900）。
 */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * 新しい会話の `open` を受けた画面が、URL を新しい会話へ付け替えるところまで進んだこと。
 * 付け替えは `open` の処理（`chat.tsx` の `send`）の最後の1手なので、これが見えたら
 * `open` が起こす状態の更新は出し終わっている。
 */
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
