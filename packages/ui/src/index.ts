/**
 * `@alteroid/ui` —— Web UI の見た目の部品。
 *
 * **API もデーモンも知らない層である。** 通信（`@alteroid/swr`）や画面の
 * ロジック（`@alteroid/logic`）を import しないこと——ここへ引き込むと、見た目を
 * 差し替えるだけの変更が通信の層まで巻き込むようになる。
 *
 * shadcn の素の部品（`Button` / `Sheet`）は名前が `components/ui.tsx` の
 * `Button` と衝突するので、ここからは出さず `@alteroid/ui/shadcn` から出す。
 * テーマの CSS は `@alteroid/ui/styles.css`。
 */
export * from './components/common';
export * from './components/page';
export * from './components/drawer';
export * from './components/markdown';
export * from './hooks/use-is-mobile';
export * from './hooks/use-measured-height';
export { cn } from './lib/utils';
