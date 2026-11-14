import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `journal_read` を `types` なしで引いたとき、日々積まれる診断の要約の行（受け取った `diagnostics_summary`・送った結果の `diagnostics_summary_send`）が既定の一覧を埋めない。
// `types` で名指ししたときだけ出る。他の種別（turn_usage など）の出方は変えない。

type Append = Parameters<ReturnType<typeof createMemoryStores>['journal']['append']>[0];

const RECEIVED: Append = {
  type: 'diagnostics_summary',
  source: 'remote.alteroid',
  principalKind: 'integration',
  payload: { period: { start: '2026-11-13T00:00:00.000Z', end: '2026-11-13T23:00:00.000Z' } },
} as Append;

const SENT: Append = {
  type: 'diagnostics_summary_send',
  period: { start: '2026-11-13T00:00:00.000Z', end: '2026-11-14T00:00:00.000Z' },
  outcome: 'failed',
  attempt: 2,
  reason: 'http_5xx',
  httpStatus: 503,
  sinkHost: 'sink.example',
} as Append;

const DECISION: Append = {
  type: 'decision',
  decision: '既定の一覧に出る判断',
  grounds: '根拠',
} as Append;

const TURN_USAGE: Append = {
  type: 'turn_usage',
  layer: 'clone',
  site: 'session',
  managerId: 'clone',
  models: {
    opus: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      webSearchRequests: 0,
      costUsd: 0.01,
    },
  },
} as Append;

async function listing(args: Record<string, unknown>): Promise<string> {
  const stores = createMemoryStores();
  for (const entry of [DECISION, TURN_USAGE, RECEIVED, SENT]) await stores.journal.append(entry);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'journal_read');
  if (!found) throw new Error('journal_read が無い');
  const result = await found.handler(args as never, {});
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

describe('journal_read の既定の一覧から診断の要約の行を外す', () => {
  it('types を省くと、診断の要約（受け取った・送った）の行は出ない。他の種別は今までどおり出る', async () => {
    const text = await listing({});
    expect(text).not.toContain('[diagnostics_summary');
    expect(text).toContain('既定の一覧に出る判断');
    // turn_usage など他の診断の種別は外していない
    expect(text).toContain('[turn_usage');
  });

  it('types で名指しすると出る（受け取った・送った・両方）', async () => {
    expect(await listing({ types: ['diagnostics_summary'] })).toContain(
      '[diagnostics_summary remote.alteroid integration]',
    );
    const sent = await listing({ types: ['diagnostics_summary_send'] });
    expect(sent).toContain('[diagnostics_summary_send failed]');
    expect(sent).toContain('sink.example');
    expect(sent).toContain('http_5xx');
    const both = await listing({ types: ['diagnostics_summary', 'diagnostics_summary_send'] });
    expect(both).toContain('[diagnostics_summary remote.alteroid');
    expect(both).toContain('[diagnostics_summary_send failed]');
  });

  it('語（q）で探す呼びでも、types を省けば診断の要約の行は出ない', async () => {
    const text = await listing({ q: '判断' });
    expect(text).not.toContain('[diagnostics_summary');
    expect(text).toContain('既定の一覧に出る判断');
  });
});
