import { createMemoryStores, failingJournalAppend } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { reportBootToolSearch } from './boot-tool-search.js';

const LINE = 'ToolSearch: クローンの子の env には止める条件が置かれていない';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe('reportBootToolSearch（標準出力と日誌の両方へ、起動を止めずに出す）', () => {
  it('標準出力に alteroidd: の1行を書き、日誌に external_event（source=boot-tool-search）を1行残す', async () => {
    const stores = createMemoryStores();
    const { stdout, stderr, out } = capture();

    await reportBootToolSearch(stores, LINE, out);

    expect(stdout).toEqual([`alteroidd: ${LINE}\n`]);
    expect(stderr).toEqual([]);
    const entries = (await stores.journal.list()).filter(
      (entry) => entry.type === 'external_event' && entry.source === 'boot-tool-search',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ summary: LINE });
  });

  it('⛔ 日誌への追記が失敗しても投げない（起動を止めない）。標準出力へは既に書いている', async () => {
    const stores = failingJournalAppend(createMemoryStores(), '接続がまだ立ち上がっていない');
    const { stdout, stderr, out } = capture();

    await expect(reportBootToolSearch(stores, LINE, out)).resolves.toBeUndefined();

    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('日誌へ残せませんでした');
  });
});
