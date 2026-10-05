import { clsx, type ClassValue } from 'clsx';
import { createTailwindMerge, fromTheme, validators, type Config } from 'tailwind-merge';

const {
  isAny,
  isAnyNonArbitrary,
  isArbitraryFamilyName,
  isArbitraryLength,
  isArbitraryNumber,
  isArbitraryShadow,
  isArbitraryValue,
  isArbitraryVariable,
  isArbitraryVariableLength,
  isArbitraryVariableShadow,
  isArbitraryVariableWeight,
  isArbitraryVariableFamilyName,
  isArbitraryWeight,
  isFraction,
  isInteger,
  isNamedContainerQuery,
  isNumber,
  isTshirtSize,
} = validators;

const themeAnimate = fromTheme('animate');
const themeAspect = fromTheme('aspect');
const themeBlur = fromTheme('blur');
const themeBreakpoint = fromTheme('breakpoint');
const themeColor = fromTheme('color');
const themeContainer = fromTheme('container');
const themeEase = fromTheme('ease');
const themeFont = fromTheme('font');
const themeFontWeight = fromTheme('font-weight');
const themeLeading = fromTheme('leading');
const themeRadius = fromTheme('radius');
const themeShadow = fromTheme('shadow');
const themeSpacing = fromTheme('spacing');
const themeText = fromTheme('text');
const themeTracking = fromTheme('tracking');

// 既定の設定が内部に持つ同名の `scale*`。毎回新しい配列を返す形も既定のまま。
const scaleOverflow = () => ['auto', 'hidden', 'clip', 'visible', 'scroll'];
const scaleUnambiguousSpacing = () => [isArbitraryVariable, isArbitraryValue, themeSpacing];
const scaleInset = () => [isFraction, 'full', 'auto', ...scaleUnambiguousSpacing()];
const scaleGridTemplateColsRows = () => [
  isInteger,
  'none',
  'subgrid',
  isArbitraryVariable,
  isArbitraryValue,
];
const scaleGridColRowStartAndEnd = () => [
  'auto',
  { span: ['full', isInteger, isArbitraryVariable, isArbitraryValue] },
  isInteger,
  isArbitraryVariable,
  isArbitraryValue,
];
const scaleGridColRowStartOrEnd = () => [isInteger, 'auto', isArbitraryVariable, isArbitraryValue];
const scaleGridAutoColsRows = () => [
  'auto',
  'min',
  'max',
  'fr',
  isArbitraryVariable,
  isArbitraryValue,
];
const scaleAlignPrimaryAxis = () => [
  'start',
  'end',
  'center',
  'between',
  'around',
  'evenly',
  'stretch',
  'baseline',
  'center-safe',
  'end-safe',
];
const scaleAlignSecondaryAxis = () => [
  'start',
  'end',
  'center',
  'stretch',
  'center-safe',
  'end-safe',
];
const scaleMargin = () => ['auto', ...scaleUnambiguousSpacing()];
const scaleSizing = () => [
  isFraction,
  'auto',
  'full',
  'dvw',
  'dvh',
  'lvw',
  'lvh',
  'svw',
  'svh',
  'min',
  'max',
  'fit',
  ...scaleUnambiguousSpacing(),
];
const scaleColor = () => [themeColor, isArbitraryVariable, isArbitraryValue];
const scaleRadius = () => ['', 'none', 'full', themeRadius, isArbitraryVariable, isArbitraryValue];
const scaleBorderWidth = () => ['', isNumber, isArbitraryVariableLength, isArbitraryLength];
const scaleLineStyle = () => ['solid', 'dashed', 'dotted', 'double'];
const scaleBlendMode = () => [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];
const scaleBlur = () => ['', 'none', themeBlur, isArbitraryVariable, isArbitraryValue];
const scaleRotate = () => ['none', isNumber, isArbitraryVariable, isArbitraryValue];
const scaleTranslate = () => [isFraction, 'full', ...scaleUnambiguousSpacing()];
const scalePositionWithArbitrary = () => [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'left-top',
  'top-right',
  'right-top',
  'bottom-right',
  'right-bottom',
  'bottom-left',
  'left-bottom',
  isArbitraryVariable,
  isArbitraryValue,
];

