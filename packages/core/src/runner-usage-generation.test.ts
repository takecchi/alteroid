import type {
  ModelUsage,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

interface FakeSession {
  finish(
    text: string,
    options?: { subtype?: string; isError?: boolean; costUsd?: number },
  ): Promise<void>;
  endStream(): void;
  closed: boolean;
}

function modelUsage(costUsd: number): Record<string, ModelUsage> {
  return {
    'claude-opus-5': {
      inputTokens: 100,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: costUsd,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  };
}

function fakeSdk(zombie: boolean): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const fn = ((params: { prompt: unknown }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let finishes = 0;
    const label = `sess-${String(sessions.length)}`;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };
    const session: FakeSession = {
      closed: false,
      async finish(text, options = {}) {
        push({
          type: 'result',
          subtype: options.subtype ?? 'success',
          result: text,
          session_id: label,
          uuid: `uuid-result-${label}-${(finishes += 1)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
          ...(options.costUsd === undefined ? {} : { modelUsage: modelUsage(options.costUsd) }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      endStream() {
        if (emit) emit(null);
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: label,
        uuid: `uuid-init-${label}`,
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => {
        session.closed = true;
        // 実 SDK が close() の後に出すかは確かめられないので、zombie では出し続けると仮定する。
        if (!zombie && emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions };
}

let hosts: RunnerHost[] = [];
let allSessions: FakeSession[] = [];

afterEach(async () => {
  // 止まらない偽の古い世代を、片付けのときだけ終わらせる（shutdown が待つ）。
  for (const session of allSessions) session.endStream();
  allSessions = [];
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(zombie: boolean) {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk(zombie);
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  allSessions = sessions;
  return { host, events, sessions };
}

async function nthSession(sessions: readonly FakeSession[], index: number): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) throw new Error(`${String(index)} 本目のセッションがまだ開いていない`);
    return found;
  });
}

function usageCosts(events: readonly RunnerEvent[]): number[] {
  return events
    .filter((event): event is Extract<RunnerEvent, { type: 'usage' }> => event.type === 'usage')
    .map((event) => Object.values(event.models).reduce((sum, totals) => sum + totals.costUsd, 0));
}

async function resumeDead(host: RunnerHost, managerId: string): Promise<void> {
  await host.resume({
    managerId,
    sessionId: 'sess-dead',
    cwd: '/work/project',
    request: '最初の依頼',
    entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
  });
}

describe('復帰で畳まれた古い世代の result は usage に混ざらない（#3022 仮説2）', () => {
  for (const zombie of [false, true]) {
    it(`(a) resume が効かず復帰した後に古い世代が成功の result を出しても、その累積は usage に出ない（zombie=${String(zombie)}）`, async () => {
      const { host, events, sessions } = setup(zombie);
      await resumeDead(host, 'mgr-gen');

      const old = await nthSession(sessions, 0);
      await old.finish('', { subtype: 'error_during_execution', isError: true });
      const fresh = await nthSession(sessions, 1);

      await fresh.finish('続けた', { costUsd: 1 });
      await vi.waitFor(() => expect(usageCosts(events)).toEqual([1]));

      if (zombie) {
        await old.finish('古い世代の遅れた結果', { costUsd: 10 });
        await settle();
      }
      expect(usageCosts(events)).toEqual([1]);
    });
  }

  it('(b) 古い世代が成功の result を出した直後（同じ tick）に、失敗の result による復帰の判定が走っても、成功した世代の usage は出て、復帰しない', async () => {
    const { host, events, sessions } = setup(true);
    await resumeDead(host, 'mgr-race');

    const old = await nthSession(sessions, 0);
    void old.finish('進んだ', { costUsd: 3 });
    void old.finish('', { subtype: 'error_during_execution', isError: true });
    await settle();

    expect(usageCosts(events)).toEqual([3]);
    expect(sessions).toHaveLength(1);
  });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
