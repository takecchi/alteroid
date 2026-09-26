import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * `TokenPoolStore.replace()` の3実装の食い違い（issue #1652）。
 *
 * fs は `agentTokenRowSchema.parse(token)`（`order: z.number().int()`）を
 * 通してから書く（`packages/storage-fs/src/token-pool.ts`）。pg は zod での
 * 検査こそ持たないが、`order` 列が SQL の整数型なので非整数を渡すと DB 側の
 * 型検査で落ちる（`packages/storage-pg/src/token-pool.ts` の `toRow` /
 * `agentTokens` テーブル定義）。**結果として fs / pg はどちらも `order` が
 * 非整数の `AgentToken` を拒む。**
 *
 * **インメモリ実装だけが検査を持たなかった**（`tokenPool = [...next];` を
 * 素通しで呼ぶだけ）——#1634/#1635/#1640 と同じ形。
 *
 * ここは fs / pg を基準にした期待値（`order` が非整数の行は拒む）を
 * インメモリにも当てる歯——`createMemoryStores()` の `tokens.replace` が
 * `@alteroid/core` の `agentTokenSchema.parse` を通すようになったので
 * 緑になる（`packages/storage-fs/src/token-pool-replace-validation.test.ts` /
 * `packages/storage-pg/src/token-pool-replace-validation.test.ts` と同じ形）。
 *
 * `agentTokenSchema`（`packages/core/src/token-pool.ts`）は、かつて
 * `storage-fs` にしか無かった検査（`agentTokenRowSchema`）を core へ移して
 * 共有した形——`storage-fs` はいまこれを `.extend()` して使う
 * （legacy の `source: 'env'` を読めるようにする分だけ緩める）。
 */
describe('TokenPoolStore.replace() — order が非整数の AgentToken の扱い（インメモリ実装）', () => {
  it('replace() は fs / pg と同じく、order が非整数の行を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    const badToken = { id: 't1', label: 'x', order: 1.5 };
    await expect(stores.tokens.replace([badToken])).rejects.toThrow();
  });
});
