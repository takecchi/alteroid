/**
 * 画面へ出す文字列に掛ける「表示用の変換」を、上の層から受け取る口（issue #2600）。
 *
 * `packages/ui` は見た目の層で、伏せ字そのもの（`@alteroid/core` / `@alteroid/logic`）を知らない。
 * 伏せる関数は apps/web の root が {@link DisplayTextProvider} で渡す。
 *
 * - `body` —— 人や agent が書いた自由文（会話・承認待ち・日誌の本文と生の JSON）
 * - `error` —— 例外・SSE の error の文
 *
 * **既定は恒等である。** 包み忘れると伏せずに出る（漏れる向き）ので、apps/web の root が
 * 包んでいることは `apps/web/app/root.redact.test.tsx` が固定している。
 * データ（props・編集の下書き・回答欄の値）は書き換えず、描画の直前だけで通す。
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface DisplayText {
  body: (text: string) => string;
  error: (text: string) => string;
}

const identity = (text: string): string => text;

const DEFAULT_DISPLAY_TEXT: DisplayText = { body: identity, error: identity };

const DisplayTextContext = createContext<DisplayText>(DEFAULT_DISPLAY_TEXT);

export function DisplayTextProvider({
  value,
  children,
}: {
  value: DisplayText;
  children: ReactNode;
}) {
  return <DisplayTextContext.Provider value={value}>{children}</DisplayTextContext.Provider>;
}

export function useDisplayText(): DisplayText {
  return useContext(DisplayTextContext);
}
