import { beforeEach, describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { clearRecentTracesForTesting, recentDroppedTraces } from './dropped-record.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, fakeScriptedSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';

const COLLAPSED = `前置き\n${Array.from({ length: 40 }, () => 'court').join('\n')}\n以上`;

async function run(script: ScriptedStep[]) {
  const stores = createMemoryStores();
  const { fn, settled } = fakeScriptedSdk(() => script);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  clone.post(humanMessage('どうなった'));
  await waitForTerminal(events);
  await Promise.all(settled);
  const rows = await stores.journal.list({ types: ['exchange'], with: ['human'], order: 'asc' });
  await clone.stop();
  const texts = rows.flatMap((row) =>
    row.type === 'exchange' && row.role === 'outbound' ? [row.text] : [],
  );
  return { texts, events };
}

describe('クローンの返信の繰り返しの崩壊は、日誌へ書く前に切り詰める（#4142）', () => {
  beforeEach(() => {
    clearRecentTracesForTesting();
  });

  it('崩壊した本文は切り詰めた形で日誌に載り、跡が1行残る（本文は載らない）', async () => {
    const { texts, events } = await run([
      { delta: COLLAPSED },
      { assistant: [{ type: 'text', text: COLLAPSED }] },
    ]);
    const to = '前置き\ncourt\n（以下、同じ「court」が 40 回続いたので省いた）\n以上';
    expect(texts).toEqual([to]);
    // 流れた本文は取り戻せないので、done が「流した本文 → 履歴の本文」を運ぶ（受信行の置き換え用）
    expect(events.find((event) => event.type === 'done')).toEqual({
      type: 'done',
      collapsed: [{ from: COLLAPSED, to }],
    });
    const traces = recentDroppedTraces().filter((line) => line.includes('繰り返しの崩壊'));
    // 人間向けのターンと、同じ台本で走る内部ターン（自律）の両方が通るので、1行以上
    expect(traces.length).toBeGreaterThanOrEqual(1);
    for (const trace of traces) {
      expect(trace).toContain('「court」×40');
      expect(trace).not.toContain('前置き');
    }
  });

  it('崩壊していない本文は1文字も変えず、跡も残さない', async () => {
    const { texts, events } = await run([
      { delta: '普通の返事です' },
      { assistant: [{ type: 'text', text: '普通の返事です' }] },
    ]);
    expect(texts).toEqual(['普通の返事です']);
    expect(events.find((event) => event.type === 'done')).toEqual({ type: 'done' });
    expect(recentDroppedTraces().filter((line) => line.includes('繰り返しの崩壊'))).toEqual([]);
  });
});
