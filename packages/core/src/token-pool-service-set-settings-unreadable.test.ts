import { describe, expect, it } from 'vitest';

import { UnreadableTokenSettingsError, type Stores } from './store.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

describe('TokenPoolService.setSettings — 現在値が読めないとき（issue #2053）', () => {
  it('rotateOn と cooldownMs の両方を持つ patch なら、読めない現在値を読まずに書ける', async () => {
    const memory = createMemoryStores();
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings() {
          throw new UnreadableTokenSettingsError('settings が読めない（テスト用）');
        },
      },
    };
    const service = createTokenPoolService({
      stores,
      now: () => new Date('2026-09-29T00:00:00.000Z'),
    });

    const written = await service.setSettings({
      rotateOn: 'overage_exhausted',
      cooldownMs: 5000,
    });

    expect(written).toEqual({
      rotateOn: 'overage_exhausted',
      cooldownMs: 5000,
      updatedAt: '2026-09-29T00:00:00.000Z',
    });
    await expect(memory.tokens.readSettings()).resolves.toEqual(written);
  });

  it('rotateOn だけの patch は、埋める元（現在値）が読めないので投げたまま', async () => {
    const memory = createMemoryStores();
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings() {
          throw new UnreadableTokenSettingsError('settings が読めない（テスト用）');
        },
      },
    };
    const service = createTokenPoolService({ stores });

    await expect(service.setSettings({ rotateOn: 'off' })).rejects.toBeInstanceOf(
      UnreadableTokenSettingsError,
    );
  });

  it('cooldownMs だけの patch も、同じ理由で投げたまま', async () => {
    const memory = createMemoryStores();
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings() {
          throw new UnreadableTokenSettingsError('settings が読めない（テスト用）');
        },
      },
    };
    const service = createTokenPoolService({ stores });

    await expect(service.setSettings({ cooldownMs: 1000 })).rejects.toBeInstanceOf(
      UnreadableTokenSettingsError,
    );
  });

  it('patch が空でも、埋める元が無いので投げたまま', async () => {
    const memory = createMemoryStores();
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings() {
          throw new UnreadableTokenSettingsError('settings が読めない（テスト用）');
        },
      },
    };
    const service = createTokenPoolService({ stores });

    await expect(service.setSettings({})).rejects.toBeInstanceOf(UnreadableTokenSettingsError);
  });

  it(
    'UnreadableTokenSettingsError 以外は、patch に関係なくそのまま投げる' +
      '（非退行の確認——この分岐が無かった直す前も、読みが投げた例外はそのまま伝わっていた）',
    async () => {
      const memory = createMemoryStores();
      const stores: Stores = {
        ...memory,
        tokens: {
          ...memory.tokens,
          async readSettings() {
            throw new Error('器そのものの障害（テスト用）');
          },
        },
      };
      const service = createTokenPoolService({ stores });

      await expect(service.setSettings({ rotateOn: 'off', cooldownMs: 1000 })).rejects.toThrow(
        '器そのものの障害',
      );
    },
  );
});
