import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { fingerprintOf } from './credentials.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — PreCompact サイドセッションの入力を日誌に残す（#243）', () => {
  const TRANSCRIPT = 'PRECOMPACT-TRANSCRIPT-MARKER-7f2a 要約に潰される直前の生ログの中身';

  async function firePreCompact(main: FakeCall, transcript = TRANSCRIPT): Promise<void> {
    const dir = await makeTempDir('alteroid-clone-precompact-turn-input-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, transcript, 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  async function pickEntry(stores: Stores): Promise<string> {
    const entries = await stores.journal.list({ types: ['exchange'] });
    const hit = entries.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.with === 'self' &&
        entry.role === 'inbound' &&
        entry.text.includes('ターンの入力: pre_compact_distill'),
    );
    expect(
      hit,
      '日誌に self/inbound の「ターンの入力: pre_compact_distill」の行が無い',
    ).toBeDefined();
    return hit?.type === 'exchange' ? hit.text : '';
  }

  it('chars と指紋が残り、生ログの本文そのものは載らない', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompact(s.calls[0] as FakeCall);

    const text = await pickEntry(s.stores);

    expect(s.calls[1]?.inputs[0]).toContain(TRANSCRIPT);

    expect(text).toContain(`tail.chars=${TRANSCRIPT.length}`);
    expect(text).toContain(`tail.fp=${fingerprintOf(TRANSCRIPT)}`);
    expect(text).not.toContain(TRANSCRIPT);
    expect(text).not.toContain('PRECOMPACT-TRANSCRIPT-MARKER-7f2a');

    await s.clone.stop();
  });

  it('長さが同じでも内容が違えば指紋が変わる（chars だけでは区別できない）', async () => {
    const a = `${'A'.repeat(30)}-MARK-ONE`;
    const b = `${'B'.repeat(30)}-MARK-TWO`;
    expect(a.length).toBe(b.length);

    async function recordedFingerprint(transcript: string): Promise<string> {
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      await firePreCompact(s.calls[0] as FakeCall, transcript);
      const text = await pickEntry(s.stores);
      await s.clone.stop();
      const match = /tail\.fp=([0-9a-f]+)/u.exec(text);
      if (match?.[1] === undefined) throw new Error('日誌の行に指紋が見つからない');
      return match[1];
    }

    const fpA = await recordedFingerprint(a);
    const fpB = await recordedFingerprint(b);

    expect(fpA).toBe(fingerprintOf(a));
    expect(fpB).toBe(fingerprintOf(b));
    expect(fpA).not.toBe(fpB);
  });
});

describe('クローン — 蒸留の末尾は全文を読まずに取る（渡る量を減らさない）', () => {
  function japaneseTranscript(lines: number): string {
    return Array.from(
      { length: lines },
      (_, i) => `${String(i).padStart(4, '0')}行目の記録である。${'あ'.repeat(180)}`,
    ).join('\n');
  }

  async function firePreCompactWith(main: FakeCall, transcript: string): Promise<void> {
    const dir = await makeTempDir('alteroid-clone-tail-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, transcript, 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('60,000 文字級の日本語でも、渡る末尾は全文を読んだときと同じである', async () => {
    const transcript = japaneseTranscript(500);
    expect(transcript.length).toBeGreaterThan(60_000);
    expect(Buffer.byteLength(transcript, 'utf8')).toBeGreaterThan(transcript.length * 2.5);

    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompactWith(s.calls[0] as FakeCall, transcript);

    const rows = (await s.stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => entry.type === 'exchange',
    );
    const inputRow = rows.find((entry) => entry.text.includes('ターンの入力: pre_compact_distill'));
    expect(inputRow, '日誌に pre_compact_distill の行が無い').toBeDefined();
    const chars = Number(/tail\.chars=(\d+)/u.exec(inputRow?.text ?? '')?.[1] ?? '0');
    expect(chars).toBeGreaterThan(59_000);
    expect(chars).toBeLessThanOrEqual(60_000);

    const prompt = s.calls[1]?.inputs[0] ?? '';
    expect(prompt).toContain(transcript.slice(-59_000));
    expect(prompt).not.toContain(transcript.slice(0, 200));

    await s.clone.stop();
  });

  it('退避が落ちても蒸留へ進む（PreCompact。文言も2つに割れている）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      archive: {
        archive: async () => {
          throw new Error('退避先が閉じている');
        },
        list: () => stores.archive.list(),
        sessions: () => stores.archive.sessions(),
        read: (id: string) => stores.archive.read(id),
        readTail: (id: string, maxChars: number) => stores.archive.readTail(id, maxChars),
        remove: (id: string) => stores.archive.remove(id),
        clear: () => stores.archive.clear(),
      },
    };

    const s = setup(undefined, broken);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompactWith(s.calls[0] as FakeCall, 'PRECOMPACT-BROKEN-ARCHIVE の生ログ');

    const rows = (await broken.journal.list({ types: ['exchange'] })).filter(
      (entry) => entry.type === 'exchange',
    );
    expect(rows.some((entry) => entry.text.includes('ターンの入力: pre_compact_distill'))).toBe(
      true,
    );
    expect(rows.some((entry) => entry.text.includes('PreCompact の退避に失敗した'))).toBe(true);
    expect(rows.some((entry) => entry.text.includes('PreCompact の蒸留に失敗した'))).toBe(false);

    await s.clone.stop();
  });
});
