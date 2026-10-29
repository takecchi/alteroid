import { describe, expect, it } from 'vitest';

import type { AgentCloneDriver } from './agent-clone-session.js';
import { ClaudeCloneDriver } from './claude-clone-driver.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createMemoryStores, humanMessage } from './testing.js';

async function contextUsageRows(): Promise<number> {
  const { fn } = fakeSdk();
  const inner = new ClaudeCloneDriver({ queryFn: fn });
  const driver: AgentCloneDriver = {
    providerId: 'claude',
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
  const clone = createClone({ stores, driver, env: {} });
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

describe('クローン — 文脈の使用状況が取れない駆動役', () => {
  it('取れなくても毎ターン聞き、context_usage の error 行を毎ターン書く', async () => {
    expect(await contextUsageRows()).toBe(3);
  });
});
