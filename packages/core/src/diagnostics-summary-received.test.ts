import { describe, expect, it } from 'vitest';

import { parseJournalJsonl } from './diagnostics-analysis.js';
import { buildDiagnosticsSummary, type DiagnosticsSummary } from './diagnostics-summary.js';
import {
  compareDiagnosticsSummaries,
  describeDiagnosticsSummaryDigest,
  renderSummaryComparison,
} from './diagnostics-summary-format.js';
import { journalEntrySchema } from './schema.js';
import { SEARCHABLE_FIELDS_BY_TYPE, matchesJournalSearch } from './journal-search.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const MARKER_MANAGER = 'zzmarker-manager-unique';

const usageRow = (at: string, read: number, creation: number, managerId = 'mgr-a') => ({
  type: 'turn_usage',
  id: `u-${at}`,
  at,
  layer: 'clone',
  site: 'session',
  managerId,
  models: {
    opus: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: creation,
      webSearchRequests: 0,
      costUsd: 0,
    },
  },
});

const summaryOf = (rows: object[]): DiagnosticsSummary =>
  buildDiagnosticsSummary(
    { journal: parseJournalJsonl(rows.map((r) => JSON.stringify(r)).join('\n')) },
    { now: NOW },
  );

const A = summaryOf([
  usageRow('2026-11-01T00:00:00.000Z', 300, 100, MARKER_MANAGER),
  usageRow('2026-11-01T05:00:00.000Z', 100, 100, MARKER_MANAGER),
]);
const EMPTY_TIMING_ONLY = summaryOf([
  {
    type: 'turn_timing',
    id: 't1',
    at: '2026-11-02T00:00:00.000Z',
    triggers: ['manager_message'],
    batchSize: 1,
    succeeded: true,
    totalMs: 10,
  },
]);

describe('診断の要約の日誌の行の型', () => {
  it('journalEntrySchema が読める。検索欄を持たず、`summary` という欄名を使わない（q= の雑音にならない）', () => {
    const row = {
      type: 'diagnostics_summary',
      id: 'x',
      at: NOW.toISOString(),
      source: 's',
      principalKind: 'integration',
      keyId: 'k',
      payload: A,
    };
    expect(journalEntrySchema.safeParse(row).success).toBe(true);
    expect(SEARCHABLE_FIELDS_BY_TYPE.diagnostics_summary).toEqual([]);
    expect(Object.keys(row)).not.toContain('summary');
    // 本体の中の語（managerId）は q で当たらない
    expect(matchesJournalSearch(row, MARKER_MANAGER)).toBe(false);
    expect(matchesJournalSearch(row, 'turn_usage')).toBe(false);
  });
});

describe('要点の1行・比較', () => {
  it('1行（改行なし）に period と要点の数字。読めない形は読めないと言う', () => {
    const line = describeDiagnosticsSummaryDigest(A);
    expect(line).not.toContain('\n');
    expect(line).toContain('2026-11-01T00:00:00.000Z〜2026-11-01T05:00:00.000Z');
    expect(line).toContain('読み出し率 ');
    expect(describeDiagnosticsSummaryDigest({ nope: 1 })).toContain('読めない');
  });

  it('取れない（null）は 0 にせず「取れない」と出し、差は出さない', () => {
    const line = describeDiagnosticsSummaryDigest(EMPTY_TIMING_ONLY);
    // turn_usage が無い要約: 読み出し率は null
    expect(line).toContain('読み出し率 取れない');
    expect(line).not.toContain('読み出し率 0');
    const cmp = compareDiagnosticsSummaries(
      { id: 'a', at: 't', source: 's', summary: A },
      { id: 'b', at: 't', source: 's', summary: EMPTY_TIMING_ONLY },
    );
    const rate = cmp.metrics.find((m) => m.label === 'キャッシュの読み出し率');
    expect(rate?.a).toBeGreaterThan(0);
    expect(rate).toMatchObject({ b: null, diff: null });
    const text = renderSummaryComparison(cmp);
    expect(text).toContain('→ 取れない（差は取れない）');
    expect(text).not.toMatch(/読み出し率: .* → 0\.0%/);
  });

  it('同じ source でない2件は比べない', () => {
    expect(() =>
      compareDiagnosticsSummaries(
        { id: 'a', at: 't', source: 's1', summary: A },
        { id: 'b', at: 't', source: 's2', summary: A },
      ),
    ).toThrow(/source が違う/);
  });
});

describe('journal_read: 診断の要約は一覧で1行に畳み、全文は id 指定で出る', () => {
  async function setup() {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '判断A', grounds: '根拠A' });
    const row = await stores.journal.append({
      type: 'diagnostics_summary',
      source: 'remote.alteroid',
      principalKind: 'integration',
      keyId: 'k1',
      payload: A,
    });
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const read = async (args: Record<string, unknown>) => {
      const found = tools.find((t) => t.name === 'journal_read');
      if (!found) throw new Error('journal_read が無い');
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    };
    return { row, read };
  }

  it('一覧には全文（本体の欄）が出ず、source・period・数字の1行だけ', async () => {
    const { row, read } = await setup();
    const listing = await read({});
    expect(listing).toContain('[diagnostics_summary remote.alteroid integration]');
    expect(listing).toContain(`id=${row.id}`);
    expect(listing).toContain('period=2026-11-01T00:00:00.000Z');
    expect(listing).not.toContain(MARKER_MANAGER);
    expect(listing).not.toContain('schemaVersion');
    expect(listing.length).toBeLessThan(1500);
  });

  it('id 指定では全文が出る（頁送りで続きが取れる）', async () => {
    const { row, read } = await setup();
    const detail = await read({ id: row.id });
    expect(detail).toContain('schemaVersion');
    expect(detail).toContain(MARKER_MANAGER);
  });

  it('既存の型の行の見え方は、診断の要約の行があっても変わらない', async () => {
    const { read } = await setup();
    const withDiag = await read({ types: ['decision'] });
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '判断A', grounds: '根拠A' });
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((t) => t.name === 'journal_read');
    const result = await found!.handler({ types: ['decision'] } as never, {});
    const alone = (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    const strip = (s: string) =>
      s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/id=\S+/g, 'id');
    expect(strip(withDiag)).toBe(strip(alone));
  });
});
