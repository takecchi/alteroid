import { describe, expect, it } from 'vitest';

import {
  verifyPersonaCreatedAtContract,
  verifyPersonaDescribedAtContract,
  verifyPersonaDescribedBytesContract,
  verifyPersonaIfMatchContract,
  verifyPersonaProtectionStatusContract,
  verifyPersonaWriteContract,
} from './persona-contract.js';
import { ensureTrailingNewline } from './store.js';
import { createMemoryStores } from './testing.js';

// 契約そのものは `persona-contract.ts`（素の関数。vitest に依存しないので core の実行時の依存にならない）。
// fs は `packages/storage-fs/src/index.test.ts`、pg は `packages/storage-pg/src/index.persona.test.ts` から同じ関数を当てる。
// インメモリは器の裏側（索引・列）を持たないので、裏側を直に書き換えるフック（`*Hooks`）を渡さない。フックを要するケースは飛ぶ。
describe('PersonaStore の契約（インメモリ実装）', () => {
  it('書き込みの正規化と追記', async () => {
    await verifyPersonaWriteContract(createMemoryStores().persona);
  });

  it('write / remove の前提の版 ifMatch（Issue #2743・#2881。fs・pg・インメモリで同じ挙動）', async () => {
    await verifyPersonaIfMatchContract(createMemoryStores().persona);
  });

  it('protectionStatus（保護状態の派生値）', async () => {
    await verifyPersonaProtectionStatusContract(createMemoryStores().persona);
  });

  it('createdAt（作成時刻の派生値）', async () => {
    await verifyPersonaCreatedAtContract(createMemoryStores().persona);
  });

  it('describedAt（要旨の鮮度の派生値）', async () => {
    await verifyPersonaDescribedAtContract(createMemoryStores().persona);
  });

  it('describedBytes（本文の変化量の派生値、#913）', async () => {
    await verifyPersonaDescribedBytesContract(createMemoryStores().persona);
  });
});

describe('ensureTrailingNewline', () => {
  it('改行で終わっていない文字列の末尾へ改行を1つ足す', () => {
    expect(ensureTrailingNewline('# X')).toBe('# X\n');
  });

  it('既に改行で終わっている文字列は変えない（改行を増やさない）', () => {
    expect(ensureTrailingNewline('# X\n')).toBe('# X\n');
    expect(ensureTrailingNewline('# X\n\n')).toBe('# X\n\n');
  });

  it('空文字は改行1つになる', () => {
    expect(ensureTrailingNewline('')).toBe('\n');
  });
});
