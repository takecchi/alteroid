import { describe, it, expect } from 'vitest';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForTerminal } from './clone-test-harness.js';

describe('クローン — 例外だけで来た 429 も枠として扱う（#4879）', () => {
  const rateLimit429 =
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account rate limit."}}';
  const serverError500 =
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';

  it('例外が 429 の形なら、usage_limited が error より先に届き、合図は未読のまま保持される', async () => {
    const s = setup(undefined, createMemoryStores(), { failWith: rateLimit429 });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    const usageLimitedIndex = s.events.findIndex((e) => e.type === 'usage_limited');
    const errorIndex = s.events.findIndex((e) => e.type === 'error');
    expect(usageLimitedIndex).toBeGreaterThanOrEqual(0);
    expect(usageLimitedIndex).toBeLessThan(errorIndex);
    expect(s.clone.usageBlocked).toBe(true);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === event.id);
    }, '枠に当たった合図が未読として残る');

    const gauges = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[]
    ).filter((entry) => entry.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX));
    expect(gauges).toHaveLength(1);

    await s.clone.stop();
  });

  it('対照: 例外が 500 なら枠の印を立てない', async () => {
    const s = setup(undefined, createMemoryStores(), { failWith: serverError500 });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(false);
    expect(s.clone.usageBlocked).toBe(false);

    await s.clone.stop();
  });
});
