import type {
  ModelUsage,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * 復帰（`#recoverFromFailedResume`）で畳まれた古い世代の `result` は、runner の `usage` に
 * 混ざらない（Issue #3022 仮説2）。
 *
 * ## なぜこれを測るか
 *
 * `#read` は \`session.readEvents((event) => this.#apply(event))\` と、**世代を見ずに**
 * 古い世代のストリームの出来事を \`#apply\` へ通す。復帰は \`#apply\` の \`result\`（失敗）の
 * 中でも起きる（\`#read\` の外で世代が進む）ので、古いストリームがその後も何か出すと、
 * それは新しい世代の状態に当たる。\`usage\` に載る古い世代の累積が、新しい世代の累積
 * （resume で 0 から数え直し）の後ろに届くと、台帳では逆順の累積になり過大に数える。
 *
 * ## 最悪の仮定
 *
 * **実 SDK が \`close()\` の後にメッセージを出すかは確かめられない。** だからここでは出すと
 * 仮定する（\`zombie: true\` の偽 SDK は \`close()\` で止まらず、後から \`result\` を出す）。
 */

interface FakeSession {
  /** `result` を1つ流す。 */
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
        // 最悪の仮定: close() の後も、古い世代のストリームは出し続ける。
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
      // resume が効かず、手が動く前に失敗の result で終わる → 復帰（新しい世代が開く）。
      await old.finish('', { subtype: 'error_during_execution', isError: true });
      const fresh = await nthSession(sessions, 1);

      // 新しい世代の最初の成功（累積は 0 から数え直し）。
      await fresh.finish('続けた', { costUsd: 1 });
      await vi.waitFor(() => expect(usageCosts(events)).toEqual([1]));

      // 最悪の仮定: 畳まれたはずの古い世代が、後から成功の result（大きい累積）を出す。
      if (zombie) {
        await old.finish('古い世代の遅れた結果', { costUsd: 10 });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // 古い世代の累積（10）は、新しい世代の累積（1）の後ろに混ざらない。
      expect(usageCosts(events)).toEqual([1]);
    });
  }

  it('(b) 古い世代が成功の result を出した直後（同じ tick）に、失敗の result による復帰の判定が走っても、成功した世代の usage は出て、復帰しない', async () => {
    const { host, events, sessions } = setup(true);
    await resumeDead(host, 'mgr-race');

    const old = await nthSession(sessions, 0);
    // 成功の result の直後に、同じ世代が失敗の result を出す（`progressed` の判定が usage より
    // 遅れる窓が無いかを測る。成功が先に `progressed` を立てるなら、失敗は復帰にならない）。
    void old.finish('進んだ', { costUsd: 3 });
    void old.finish('', { subtype: 'error_during_execution', isError: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(usageCosts(events)).toEqual([3]);
    // 復帰していない＝新しいセッションは開いていない。
    expect(sessions).toHaveLength(1);
  });
});
