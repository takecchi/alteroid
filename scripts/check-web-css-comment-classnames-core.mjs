export const PLACEHOLDER_ELLIPSIS = /\.\.\.|…/;

export const PATTERNS = [{ name: 'placeholder-ellipsis', re: PLACEHOLDER_ELLIPSIS }];

export function findInvalidCssHits(files) {
  const hits = [];
  for (const file of files) {
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(file.content);
      if (match !== null) {
        hits.push({
          path: file.path,
          pattern: pattern.name,
          snippet: file.content.slice(Math.max(0, match.index - 60), match.index + 40),
        });
      }
    }
  }
  return hits;
}
