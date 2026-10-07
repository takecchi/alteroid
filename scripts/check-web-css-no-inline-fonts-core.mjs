// CSS 全体のサイズ予算にせず `data:font/` を直接見る: 無関係な CSS の増減で誤って落ちるため（オーナー判断）。

export const INLINE_FONT = /data:font\//i;

export const INLINE_APP_FONT = /data:application\/font-/i;

export const INLINE_APP_X_FONT = /data:application\/x-font-/i;

export const PATTERNS = [
  { name: 'data:font/', re: INLINE_FONT },
  { name: 'data:application/font-', re: INLINE_APP_FONT },
  { name: 'data:application/x-font-', re: INLINE_APP_X_FONT },
];

export const FAILURE_ADVICE =
  '原因の候補: apps/web/vite.config.ts の build.assetsInlineLimit（フォントを埋め込まない関数形が外れていないか）。' +
  '埋め込むと困る理由: unicode-range に関係なく、CSS と一緒に最初に落ちてくる（画面が使わない断片まで先に落ちる）。';

export function findInlineFontHits(files) {
  const hits = [];
  for (const file of files) {
    for (const pattern of PATTERNS) {
      const global = new RegExp(pattern.re.source, 'gi');
      const matches = [...file.content.matchAll(global)];
      if (matches.length > 0) {
        const first = matches[0].index;
        hits.push({
          path: file.path,
          pattern: pattern.name,
          count: matches.length,
          snippet: file.content.slice(Math.max(0, first - 40), first + 40),
        });
      }
    }
  }
  return hits;
}

// CSS が0本のときは空配列で緑にせず落とす: 「検査していない」を「0件だった」と読ませないため。
export function assertHasCssFiles(files) {
  return files.length === 0 ? 'CSS が1つも無い（build が壊れていないか）' : null;
}
