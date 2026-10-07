import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

afterEach(() => vi.useRealTimers());

function fakeSdk(): { fn: typeof sdkQuery; inputs: string[] } {
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
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

function boot(stores: Stores): { clone: CloneHost; inputs: string[] } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, inputs: fake.inputs };
}

function external(id: string, payload: string): InboxEvent {
  return {
    type: 'external',
    id,
    at: '2026-10-01T00:00:00.000Z',
    source: 'ci.main',
    payload,
  };
}

interface Flaky {
  stores: Stores;
  control: { failing: boolean; writtenButReportedFailed: boolean; removed: string[] };
}

function flakyInbox(): Flaky {
  const base = createMemoryStores();
  const control = { failing: false, writtenButReportedFailed: false, removed: [] as string[] };
  const stores: Stores = {
    ...base,
    inbox: {
      ...base.inbox,
      put: async (event, at) => {
        if (!control.failing) return base.inbox.put(event, at);
        if (control.writtenButReportedFailed) await base.inbox.put(event, at);
        throw new Error('器が閉じている');
      },
      remove: async (id) => {
        control.removed.push(id);
        return base.inbox.remove(id);
      },
    },
  };
  return { stores, control };
}

async function settle<T>(work: Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await work;
  vi.useRealTimers();
  return result;
}

describe('Clone#postPersisted（Issue #3679）', () => {
  it('書けたら persisted を返し、行が器に在り、配達は1回だけ', async () => {
    const { stores } = flakyInbox();
    const { clone, inputs } = boot(stores);
    expect(await clone.postPersisted(external('evt-1', 'ok-1'))).toBe('persisted');
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('ok-1');
    await clone.stop();
  });

  it('書けなかったら unavailable を返し、メモリにも積まない（配達されない）。跡は1行で本文を出さない', async () => {
    const { stores, control } = flakyInbox();
    const { clone, inputs } = boot(stores);
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';
    control.failing = true;
    let outcome: string | undefined;
    const lines = await captureStderr(async () => {
      outcome = await settle(clone.postPersisted(external('evt-lost', secret)));
    });
    expect(outcome).toBe('unavailable');
    const trace = lines.filter((line) => line.includes('受信箱へ書けなかったので受理しなかった'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('器が閉じている');
    expect(lines.join('')).not.toContain('ghp_');

    control.failing = false;
    expect(await clone.postPersisted(external('evt-retry', 'retry-1'))).toBe('persisted');
    await waitFor(() => inputs.length > 0, '送り直しが処理に入る');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('retry-1');
    expect(inputs.join('\n')).not.toContain('ghp_');
    await clone.stop();
  });

  it('書き込みが失敗を返しつつ実は通っていた行は、取り消す（次の起動の配り直しで二重にならない）', async () => {
    const { stores, control } = flakyInbox();
    const { clone } = boot(stores);
    control.failing = true;
    control.writtenButReportedFailed = true;
    let outcome: string | undefined;
    await captureStderr(async () => {
      outcome = await settle(clone.postPersisted(external('evt-ghost', 'ghost')));
    });
    expect(outcome).toBe('unavailable');
    expect(control.removed).toEqual(['evt-ghost']);
    expect(await stores.inbox.claimPending()).toEqual([]);
    await clone.stop();
  });

  it('対照: post は従来どおり、書けなくてもメモリに積んで配達する（挙動を変えていない）', async () => {
    const { stores, control } = flakyInbox();
    const { clone, inputs } = boot(stores);
    control.failing = true;
    await captureStderr(async () => {
      clone.post(external('evt-post', 'via-post'));
      await waitFor(() => inputs.length > 0, 'post した合図が処理に入る');
    });
    expect(inputs[0]).toContain('via-post');
    await clone.stop();
  });

  it('片付けの後（受信箱を閉じた後）: 書けたら persisted（行は器に残り配達はしない）、書けなければ unavailable', async () => {
    const { stores, control } = flakyInbox();
    const { clone, inputs } = boot(stores);
    await clone.stop();

    expect(await clone.postPersisted(external('evt-late', 'late'))).toBe('persisted');
    expect((await stores.inbox.claimPending()).map((p) => p.event.id)).toEqual(['evt-late']);
    expect(inputs).toEqual([]);

    control.failing = true;
    let outcome: string | undefined;
    await captureStderr(async () => {
      outcome = await settle(clone.postPersisted(external('evt-late-2', 'late-2')));
    });
    expect(outcome).toBe('unavailable');
  });
});
