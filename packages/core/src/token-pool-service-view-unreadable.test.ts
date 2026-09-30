import { describe, expect, it } from 'vitest';

import { UnreadableTokenSettingsError, type Stores } from './store.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #2095。`list()` / `replace()` が共有する `currentView()`
 * （`token-pool-service.ts`）は、以前は `Promise.all([stores.tokens.list(),
 * stores.tokens.readSettings()])` の形で、`readSettings()` が
 * `UnreadableTokenSettingsError`（issue #2053, `store.ts`）を投げると一覧
 * ごと reject していた——`GET /tokens` はそのまま 500 になり、読めている
 * トークンの一覧まで見えなくなる。
 *
 * **この PR が直すのはそこである。** 設定が読めないときは `settings` を
 * 省いて `settingsUnreadable: { reason }` を返し、**一覧は返す**。
 * **既定値（`free_exhausted` 等）で埋めない** —— 埋めると `off` にしてあった
 * 回転を実装が黙って戻すことになる（`AGENTS.md` の地雷「取れない軸に 0 の
 * 行を作る」と同じ形）。
 *
 * **この歯には「直す前」に対応する赤が無い。** `settingsUnreadable` の分岐
 * 自体がこの PR で新しく足したものである——直す前の sha では、下の
 * `readSettings` を差し替えた偽の `Stores` を渡すと `list()` / `replace()`
 * そのものが reject して、これらの `it` は「settings が読めなかった」より
 * 先に落ちる（`await expect(...).resolves...` が reject を見て落ちる）。
 */
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
    // 先に読める状態で1本置く——「設定が壊れていてもプールの中身は無事」を
    // 確かめるため、空のプールでは足りない。
    await service.replace([{ label: 'work', value: 'tok-secret-value' }]);

    const reason = 'rotateOn が enum の外（テスト用）';
    const stores = storesWithUnreadableSettings(memory, reason);
    const broken = createTokenPoolService({ stores });

    const view = await broken.list();

    expect(view.tokens).toHaveLength(1);
    expect(view.tokens[0]?.label).toBe('work');
    // **`settings` が無い。既定値へすり替わっていない。**
    expect(view.settings).toBeUndefined();
    expect(view.settingsUnreadable).toEqual({ reason });
  });

  it('replace(): 設定が読めなくても保存はでき、返り値は settingsUnreadable の形', async () => {
    const memory = createMemoryStores();
    const reason = 'cooldownMs が数値でない（テスト用）';
    const stores = storesWithUnreadableSettings(memory, reason);
    const service = createTokenPoolService({ stores });

    const view = await service.replace([{ label: 'a', value: 'tok-a-value' }]);

    expect(view.tokens).toHaveLength(1);
    expect(view.settings).toBeUndefined();
    expect(view.settingsUnreadable).toEqual({ reason });
    // **保存そのものは効いている。** 設定が読めないことが、プールの置換
    // （`tokens` だけを触る操作）まで巻き込んでいない——`readSettings` を
    // 差し替えていない `memory.tokens` 側で読み直して確かめる。
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

  it('replace(): UnreadableTokenSettingsError 以外は飲み込まず、そのまま投げる', async () => {
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

    await expect(service.replace([{ label: 'a', value: 'tok-a-value' }])).rejects.toThrow(
      'DB 接続断（テスト用。設定の形とは無関係の障害）',
    );
  });
});

/**
 * issue #2346。`settingsUnreadable`（設定の軸）と独立に、行が読めなかったときは
 * `rowsUnreadable`（行の軸）を載せる。**1件でも在るときだけ鍵が載り、0件なら鍵ごと無い。**
 * 実物の fs ストアで不正な行を置いた歯は `apps/daemon/src/tokens-practices-unreadable-rows.test.ts`
 * が持つ——ここは、サービスが `stores.tokens.listUnreadable()` をそのまま運ぶことだけを測る。
 */
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

  it('replace() の返り値にも、読めない行が在れば rowsUnreadable が載る', async () => {
    const view = await createTokenPoolService({
      stores: storesWithUnreadableRows(createMemoryStores(), [
        { id: 'tok-bad', reason: '不正な行' },
      ]),
    }).replace([{ label: 'a', value: 'tok-a-value' }]);

    expect(view.rowsUnreadable).toEqual({
      count: 1,
      rows: [{ id: 'tok-bad', reason: '不正な行' }],
    });
  });
});
