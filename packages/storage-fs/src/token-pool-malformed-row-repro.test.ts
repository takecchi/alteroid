import { readFile, writeFile } from 'node:fs/promises';

import { captureStderr } from '@alteroid/core';
import type { AgentToken } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsTokenPoolStore — tokens.json の不正な1行を読み飛ばす（issue #1942）', () => {
  let root: string;
  let tokensPath: string;

  const GOOD_TOKEN: AgentToken = {
    id: 'tok-good',
    label: 'primary',
    value: 'secret-good（この文字列がそのまま跡に出てはいけない）',
    source: 'stored',
    order: 0,
  };

  const BAD_TOKEN_RAW = {
    id: 'tok-bad',
    label: 'legacy',
    value: 'secret-bad（この文字列も跡に出てはいけない）',
    order: 'not-a-number',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    tokensPath = stores.paths.tokens;
  });

  async function writeRawTokensFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.tokens.replace([GOOD_TOKEN]);
    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as { tokens: unknown[] };
    raw.tokens.push(BAD_TOKEN_RAW);
    await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  it('list() は不正な行があっても落ちず、正しい行だけを返す', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    let list: AgentToken[] = [];
    await captureStderr(async () => {
      list = await stores.tokens.list();
    });

    expect(list.map((t) => t.id)).toEqual(['tok-good']);
  });

  it('listUnreadable() は飛ばした行を id・ラベル・不正な欄名だけで返す。value は載らない（issue #2346）', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    let rows: Awaited<ReturnType<typeof stores.tokens.listUnreadable>> = [];
    await captureStderr(async () => {
      rows = await stores.tokens.listUnreadable();
    });

    expect(rows).toEqual([{ id: 'tok-bad', label: 'legacy', reason: '不正な欄: order' }]);
    expect(JSON.stringify(rows)).not.toContain(BAD_TOKEN_RAW.value);
    expect(JSON.stringify(rows)).not.toContain(GOOD_TOKEN.value as string);
  });

  it('対照: 不正な行が無ければ listUnreadable() は空（issue #2346）', async () => {
    const stores = createFsStores(root);
    await stores.tokens.replace([GOOD_TOKEN]);

    expect(await stores.tokens.listUnreadable()).toEqual([]);
    expect(
      await createFsStores(await makeTempDir('alteroid-test-')).tokens.listUnreadable(),
    ).toEqual([]);
  });

  it('readSettings() / readActive() は不正な行があっても落ちない', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(stores.tokens.readSettings()).resolves.toBeDefined();
      await expect(stores.tokens.readActive()).resolves.toBeNull();
    });
  });

  it('跡: 飛ばした行を stderr へ1行出す。value は絶対に含めない', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.tokens.list();
    });
    const joined = lines.join('');

    expect(joined).toContain('tok-bad');
    expect(joined).not.toContain(BAD_TOKEN_RAW.value);
    expect(joined).not.toContain(GOOD_TOKEN.value as string);
  });

  it('writeSettings() は投げない。書いた後も不正な行が元の形のまま残る', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await stores.tokens.writeSettings({ rotateOn: 'overage_exhausted', cooldownMs: 1000 });
    });

    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as { tokens: unknown[] };
    const badRow = raw.tokens.find(
      (row) =>
        typeof row === 'object' && row !== null && (row as { id?: unknown }).id === 'tok-bad',
    );
    expect(badRow).toEqual(BAD_TOKEN_RAW);
  });

  it('replace() は読めた行を全文置換するが、読めない行は消さず、元の形のまま持ち越す（issue #2354）', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await stores.tokens.replace([{ ...GOOD_TOKEN, label: 'renamed' }]);
    });

    const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as { tokens: unknown[] };
    expect(raw.tokens.map((row) => (row as { id?: unknown }).id).sort()).toEqual([
      'tok-bad',
      'tok-good',
    ]);
    expect(raw.tokens.find((row) => (row as { id?: unknown }).id === 'tok-bad')).toEqual(
      BAD_TOKEN_RAW,
    );
    expect(
      (raw.tokens.find((row) => (row as { id?: unknown }).id === 'tok-good') as { label: string })
        .label,
    ).toBe('renamed');
  });

  it('replace([]) でも、読めた行は空になり、読めない行は残る（issue #2354）', async () => {
    await writeRawTokensFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      expect(await stores.tokens.replace([])).toEqual([]);
      expect((await stores.tokens.listUnreadable()).map((row) => row.id)).toEqual(['tok-bad']);
    });
  });

  describe('removeUnreadable()（issue #2354）', () => {
    it('id で指した読めない行だけを消す。読めた行は残り、消した id を返す。値は返さない', async () => {
      await writeRawTokensFile();
      const stores = createFsStores(root);

      await captureStderr(async () => {
        const removed = await stores.tokens.removeUnreadable(['tok-bad']);
        expect(removed).toEqual(['tok-bad']);
        expect(JSON.stringify(removed)).not.toContain(BAD_TOKEN_RAW.value);
        expect(await stores.tokens.listUnreadable()).toEqual([]);
        expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-good']);
      });
      const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as { tokens: unknown[] };
      expect(raw.tokens.map((row) => (row as { id?: unknown }).id)).toEqual(['tok-good']);
    });

    it('知らない id は何も消さず、空を返す。読めた行の id を指しても消えない', async () => {
      await writeRawTokensFile();
      const stores = createFsStores(root);

      await captureStderr(async () => {
        expect(await stores.tokens.removeUnreadable(['no-such-id', 'tok-good'])).toEqual([]);
        expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-good']);
        expect((await stores.tokens.listUnreadable()).map((r) => r.id)).toEqual(['tok-bad']);
      });
    });

    it('id が取れない読めない行は、この口では消せない（残る）', async () => {
      await writeRawTokensFile();
      const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as { tokens: unknown[] };
      raw.tokens.push({ label: 'no-id', value: 'secret-noid', order: 'x' });
      await writeFile(tokensPath, `${JSON.stringify(raw, null, 2)}\n`);
      const stores = createFsStores(root);

      await captureStderr(async () => {
        expect(await stores.tokens.removeUnreadable(['tok-bad', ''])).toEqual(['tok-bad']);
        const left = await stores.tokens.listUnreadable();
        expect(left).toEqual([{ label: 'no-id', reason: '不正な欄: id,order' }]);
      });
    });
  });
});
