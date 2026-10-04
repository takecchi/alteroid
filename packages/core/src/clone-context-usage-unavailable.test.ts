import { describe, expect, it } from 'vitest';

import type { AgentCloneDriver } from './agent-clone-session.js';
import { ClaudeCloneDriver } from './claude-clone-driver.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createMemoryStores, humanMessage } from './testing.js';

/** 文脈の使用状況を出せない駆動役は、毎ターンではなく最初の1回だけ「取れない」と日誌へ残す。 */
async function contextUsageRows(unavailable: boolean): Promise<number> {
  const { fn } = fakeSdk();
  const inner = new ClaudeCloneDriver({ queryFn: fn });
  const driver: AgentCloneDriver = {
    providerId: 'claude',
    ...(unavailable ? { providesContextUsage: false as const } : {}),
    open: (spec) => {
      const session = inner.open(spec);
      return {
        readEvents: (onEvent) => session.readEvents(onEvent),
        interrupt: () => session.interrupt(),
        close: () => session.close(),
        contextUsage: () => Promise.reject(new Error('取れない')),
        sessionModelUsage: () => session.sessionModelUsage(),
      };
    },
  };
  const stores = createMemoryStores();
  const clone = createClone({ stores, driver, env: {}, redeliveryGate: ALWAYS_REDELIVER });
  const { events } = wireEvents(clone, 'conv-1');
  for (let i = 0; i < 3; i += 1) {
    events.length = 0;
    clone.post(humanMessage(`やあ${i}`));
    await waitForDone(events);
  }
  const rows = await stores.journal.list({ types: ['context_usage'] });
  await clone.stop();
  return rows.length;
}

describe('クローン — 文脈の使用状況が無い駆動役（Codex）', () => {
  it('providesContextUsage=false なら、context_usage の error 行は最初の1回だけ', async () => {
    expect(await contextUsageRows(true)).toBe(1);
  });

  it('Claude（印なし）は従来どおり毎ターン書く', async () => {
    expect(await contextUsageRows(false)).toBe(3);
  });
});
