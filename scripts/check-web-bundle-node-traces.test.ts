import { describe, expect, it } from 'vitest';

import {
  findNodeTraceHits,
  NODE_SPECIFIER,
  PATTERNS,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-web-bundle-node-traces-core.mjs';

describe('check-web-bundle-node-traces: findNodeTraceHits', () => {
  it('4つの検査語とも該当なしなら0件を返す', () => {
    const hits = findNodeTraceHits([{ path: 'clean.js', content: 'const a = 1; export { a };' }]);
    expect(hits).toEqual([]);
  });

  it('createRequire（#294/#306 の実際の混入と同じ形）を捕まえる', () => {
    const content = 'qa=(0,E.createRequire)(import.meta.url),Tte=Symbol.dispose';
    const hits = findNodeTraceHits([{ path: 'x.js', content }]);
    expect(hits.map((h: { pattern: string }) => h.pattern)).toContain('createRequire');
  });

  it('引用符付き node: 指定子を捕まえる', () => {
    const content = 'globalThis.File to import("node:buffer").File';
    const hits = findNodeTraceHits([{ path: 'x.js', content }]);
    expect(hits.map((h: { pattern: string }) => h.pattern)).toContain('node: 指定子(引用符付き)');
  });

  it('process.cwd を捕まえる', () => {
    const content = 'this.workdir=e.workdir??process.cwd(),this.unrestrictedPaths=e';
    const hits = findNodeTraceHits([{ path: 'x.js', content }]);
    expect(hits.map((h: { pattern: string }) => h.pattern)).toContain('process.cwd');
  });

  it('Bun. を捕まえる', () => {
    const content = 'function RG(e){let t=Bun.which(e);return!t}';
    const hits = findNodeTraceHits([{ path: 'x.js', content }]);
    expect(hits.map((h: { pattern: string }) => h.pattern)).toContain('Bun.');
  });

  it('⚠️ 回帰: node: の素の部分一致には反応しない（一度踏んだ誤検知）', () => {
    const content = 'if(r=e+n.textContent.length,e<=t&&r>=t)return{node:n,offset:t-e};';
    expect(NODE_SPECIFIER.test(content)).toBe(false);
    const hits = findNodeTraceHits([{ path: 'entry.client.js', content }]);
    expect(hits).toEqual([]);
  });

  it('検査語は4つのまま（増減したらこのテストを更新して意図を明記すること）', () => {
    expect(PATTERNS.map((p: { name: string }) => p.name)).toEqual([
      'createRequire',
      'node: 指定子(引用符付き)',
      'process.cwd',
      'Bun.',
    ]);
  });
});
