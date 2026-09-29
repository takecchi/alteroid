import { describe, expect, it } from 'vitest';

import { UnreadableTokenSettingsError, type Stores } from './store.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #2053。`readSettings()` が `UnreadableTokenSettingsError` を投げている
 * とき、`TokenPoolService.setSettings(patch)` は `patch` が `rotateOn` と
 * `cooldownMs` の**両方**を持っていれば、読めない現在値を読まずに新しい値
 * だけで書き直す。**片方しか無ければ埋める元（現在値）が無いので、投げた
 * まま呼び出し側（`PUT /tokens/policy`）へ返す。**
 *
 * **インメモリ実装は書き込み時に `tokenRotationSettingsSchema.parse` を通す
 * ので、壊れた値をそもそも持てない**（`testing.ts` の `tokens.writeSettings`
 * の doc）。この分岐を単体で確かめるには、`readSettings()` だけを差し替えた
 * 偽の `Stores` を渡す必要がある——`tools.test.ts` が
 * `UnreadableCommitmentError` を確かめるのに使っているのと同じ手法
 * （`createMemoryStores()` の結果を spread で一部だけ差し替える）。
 *
 * **この歯には「直す前」に対応する赤が無い。** `UnreadableTokenSettingsError`
 * も、それを捕まえる分岐も、この PR で新しく足したものである。
 */
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
    // **実際に書けている。** 次の `readSettings()`（本物のインメモリ実装）が
    // 読める——`readSettings()` を差し替えていない `memory.tokens` の側で
    // 確かめる（`stores.tokens.readSettings` は差し替えたままなので使えない）。
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
