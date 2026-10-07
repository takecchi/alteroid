import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyCodexChatgptAuthContract } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsCodexChatgptAuthStore } from './codex-auth.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alteroid-codex-auth-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FsCodexChatgptAuthStore（#3939）', () => {
  it('約束（3実装で同じことを測る）', async () => {
    await verifyCodexChatgptAuthContract(new FsCodexChatgptAuthStore(join(dir, 'a.json')));
  });

  it('正本のファイルは 0600 で置く', async () => {
    const path = join(dir, 'a.json');
    const store = new FsCodexChatgptAuthStore(path);
    await store.replace({
      value: '{}',
      revision: 'r',
      updatedAt: '2026-10-07T00:00:00.000Z',
      email: null,
      planType: null,
      failure: null,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ revision: 'r' });
  });

  it('壊れたファイルは「無い」と混ぜずに投げ、理由に値を載せない', async () => {
    const path = join(dir, 'a.json');
    await writeFile(path, '{"value":"secret-value-xyz"}');
    const store = new FsCodexChatgptAuthStore(path);
    const error = await store.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-value-xyz');
    // ログアウトで壊れた正本を片付けられる。
    expect(await store.remove()).toBe(true);
    expect(await store.get()).toBeNull();
  });
});
