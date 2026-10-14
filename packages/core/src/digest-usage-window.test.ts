import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TZ = 'Asia/Tokyo';
});

import { buildActivityDigest } from './digest.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

async function spend(stores: Stores, date: string, costUsd: number): Promise<void> {
  await stores.usage.record({
    layer: 'manager',
    site: 'session',
    managerId: `mgr-${date}`,
    date,
    at: `${date}T03:00:00.000Z`,
    snapshot: {
      sessionId: `s-${date}`,
      models: {
        opus: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd,
        },
      },
    },
    accumulation: 'oneshot',
  });
}

function usageOf(text: string): string {
  return text.slice(text.indexOf('## 使った分'));
}

describe('digest の「使った分」は、日に揃わない窓では集計した日付を名乗る（#4756）', () => {
  it('⭐ 直近24時間（15:00〜翌15:00）の窓では、日ごとの台帳を2日ぶん足したことと、期間より広いことを書く', async () => {
    const stores = createMemoryStores();
    await spend(stores, '2026-10-05', 1);
    await spend(stores, '2026-10-06', 2);
    const text = await buildActivityDigest(stores, {
      since: new Date('2026-10-05T15:00:00+09:00'),
      until: new Date('2026-10-06T15:00:00+09:00'),
    });
    const usage = usageOf(text);
    expect(usage).toContain('2026-10-05〜2026-10-06');
    expect(usage).toContain('上の期間より広い');
    expect(usage).toContain('合計: $3.00');
  });

  it('日に揃った窓（0時〜0時）では書き添えない（日報の窓）', async () => {
    const stores = createMemoryStores();
    await spend(stores, '2026-10-05', 1);
    const text = await buildActivityDigest(stores, {
      since: new Date('2026-10-05T00:00:00+09:00'),
      until: new Date('2026-10-06T00:00:00+09:00'),
    });
    const usage = usageOf(text);
    expect(usage).not.toContain('上の期間より広い');
    expect(usage).toContain('合計: $1.00');
  });
});
