import { create } from 'storybook/theming';

/**
 * 見本帳の外枠（左の一覧・上の帯）と docs の頁の色。
 *
 * **docs の頁は Storybook が自分で描く白い頁**で、`styles.css` のテーマは届かない。
 * 既定のままだと、暗い側の文字（明るい色）が白い頁の上に乗って読めなくなる。
 * だから外枠も docs も暗い側（画面の既定）へ寄せる。
 *
 * 値は `src/styles.css` の `.dark` を sRGB へ写したもの（Storybook の theming は
 * oklch を読めない）。**`styles.css` の値を変えたら、ここも合わせること**
 * ——ずれても壊れはしないが、外枠と見本の地の色が食い違って見える。
 */
export const alteroidDark = create({
  base: 'dark',
  brandTitle: 'alteroid',
  colorPrimary: '#b6b3ff',
  colorSecondary: '#b6b3ff',
  appBg: '#0b0e18',
  appContentBg: '#0b0e18',
  appPreviewBg: '#0b0e18',
  appBorderColor: '#282d3d',
  appBorderRadius: 6,
  textColor: '#e9eaf3',
  textMutedColor: '#999db2',
  textInverseColor: '#0b0e18',
  barBg: '#121522',
  barTextColor: '#999db2',
  barSelectedColor: '#b6b3ff',
  inputBg: '#1d212f',
  inputBorder: '#282d3d',
  inputTextColor: '#e9eaf3',
  fontBase: "'IBM Plex Sans JP', ui-sans-serif, system-ui, sans-serif",
  fontCode: "'IBM Plex Mono', ui-monospace, monospace",
});
