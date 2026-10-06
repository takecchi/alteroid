import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCloneTools } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { FsJournalStore } from './journal.js';

describe('journal_read id=<読めない行> （fs）', () => {
  it('行が在るのに「まだ書かれていない」と言わない', async () => {
    const dir = await makeTempDir('alteroid-aj-');
    await mkdir(dir, { recursive: true });
    const bad = JSON.stringify({
      id: 'bad-1',
      at: '2026-01-01T00:00:00.001Z',
      type: 'no-such-type',
    });
    await writeFile(join(dir, '2026-01-01.jsonl'), `${bad}\n`);
    const journal = new FsJournalStore(dir);
    const tools = createCloneTools({
      stores: { journal } as never,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const tool = tools.find((entry) => entry.name === 'journal_read')!;

    const result = (await tool.handler({ id: 'bad-1' } as never, {} as never)) as {
      content: { text: string }[];
    };
    const reply = result.content.map((part) => part.text).join('');

    expect(reply).not.toContain('まだ書かれていない');
  });
});
