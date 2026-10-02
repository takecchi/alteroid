import { describe, expect, it } from 'vitest';

import type { AgentProvider } from './agent-ports.js';
import { NO_CAPABILITIES } from './agent-ports.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, wireEvents, waitForDone, waitForTerminal } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { CLONE_ACTOR_ID } from './usage.js';

/**
 * 台帳の「取れなかった」（Issue #486 M7）。**消費を報告しない provider
 * （`capabilities.usage === false`）のターンだけを `recordUnmetered` で数え、
 * `usage_daily` に 0 を積まない。** 起こす条件は `usage === undefined` ではない
 * （Claude の失敗した result も usage が無いが、無報告ではない）。
 */
const UNMETERED_PROVIDER: AgentProvider = {
  id: 'claude', // AgentProviderId は現状 'claude' のみ。条件が見るのは capabilities だけ
  displayName: 'Unmetered fake',
  capabilities: { ...NO_CAPABILITIES },
};

function build(
  provider: Pick<AgentProvider, 'id' | 'capabilities'> | undefined,
  sdkOptions: Parameters<typeof fakeSdk>[1],
) {
  const stores = createMemoryStores();
  const { fn } = fakeSdk(undefined, sdkOptions);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    ...(provider === undefined ? {} : { provider }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, events };
}

describe('クローンの無報告ターン（capabilities.usage === false）', () => {
  it('無報告の provider は「取れなかった」として数え、usage_daily にも usage_turns にも 0 を積まない', async () => {
    const s = build(UNMETERED_PROVIDER, {});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const aggregate = await s.stores.usage.aggregate({});
    expect(aggregate.unmeteredRows).toEqual([
      expect.objectContaining({
        layer: 'clone',
        site: 'session',
        managerId: CLONE_ACTOR_ID,
        provider: 'claude',
        turns: 1,
      }),
    ]);
    // 0 の行を作らない（0 を積むと、その層が安いと読める）。
    expect(aggregate.rows).toEqual([]);
    expect(aggregate.turnRows).toEqual([]);
    expect(aggregate.since).toBeNull();

    await s.clone.stop();
  });

  it('Claude（既定）は無報告に数えない: 成功ターンでも、鍵が出ない', async () => {
    const s = build(undefined, {
      modelUsage: () => ({
        opus: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.1,
        },
      }),
    });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const aggregate = await s.stores.usage.aggregate({});
    expect(aggregate.rows).toHaveLength(1);
    expect(aggregate).not.toHaveProperty('unmeteredRows');
    await s.clone.stop();
  });

  it('Claude の失敗した result（usage 無し）は無報告に数えない', async () => {
    const s = build(CLAUDE_PROVIDER, { resultSubtype: 'error_during_execution' });
    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const aggregate = await s.stores.usage.aggregate({});
    expect(aggregate).not.toHaveProperty('unmeteredRows');
    expect(aggregate.rows).toEqual([]);
    await s.clone.stop();
  });
});
