import { readFile, writeFile } from 'node:fs/promises';

import {
  captureStderr,
  UnreadableActiveTokenError,
  UnreadableTokenSettingsError,
} from '@alteroid/core';
import type { AgentToken } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #2053。`readSettings()` / `readActive()` が読めないときに投げる型を
 * `UnreadableTokenSettingsError` / `UnreadableActiveTokenError`
 * （`@alteroid/core`）へ固定する（`UnreadableCommitmentError` /
 * `UnreadablePracticeError` と同じ形）。
 *
 * **この歯には「直す前」に対応する赤が無い。** この2つの型そのものがこの
 * PR で新しく足したもので、直す前の版にはこの import が解決できる状態が
 * 存在しない（`import` の時点で解決に失敗する）。decouple の赤/緑は
 * `token-pool-settings-active-malformed-repro.test.ts`（型を import しない
 * 形）で別に取ってある——そちらが「投げるか」を、こちらが「何を投げるか」
 * を固定する、という役割分担である。
 */
describe('FsTokenPoolStore — readSettings() / readActive() が投げる型（issue #2053）', () => {
  let root: string;
  let tokensPath: string;

  const GOOD_TOKEN: AgentToken = {
    id: 'tok-good',
    label: 'primary',
    value: 'secret-good',
    source: 'stored',
    order: 0,
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    tokensPath = stores.paths.tokens;
    await stores.tokens.replace([GOOD_TOKEN]);
  });

  it('readSettings() は UnreadableTokenSettingsError を投げる', async () => {
    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as Record<string, unknown>;
    raw.settings = { rotateOn: 'not-a-real-policy', cooldownMs: 1000 };
    await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(stores.tokens.readSettings()).rejects.toBeInstanceOf(
        UnreadableTokenSettingsError,
      );
    });
  });

  it('readActive() は UnreadableActiveTokenError を投げる', async () => {
    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as Record<string, unknown>;
    raw.active = { generation: 1, rotatedAt: '2026-09-01T00:00:00.000Z' }; // tokenId 欠落
    await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(stores.tokens.readActive()).rejects.toBeInstanceOf(UnreadableActiveTokenError);
    });
  });
});
