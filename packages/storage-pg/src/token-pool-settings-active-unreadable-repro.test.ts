import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { agentTokenActive, agentTokenSettings } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

// `UnreadableTokenSettingsError` / `UnreadableActiveTokenError` を import しない: 型を問わず「投げる」ことだけを固定する。型そのものの固定は `token-pool-settings-unreadable-error-type.test.ts`。
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('PgTokenPoolStore — settings / active が読めないときの扱い（issue #2053）', () => {
  const BAD_ROTATE_ON = 'not-a-real-policy';

  it('readSettings() は rotateOn が壊れていると投げる。値はメッセージに含めない（非退行の確認——実測ではこの版の zod は元から値を含まない。上のファイル doc を見よ）', async () => {
    await db.insert(agentTokenSettings).values({
      id: 'default',
      rotateOn: BAD_ROTATE_ON,
      cooldownMs: 1000,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    let rejection: unknown;
    try {
      await stores.tokens.readSettings();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    expect(message).not.toContain(BAD_ROTATE_ON);
  });

  it('対照: list() は settings が壊れていても影響を受けない（元から独立の表。直す前後で変わらない）', async () => {
    await db.insert(agentTokenSettings).values({
      id: 'default',
      rotateOn: BAD_ROTATE_ON,
      cooldownMs: 1000,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(stores.tokens.list()).resolves.toEqual([]);
  });

  it(
    'readActive() は tokenId が空文字列（activeAgentTokenSchema の下限違反）の行があると' +
      '投げる（直す前は検査そのものが無く、壊れた行をそのまま返していて赤）',
    async () => {
      await db.insert(agentTokenActive).values({
        id: 'default',
        tokenId: '',
        generation: 1,
        rotatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      await expect(stores.tokens.readActive()).rejects.toThrow();
    },
  );

  it(
    'readActive() は generation が負の数（activeAgentTokenSchema の下限違反）の行があると' +
      '投げる（直す前は検査そのものが無く、壊れた行をそのまま返していて赤）',
    async () => {
      await db.insert(agentTokenActive).values({
        id: 'default',
        tokenId: 'tok-good',
        generation: -1,
        rotatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      await expect(stores.tokens.readActive()).rejects.toThrow();
    },
  );

  it('確認: writeSettings() は壊れた既存値があっても上書きできる（pg は読まずに書くため。直す前から緑）', async () => {
    await db.insert(agentTokenSettings).values({
      id: 'default',
      rotateOn: BAD_ROTATE_ON,
      cooldownMs: 1000,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await stores.tokens.writeSettings({ rotateOn: 'overage_exhausted', cooldownMs: 2000 });

    await expect(stores.tokens.readSettings()).resolves.toEqual({
      rotateOn: 'overage_exhausted',
      cooldownMs: 2000,
    });
  });

  it('確認: writeActive() は壊れた既存値があっても上書きできる（pg は読まずに書くため。直す前から緑）', async () => {
    await db.insert(agentTokenActive).values({
      id: 'default',
      tokenId: '',
      generation: -1,
      rotatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const written = await stores.tokens.writeActive({
      tokenId: 'tok-good',
      generation: 2,
      rotatedAt: '2026-09-02T00:00:00.000Z',
    });

    expect(written).toEqual({
      tokenId: 'tok-good',
      generation: 2,
      rotatedAt: '2026-09-02T00:00:00.000Z',
    });
    await expect(stores.tokens.readActive()).resolves.toEqual(written);
  });
});
