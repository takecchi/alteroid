import { describe, expect, it } from 'vitest';

import { UnreadableTokenSettingsError, type Stores } from './store.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

describe('TokenPoolService.list() / replace() — 設定が読めないとき（issue #2095）', () => {
  function storesWithUnreadableSettings(memory: Stores, reason: string): Stores {
    return {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings() {
          throw new UnreadableTokenSettingsError(reason);
        },
      },
    };
  }

  it('list(): 設定が読めなくても一覧は返り、settings は省いて settingsUnreadable.reason を返す', async () => {
    const memory = createMemoryStores();
    const service = createTokenPoolService({ stores: memory });
    await service.replace([{ label: 'work', value: 'tok-secret-value' }]);

    const reason = 'rotateOn が enum の外（テスト用）';
    const stores = storesWithUnreadableSettings(memory, reason);
    const broken = createTokenPoolService({ stores });

    const view = await broken.list();

    expect(view.tokens).toHaveLength(1);
    expect(view.tokens[0]?.label).toBe('work');
    expect(view.settings).toBeUndefined();
    expect(view.settingsUnreadable).toEqual({ reason });
  });

  it('replace(): 設定が読めなくても保存はでき、返り値は settingsUnreadable の形', async () => {
    const memory = createMemoryStores();
    const reason = 'cooldownMs が数値でない（テスト用）';
    const stores = storesWithUnreadableSettings(memory, reason);
    const service = createTokenPoolService({ stores });

    const result = await service.replace([{ label: 'a', value: 'tok-a-value' }]);
    if (result.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    const view = result.view;

    expect(view.tokens).toHaveLength(1);
    expect(view.settings).toBeUndefined();
    expect(view.settingsUnreadable).toEqual({ reason });
    await expect(memory.tokens.list()).resolves.toEqual([expect.objectContaining({ label: 'a' })]);
  });

  it('list(): UnreadableTokenSettingsError 以外は飲み込まず、そのまま投げる', async () => {
    const memory = createMemoryStores();
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings(): Promise<never> {
          throw new Error('DB 接続断（テスト用。設定の形とは無関係の障害）');
        },
      },
    };
    const service = createTokenPoolService({ stores });

    await expect(service.list()).rejects.toThrow('DB 接続断（テスト用。設定の形とは無関係の障害）');
  });

  it('replace(): UnreadableTokenSettingsError 以外が保存の後の読み直しで投げても、保存は済んでいる。投げずに replacedViewFailed で返す（#2396）', async () => {
    const memory = createMemoryStores();
    const cause = new Error('DB 接続断（テスト用。設定の形とは無関係の障害）');
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async readSettings(): Promise<never> {
          throw cause;
        },
      },
    };
    const changes: string[] = [];
    const service = createTokenPoolService({ stores, onChanged: (c) => changes.push(c) });

    const result = await service.replace([{ label: 'a', value: 'tok-a-value' }]);

    expect(result).toEqual({ kind: 'replacedViewFailed', cause });
    expect((await memory.tokens.list()).map((token) => token.label)).toEqual(['a']);
    expect(changes).toEqual(['pool']);
  });

  it('対照: replace() の保存そのものが投げたら、今までどおり投げる（保存していない）', async () => {
    const memory = createMemoryStores();
    const stores: Stores = {
      ...memory,
      tokens: {
        ...memory.tokens,
        async replace(): Promise<never> {
          throw new Error('保存の失敗（テスト用）');
        },
      },
    };
    const service = createTokenPoolService({ stores });

    await expect(service.replace([{ label: 'a', value: 'tok-a-value' }])).rejects.toThrow(
      '保存の失敗（テスト用）',
    );
  });
});

describe('TokenPoolService.list() / replace() — 行が読めないとき（issue #2346）', () => {
  function storesWithUnreadableRows(
    memory: Stores,
    rows: { id?: string; label?: string; reason: string }[],
  ): Stores {
    return {
      ...memory,
      tokens: {
        ...memory.tokens,
        async listUnreadable() {
          return rows;
        },
      },
    };
  }

  it('list(): 読めない行が在れば rowsUnreadable に件数と行を載せる。読めた行・設定は今までどおり', async () => {
    const memory = createMemoryStores();
    const service = createTokenPoolService({ stores: memory });
    await service.replace([{ label: 'work', value: 'tok-secret-value' }]);
    const rows = [{ id: 'tok-bad', label: 'broken', reason: '不正な欄: order' }];

    const view = await createTokenPoolService({
      stores: storesWithUnreadableRows(memory, rows),
    }).list();

    expect(view.rowsUnreadable).toEqual({ count: 1, rows });
    expect(view.tokens).toHaveLength(1);
    expect(view.settings).toBeDefined();
    expect(JSON.stringify(view)).not.toContain('tok-secret-value');
  });

  it('list(): 読めた行が0件でも、読めない行が在れば rowsUnreadable が載る（「空」に化けない）', async () => {
    const view = await createTokenPoolService({
      stores: storesWithUnreadableRows(createMemoryStores(), [{ reason: '不正な行' }]),
    }).list();

    expect(view.tokens).toEqual([]);
    expect(view.rowsUnreadable).toEqual({ count: 1, rows: [{ reason: '不正な行' }] });
  });

  it('対照: 読めない行が0件なら、rowsUnreadable は鍵ごと無い', async () => {
    const view = await createTokenPoolService({ stores: createMemoryStores() }).list();

    expect('rowsUnreadable' in view).toBe(false);
  });

  it('replace() の返り値にも、読めない行が在れば rowsUnreadable が載る。持ち越した印（carriedOver）付き（#2354）', async () => {
    const result = await createTokenPoolService({
      stores: storesWithUnreadableRows(createMemoryStores(), [
        { id: 'tok-bad', reason: '不正な行' },
      ]),
    }).replace([{ label: 'a', value: 'tok-a-value' }]);
    if (result.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    const view = result.view;

    expect(view.rowsUnreadable).toEqual({
      count: 1,
      rows: [{ id: 'tok-bad', reason: '不正な行' }],
      carriedOver: true,
    });
    expect(JSON.stringify(view)).not.toContain('tok-a-value');
  });

  it('対照: list() の rowsUnreadable には carriedOver が付かない（持ち越したと言うのは置換の応答だけ）（#2354）', async () => {
    const view = await createTokenPoolService({
      stores: storesWithUnreadableRows(createMemoryStores(), [
        { id: 'tok-bad', reason: '不正な行' },
      ]),
    }).list();

    expect(view.rowsUnreadable).not.toHaveProperty('carriedOver');
  });
});
