import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone, InvalidApprovalSelectionsError } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ApprovalQuestion, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #2525: 選択肢つきの回答（`selections`）が、`Clone#answerApproval` で
 * 畳んだ文・構造・日誌・受信箱・ターンの入力へどう流れるか。
 * 突き合わせと畳み方そのものの歯は `approval-choices.test.ts`。
 */

const questions: ApprovalQuestion[] = [
  {
    id: 'target',
    prompt: 'デプロイ先',
    options: [
      { id: 'railway', label: 'Railway', recommended: true },
      { id: 'fly', label: 'Fly.io' },
    ],
  },
  {
    id: 'notify',
    prompt: '通知先',
    multiple: true,
    options: [
      { id: 'slack', label: 'Slack' },
      { id: 'mail', label: 'メール' },
    ],
  },
];

function fakeSdk(): { fn: typeof sdkQuery; inputs: string[] } {
  const inputs: string[] = [];
  const forever = new Promise<void>(() => undefined);
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        await forever;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

function boot(stores: Stores): { clone: CloneHost; inputs: string[] } {
  const sdk = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: sdk.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, inputs: sdk.inputs };
}

function seed(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'ap-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    question: 'どうする',
    questions,
    ...overrides,
  };
}

describe('Clone#answerApproval の selections（issue #2525）', () => {
  it('畳んだ文を answer・日誌の escalation・human_answer に入れ、構造は selections に残す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seed());
    const { clone, inputs } = boot(stores);
    const selections = [
      { questionId: 'target', optionIds: ['railway'], other: 'ただし来週' },
      { questionId: 'notify', optionIds: ['slack', 'mail'] },
    ];

    await clone.answerApproval('ap-1', '金曜は避けたい', undefined, selections);
    await waitFor(() => inputs.length > 0, '回答のターンが起きる');

    const folded =
      'Q1 デプロイ先: (a) Railway［推奨］ / その他: ただし来週\n' +
      'Q2 通知先: (a) Slack / (b) メール\n' +
      '補足: 金曜は避けたい';
    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answer).toBe(folded);
    expect(approval?.selections).toEqual(selections);
    expect(approval?.answerDelivery).toBe('delivered');

    const escalation = (await stores.journal.list({ types: ['escalation'] })).find(
      (entry) => entry.type === 'escalation' && entry.answer !== undefined,
    );
    expect(escalation).toMatchObject({ type: 'escalation', answer: folded });

    const [pending] = (await stores.inbox.peekPending()).entries;
    expect(pending?.event).toMatchObject({ type: 'human_answer', answer: folded, selections });

    // ターンの入力: 畳んだ文と構造（id）の両方が読める。
    expect(inputs[0]).toContain(`回答: ${folded}`);
    expect(inputs[0]).toContain('"questionId":"target"');
    expect(inputs[0]).toContain('"optionIds":["slack","mail"]');
  });

  it('selections だけ（補足なし）でも答えられ、未回答の設問は「未回答」', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seed());
    const { clone } = boot(stores);

    await clone.answerApproval('ap-1', '', undefined, [
      { questionId: 'target', optionIds: ['fly'] },
    ]);

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answer).toBe('Q1 デプロイ先: (b) Fly.io\nQ2 通知先: 未回答');
  });

  it('何も答えていない selections は InvalidApprovalSelectionsError で、何も書かない（issue #2582）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seed());
    const { clone } = boot(stores);

    await expect(
      clone.answerApproval('ap-1', ' ', undefined, [
        { questionId: 'target', optionIds: [], other: ' ' },
      ]),
    ).rejects.toBeInstanceOf(InvalidApprovalSelectionsError);

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answeredAt).toBeUndefined();
    expect(approval?.answer).toBeUndefined();
  });

  it('何も選ばず補足だけなら答えられる（issue #2582）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seed());
    const { clone } = boot(stores);

    await clone.answerApproval('ap-1', '金曜は避けたい', undefined, [
      { questionId: 'target', optionIds: [] },
    ]);

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answeredAt).toBeDefined();
    expect(approval?.answer).toContain('補足: 金曜は避けたい');
  });

  it('不正な selections は InvalidApprovalSelectionsError で、何も書かない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seed());
    const { clone } = boot(stores);

    await expect(
      clone.answerApproval('ap-1', '', undefined, [{ questionId: 'nope', optionIds: [] }]),
    ).rejects.toBeInstanceOf(InvalidApprovalSelectionsError);

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answeredAt).toBeUndefined();
    expect(approval?.answer).toBeUndefined();
    expect((await stores.inbox.peekPending()).entries).toEqual([]);
  });

  it('questions を持たない承認待ち（request_permission を含む）への selections は断る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(
      seed({
        questions: undefined,
        permissionRequest: { rule: 'Bash(ls:*)', allows: ['ls'], denies: ['rm'] },
      }),
    );
    const { clone } = boot(stores);

    await expect(
      clone.answerApproval('ap-1', '許可します。', undefined, [
        { questionId: 'target', optionIds: [] },
      ]),
    ).rejects.toBeInstanceOf(InvalidApprovalSelectionsError);
  });

  it('selections を渡さない回答は、今までどおり answer がそのまま回答（selections 欄は付かない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seed());
    const { clone } = boot(stores);

    await clone.answerApproval('ap-1', 'railway で');

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answer).toBe('railway で');
    expect(approval).not.toHaveProperty('selections');
    const [pending] = (await stores.inbox.peekPending()).entries;
    expect(pending?.event).not.toHaveProperty('selections');
  });

  it('落ちた窓の拾い直しでも、構造（selections）が human_answer に載る', async () => {
    const stores = createMemoryStores();
    const selections = [{ questionId: 'target', optionIds: ['railway'] }];
    await stores.jobs.putApproval(
      seed({
        answeredAt: '2026-09-01T00:05:00.000Z',
        answer: 'Q1 デプロイ先: (a) Railway［推奨］\nQ2 通知先: 未回答',
        selections,
        answerDelivery: 'pending',
      }),
    );
    const { inputs } = boot(stores);
    await waitFor(() => inputs.length > 0, '回答のターンが起きる');

    expect(inputs[0]).toContain('"questionId":"target"');
    const [pending] = (await stores.inbox.peekPending()).entries;
    expect(pending?.event).toMatchObject({ type: 'human_answer', selections });
  });
});
