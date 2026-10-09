import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';

interface FakeSession {
  end(): void;
  promptEnded(): boolean;
  waitForPromptEnded(): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let ended = false;
    let endedResolve!: () => void;
    const endedPromise = new Promise<void>((resolve) => {
      endedResolve = resolve;
    });

    const push = (message: SDKMessage | null) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(message);
      } else if (message !== null) {
        buffered.push(message);
      }
    };

    // 1回の .next() では足りない: 積まれた入力を読み切るまで waitForInput() に到達しないため、継続して読む
    void (async () => {
      for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      ended = true;
      endedResolve();
    })();

    const session: FakeSession = {
      end() {
        push(null);
      },
      promptEnded: () => ended,
      waitForPromptEnded: () => endedPromise,
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

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

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        push(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];
let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-finish-wakes-input-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]);
}

describe('#finishBody の wakeInput(): 入力待ちの #inputStream generator を起こす', () => {
  it('自然終了（result なしで for await が抜ける経路）の #finish 後、#inputStream の drain が終わる', async () => {
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-finish-wakes-input',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(sessions);

    expect(session.promptEnded()).toBe(false);

    session.end();

    await withTimeout(
      session.waitForPromptEnded(),
      1000,
      '#finishBody の後に #inputStream の generator が終わらなかった(wakeInput() が呼ばれていない疑い)',
    );

    expect(session.promptEnded()).toBe(true);
  });
});
