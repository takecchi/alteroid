// `node:` を引用符付きの import 指定子として見る: そのままの部分一致は `{node:n,...}` のようなオブジェクトリテラルのプロパティ名に誤検知するため。
export const NODE_SPECIFIER = /["']node:[a-zA-Z0-9/_-]+["']/;

export const PATTERNS = [
  { name: 'createRequire', re: /createRequire/ },
  { name: 'node: 指定子(引用符付き)', re: NODE_SPECIFIER },
  { name: 'process.cwd', re: /process\.cwd/ },
  { name: 'Bun.', re: /Bun\./ },
];

export function findNodeTraceHits(files) {
  const hits = [];
  for (const file of files) {
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(file.content);
      if (match !== null) {
        hits.push({
          path: file.path,
          pattern: pattern.name,
          snippet: file.content.slice(Math.max(0, match.index - 40), match.index + 60),
        });
      }
    }
  }
  return hits;
}
