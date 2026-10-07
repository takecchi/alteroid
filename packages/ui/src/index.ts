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
 *
 * 置き場の分け方:
 * - `components/ui/` —— shadcn が生成した部品（手を入れない。`@alteroid/ui/shadcn`）。見本帳では `UI/*`
 * - `components/layout/` —— 画面の骨組み（脇の面・上端の帯・印・全画面の状態）。見本帳では `Layout/*`
 * - `components/features/` —— 画面が組み立てに使うまとまり（量・名前と値・生ログ・確認の窓・⌘K の窓・チャット）。見本帳では `Features/*`
 * - `components/*.tsx` —— 以前からの画面の部品（`common` / `page` / `drawer` / `markdown`）
 */
export * from './components/common';
export * from './components/page';
export * from './components/document-title';
export * from './components/drawer';
export * from './components/markdown';
export * from './components/zoomable-image';
export * from './components/layout';
export * from './components/features';
export * from './hooks/use-is-mobile';
export * from './hooks/use-measured-height';
export { cn } from './lib/utils';
export * from './lib/display-text';
