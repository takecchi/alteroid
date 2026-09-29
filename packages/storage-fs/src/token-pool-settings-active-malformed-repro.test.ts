import { readFile, writeFile } from 'node:fs/promises';

import { captureStderr } from '@alteroid/core';
import type { ActiveAgentToken, AgentToken, TokenRotationSettings } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #2053（#1942 の続き。tokens は行ごとの検査に直したが、`settings` /
 * `active` はトップレベルの `fileSchema.parse` に残っていて、どちらかが壊れて
 * いると `#read()` がファイル全体を道連れに投げていた）。
 *
 * **この repro ファイルは `UnreadableTokenSettingsError` / `UnreadableActiveTokenError`
 * を import しない。** 直す前（これらの型が存在しない版）でもそのまま実行できる
 * ようにするためで、`.rejects.toThrow()` のような型を問わない形で赤/緑の両方を
 * 観測する（`packages/storage-pg/src/practices-malformed-row-repro.test.ts` と
 * 同じ作法）。専用の型（`instanceof`）を固定する歯は別ファイル
 * （`token-pool-settings-unreadable-error-type.test.ts`）に置く——あちらは
 * 新しい型を直接 import するので、直す前には実行できない（import 自体が
 * 解決できない）。
 */
describe('FsTokenPoolStore — settings / active が壊れていても tokens ごと読めなくなることはない（issue #2053）', () => {
  let root: string;
  let tokensPath: string;

  const GOOD_TOKEN: AgentToken = {
    id: 'tok-good',
    label: 'primary',
    value: 'secret-good（この文字列がそのまま跡に出てはいけない）',
    source: 'stored',
    order: 0,
  };

  // rotateOn が enum の外——版ずれ・手編集を模す。
  const BAD_SETTINGS_RAW = { rotateOn: 'not-a-real-policy', cooldownMs: 1000 };
  // tokenId が欠けている——版ずれ・手編集を模す。
  const BAD_ACTIVE_RAW = { generation: 1, rotatedAt: '2026-09-01T00:00:00.000Z' };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    tokensPath = stores.paths.tokens;
    await stores.tokens.replace([GOOD_TOKEN]);
  });

  async function corruptSettings(): Promise<void> {
    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as Record<string, unknown>;
    raw.settings = BAD_SETTINGS_RAW;
    await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  async function corruptActive(): Promise<void> {
    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as Record<string, unknown>;
    raw.active = BAD_ACTIVE_RAW;
    await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  async function readRawFile(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(tokensPath, 'utf8')) as Record<string, unknown>;
  }

  it('list() は settings が壊れていても落ちず、正しい token を返す（直す前は道連れで赤）', async () => {
    await corruptSettings();
    const stores = createFsStores(root);

    let list: AgentToken[] = [];
    await captureStderr(async () => {
      list = await stores.tokens.list();
    });

    expect(list.map((t) => t.id)).toEqual(['tok-good']);
  });

  it('list() は active が壊れていても落ちず、正しい token を返す（直す前は道連れで赤）', async () => {
    await corruptActive();
    const stores = createFsStores(root);

    let list: AgentToken[] = [];
    await captureStderr(async () => {
      list = await stores.tokens.list();
    });

    expect(list.map((t) => t.id)).toEqual(['tok-good']);
  });

  it('replace() は settings / active が壊れていても落ちない（直す前は道連れで赤）', async () => {
    await corruptSettings();
    const stores = createFsStores(root);

    let replaced: AgentToken[] = [];
    await captureStderr(async () => {
      replaced = await stores.tokens.replace([{ ...GOOD_TOKEN, label: 'renamed' }]);
    });

    expect(replaced.map((t) => t.label)).toEqual(['renamed']);
  });

  it('readSettings() は settings が壊れていると投げる（既定値へすり替えない。直す前も投げるが、跡（stderr）は無くて赤）', async () => {
    await corruptSettings();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await expect(stores.tokens.readSettings()).rejects.toThrow();
    });
    const joined = lines.join('');

    // 跡は残す。値（rotateOn の実際の値）は載せない。
    expect(joined).toContain('settings');
    expect(joined).not.toContain(BAD_SETTINGS_RAW.rotateOn);
  });

  it('readActive() は active が壊れていると投げる（null へすり替えない。直す前も投げるが、跡（stderr）は無くて赤）', async () => {
    await corruptActive();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await expect(stores.tokens.readActive()).rejects.toThrow();
    });
    const joined = lines.join('');

    expect(joined).toContain('active');
  });

  it('writeSettings() は settings が壊れていても上書きできる。書いた後は readSettings() が読める（直す前は道連れで赤）', async () => {
    await corruptSettings();
    const stores = createFsStores(root);

    const goodSettings: TokenRotationSettings = { rotateOn: 'overage_exhausted', cooldownMs: 2000 };
    await captureStderr(async () => {
      await stores.tokens.writeSettings(goodSettings);
    });

    await expect(stores.tokens.readSettings()).resolves.toEqual(goodSettings);
    // ファイル上も壊れた生の値は残っていない——新しい値で置き換わっている。
    const raw = await readRawFile();
    expect(raw.settings).toEqual(goodSettings);
  });

  it('writeActive() は active が壊れていても上書きできる。書いた後は readActive() が読める（直す前は道連れで赤）', async () => {
    await corruptActive();
    const stores = createFsStores(root);

    const goodActive: ActiveAgentToken = {
      tokenId: 'tok-good',
      generation: 1,
      rotatedAt: '2026-09-02T00:00:00.000Z',
    };
    await captureStderr(async () => {
      await stores.tokens.writeActive(goodActive);
    });

    await expect(stores.tokens.readActive()).resolves.toEqual(goodActive);
    const raw = await readRawFile();
    expect(raw.active).toEqual(goodActive);
  });

  it(
    '壊れた settings が在る間に writeActive() を書いても、settings の壊れた生の値は' +
      '消えない（round trip。書き戻しで黙って消さない）',
    async () => {
      await corruptSettings();
      const stores = createFsStores(root);

      await captureStderr(async () => {
        await stores.tokens.writeActive({
          tokenId: 'tok-good',
          generation: 1,
          rotatedAt: '2026-09-02T00:00:00.000Z',
        });
      });

      const raw = await readRawFile();
      expect(raw.settings).toEqual(BAD_SETTINGS_RAW);
      // readSettings() はまだ壊れているので、まだ投げる。
      await captureStderr(async () => {
        await expect(stores.tokens.readSettings()).rejects.toThrow();
      });
    },
  );

  it('replace() は tokens だけを全文置換する。settings / active の壊れた生の値には触れない', async () => {
    await corruptSettings();
    await corruptActive();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await stores.tokens.replace([{ ...GOOD_TOKEN, label: 'renamed' }]);
    });

    const raw = await readRawFile();
    expect(raw.settings).toEqual(BAD_SETTINGS_RAW);
    expect(raw.active).toEqual(BAD_ACTIVE_RAW);
  });
});
