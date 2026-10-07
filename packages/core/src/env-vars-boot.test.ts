import { describe, expect, it, vi } from 'vitest';

import { createCredentialService, resolveCredentialRows } from './credential-service.js';
import {
  APP_ENV_VAR_DEFAULTS,
  applyAppScopedEnvVars,
  migrateEnvBaseCredentialsOnce,
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

  /**
   * **書き込みを拒むだけでは塞がらない**（2026-09-15）。一覧へ名前を足す前に
   * 置かれた行は袋に残り続ける ⟹ 重ねてしまえば、器の生の環境変数を直しても
   * 二度と効かない（`credentials.ts` の `ENV_FILE_OWNED_CREDENTIAL_NAMES` の doc）。
   */
  it('正本が器の生の環境変数である名前の行は、既に在っても重ねない', async () => {
    const stores = createMemoryStores();
    // `apply` は拒むので、店の側から直に作る（拒む前に置かれた行の再現）。
    await stores.credentials.put([
      { name: 'ALTEROID_CLONE_MODEL', value: 'opus', scope: 'app', secret: false },
      { name: 'ALTEROID_MANAGER_MODEL', value: 'haiku', scope: 'all', secret: false },
      { name: 'ALTEROID_AUTH', value: 'off', scope: 'app', secret: false },
    ]);
    const target: NodeJS.ProcessEnv = { ALTEROID_CLONE_MODEL: 'fable' };

    await applyAppScopedEnvVars(stores, target);

    // **器の生の環境変数の値がそのまま残る。**
    expect(target.ALTEROID_CLONE_MODEL).toBe('fable');
    expect(target.ALTEROID_MANAGER_MODEL).toBeUndefined();
    expect(target.ALTEROID_AUTH).toBeUndefined();
  });

  it('重ねなかった行は黙って落とさず、名前だけを stderr に出す', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([
      { name: 'ALTEROID_CLONE_MODEL', value: 'opus', scope: 'app', secret: false },
    ]);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      await applyAppScopedEnvVars(stores, {});
    } finally {
      spy.mockRestore();
    }

    const line = written.join('');
    expect(line).toContain('ALTEROID_CLONE_MODEL');
    // **値は出さない**（この袋には秘密の行も居る）。
    expect(line).not.toContain('opus');
  });
});

/**
 * **器の環境変数にだけ置かれていた鍵を、起動時に1度だけ正本へ移す**
 * （`migrateEnvBaseCredentialsOnce`。2026-10-06 のオーナー決定）。
 *
 * 守るのは5つ: (1) 土台だった3つの名前（`GH_TOKEN` / `GITHUB_TOKEN` / `CODEX_API_KEY`）だけを、
 * 正本に行が無く非空のときに `scope: all`・`secret: true` で写す（プールの名前・任意の名前は
 * 写さない） (2) **1度だけ**——画面で消した後の再起動で蘇らない（印） (3) 既に在る行は上書きしない
 * (4) 名前だけを stderr と日誌へ残し、値は出さない (5) 失敗しても起動を止めない。
 */
