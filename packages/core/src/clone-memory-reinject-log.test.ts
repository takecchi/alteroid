import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { MEMORY_INDEX_REINJECTED_PHRASE } from './clone-distill-memory-state.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, wireEvents, waitForDone } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

const SECRET_BODY = 'SECRET-BODY-MARKER';
const SECRET_DESCRIPTION = 'SECRET-DESCRIPTION-MARKER';

describe('クローン — 要約後の記憶の索引の載せ直しを日誌へ1行残す', () => {
  async function twoPremises(): Promise<Stores> {
    const stores = createMemoryStores();
    await stores.persona.write(
      'values',
      `---\ntype: premise\ndescription: ${SECRET_DESCRIPTION}\n---\n## VALUES-HEAD\n${SECRET_BODY}\n`,
    );
    await stores.persona.write(
      'habits',
      '---\ntype: premise\ndescription: 習慣の要旨\n---\n## HABITS-HEAD\n本文\n',
    );
    return stores;
  }

  const VALUES_V2 = `---\ntype: premise\ndescription: ${SECRET_DESCRIPTION}\n---\n## VALUES-HEAD-V2\n${SECRET_BODY}\n`;

  async function firePreCompact(s: Setup): Promise<void> {
    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-index-refresh-log-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );
  }

  async function gaugeTexts(stores: Stores, phrase: string): Promise<string[]> {
    const rows = await stores.journal.list({ types: ['exchange'] });
    return rows.flatMap((row) =>
      row.type === 'exchange' &&
      row.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX) &&
      row.text.includes(phrase)
        ? [row.text]
        : [],
    );
  }

  it('⭐ 載せ直した回の行に記憶の本文・要旨は出ない', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores, {}, {});
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);
    const { events: second } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(second);

    const lines = await gaugeTexts(stores, MEMORY_INDEX_REINJECTED_PHRASE);
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(line).not.toContain(SECRET_BODY);
      expect(line).not.toContain(SECRET_DESCRIPTION);
      expect(line).not.toContain('VALUES-HEAD');
    }

    await s.clone.stop();
  });

  it('⭐ 要約に潰されていない回（refreshIndex が立たない回）は行が書かれない', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores, {}, {});
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', VALUES_V2);
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain('## VALUES-HEAD-V2');
    expect(await gaugeTexts(stores, MEMORY_INDEX_REINJECTED_PHRASE)).toHaveLength(0);

    await s.clone.stop();
  });
});
