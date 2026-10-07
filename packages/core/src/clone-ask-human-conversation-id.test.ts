import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';

function setupWithToolCalls(callInTurn: (context: ToolContext) => Promise<unknown>) {
  const stores = createMemoryStores();
  let captured: ToolContext | undefined;
  const calls: Promise<unknown>[] = [];
  const { fn } = fakeSdk(() => {
    if (captured !== undefined && calls.length === 0) calls.push(callInTurn(captured));
    return '確認を積んだ';
  });
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, events, calls };
}

describe('会話のターンの中の ask_human は承認の行に会話 id を残す（#768）', () => {
  it('ask_human: 積んだ行にも、回答したあとの行にも conversationId が付く', async () => {
    const s = setupWithToolCalls(async (context) => {
      const tool = createCloneTools(context).find((t) => t.name === 'ask_human');
      return tool?.handler({ question: '本番に出してよいか' } as never, {});
    });
    s.clone.post(humanMessage('進めてよいか確認して'));
    await waitForDone(s.events);
    await Promise.all(s.calls);

    const [pending] = (await s.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(pending?.question).toBe('本番に出してよいか');
    expect(pending?.conversationId).toBe('conv-1');

    await s.clone.answerApproval(pending?.id ?? '', 'はい');
    const answered = await s.stores.jobs.getApproval(pending?.id ?? '');
    expect(answered?.answeredAt).toBeDefined();
    expect(answered?.conversationId).toBe('conv-1');
    await s.clone.stop();
  });

  it('request_permission も同じ（会話のターンの中なら会話 id が付く）', async () => {
    const s = setupWithToolCalls(async (context) => {
      const tool = createCloneTools(context).find((t) => t.name === 'request_permission');
      return tool?.handler(
        {
          rule: 'Bash(gh release edit:*)',
          allows: ['gh release edit v1 --draft'],
          denies: ['gh release delete v1'],
          reason: 'リリースの下書きを直したい',
        } as never,
        {},
      );
    });
    s.clone.post(humanMessage('下書きを直して'));
    await waitForDone(s.events);
    await Promise.all(s.calls);

    const [pending] = (await s.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(pending?.permissionRequest).toBeDefined();
    expect(pending?.conversationId).toBe('conv-1');
    await s.clone.stop();
  });
});