/**
 * `cn` が使う tailwind-merge の設定。**既定の設定（`getDefaultConfig()`）の部分集合を手で写したもの**である。
 *
 * なぜ既定を使わないか: 既定の設定は tailwind-merge のほぼ全て（生で 27 KB 前後）を占め、全ての経路が通る
 * 共通チャンクへ入る。エンジンだけなら 5 KB 弱で済む。この repo が使わない class グループ
 * （フィルタ・マスク・scroll-snap など）の定義を全員が持ち歩く理由は無い。
 *
 * **本番コードから `getDefaultConfig()` を呼ばないこと**（呼んだ瞬間に全体が bundle へ戻る）。
 * 既定との突き合わせは `utils.test.ts` だけが行う。
 *
 * 各グループの定義は既定と**同じ並びのまま**写してある（同じ class が複数のグループに当たるとき、
 * 先に定義されたほうが勝つ）。`conflictingClassGroups` は、ここに在るグループ同士の分だけ残した。
 * 無いグループとの衝突は、そのグループの class が現れない限り起きない。
 *
 * **新しい class を使い始めたら** `utils.test.ts` の「使われている class のグループが slim に在る」が
 * 落ちる。メッセージが挙げるグループの定義を、`node_modules/tailwind-merge/dist/bundle-mjs.mjs` の
 * `getDefaultConfig()` の `classGroups` から同じ並びの位置へ写し、使う `scale*` / `theme` が
 * 無ければ足す。`conflictingClassGroups` も既定の該当の行を写す。足し終えたら、同じテストの
 * 差分の検査（既定の `twMerge` と完全一致）が通ること。
 */
