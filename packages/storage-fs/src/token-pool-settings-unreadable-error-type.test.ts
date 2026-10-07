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
    raw.active = { generation: 1, rotatedAt: '2026-09-01T00:00:00.000Z' };
    await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(stores.tokens.readActive()).rejects.toBeInstanceOf(UnreadableActiveTokenError);
    });
  });
});
