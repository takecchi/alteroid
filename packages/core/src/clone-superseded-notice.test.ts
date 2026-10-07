import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { JobStatus } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(): Fake {
  const inputs: string[] = [];
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
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

function summary(id: string, status: JobStatus, live: boolean): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
  };
}

function stubPool(managers: ManagerSummary[]): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () => Promise.resolve(managers),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: [
          {
            label: 'runner-0',
            state: 'connected' as RunnerLiveness,
            since: '2026-09-05T00:00:00.000Z',
            managers: [],
            revision: { status: 'unheard' as const },
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

function bootClone(stores: Stores, managers: ManagerPool): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

const AT = '2026-09-05T00:00:00.000Z';
const MANAGER_ID = 'mgr-run';

function pool(): ManagerPool {
  return stubPool([summary(MANAGER_ID, 'running', true)]);
}

describe('後続の報告が台帳に在るとき、プロンプトに件数の行が出る', () => {
  it('先に積んである「未来」の報告を数えて件数の行を出す', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'evt-future',
      at: '2026-09-05T00:05:00.000Z',
      origin: 'manager',
      source: MANAGER_ID,
      body: '[report] 先に進んでいた',
    });
    const s = bootClone(stores, pool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-old',
      at: AT,
      managerId: MANAGER_ID,
      kind: 'report',
      text: '拾い直された古い報告',
    });
    await waitFor(() => s.inputs.length > 0, '1本目のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain(`この委譲（${MANAGER_ID}）`);
    expect(text).toContain('報告が 1 件届いている');
    expect(text).toContain('2026-09-05T00:05:00.000Z');

    await s.clone.stop();
  });
});

describe('後続が0件で数え切れたときは、プロンプトを1文字も変えない', () => {
  it('台帳に他の行が無ければ、この節の語彙がプロンプトに1つも現れない', async () => {
    const s = bootClone(createMemoryStores(), pool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-only',
      at: AT,
      managerId: MANAGER_ID,
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターン');

    const text = s.inputs.join('\n');
    // 番兵を主題語（後続）にする: 文面の断片だと、describeSuperseded が別の文言を返す変異で緑のままになるため
    expect(text).not.toContain('後続');
    expect(text).not.toContain('この合図より後');
    expect(text).toContain('終わった');

    await s.clone.stop();
  });
});

describe('台帳（stores.commitments）が読めなくても、受信箱のループは死なない', () => {
  it('list() が投げても、uncountable の文が出て、次の合図もちゃんと処理される', async () => {
    const stores = createMemoryStores();
    stores.commitments.list = () => Promise.reject(new Error('台帳が壊れている（実測を模す）'));
    const s = bootClone(stores, pool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-1',
      at: AT,
      managerId: MANAGER_ID,
      kind: 'report',
      text: '終わった1',
    });
    await waitFor(() => s.inputs.length > 0, '1本目のターン');

    const first = s.inputs[0];
    expect(first).toContain('数えられなかった');
    expect(first).toContain('台帳が壊れている（実測を模す）');
    expect(first).toContain('「0 件」ではなく');

    s.clone.post({
      type: 'human_message',
      id: 'evt-2',
      at: AT,
      text: '次の合図はちゃんと届く',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 1, '2本目のターン');
    expect(s.inputs[1]).toContain('次の合図はちゃんと届く');

    await s.clone.stop();
  });
});
