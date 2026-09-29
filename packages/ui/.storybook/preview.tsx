import type { Preview } from '@storybook/react-vite';

import { TooltipProvider } from '../src/components/ui/tooltip';

import { alteroidDark } from './theme';

import './preview.css';

/**
 * 明るい側・暗い側を上の帯で切り替える。**既定は暗い側**（画面と同じ。
 * `apps/web/app/root.tsx` が `<html class="dark">` で始める）。
 *
 * `.dark` は `<html>` に付け外しする——`styles.css` の `@custom-variant dark` は
 * 祖先の `.dark` を見るので、Portal で `<body>` 直下へ出る部品（Dialog / Sheet /
 * Tooltip）にも同じ側が効く。
 */
const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: { disable: true },
    // docs の頁の色（`theme.ts`）。見本1つぶんの地は `preview.css` が Theme の切り替えに合わせる。
    docs: { theme: alteroidDark },
  },
  decorators: [
    (Story, context) => {
      // `globals` は `Record<string, any>` なので、文字列であることを確かめてから使う。
      const theme = typeof context.globals.theme === 'string' ? context.globals.theme : 'dark';
      document.documentElement.classList.toggle('dark', theme === 'dark');
      return (
        <TooltipProvider>
          <Story />
        </TooltipProvider>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: '明るい側・暗い側',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark', icon: 'moon' },
          { value: 'light', title: 'Light', icon: 'sun' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
  },
};

export default preview;
