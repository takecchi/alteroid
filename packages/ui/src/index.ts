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
 * - `components/layout/` —— 画面の骨組み（脇の面・上端の帯・印・全画面の状態）
 * - `components/data/` —— 値の見せ方（量・名前と値・生の文字列・状態の点・空）
 * - `components/features/` —— 振る舞いを持つまとまり（確認の窓・⌘K の窓）
 * - `components/*.tsx` —— 以前からの画面の部品（`common` / `page` / `drawer` / `markdown`）
 */
export * from './components/common';
export * from './components/page';
export * from './components/drawer';
export * from './components/markdown';
export * from './components/layout';
export * from './components/data';
export * from './components/features';
export * from './hooks/use-is-mobile';
export * from './hooks/use-measured-height';
export { cn } from './lib/utils';
