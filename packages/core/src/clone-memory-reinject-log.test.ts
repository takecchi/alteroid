import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { MEMORY_UNCHANGED_SINCE_BAKED_NOTICE } from './clone.js';
import {
  MEMORY_INDEX_NOT_REINJECTED_PHRASE,
  MEMORY_INDEX_REINJECTED_PHRASE,
} from './clone-distill-memory-state.js';
import {
  EXCHANGE_KIND_GAUGE_PREFIX,
  MEMORY_INDEX_NOT_REINJECTED_JOURNAL_HEAD,
  MEMORY_INDEX_REINJECTED_JOURNAL_HEAD,
} from './exchange-kind.js';
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

  it('⭐ 載せ直した回: 載せ直したこと・違った文書の slug と種類・文字数・全文書数が1行で残る', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', VALUES_V2);
    await stores.persona.write(
      'newcomer',
      '---\ntype: premise\ndescription: 新参\n---\n## NEW-HEAD\n本文\n',
    );
    await stores.persona.remove('habits');
    await firePreCompact(s);

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('いまの索引を丸ごと載せ直す');

    const lines = await gaugeTexts(stores, MEMORY_INDEX_REINJECTED_PHRASE);
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line.startsWith(MEMORY_INDEX_REINJECTED_JOURNAL_HEAD)).toBe(true);
    expect(line).toContain('values（内容が変わった）');
    expect(line).toContain('newcomer（焼いた時点に無かった）');
    expect(line).toContain('habits（消えた）');
    expect(line).toMatch(/全文書数 2/);
    const chars = /載せ直した文字数 (\d+)/.exec(line);
    expect(chars).not.toBeNull();
    expect(Number(chars?.[1])).toBeGreaterThan(0);
    expect(await gaugeTexts(stores, MEMORY_INDEX_NOT_REINJECTED_PHRASE)).toHaveLength(0);

    await s.clone.stop();
  });

  it('⭐ 載せ直さなかった回: 載せ直さなかったこと・文字数 0・全文書数が1行で残る', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain(MEMORY_UNCHANGED_SINCE_BAKED_NOTICE);

    const lines = await gaugeTexts(stores, MEMORY_INDEX_NOT_REINJECTED_PHRASE);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(MEMORY_INDEX_NOT_REINJECTED_JOURNAL_HEAD)).toBe(true);
    expect(lines[0]).toContain('載せ直した文字数 0');
    expect(lines[0]).toContain('全文書数 2');
    expect(await gaugeTexts(stores, MEMORY_INDEX_REINJECTED_PHRASE)).toHaveLength(0);

    await s.clone.stop();
  });

  it('⭐ どちらの行にも記憶の本文・要旨は出ない', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);
    const { events: second } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(second);

    await stores.persona.write('values', VALUES_V2);
    await firePreCompact(s);
    const { events: third } = wireEvents(s.clone, 'conv-3');
    s.clone.post(humanMessage('3回目', 'conv-3'));
    await waitForDone(third);

    const lines = [
      ...(await gaugeTexts(stores, MEMORY_INDEX_NOT_REINJECTED_PHRASE)),
      ...(await gaugeTexts(stores, MEMORY_INDEX_REINJECTED_PHRASE)),
    ];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(SECRET_BODY);
      expect(line).not.toContain(SECRET_DESCRIPTION);
      expect(line).not.toContain('VALUES-HEAD');
    }

    await s.clone.stop();
  });

  it('⭐ 日誌が書けなくても、会話へ載るものは変わらない（載せ直す回・載せ直さない回の両方）', async () => {
    const stores = await twoPremises();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const s = setup(undefined, stores);
      s.clone.post(humanMessage('1回目'));
      await waitForDone(s.events);
      vi.spyOn(stores.journal, 'append').mockRejectedValue(new Error('journal down'));

      await firePreCompact(s);
      const { events: second } = wireEvents(s.clone, 'conv-2');
      s.clone.post(humanMessage('2回目', 'conv-2'));
      await waitForDone(second);
      expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain(
        MEMORY_UNCHANGED_SINCE_BAKED_NOTICE,
      );

      await stores.persona.write('values', VALUES_V2);
      await firePreCompact(s);
      const { events: third } = wireEvents(s.clone, 'conv-3');
      s.clone.post(humanMessage('3回目', 'conv-3'));
      await waitForDone(third);
      const input = (s.calls[0] as FakeCall).inputs[2] ?? '';
      expect(input).toContain('いまの索引を丸ごと載せ直す');
      expect(input).toContain('## VALUES-HEAD-V2');
      expect(input).toContain('3回目');

      await s.clone.stop();
    } finally {
      stderr.mockRestore();
    }
  });

  it('⭐ 要約に潰されていない回（refreshIndex が立たない回）は行が書かれない', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', VALUES_V2);
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain('## VALUES-HEAD-V2');
    expect(await gaugeTexts(stores, MEMORY_INDEX_REINJECTED_PHRASE)).toHaveLength(0);
    expect(await gaugeTexts(stores, MEMORY_INDEX_NOT_REINJECTED_PHRASE)).toHaveLength(0);

    await s.clone.stop();
  });
});
