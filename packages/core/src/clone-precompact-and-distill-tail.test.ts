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

  /** `PreCompact` フックを実際に叩いて蒸留のサイドクエリを走らせる。 */
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

  /** 日誌から `pre_compact_distill` の1行を拾う（self/inbound で絞る）。 */
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

    // **先に、本文が実際にそのターン（SDK へ渡った側）には載っていることを
    // 確かめる。** これが無いと下の `not.toContain` は空振りで真になる。
    expect(s.calls[1]?.inputs[0]).toContain(TRANSCRIPT);

    expect(text).toContain(`tail.chars=${TRANSCRIPT.length}`);
    expect(text).toContain(`tail.fp=${fingerprintOf(TRANSCRIPT)}`);
    // **本文そのもの（全文でも抜粋でも）は載らない。**
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

/**
 * 蒸留へ渡す末尾は、**全文を 1 本の文字列にせずに**読む（`readTranscriptTail`）。
 *
 * ## なぜこの歯が要るか
 *
 * `readFile(path, 'utf8')` は中身を 1 本の文字列にするので、JS の文字列の上限
 * （`node:buffer` の `constants.MAX_STRING_LENGTH`）を超えると
 * `ERR_STRING_TOO_LONG` で投げる。**クローンの生ログは 1 本のセッションが伸び続ける
 * 形（resume が同じセッションへ書き足す）なので、伸びるほど確実に当たる側である。**
 *
 * ## ⚠️ この歯が測っているのは「単位」である
 *
 * `tailOf` が切るのは**文字**であってバイトではない。⟹ 末尾から
 * `DISTILL_TRANSCRIPT_TAIL_CHARS` **バイト**だけ読む形へ直すと、日本語混じりの生ログでは
 * 渡る量が 1/3 になる。**そしてそれは赤くならない** —— 短い末尾でも蒸留は成功するので、
 * 失われたことがどこにも出ない。⟹ **だから長さと中身をここで測る。**
 */
describe('クローン — 蒸留の末尾は全文を読まずに取る（渡る量を減らさない）', () => {
  /** 1 行あたり約 200 文字の日本語（1 文字 3 バイト）を並べた生ログ。 */
  function japaneseTranscript(lines: number): string {
    return Array.from(
      { length: lines },
      (_, i) => `${String(i).padStart(4, '0')}行目の記録である。${'あ'.repeat(180)}`,
    ).join('\n');
  }

  /** `PreCompact` フックを実際に叩いて蒸留のサイドクエリを走らせる。 */
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
    // **前提を先に測る。** ここが偽なら、下の歯は単位の取り違えを検出できない。
    expect(transcript.length).toBeGreaterThan(60_000);
    expect(Buffer.byteLength(transcript, 'utf8')).toBeGreaterThan(transcript.length * 2.5);

    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompactWith(s.calls[0] as FakeCall, transcript);

    // **末尾 60,000 文字ぶんが渡っている。** バイトで窓を取ると 20,000 文字台になる。
    const rows = (await s.stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => entry.type === 'exchange',
    );
    const inputRow = rows.find((entry) => entry.text.includes('ターンの入力: pre_compact_distill'));
    expect(inputRow, '日誌に pre_compact_distill の行が無い').toBeDefined();
    const chars = Number(/tail\.chars=(\d+)/u.exec(inputRow?.text ?? '')?.[1] ?? '0');
    expect(chars).toBeGreaterThan(59_000);
    expect(chars).toBeLessThanOrEqual(60_000);

    // **中身も同じである。** 長さだけでは、別の 60,000 文字を渡しても通る。
    const prompt = s.calls[1]?.inputs[0] ?? '';
    expect(prompt).toContain(transcript.slice(-59_000));
    // 渡すのは末尾だけである（全文は渡らない）。
    expect(prompt).not.toContain(transcript.slice(0, 200));

    await s.clone.stop();
  });

  /**
   * **⭐ 退避が落ちても蒸留へ進む**（`#onPreCompact`）。
   *
   * 直す前は 1 つの `try` に (i) 退避と (ii) 蒸留が入っていた。⟹ 全文の `readFile` か
   * `archive` のどちらかが落ちると**蒸留も走らない。** この経路の doc は逐語で
   * 「蒸留は生存条件であり、後回しにしてよい機能ではない」と書いているので、
   * **退避の都合で蒸留が止まる形は、その約束と食い違う。**
   */
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
    // **蒸留は走った**（退避の失敗に巻き込まれていない）。
    expect(rows.some((entry) => entry.text.includes('ターンの入力: pre_compact_distill'))).toBe(
      true,
    );
    // **文言は2つに割れている**（直す前は「退避・蒸留に失敗した」の1本だった）。
    expect(rows.some((entry) => entry.text.includes('PreCompact の退避に失敗した'))).toBe(true);
    expect(rows.some((entry) => entry.text.includes('PreCompact の蒸留に失敗した'))).toBe(false);

    await s.clone.stop();
  });
});

/**
 * 起動時に、**前の器が記憶へ移せなかった区間を拾い直す**（#564 E1b。
 * `#pickUpTranscriptGrave`）。
 *
 * ## なぜ歯が要るか
 *
 * 印（墓標）が立つのは蒸留が落ちた回で、**主な理由は枠が閉じていること**である。
 * 枠は待てば開くが、**拾い直す手が無ければ、開いても誰も戻らない。**
 *
 * ## ⚠️ この歯が測っていないこと
 *
 * **枠が閉じたまま何度も起動する回**は測っていない（印が残り続けることは
 * 「印を下ろすのは成功したときだけ」という1本の条件から出るが、実際に回して
 * いない）。
 */