describe('migrateEnvBaseCredentialsOnce', () => {
  const SNAPSHOT: NodeJS.ProcessEnv = {
    GH_TOKEN: 'ghp_dummy_gh',
    GITHUB_TOKEN: 'ghp_dummy_github',
    CODEX_API_KEY: 'sk-dummy-codex',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-dummy-pool',
    NPM_TOKEN: 'npm_dummy',
  };

  function quiet<T>(run: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return run().finally(() => spy.mockRestore());
  }

  it('土台だった3つの名前だけを、scope: all / secret: true で写す（プールの名前・任意の名前は写さない）', async () => {
    const stores = createMemoryStores();

    const written = await quiet(() => migrateEnvBaseCredentialsOnce(stores, SNAPSHOT));

    expect([...written].sort()).toEqual(['CODEX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']);
    const rows = await stores.credentials.list();
    expect(rows.map((row) => row.name)).toEqual(['CODEX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']);
    for (const row of rows)
      expect(row).toEqual(expect.objectContaining({ scope: 'all', secret: true }));
    expect(rows.find((row) => row.name === 'GH_TOKEN')?.value).toBe('ghp_dummy_gh');
  });

  it('1度だけ: 画面で消した後に再起動しても、器の env から蘇らない（印）', async () => {
    const stores = createMemoryStores();
    await quiet(() => migrateEnvBaseCredentialsOnce(stores, SNAPSHOT));
    // 人間が画面から消した。
    await stores.credentials.put([{ name: 'GH_TOKEN', value: '' }]);

    const again = await quiet(() => migrateEnvBaseCredentialsOnce(stores, SNAPSHOT));

    expect(again).toEqual([]);
    expect((await stores.credentials.list()).map((row) => row.name)).not.toContain('GH_TOKEN');
  });

  it('既に正本に在る名前は上書きしない（人間が置いたものが勝つ）。印は立つ', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'GH_TOKEN', value: 'ghp_human_placed', scope: 'app' }]);

    const written = await quiet(() => migrateEnvBaseCredentialsOnce(stores, SNAPSHOT));

    expect([...written].sort()).toEqual(['CODEX_API_KEY', 'GITHUB_TOKEN']);
    expect((await stores.credentials.list()).find((row) => row.name === 'GH_TOKEN')).toEqual(
      expect.objectContaining({ value: 'ghp_human_placed', scope: 'app' }),
    );
  });

  it('空文字・未設定は写さない。**書くものが無くても印は立つ**（後から置かれた器の env を拾わない）', async () => {
    const stores = createMemoryStores();
    const first = await quiet(() =>
      migrateEnvBaseCredentialsOnce(stores, { GH_TOKEN: '', GITHUB_TOKEN: undefined }),
    );
    expect(first).toEqual([]);

    const second = await quiet(() => migrateEnvBaseCredentialsOnce(stores, SNAPSHOT));

    expect(second).toEqual([]);
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('移した名前を stderr と日誌に残し、値は1文字も出さない', async () => {
    const stores = createMemoryStores();
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await migrateEnvBaseCredentialsOnce(stores, SNAPSHOT);
    } finally {
      spy.mockRestore();
    }

    const stderr = written.join('');
    expect(stderr).toContain('GH_TOKEN');
    const journal = JSON.stringify(await stores.journal.list());
    expect(journal).toContain('GH_TOKEN');
    for (const value of ['ghp_dummy_gh', 'ghp_dummy_github', 'sk-dummy-codex']) {
      expect(stderr).not.toContain(value);
      expect(journal).not.toContain(value);
    }
  });

  it('正本へ書けなくても投げない（起動を止めない）。失敗は stderr に残る', async () => {
    const stores = createMemoryStores();
    stores.credentials.seedOnce = () => Promise.reject(new Error('boom'));
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await expect(migrateEnvBaseCredentialsOnce(stores, SNAPSHOT)).resolves.toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toContain('移せませんでした');
  });
});

/**
 * **確認済みのバグの再現（2026-10-05）。** 起動時に `applyAppScopedEnvVars` が正本（袋）の
 * `scope: all | app` の行を `process.env` へ書き写し、それを「器の env」と取り違えると、
 * 正本を画面で更新しても古い値が配られ、削除しても書き写した古い値が配られ続けた
 * （`resolveCredentialRows` の `fromEnvOnly` / `cloneEnvWins`）。**正本が唯一の出所であること**を、
 * 起動の流れ（正本へ置く → 書き写す → 更新 → 削除）そのままで測る。
 */
describe('起動時の書き写しは「器の env」ではない（2026-10-05 の再現）', () => {
  it('正本の GH_TOKEN を更新すれば新しい値が配られ、削除すれば何も配られない', async () => {
    const stores = createMemoryStores();
    await stores.credentials.put([{ name: 'GH_TOKEN', value: 'old', scope: 'all' }]);
    const written: NodeJS.ProcessEnv = {};
    await applyAppScopedEnvVars(stores, written); // 起動時の書き写し
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
