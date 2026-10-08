import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

/**
 * runner が `session` に plugin の読み込み結果（init の `plugins` / `plugin_errors`）を載せること
 * （Issue #3816）。init を出すだけの偽 SDK で、runner が外へ出す `session` を見る。
 */
function fakeSdkWithInit(initExtras: Record<string, unknown>): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
        ...initExtras,
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<unknown>) void message;
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function sessionEventOf(initExtras: Record<string, unknown>): Promise<RunnerEvent> {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fakeSdkWithInit(initExtras),
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
  const deadline = Date.now() + 2000;
  while (!events.some((event) => event.type === 'session')) {
    if (Date.now() > deadline) throw new Error('session が出なかった');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return events.find((event) => event.type === 'session')!;
}

describe('runner の session イベントの pluginLoad', () => {
  it('init が plugins と plugin_errors を知らせると、session に載り、ワイヤのスキーマを通る', async () => {
    const event = await sessionEventOf({
      plugins: [{ name: 'p', path: '/p', version: '1.0.0' }],
      plugin_errors: [{ plugin: 'q', type: 'load', message: 'boom' }],
    });

    expect(event).toMatchObject({
      type: 'session',
      managerId: 'mgr-1',
      pluginLoad: {
        plugins: [{ name: 'p', version: '1.0.0' }],
        errors: [{ plugin: 'q', type: 'load', message: 'boom' }],
      },
    });
    expect(runnerEventSchema.safeParse(event).success).toBe(true);
  });

  it('plugin_errors を省いた init は errors: null で載る（無事の断定にしない）', async () => {
    const event = await sessionEventOf({ plugins: [] });

    expect(event).toMatchObject({ type: 'session', pluginLoad: { plugins: [], errors: null } });
  });

  it('init に plugins が無ければ pluginLoad の欄ごと省く（古い runner と同じ形）', async () => {
    const event = await sessionEventOf({});

    expect(event.type).toBe('session');
    expect('pluginLoad' in event).toBe(false);
  });

  it('pluginLoad を持たない旧い runner の session も、スキーマを通る', () => {
    expect(
      runnerEventSchema.safeParse({ type: 'session', managerId: 'mgr-1', sessionId: 's' }).success,
    ).toBe(true);
  });
});
