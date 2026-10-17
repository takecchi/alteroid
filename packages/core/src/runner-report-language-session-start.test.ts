import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { REPORT_LANGUAGE_ENV, REPORT_LANGUAGE_PROMPT_PARAGRAPH } from './report-language.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// resume・fork で開いた担当の会話へ、言語の段落を SessionStart の additionalContext で足す（#4995）

function fakeSdk(): { fn: typeof sdkQuery; sessions: { options: Options }[] } {
  const sessions: { options: Options }[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const queue: (SDKMessage | null)[] = [];
    let wake: (() => void) | null = null;
    sessions.push({ options: params.options ?? {} });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        while (!(await iterator.next()).done) {
          // 入力は読み捨てる
        }
      })();
      for (;;) {
        const next = queue.shift();
        if (next === null) return;
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
    return Object.assign(generate(), {
      close: () => {
        queue.push(null);
        wake?.();
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

async function start(env: NodeJS.ProcessEnv): Promise<{ options: Options; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk();
  const dir = makeTempDirSync('alteroid-runner-session-start-');
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin', ...env },
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  await vi.waitFor(() => {
    if (sessions.length < 1) throw new Error('セッションがまだ開いていない');
  });
  return { options: sessions[0]!.options, events };
}

function sessionStart(options: Options, source: string): Promise<HookJSONOutput> {
  const hook = options.hooks?.SessionStart?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('SessionStart フックが登録されていない');
  return hook({ hook_event_name: 'SessionStart', source } as never, undefined, {
    signal: new AbortController().signal,
  });
}

const contextOf = (result: HookJSONOutput): string | undefined =>
  (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;

describe('resume・fork の回に言語の段落を会話へ足す（SessionStart。#4995）', () => {
  it('ja かつ resume のとき、段落を additionalContext で返し、note を1行残す', async () => {
    const { options, events } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    const result = await sessionStart(options, 'resume');
    expect(result).toMatchObject({ continue: true });
    expect(contextOf(result)).toBe(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
    expect(
      events.filter((event) => event.type === 'note' && event.text.includes('#4995')),
    ).toHaveLength(1);
  });

  it('ja かつ fork のときも段落を返す', async () => {
    const { options } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    expect(contextOf(await sessionStart(options, 'fork'))).toBe(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
  });

  it.each(['startup', 'compact', 'clear'])('ja でも %s では足さない', async (source) => {
    const { options, events } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    const result = await sessionStart(options, source);
    expect(result).toEqual({ continue: true });
    expect(events.some((event) => event.type === 'note' && event.text.includes('#4995'))).toBe(
      false,
    );
  });

  it('off のときは resume でも足さない', async () => {
    const { options } = await start({ [REPORT_LANGUAGE_ENV]: 'off' });
    expect(await sessionStart(options, 'resume')).toEqual({ continue: true });
  });
});
