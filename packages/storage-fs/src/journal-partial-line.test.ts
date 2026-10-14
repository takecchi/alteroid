import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { FsJournalStore } from './journal.js';

describe('FsJournalStore.append — 書きかけの行の後ろに追記しない（#4721）', () => {
  it('⭐ 前の追記が改行を書く前に途切れていても、次の行は読める行として残る', async () => {
    const dir = await makeTempDir('alteroid-journal-partial-');
    const journal = new FsJournalStore(dir);
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(dir, { recursive: true });
    // ディスクフルなどで途中まで書かれた行（改行が無い）
    await writeFile(
      join(dir, `${day}.jsonl`),
      '{"id":"half","at":"2026-10-14T00:00:00.000Z","ty',
      'utf8',
    );

    const appended = await journal.append({
      type: 'decision',
      decision: '次の判断',
      grounds: '根拠',
    });

    const rows = await journal.list();
    expect(rows.map((row) => row.id)).toContain(appended.id);
    const raw = await readFile(join(dir, `${day}.jsonl`), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('改行で終わっているファイル・空のファイルには、余計な空行を足さない', async () => {
    const dir = await makeTempDir('alteroid-journal-partial-');
    const journal = new FsJournalStore(dir);
    const first = await journal.append({ type: 'decision', decision: '一つ目', grounds: '根拠' });
    const second = await journal.append({ type: 'decision', decision: '二つ目', grounds: '根拠' });
    const day = first.at.slice(0, 10);
    const raw = await readFile(join(dir, `${day}.jsonl`), 'utf8');
    expect(raw.split('\n')).toHaveLength(3);
    expect(raw.includes('\n\n')).toBe(false);
    expect((await journal.list()).map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});
