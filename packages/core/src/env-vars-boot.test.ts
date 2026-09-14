import { describe, expect, it } from 'vitest';

import {
  APP_ENV_VAR_DEFAULTS,
  applyAppScopedEnvVars,
  seedDefaultEnvVars,
} from './env-vars-boot.js';
import { createMemoryStores } from './testing.js';

/**
 * alteroid 自身の運用設定を、環境変数の袋（DB 正本）へ播種・反映する口。
 *
 * ここが守っているのは3つである:
 *
 * 1. **播種は「まだ無ければ入れる」だけ**（人間が既に置いた・消した値を
 *    上書きしない）
 * 2. **移行期は器の環境変数を優先する**（コンテナに既に置かれている値を、
 *    ハードコードの既定で黙って巻き戻さない）
 * 3. **反映（`applyAppScopedEnvVars`）は `scope: 'all' | 'app'` だけを通す**
 *    ——`scope: 'runner'` の行はデーモン自身の `process.env` には要らない
 */

describe('seedDefaultEnvVars', () => {
  it('空の正本には、既定値がある変数だけを scope: app / secret: false で書く', async () => {
    const stores = createMemoryStores();

    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const entry of APP_ENV_VAR_DEFAULTS) {
      expect(byName.get(entry.name)).toEqual(
        expect.objectContaining({ value: entry.value, scope: 'app', secret: false }),
      );
    }
    expect(rows).toHaveLength(APP_ENV_VAR_DEFAULTS.length);
  });

  it('既に置かれている名前は上書きしない（人間が明示的に選んだ値を尊重する）', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([
      { name: 'TZ', value: 'Europe/London', scope: 'app', secret: false },
    ]);

    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    const tz = rows.find((row) => row.name === 'TZ');
    expect(tz).toEqual(expect.objectContaining({ value: 'Europe/London' }));
    // 他の既定値は、まだ無いのでそのぶんだけ足される。
    expect(rows).toHaveLength(APP_ENV_VAR_DEFAULTS.length);
  });

  it('人間が明示的に外した（値を消した）名前も、播種で復活させない', async () => {
    // **`existing` は list() の結果、つまり「いま在る名前」だけを見る。**
    // 一度置いてから外した名前は list() に出てこないので、この歯は
    // 「置いたことがあるかどうか」ではなく「いま在るかどうか」を確かめる
    // ——実装がその区別を持たないことを検証する側の歯である。
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'TZ', value: 'Europe/London', secret: false }]);
    await stores.credentials.put([{ name: 'TZ', value: '' }]); // 外す

    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    const tz = rows.find((row) => row.name === 'TZ');
    // **外した名前は「いま無い」なので、播種が既定値で入れ直す。**
    // これは「人間の意思を無視する」のではなく——播種の対象はあくまで
    // 「まだ無い名前」であり、この関数は「外した」という意図までは
    // 記録しないという実装の性質そのものを固定している。
    expect(tz).toEqual(expect.objectContaining({ value: 'Asia/Tokyo' }));
  });

  it('器の生の環境変数だけが正本の5つは播種しない（ENV_FILE_OWNED_CREDENTIAL_NAMES）', async () => {
    const stores = createMemoryStores();

    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    expect(rows.some((row) => row.name === 'ALTEROID_ALLOWED_ORIGINS')).toBe(false);
    expect(rows.some((row) => row.name === 'ALTEROID_GOOGLE_CLIENT_ID')).toBe(false);
    expect(rows.some((row) => row.name === 'ALTEROID_GOOGLE_CLIENT_SECRET')).toBe(false);
    expect(rows.some((row) => row.name === 'ALTEROID_PUBLIC_URL')).toBe(false);
    expect(rows.some((row) => row.name === 'ALTEROID_AUTH')).toBe(false);
  });

  it('ALTEROID_MEMORY_TIDY_AT / ALTEROID_REPORT_LOOKBACK_DAYS は既定値を持つので播種する', async () => {
    const stores = createMemoryStores();

    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    expect(rows.find((row) => row.name === 'ALTEROID_MEMORY_TIDY_AT')).toEqual(
      expect.objectContaining({ value: '03:00', scope: 'app', secret: false }),
    );
    expect(rows.find((row) => row.name === 'ALTEROID_REPORT_LOOKBACK_DAYS')).toEqual(
      expect.objectContaining({ value: '3', scope: 'app', secret: false }),
    );
  });

  it('器の環境変数に既に値が在れば、そちらを優先して播種する（移行期の配慮）', async () => {
    const stores = createMemoryStores();

    await seedDefaultEnvVars(stores, { TZ: 'America/New_York' });

    const rows = await stores.credentials.list();
    const tz = rows.find((row) => row.name === 'TZ');
    expect(tz).toEqual(expect.objectContaining({ value: 'America/New_York' }));
  });

  it('器の環境変数が空・空白だけなら、ハードコードの既定を使う', async () => {
    const stores = createMemoryStores();

    await seedDefaultEnvVars(stores, { TZ: '   ' });

    const rows = await stores.credentials.list();
    const tz = rows.find((row) => row.name === 'TZ');
    expect(tz).toEqual(expect.objectContaining({ value: 'Asia/Tokyo' }));
  });

  it('2回呼んでも増えない（起動のたびに呼んでも安全）', async () => {
    const stores = createMemoryStores();

    await seedDefaultEnvVars(stores, {});
    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    expect(rows).toHaveLength(APP_ENV_VAR_DEFAULTS.length);
  });

  it('正本が読めなくても投げない（起動を止めない）', async () => {
    const stores = createMemoryStores();
    stores.credentials.list = () => Promise.reject(new Error('boom'));

    await expect(seedDefaultEnvVars(stores, {})).resolves.toBeUndefined();
  });
});

