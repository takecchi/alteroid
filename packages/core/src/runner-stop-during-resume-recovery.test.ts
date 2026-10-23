import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// 2026-10-23 heosterra（#5205）: 起こし直したばかりの担当（resume の最初のターンの途中）を、鍵の付け替えの畳みが stop した。
// 畳みで終わったターンの失敗の結果を「resume が戻れなかった」と読んで、止めたはずのセッションの中に CLI を作り直していた。
// 作り直した CLI は名簿から外れたまま、古い世代で出来事を出し続け、stop も答えも届かなかった。

interface FakeSession {
  options: Options;
  /** 失敗の結果（`subtype` が success でない）で1ターンを終える。 */
  failTurn(): Promise<void>;
  endStream(): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    // 閉じた印を残す: 結果を処理している最中（待っていない間）に閉じられても、次に待つ前に流れを終えるため
    let closed = false;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      async failTurn() {
        push({
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sess-mgr',
          uuid: `uuid-failed-${String(sessions.indexOf(session))}`,
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
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
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
        if (closed) return;
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
        closed = true;
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(): { host: RunnerHost; events: RunnerEvent[]; sessions: FakeSession[] } {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  return { host, events, sessions };
}

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('#5205 止めたセッションの中に CLI を作り直さない', () => {
  it('⭐ resume の最初のターンの途中で stop した後に失敗の結果が届いても、resume の立て直しで CLI を作り直さない', async () => {
    const { host, events, sessions } = setup();
    await host.resume({
      managerId: 'mgr-fold',
      sessionId: 'sess-rotated',
      cwd: '/work/project',
      request: '続き',
      message: '通る鍵に戻ったので続きを',
      // 素材を1件渡す: 渡さないと立て直す材料が無く、作り直しの枝そのものに入らない
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });
    const first = await firstSession(sessions);

    // 鍵の付け替えの畳み（keepPeers）。stop の同期の部分で「止めた」が立ち、その後に畳みで終わったターンの結果が届く形
    const stopping = host.stop('mgr-fold', { keepPeers: true });
    await first.failTurn();
    await stopping;
    await settle();

    expect(sessions).toHaveLength(1);
    expect(events.filter((event) => event.type === 'resume_failed')).toEqual([]);
    expect(host.list().map((state) => state.managerId)).not.toContain('mgr-fold');
  });

  it('陽性対照: 止めていなければ、resume の最初のターンの失敗は今どおり作り直す（resume_failed recovered=true）', async () => {
    const { host, events, sessions } = setup();
    await host.resume({
      managerId: 'mgr-live',
      sessionId: 'sess-rotated-2',
      cwd: '/work/project',
      request: '続き',
      message: '通る鍵に戻ったので続きを',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });
    const first = await firstSession(sessions);

    await first.failTurn();
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    const recovered = events.filter(
      (event): event is Extract<RunnerEvent, { type: 'resume_failed' }> =>
        event.type === 'resume_failed',
    );
    expect(recovered.map((event) => event.recovered)).toEqual([true]);
  });
});
