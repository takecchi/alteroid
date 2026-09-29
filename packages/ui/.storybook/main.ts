import { fileURLToPath } from 'node:url';

import type { StorybookConfig } from '@storybook/react-vite';

/**
 * `packages/ui` の見本帳。根で `pnpm storybook`（= `pnpm --filter @alteroid/ui storybook`）。
 *
 * **Vite の設定はここで足す**（`packages/ui` は build を持たないので `vite.config.ts` が無い）。
 * - `@tailwindcss/vite`: テーマ（`src/styles.css`）と部品の class を回す
 * - `@` の別名: shadcn の部品が `@/lib/utils` の形で互いを import する
 *   （`components.json` の aliases。apps/web と共通の vitest にも同じ対応が在る）
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  // 匿名の利用状況の送信を止める（開発の道具が外へ何かを送る理由が無い）。
  core: { disableTelemetry: true },
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (viteConfig) => {
    const { mergeConfig } = await import('vite');
    const tailwindcss = (await import('@tailwindcss/vite')).default;
    return mergeConfig(viteConfig, {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          '@': fileURLToPath(new URL('../src', import.meta.url)),
        },
      },
    });
  },
};

export default config;
