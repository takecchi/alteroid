import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  findNodeTraceHits,
  NODE_SPECIFIER,
  PATTERNS,
} from './check-web-bundle-node-traces-core.mjs';

/**
 * `check-web-bundle-node-traces` の判定ロジックの歯。
 *
 * **本物の `pnpm build` を走らせずに試す。** CLI 側（`check-web-bundle-node-traces.mjs`）は
 * ファイル読み込みだけを持ち、判定は `check-web-bundle-node-traces-core.mjs` に切り出して
 * あるので、ここでは合成した文字列で当たり判定だけを確かめる（`scripts/verify-core.test.ts`
 * と同じ分け方・同じ理由）。
 *
 * **狙いは2つ。**
 * 1. 4つの検査語それぞれが、実際に混入した形（#294 / #306 の事故で実際に本番へ出た
 *    バンドルから取った断片）を捕まえること
 * 2. **一度踏んだ誤検知（`node:` の部分一致が `{node:n,...}` という無関係な
 *    オブジェクトリテラルに当たった）を再び埋め込まないこと** — 検査語を選ぶ理由の
 *    半分はこの誤検知を避けるためだったので、ここで固定しておかないと次に検査語を
 *    足す人が同じ誤検知へ戻しかねない
 */
describe('check-web-bundle-node-traces: findNodeTraceHits', () => {
  it('4つの検査語とも該当なしなら0件を返す', () => {
    const hits = findNodeTraceHits([{ path: 'clean.js', content: 'const a = 1; export { a };' }]);
    expect(hits).toEqual([]);
  });

  it('createRequire（#294/#306 の実際の混入と同じ形）を捕まえる', () => {
    // 実測（2026-08-23、直す前の commitments チャンク）から取った断片。
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
    // 実測（2026-08-23、直した後の entry.client チャンク）: DOM 操作の
    // オブジェクトリテラルのプロパティ名が `node:` に部分一致していた。
    // これは import 指定子ではないので、当たってはいけない。
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
