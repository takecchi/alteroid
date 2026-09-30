import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { agentTokenActive, agentTokenSettings } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #2053。`PgTokenPoolStore.readSettings()` は `tokenRotationPolicySchema
 * .parse(row.rotateOn)`（`safeParse` ではない）を直に呼んでいて、`rotateOn` が
 * enum の外の行だと投げていた。`readActive()` は逆に、行の形をまったく検査
 * していない——`tokenId` が空文字列・`generation` が負の数でも、そのまま
 * 返していた（`activeAgentTokenSchema` を一度も通さない）。
 *
 * **実測（この版の zod、2026-09-29）: `readSettings()` が壊れた `rotateOn`
 * で投げる素の `ZodError` は、この版では値そのもの（`received`）を含まない**
 * ——`invalid_value`（enum）の既定メッセージが `"Invalid option: expected one
 * of …"` という形で、受け取った値を書かない版だった（zod v3 系の enum の
 * 既定メッセージは受け取った値を含むことがあり、そちらを前提に書いた歯は
 * 赤にならなかった。**依頼文の想定と食い違ったのでここに残す**）。⟹
 * 「値を含めない」の歯は直す前後どちらでも緑になる（非退行の確認であって
 * 赤→緑の対比ではない）。**それでもメッセージの文字列に依存しない
 * `summarizeInvalidFields`（欄名だけ）へ寄せる判断そのものは変わらない**
 * ——zod の既定メッセージの版依存を前提にしないための設計であり、たまたま
 * 今回leakしていなかったことはその設計の正しさを損なわない。
 *
 * **この repro ファイルは `UnreadableTokenSettingsError` /
 * `UnreadableActiveTokenError` を import しない**——`readSettings()` /
 * `readActive()` が「投げる」ことは型を問わずに固定できるので、直す前の版
 * でもそのまま実行できる形にしてある（fs 側
 * `token-pool-settings-active-malformed-repro.test.ts` と同じ役割分担。型
 * そのものの固定は `token-pool-settings-unreadable-error-type.test.ts`）。
 *
 * fs と違い、`settings` / `active` は `tokens` とは別の1行表なので、`list()`
 * は元から道連れにならない（`PgTokenPoolStore` の doc）——ここでは対照として
 * 確かめるだけで、直す前後で変わらない。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedPglite());
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

    // **`updatedAt` を渡していないので付かない**（`writeSettings` は受けた値を
    // そのまま書くだけで、既定を補わない）。
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
