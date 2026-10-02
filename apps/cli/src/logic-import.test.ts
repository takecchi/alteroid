/**
 * `@alteroid/logic` を `apps/cli` から import できること（#2558）の歯。
 *
 * `@alteroid/logic` はビルドせず `.ts` のまま export している。`apps/cli` は NodeNext
 * なので、logic の中に拡張子の無い相対 import が1つでも入ると、`tsc --noEmit` が
 * `TS2835` で落ちる（このファイルが型検査に載るので、そこで赤になる）。logic が DOM の
 * 型（`location`）や vite の型を前提にして CLI の型検査を壊した場合も同じ。
 *
 * 値も1つ実際に呼ぶ（vitest が `.js` → `.ts` を解決できることも、ここで測る）。
 */
import { formatBytes, summarizeJournalEntry } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

describe('@alteroid/logic を CLI から読める', () => {
  it('純関数を呼べる', () => {
    expect(
      summarizeJournalEntry({
        type: 'decision',
        id: 'd1',
        at: '2026-10-02T00:00:00.000Z',
        decision: '進める',
        grounds: '根拠',
      }),
    ).toBe('進める（根拠: 根拠）');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
