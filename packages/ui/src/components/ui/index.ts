/**
 * shadcn（`components.json` の `"style": "radix-nova"）が吐いた素の部品。`@alteroid/ui/shadcn`。
 *
 * **ここにある部品は `shadcn add` が吐いたまま**で、手を入れない（入れると次の
 * `shadcn add --overwrite` で黙って消える）。画面の呼び方へ合わせるのは
 * `../common.tsx` の役目である。部品を足したら `pnpm --filter @alteroid/ui shadcn:add <名前>`
 * で足し、ここへ1行足す。
 */
export * from './alert';
export * from './alert-dialog';
export * from './avatar';
export * from './badge';
export * from './button';
export * from './card';
export * from './checkbox';
export * from './dialog';
export * from './dropdown-menu';
export * from './empty';
export * from './input';
export * from './kbd';
export * from './label';
export * from './native-select';
export * from './popover';
export * from './progress';
export * from './scroll-area';
export * from './select';
export * from './separator';
export * from './sheet';
export * from './skeleton';
export * from './spinner';
export * from './switch';
export * from './table';
export * from './tabs';
export * from './textarea';
export * from './toggle';
export * from './toggle-group';
export * from './tooltip';
