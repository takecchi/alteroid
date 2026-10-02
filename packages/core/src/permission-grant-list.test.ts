import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('permission-grant-list.ts は読むだけである（#863 C 節の歯を緩めない代わりの歯）', () => {
  const source = readFileSync(new URL('./permission-grant-list.ts', import.meta.url), 'utf8');

  it('書き手の口（put / revoke / markUsed / removeUnreadable）に触れない', () => {
    expect(source).not.toMatch(/\.(put|revoke|markUsed|removeUnreadable)\s*\(/);
  });

  it('ストアへ届くのは list / listUnreadable の2つだけ', () => {
    const touched = [...source.matchAll(/stores\.permissionGrants\.(\w+)/g)].map((m) => m[1]);
    expect(touched.sort()).toEqual(['list', 'listUnreadable']);
  });
});