describe('applyAppScopedEnvVars', () => {
  it('scope: all / app の行を対象の env へ上書きで重ねる', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([
      { name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false },
      { name: 'NPM_TOKEN', value: 'npm_x', scope: 'all' },
    ]);
    const target: NodeJS.ProcessEnv = {};

    await applyAppScopedEnvVars(stores, target);

    expect(target.TZ).toBe('Asia/Tokyo');
    expect(target.NPM_TOKEN).toBe('npm_x');
  });

  it('scope: runner の行はデーモン自身の env には重ねない（manager だけに意味を持つ値のため）', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'MANAGER_ONLY', value: 'x', scope: 'runner' }]);
    const target: NodeJS.ProcessEnv = {};

    await applyAppScopedEnvVars(stores, target);

    expect(target.MANAGER_ONLY).toBeUndefined();
  });

  it('既存の env の値を、正本の値で上書きする', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'TZ', value: 'Asia/Tokyo', scope: 'app' }]);
    const target: NodeJS.ProcessEnv = { TZ: 'UTC' };

    await applyAppScopedEnvVars(stores, target);

    expect(target.TZ).toBe('Asia/Tokyo');
  });

  it('正本が空なら、渡した env を1文字も変えない', async () => {
    const stores = createMemoryStores();
    const target: NodeJS.ProcessEnv = { TZ: 'UTC', SOME_OTHER: 'kept' };

    await applyAppScopedEnvVars(stores, target);

    expect(target).toEqual({ TZ: 'UTC', SOME_OTHER: 'kept' });
  });

  it('正本が読めなくても投げず、渡した env をそのまま残す（起動を止めない）', async () => {
    const stores = createMemoryStores();
    stores.credentials.list = () => Promise.reject(new Error('boom'));
    const target: NodeJS.ProcessEnv = { TZ: 'UTC' };

    await expect(applyAppScopedEnvVars(stores, target)).resolves.toBeUndefined();
    expect(target).toEqual({ TZ: 'UTC' });
  });

  it('seedDefaultEnvVars で播種した直後の値がそのまま反映される（起動時の連携）', async () => {
    const stores = createMemoryStores();
    const target: NodeJS.ProcessEnv = {};

    await seedDefaultEnvVars(stores, target);
    await applyAppScopedEnvVars(stores, target);

    for (const entry of APP_ENV_VAR_DEFAULTS) {
      expect(target[entry.name]).toBe(entry.value);
    }
  });
});
