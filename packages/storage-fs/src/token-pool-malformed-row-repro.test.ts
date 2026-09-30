import { readFile, writeFile } from 'node:fs/promises';

import { captureStderr } from '@alteroid/core';
import type { AgentToken } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1942（#1868 / PR #1884、#1928 / PR #1930 と同じ形の穴）。
 *
 * `FsTokenPoolStore#read()` の `fileSchema` は `tokens` 配列を
 * `z.array(agentTokenRowSchema)` で1回に検査していた。既知の互換形
 * （`source: 'env'`。器の環境変数を指していた廃止済みの行）だけは通すが、
 * それ以外の不正な形（欄の欠落・型違い）には無防備で、**1行でも合わなければ
 * `list()` / `readSettings()` / `writeSettings()` / `readActive()` /
 * `writeActive()` が丸ごと例外を投げ、正しい行も読めなくなっていた**
 * ——`#read()` が `tokens` / `settings` / `active` を同時に返す1つの関数
 * だからである。
 *
 * pg 版（`PgTokenPoolStore`）は正規化された列を持つので、そもそも「1行の
 * 不正が他の行を道連れにする」形をしていない。fs の jobs/approvals
 * （#1868 / #1928）・fs の credentials（#1740）と同じ「その行だけを飛ばし、
 * 残りは返す。書き戻しでは元の形のまま保つ」に tokens.json もそろえる。
 */
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

  // order（必須・整数）が文字列——版ずれ・手編集を模す。
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

  /**
   * tokens.json を、正しい token 1件・schema に合わない token 1件で直接作る
   * （手編集・版ずれを模す）。
   */
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
    // ファイルが無い（本当に0件）ときも空。
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

  it(
    'replace() は全文置換——呼び手が正本の全体を渡す操作なので、古い壊れた行も' +
      '一緒に置き換わる（残さない）',
    async () => {
      await writeRawTokensFile();
      const stores = createFsStores(root);

      await captureStderr(async () => {
        await stores.tokens.replace([{ ...GOOD_TOKEN, label: 'renamed' }]);
      });

      const raw = JSON.parse(await readFile(tokensPath, 'utf8')) as { tokens: unknown[] };
      expect(raw.tokens.map((row) => (row as { id?: unknown }).id)).toEqual(['tok-good']);
    },
  );
});
