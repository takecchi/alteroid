import { describe, expect, it } from 'vitest';

import { describeLoopStall, type LoopStall } from './loop-stall.js';
import { journalEntrySchema } from './schema.js';

// 日誌の `loop-stall` の行は `external_event`（`source: 'loop-stall'`）の自由文 `summary` で、専用の欄を持たない。
// 印（`notePhase`）を外したので、新しい行からは「直前の印」「窓の中の印」「最も長い印の無い間」の文が消える。
// 外す前に書かれた古い行もそのまま読めること（行の形が変わらないこと）を縛る。

const OLD_SUMMARY =
  'イベントループが 2000ms 止まった（2026-10-15T14:32:10.000Z から）。' +
  '直前の印: runner-event-settled:tool_use（見張りが最後に回った時刻の 500ms 前）。' +
  '窓の中の印: runner-event:mirror:120B@+1500ms → runner-event-handled:mirror@+1500ms。' +
  '最も長い印の無い間: +1500ms から 1000ms（その前の印: runner-event:mirror:120B）。' +
  '窓の中の GC: 1 回・合計 1ms・最大 1ms。' +
  '窓 2500ms の中でこのプロセスが使った CPU: user 6ms・system 5ms。' +
  '器の CPU の絞り（直近 500ms）: 0ms・0 周期。' +
  'ヒープ 220/225MB・RSS 407MB。';

const STALL: LoopStall = {
  stalledMs: 2_000,
  since: '2026-11-13T00:00:00.000Z',
  gcCount: 1,
  gcTotalMs: 1,
  gcMaxMs: 1,
  heapUsedMb: 220,
  heapTotalMb: 225,
  rssMb: 407,
  cpuUserMs: 1_200,
  cpuSystemMs: 0,
  windowMs: 2_500,
};

function row(summary: string): unknown {
  return {
    type: 'external_event',
    id: 'row-1',
    at: '2026-11-13T00:00:00.000Z',
    source: 'loop-stall',
    summary,
  };
}

describe('日誌の loop-stall の行（印を外した後も古い行を読める）', () => {
  it('印の文を含む古い行も、印の文を含まない新しい行も、同じ external_event として読める', () => {
    const oldRow = journalEntrySchema.parse(row(OLD_SUMMARY));
    expect(oldRow).toMatchObject({ type: 'external_event', source: 'loop-stall' });
    expect((oldRow as { summary: string }).summary).toContain(
      '直前の印: runner-event-settled:tool_use',
    );

    const newSummary = describeLoopStall(STALL);
    const newRow = journalEntrySchema.parse(row(newSummary));
    expect(newRow).toMatchObject({ type: 'external_event', source: 'loop-stall' });
    expect(newSummary).toContain('止まった');
    expect(newSummary).not.toContain('直前の印');
    expect(newSummary).not.toContain('窓の中の印');
  });
});
