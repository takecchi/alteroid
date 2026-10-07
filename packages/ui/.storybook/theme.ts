import { create } from 'storybook/theming';

// sRGB で書く: Storybook の theming は oklch を読めないため
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
