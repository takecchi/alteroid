import { describe, expect, it } from 'vitest';

import { tokenRotationStream } from './index.js';

/**
 * 認証トークン回りの日誌1行を stdout/stderr のどちらへ出すかの分類
 * （Issue #420 の残件）。
 *
 * **6値すべてを当てる。** 1つでも欠けると、次に分類を変える人（あるいは
 * `packages/core/src/schema.ts` の `token_rotation.event` へ新しい値を足す人）が
 * ここで気づけない。`tokenRotationStream` 自身は型で網羅性を守っている
 * （新しい event を足すと `pnpm typecheck` が落ちる）ので、この歯が測るのは
 * **いまの6値の割り当てが正しいか**である。
 *
 * `.write()` は呼ばない——同一性（`toBe`）だけを見る。本物の stdout/stderr へ
 * 書くと `vitest.setup.ts` の歯（#314）に掛かるので、それを避ける形にしてある。
 */
describe('tokenRotationStream', () => {
  it.each([
    ['rotated', 'stdout'],
    ['not_rotated', 'stdout'],
    ['restored', 'stdout'],
    ['exhausted', 'stderr'],
    ['sweep_stopped', 'stderr'],
    ['restore_failed', 'stderr'],
  ] as const)('%s は %s へ出す', (event, expected) => {
    const stream = tokenRotationStream(event);

    expect(stream).toBe(expected === 'stdout' ? process.stdout : process.stderr);
  });
});
