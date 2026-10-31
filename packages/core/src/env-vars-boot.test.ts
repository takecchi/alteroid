import { describe, expect, it } from 'vitest';

import { createCredentialService, resolveCredentialRows } from './credential-service.js';
import {
  APP_ENV_VAR_DEFAULTS,
  applyAppScopedEnvVars,
  seedDefaultEnvVars,
} from './env-vars-boot.js';
import { captureStderr, createMemoryStores } from './testing.js';

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
    expect(rows).toHaveLength(APP_ENV_VAR_DEFAULTS.length);
  });

  it('人間が明示的に外した（値を消した）名前も、播種で復活させない', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'TZ', value: 'Europe/London', secret: false }]);
    await stores.credentials.put([{ name: 'TZ', value: '' }]);

    await seedDefaultEnvVars(stores, {});

    const rows = await stores.credentials.list();
    const tz = rows.find((row) => row.name === 'TZ');
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

  it('正本が器の生の環境変数である名前の行は、既に在っても重ねない', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([
      { name: 'ALTEROID_CLONE_MODEL', value: 'opus', scope: 'app', secret: false },
      { name: 'ALTEROID_MANAGER_MODEL', value: 'haiku', scope: 'all', secret: false },
      { name: 'ALTEROID_AUTH', value: 'off', scope: 'app', secret: false },
    ]);
    const target: NodeJS.ProcessEnv = { ALTEROID_CLONE_MODEL: 'fable' };

    await applyAppScopedEnvVars(stores, target);

    expect(target.ALTEROID_CLONE_MODEL).toBe('fable');
    expect(target.ALTEROID_MANAGER_MODEL).toBeUndefined();
    expect(target.ALTEROID_AUTH).toBeUndefined();
  });

  it('重ねなかった行は黙って落とさず、名前だけを stderr に出す', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([
      { name: 'ALTEROID_CLONE_MODEL', value: 'opus', scope: 'app', secret: false },
    ]);
    // 跡の書き先（`writeStderrLine`）を通るので `captureStderr` で拾う（#5003）
    const written = await captureStderr(() => applyAppScopedEnvVars(stores, {}));

    const line = written.join('');
    expect(line).toContain('ALTEROID_CLONE_MODEL');
    expect(line).not.toContain('opus');
  });
});

describe('起動時の書き写しは「器の env」ではない（2026-10-05 の再現）', () => {
  it('正本の GH_TOKEN を更新すれば新しい値が配られ、削除すれば何も配られない', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'GH_TOKEN', value: 'old', scope: 'all' }]);
    const written: NodeJS.ProcessEnv = {};
    await applyAppScopedEnvVars(stores, written);
    expect(written.GH_TOKEN).toBe('old');

    const service = createCredentialService({ stores, withheldEnvKeys: [] });
    await service.apply([{ name: 'GH_TOKEN', value: 'new' }]);
    expect(
      resolveCredentialRows(await stores.credentials.list(), 'manager').map((row) => row.value),
    ).toEqual(['new']);

    await service.apply([{ name: 'GH_TOKEN', value: '' }]);
    expect(resolveCredentialRows(await stores.credentials.list(), 'manager')).toEqual([]);
    expect(resolveCredentialRows(await stores.credentials.list(), 'clone')).toEqual([]);
  });

  it('applyAppScopedEnvVars の alsoInto は、同じ解決結果をもう1つの env へも書く（子の土台用）', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x', scope: 'all' }]);
    const target: NodeJS.ProcessEnv = {};
    const also: NodeJS.ProcessEnv = { KEPT: 'yes' };

    await applyAppScopedEnvVars(stores, target, also);

    expect(target.NPM_TOKEN).toBe('npm_x');
    expect(also).toEqual({ KEPT: 'yes', NPM_TOKEN: 'npm_x' });
  });
});