export const tailwindMergeConfig: Config<string, string> = {
  cacheSize: 500,
  theme: {
    animate: ['spin', 'ping', 'pulse', 'bounce'],
    aspect: ['video'],
    blur: [isTshirtSize],
    breakpoint: [isTshirtSize],
    color: [isAny],
    container: [isTshirtSize],
    ease: ['in', 'out', 'in-out'],
    font: [isAnyNonArbitrary],
    'font-weight': [
      'thin',
      'extralight',
      'light',
      'normal',
      'medium',
      'semibold',
      'bold',
      'extrabold',
      'black',
    ],
    leading: ['none', 'tight', 'snug', 'normal', 'relaxed', 'loose'],
    radius: [isTshirtSize],
    shadow: [isTshirtSize],
    spacing: ['px', isNumber],
    text: [isTshirtSize],
    tracking: ['tighter', 'tight', 'normal', 'wide', 'wider', 'widest'],
  },
  classGroups: {
    aspect: [
      {
        aspect: ['auto', 'square', isFraction, isArbitraryValue, isArbitraryVariable, themeAspect],
      },
    ],
    container: ['container'],
    'container-named': [isNamedContainerQuery],
    display: [
      'block',
      'inline-block',
      'inline',
      'flex',
      'inline-flex',
      'table',
      'inline-table',
      'table-caption',
      'table-cell',
      'table-column',
      'table-column-group',
      'table-footer-group',
      'table-header-group',
      'table-row-group',
      'table-row',
      'flow-root',
      'grid',
      'inline-grid',
      'contents',
      'list-item',
      'hidden',
    ],
    sr: ['sr-only', 'not-sr-only'],
    isolation: ['isolate', 'isolation-auto'],
    'object-fit': [{ object: ['contain', 'cover', 'fill', 'none', 'scale-down'] }],
    overflow: [{ overflow: scaleOverflow() }],
    'overflow-x': [{ 'overflow-x': scaleOverflow() }],
    'overflow-y': [{ 'overflow-y': scaleOverflow() }],
    position: ['static', 'fixed', 'absolute', 'relative', 'sticky'],
    inset: [{ inset: scaleInset() }],
    'inset-x': [{ 'inset-x': scaleInset() }],
    'inset-y': [{ 'inset-y': scaleInset() }],
    top: [{ top: scaleInset() }],
    right: [{ right: scaleInset() }],
    bottom: [{ bottom: scaleInset() }],
    left: [{ left: scaleInset() }],
    visibility: ['visible', 'invisible', 'collapse'],
    z: [{ z: [isInteger, 'auto', isArbitraryVariable, isArbitraryValue] }],
    basis: [{ basis: [isFraction, 'full', 'auto', themeContainer, ...scaleUnambiguousSpacing()] }],
    'flex-direction': [{ flex: ['row', 'row-reverse', 'col', 'col-reverse'] }],
    'flex-wrap': [{ flex: ['nowrap', 'wrap', 'wrap-reverse'] }],
    flex: [{ flex: [isNumber, isFraction, 'auto', 'initial', 'none', isArbitraryValue] }],
    grow: [{ grow: ['', isNumber, isArbitraryVariable, isArbitraryValue] }],
    shrink: [{ shrink: ['', isNumber, isArbitraryVariable, isArbitraryValue] }],
    order: [{ order: [isInteger, 'first', 'last', 'none', isArbitraryVariable, isArbitraryValue] }],
    'grid-cols': [{ 'grid-cols': scaleGridTemplateColsRows() }],
    'col-start-end': [{ col: scaleGridColRowStartAndEnd() }],
    'col-start': [{ 'col-start': scaleGridColRowStartOrEnd() }],
    'grid-rows': [{ 'grid-rows': scaleGridTemplateColsRows() }],
    'row-start-end': [{ row: scaleGridColRowStartAndEnd() }],
    'row-start': [{ 'row-start': scaleGridColRowStartOrEnd() }],
    'auto-rows': [{ 'auto-rows': scaleGridAutoColsRows() }],
    gap: [{ gap: scaleUnambiguousSpacing() }],
    'gap-x': [{ 'gap-x': scaleUnambiguousSpacing() }],
    'gap-y': [{ 'gap-y': scaleUnambiguousSpacing() }],
    'justify-content': [{ justify: [...scaleAlignPrimaryAxis(), 'normal'] }],
    'justify-self': [{ 'justify-self': ['auto', ...scaleAlignSecondaryAxis()] }],
    'align-items': [{ items: [...scaleAlignSecondaryAxis(), { baseline: ['', 'last'] }] }],
    'align-self': [{ self: ['auto', ...scaleAlignSecondaryAxis(), { baseline: ['', 'last'] }] }],
    'place-content': [{ 'place-content': scaleAlignPrimaryAxis() }],
    'place-items': [{ 'place-items': [...scaleAlignSecondaryAxis(), 'baseline'] }],
    p: [{ p: scaleUnambiguousSpacing() }],
    px: [{ px: scaleUnambiguousSpacing() }],
    py: [{ py: scaleUnambiguousSpacing() }],
    pt: [{ pt: scaleUnambiguousSpacing() }],
    pr: [{ pr: scaleUnambiguousSpacing() }],
    pb: [{ pb: scaleUnambiguousSpacing() }],
    pl: [{ pl: scaleUnambiguousSpacing() }],
    m: [{ m: scaleMargin() }],
    mx: [{ mx: scaleMargin() }],
    my: [{ my: scaleMargin() }],
    mt: [{ mt: scaleMargin() }],
    mr: [{ mr: scaleMargin() }],
    mb: [{ mb: scaleMargin() }],
    ml: [{ ml: scaleMargin() }],
    'space-x': [{ 'space-x': scaleUnambiguousSpacing() }],
    'space-y': [{ 'space-y': scaleUnambiguousSpacing() }],
    size: [{ size: scaleSizing() }],
    w: [{ w: [themeContainer, 'screen', ...scaleSizing()] }],
    'min-w': [{ 'min-w': [themeContainer, 'screen', 'none', ...scaleSizing()] }],
    'max-w': [
      {
        'max-w': [
          themeContainer,
          'screen',
          'none',
          'prose',
          { screen: [themeBreakpoint] },
          ...scaleSizing(),
        ],
      },
    ],
    h: [{ h: ['screen', 'lh', ...scaleSizing()] }],
    'min-h': [{ 'min-h': ['screen', 'lh', 'none', ...scaleSizing()] }],
    'max-h': [{ 'max-h': ['screen', 'lh', 'none', ...scaleSizing()] }],
    'font-size': [{ text: ['base', themeText, isArbitraryVariableLength, isArbitraryLength] }],
    'font-style': ['italic', 'not-italic'],
    'font-weight': [{ font: [themeFontWeight, isArbitraryVariableWeight, isArbitraryWeight] }],
    'font-family': [{ font: [isArbitraryVariableFamilyName, isArbitraryFamilyName, themeFont] }],
    'fvn-spacing': ['proportional-nums', 'tabular-nums'],
    tracking: [{ tracking: [themeTracking, isArbitraryVariable, isArbitraryValue] }],
    'line-clamp': [{ 'line-clamp': [isNumber, 'none', isArbitraryVariable, isArbitraryNumber] }],
    leading: [{ leading: ['none', themeLeading, ...scaleUnambiguousSpacing()] }],
    'list-style-type': [
      { list: ['disc', 'decimal', 'none', isArbitraryVariable, isArbitraryValue] },
    ],
    'text-alignment': [{ text: ['left', 'center', 'right', 'justify', 'start', 'end'] }],
    'text-color': [{ text: scaleColor() }],
    'text-decoration': ['underline', 'overline', 'line-through', 'no-underline'],
    'text-decoration-style': [{ decoration: [...scaleLineStyle(), 'wavy'] }],
    'text-decoration-color': [{ decoration: scaleColor() }],
    'underline-offset': [
      { 'underline-offset': [isNumber, 'auto', isArbitraryVariable, isArbitraryValue] },
    ],
    'text-transform': ['uppercase', 'lowercase', 'capitalize', 'normal-case'],
    'text-overflow': ['truncate', 'text-ellipsis', 'text-clip'],
    'text-wrap': [{ text: ['wrap', 'nowrap', 'balance', 'pretty'] }],
    'vertical-align': [
      {
        align: [
          'baseline',
          'top',
          'middle',
          'bottom',
          'text-top',
          'text-bottom',
          'sub',
          'super',
          isArbitraryVariable,
          isArbitraryValue,
        ],
      },
    ],
    whitespace: [
      { whitespace: ['normal', 'nowrap', 'pre', 'pre-line', 'pre-wrap', 'break-spaces'] },
    ],
    break: [{ break: ['normal', 'words', 'all', 'keep'] }],
    wrap: [{ wrap: ['break-word', 'anywhere', 'normal'] }],
    'bg-clip': [{ 'bg-clip': ['border', 'padding', 'content', 'text'] }],
    'bg-color': [{ bg: scaleColor() }],
    'gradient-from': [{ from: scaleColor() }],
    'gradient-to': [{ to: scaleColor() }],
    rounded: [{ rounded: scaleRadius() }],
    'rounded-t': [{ 'rounded-t': scaleRadius() }],
    'rounded-r': [{ 'rounded-r': scaleRadius() }],
    'rounded-b': [{ 'rounded-b': scaleRadius() }],
    'rounded-l': [{ 'rounded-l': scaleRadius() }],
    'border-w': [{ border: scaleBorderWidth() }],
    'border-w-t': [{ 'border-t': scaleBorderWidth() }],
    'border-w-r': [{ 'border-r': scaleBorderWidth() }],
    'border-w-b': [{ 'border-b': scaleBorderWidth() }],
    'border-w-l': [{ 'border-l': scaleBorderWidth() }],
    'border-style': [{ border: [...scaleLineStyle(), 'hidden', 'none'] }],
    'border-color': [{ border: scaleColor() }],
    'border-color-t': [{ 'border-t': scaleColor() }],
    'border-color-l': [{ 'border-l': scaleColor() }],
    'outline-style': [{ outline: [...scaleLineStyle(), 'none', 'hidden'] }],
    'outline-w': [{ outline: ['', isNumber, isArbitraryVariableLength, isArbitraryLength] }],
    'outline-color': [{ outline: scaleColor() }],
    shadow: [
      { shadow: ['', 'inner', 'none', themeShadow, isArbitraryVariableShadow, isArbitraryShadow] },
    ],
    'shadow-color': [{ shadow: scaleColor() }],
    'ring-w': [{ ring: scaleBorderWidth() }],
    'ring-color': [{ ring: scaleColor() }],
    opacity: [{ opacity: [isNumber, isArbitraryVariable, isArbitraryValue] }],
    'mix-blend': [{ 'mix-blend': [...scaleBlendMode(), 'plus-darker', 'plus-lighter'] }],
    'bg-blend': [{ 'bg-blend': scaleBlendMode() }],
    filter: [{ filter: ['', 'none', isArbitraryVariable, isArbitraryValue] }],
    'backdrop-blur': [{ 'backdrop-blur': scaleBlur() }],
    'border-collapse': [{ border: ['collapse', 'separate'] }],
    caption: [{ caption: ['top', 'bottom'] }],
    transition: [
      {
        transition: [
          '',
          'all',
          'colors',
          'opacity',
          'shadow',
          'transform',
          'none',
          isArbitraryVariable,
          isArbitraryValue,
        ],
      },
    ],
    duration: [{ duration: [isNumber, 'initial', isArbitraryVariable, isArbitraryValue] }],
    ease: [{ ease: ['linear', 'initial', themeEase, isArbitraryVariable, isArbitraryValue] }],
    animate: [{ animate: ['none', themeAnimate, isArbitraryVariable, isArbitraryValue] }],
    rotate: [{ rotate: scaleRotate() }],
    transform: [{ transform: [isArbitraryVariable, isArbitraryValue, '', 'none', 'gpu', 'cpu'] }],
    'transform-origin': [{ origin: scalePositionWithArbitrary() }],
    'translate-x': [{ 'translate-x': scaleTranslate() }],
    'translate-y': [{ 'translate-y': scaleTranslate() }],
    appearance: [{ appearance: ['none', 'auto'] }],
    cursor: [
      {
        cursor: [
          'auto',
          'default',
          'pointer',
          'wait',
          'text',
          'move',
          'help',
          'not-allowed',
          'none',
          'context-menu',
          'progress',
          'cell',
          'crosshair',
          'vertical-text',
          'alias',
          'copy',
          'no-drop',
          'grab',
          'grabbing',
          'all-scroll',
          'col-resize',
          'row-resize',
          'n-resize',
          'e-resize',
          's-resize',
          'w-resize',
          'ne-resize',
          'nw-resize',
          'se-resize',
          'sw-resize',
          'ew-resize',
          'ns-resize',
          'nesw-resize',
          'nwse-resize',
          'zoom-in',
          'zoom-out',
          isArbitraryVariable,
          isArbitraryValue,
        ],
      },
    ],
    'field-sizing': [{ 'field-sizing': ['fixed', 'content'] }],
    'pointer-events': [{ 'pointer-events': ['auto', 'none'] }],
    resize: [{ resize: ['none', '', 'y', 'x'] }],
    'scroll-my': [{ 'scroll-my': scaleUnambiguousSpacing() }],
    'scroll-py': [{ 'scroll-py': scaleUnambiguousSpacing() }],
    touch: [{ touch: ['auto', 'none', 'manipulation'] }],
    select: [{ select: ['none', 'text', 'all', 'auto'] }],
    fill: [{ fill: ['none', ...scaleColor()] }],
    stroke: [{ stroke: ['none', ...scaleColor()] }],
  },
  conflictingClassGroups: {
    overflow: ['overflow-x', 'overflow-y'],
    inset: ['inset-x', 'inset-y', 'top', 'right', 'bottom', 'left'],
    'inset-x': ['right', 'left'],
    'inset-y': ['top', 'bottom'],
    flex: ['basis', 'grow', 'shrink'],
    gap: ['gap-x', 'gap-y'],
    p: ['px', 'py', 'pt', 'pr', 'pb', 'pl'],
    px: ['pr', 'pl'],
    py: ['pt', 'pb'],
    m: ['mx', 'my', 'mt', 'mr', 'mb', 'ml'],
    mx: ['mr', 'ml'],
    my: ['mt', 'mb'],
    size: ['w', 'h'],
    'font-size': ['leading'],
    'line-clamp': ['display', 'overflow'],
    rounded: ['rounded-t', 'rounded-r', 'rounded-b', 'rounded-l'],
    'border-w': ['border-w-t', 'border-w-r', 'border-w-b', 'border-w-l'],
    'border-color': ['border-color-t', 'border-color-l'],
  },
  conflictingClassGroupModifiers: {
    'font-size': ['leading'],
  },
  postfixLookupClassGroups: [],
  orderSensitiveModifiers: [
    '*',
    '**',
    'after',
    'backdrop',
    'before',
    'details-content',
    'file',
    'first-letter',
    'first-line',
    'marker',
    'placeholder',
    'selection',
  ],
};

const twMerge = createTailwindMerge(() => tailwindMergeConfig);

/** 条件付きクラス名を潰して、後勝ちの Tailwind 衝突も解く。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
