import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * Issue #929 の最新コメントの項目6:「`#markProgressed()` の効果は、PR #1369
 * の歯では直接観測していない」。`runner-wakeup.test.ts` の #929 の歯
 * （`マネージャー自身の失敗した道具呼び出し（PostToolUseFailure）も
 * toolless に数えない`）は `#toolsSinceResult`（`worker_wait.toolless`）
 * だけを見ており、`#markProgressed()` のもう1つの効果——`#progressed` を
 * 立てて `#seed` を解放すること——には一度も触れていない。
 * `runner-post-tool-use-failure.test.ts` の doc はそちらへ「足した」と
 * 書いていたが、実際に足されたのは前者だけだった（この PR でその doc も
 * 直す）。
 *
 * ## 観測の形
 *
 * `#recoverFromFailedResume`（`runner.ts`）は `this.#progressed` が立って
 * いれば `'not-a-resume-failure'` を即座に返し、`renderSessionLog(this.#seed)`
 * を使った作り直しへは一度も進まない——`resume_failed` イベントを1件も
 * 出さないまま、通常の「セッションが閉じた」経路
 * （`await this.#finish('done', 'マネージャーのセッションが閉じた。')`）へ
 * 落ちる。**逆に `#progressed` が立っていなければ**、`resume_failed`
 * （`recovered: true`）を出して2本目のセッションを作り直す。この2本の
 * 差が、`#markProgressed()` が resume の外へ実際に及ぼす効果である。
 *
 * ## 足場
 *
 * `runner-resume-recreate-worker-count.test.ts` の偽 SDK（`host.resume()`
 * を直接叩き、`endStream()` で「resume したが一度も手が動く前に SDK が
 * 黙って落ちた」形を模す）に、`runner-post-tool-use-failure.test.ts` の
 * `options.hooks.PostToolUseFailure` を直接叩く形を合わせてある。
 * `createRunnerHost` を直接使う（`createManagerPool` を経由しない）のも
 * 同じ理由——resume を起こすには `host.resume()` を直接呼ぶのがいちばん
 * 素直である。
 */

interface FakeSession {
  options: Options;
  finish(text: string, options?: { isError?: boolean }): Promise<void>;
  /** PostToolUseFailure フックを鳴らす（既定はマネージャー自身の道具）。 */
  usedToolFailure(tool: string, extra?: Record<string, unknown>): Promise<void>;
  /** ストリームを畳む（SDK 側が結果を1つも返さずに黙って落ちた形を模す）。 */
  endStream(): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      async finish(text, opts = {}) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(finishes += 1)}`,
          ...(opts.isError === undefined ? {} : { is_error: opts.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async usedToolFailure(tool, extra = {}) {
        const hook = options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
        await hook(
          {
            hook_event_name: 'PostToolUseFailure',
            tool_name: tool,
            tool_use_id: `tu-${tool}`,
            error: `${tool} failed`,
            ...extra,
          } as never,
          undefined,
          { signal: new AbortController().signal },
        );
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

      // 入力を読み続ける裏方（読まないと送り手が詰まる）。中身は使わない。
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

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
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

async function nthSession(sessions: readonly FakeSession[], index: number): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) throw new Error(`${String(index)} 本目のセッションがまだ開いていない`);
    return found;
  });
}

type ClosedEvent = Extract<RunnerEvent, { type: 'closed' }>;
type ResumeFailedEvent = Extract<RunnerEvent, { type: 'resume_failed' }>;

function closedEvents(events: readonly RunnerEvent[]): ClosedEvent[] {
  return events.filter((event): event is ClosedEvent => event.type === 'closed');
}

function resumeFailedEvents(events: readonly RunnerEvent[]): ResumeFailedEvent[] {
  return events.filter((event): event is ResumeFailedEvent => event.type === 'resume_failed');
}

describe('#929 項目6: PostToolUseFailure でも #progressed が立ち #seed が解放される（resume の作り直しで観測）', () => {
  it('resume 後にマネージャー自身の道具が1度失敗すると、その後セッションが黙って落ちても作り直さない', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-dead',
      cwd: '/work/project',
      request: '最初の依頼',
      // renderSessionLog が null を返さないよう、素材を1件渡す
      // （空配列/undefined だけ null を返す——渡していれば「作り直せる
      // 材料はあった」ことになり、作り直さない理由が `#progressed` に
      // あることがはっきりする）。
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    // マネージャー自身の道具（agent_id 無し）が失敗する
    // ＝ `#onPostToolUseFailure` が `#markProgressed()` を呼ぶ。
    await first.usedToolFailure('Bash');
    // resume したセッションが、その後もう一度何も返さずに黙って落ちる。
    first.endStream();

    const closed = await vi.waitFor(() => {
      const found = closedEvents(events);
      if (found.length === 0) throw new Error('closed イベントがまだ来ていない');
      return found;
    });

    expect(closed).toHaveLength(1);
    expect(closed[0]?.managerId).toBe('mgr-1');
    expect(closed[0]?.status).toBe('done');
    expect(closed[0]?.reason).toBe('マネージャーのセッションが閉じた。');
    // 作り直しの合図（resume_failed）は1件も出ない —— `#progressed` が
    // 立っているので `#recoverFromFailedResume` は
    // `'not-a-resume-failure'` で `renderSessionLog(#seed)` へ進む前に
    // 即座に抜けている。
    expect(resumeFailedEvents(events)).toHaveLength(0);
    // 2本目のセッションは立たない（作り直しが起きていない）。
    expect(sessions).toHaveLength(1);
  });

  it('陽性対照: 道具の失敗が無ければ、同じ形でセッションが落ちても resume 失敗として作り直す', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-dead-2',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    // 道具は一度も使わない・失敗もしない（`usedToolFailure` を呼ばない）。
    first.endStream();

    // `#progressed` が立っていないので `#recoverFromFailedResume` は
    // `renderSessionLog(#seed)` まで進み、2本目のセッションを作り直す。
    await nthSession(sessions, 1);

    const resumeFailed = await vi.waitFor(() => {
      const found = resumeFailedEvents(events);
      if (found.length === 0) throw new Error('resume_failed イベントがまだ来ていない');
      return found;
    });
    expect(resumeFailed).toHaveLength(1);
    expect(resumeFailed[0]?.managerId).toBe('mgr-2');
    expect(resumeFailed[0]?.sessionId).toBe('sess-dead-2');
    expect(resumeFailed[0]?.recovered).toBe(true);
    // 作り直したのだから「セッションが閉じた」の closed（'done'）は出ない。
    expect(closedEvents(events)).toHaveLength(0);
  });
});
