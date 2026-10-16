import { join } from 'node:path';

import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createProfileVessel } from './profile.js';
import { REPORT_LANGUAGE_ENV, REPORT_LANGUAGE_NOTICE_INTERVAL_MS } from './report-language.js';
import { createRunnerHost, WITHHELD_ENV_KEYS, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 担当の発言に英語の文が混ざったら、次の道具の結果に知らせを添え、日誌に1行残す（#4965）

interface FakeSession {
  options: Options;
  say(text: string, options?: { parentToolUseId?: string }): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  let serial = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const queue: (SDKMessage | null)[] = [];
    let wake: (() => void) | null = null;
    const push = (message: SDKMessage | null) => {
      queue.push(message);
      wake?.();
    };
    sessions.push({
      options: params.options ?? {},
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: sayOptions.parentToolUseId ?? null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${String((serial += 1))}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
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
      close: () => push(null),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function start(
  env: NodeJS.ProcessEnv,
  profileScript?: string,
): Promise<{ session: FakeSession; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk();
  const dir = makeTempDirSync('alteroid-runner-report-language-');
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin', ...env },
    ...(profileScript === undefined
      ? {}
      : {
          profile: createProfileVessel({
            path: join(dir, 'profile', 'profile.sh'),
            withheldEnvKeys: WITHHELD_ENV_KEYS,
          }),
        }),
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  await vi.waitFor(() => {
    if (sessions.length < 1) throw new Error('セッションがまだ開いていない');
  });
  if (profileScript !== undefined) {
    const result = await host.setProfile(profileScript);
    if (!result.ok) throw new Error('プロファイルが置けない');
  }
  return { session: sessions[0]!, events };
}

function postToolUse(options: Options, extra: Record<string, unknown> = {}) {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: '', stderr: '' },
      ...extra,
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

const contextOf = (result: HookJSONOutput): string | undefined =>
  (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;

const languageNotes = (events: RunnerEvent[]) =>
  events.filter((event) => event.type === 'note' && event.text.includes('英語の文が'));

const NOTICE_HEAD = '⚠ alteroid からの知らせ: 直前の文に英語が混ざっている';

describe('担当の発言に英語の文が混ざったら知らせる（ALTEROID_REPORT_LANGUAGE。#4965）', () => {
  it('ja のとき、英語の文の後の道具の結果に知らせが添わり、note が1行出る。止めない', async () => {
    const { session, events } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    await session.say('型を確かめた。\nTypes pass.');

    const result = await postToolUse(session.options);
    expect(result).not.toHaveProperty('decision');
    expect((result as { continue?: boolean }).continue).not.toBe(false);
    const context = contextOf(result);
    expect(context).toContain(`${NOTICE_HEAD}（例: "Types pass"）。`);
    expect(context).toContain('これは知らせで、止める指示ではない。');
    expect(languageNotes(events).map((event) => (event as { text: string }).text)).toEqual([
      '担当の発言に英語の文が 1 件混ざっていた（担い手: manager:mgr-1、例: "Types pass"）。#4965',
    ]);
    // 添えるのは1回だけ
    expect(contextOf(await postToolUse(session.options))).toBeUndefined();
  });

  it('10分以内の2回目は添えず、note も出さない。10分を過ぎれば添える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { session, events } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    // 開いた後に置く: `start` の `vi.waitFor` は偽の時計を進めるため
    vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'));
    await session.say('Types pass.');
    expect(contextOf(await postToolUse(session.options))).toContain(NOTICE_HEAD);

    vi.setSystemTime(new Date('2026-10-16T00:09:59.000Z'));
    await session.say('Now running the full test suite.');
    expect(contextOf(await postToolUse(session.options))).toBeUndefined();
    expect(languageNotes(events)).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-16T00:10:00.000Z'));
    await session.say('Now running the full test suite.');
    expect(languageNotes(events)).toHaveLength(2);
    expect(contextOf(await postToolUse(session.options))).toContain(
      '例: "Now running the full test suite"',
    );
    expect(REPORT_LANGUAGE_NOTICE_INTERVAL_MS).toBe(10 * 60_000);
  });

  it('既定（未設定）・off では何もしない', async () => {
    for (const env of [{}, { [REPORT_LANGUAGE_ENV]: 'off' }]) {
      const { session, events } = await start(env);
      await session.say('Types pass.');
      expect(await postToolUse(session.options)).toEqual({ continue: true });
      expect(languageNotes(events)).toHaveLength(0);
    }
  });

  it('プロファイルで ja にすると効く（runner の env は未設定）', async () => {
    const { session, events } = await start({}, `export ${REPORT_LANGUAGE_ENV}=ja`);
    await session.say('Types pass.');
    expect(contextOf(await postToolUse(session.options))).toContain(NOTICE_HEAD);
    expect(languageNotes(events)).toHaveLength(1);
  });

  it('runner の env が ja でも、プロファイルが off なら何もしない', async () => {
    const { session, events } = await start(
      { [REPORT_LANGUAGE_ENV]: 'ja' },
      `export ${REPORT_LANGUAGE_ENV}=off`,
    );
    await session.say('Types pass.');
    expect(await postToolUse(session.options)).toEqual({ continue: true });
    expect(languageNotes(events)).toHaveLength(0);
  });

  it('日本語だけの発言では何もしない', async () => {
    const { session, events } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    await session.say(
      '型は通った。`git push origin main` した。CI が green になった。\n```\nrun the tests\n```',
    );
    expect(await postToolUse(session.options)).toEqual({ continue: true });
    expect(languageNotes(events)).toHaveLength(0);
  });

  it('作業者の発言（parentToolUseId 付き）には掛けない', async () => {
    const { session, events } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    await session.say('Types pass.', { parentToolUseId: 'toolu-1' });
    expect(
      await postToolUse(session.options, { agent_id: 'agent-1', agent_type: 'worker' }),
    ).toEqual({ continue: true });
    expect(await postToolUse(session.options)).toEqual({ continue: true });
    expect(languageNotes(events)).toHaveLength(0);
  });

  it('担当本人の発言の知らせは、作業者の道具の結果には添えない', async () => {
    const { session } = await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    await session.say('Types pass.');
    expect(
      await postToolUse(session.options, { agent_id: 'agent-1', agent_type: 'worker' }),
    ).toEqual({ continue: true });
    expect(contextOf(await postToolUse(session.options))).toContain(NOTICE_HEAD);
  });

  it('綴り違いは知らせない側へ倒し、道具の結果を壊さず、note に1回だけ残す', async () => {
    const { session, events } = await start({ [REPORT_LANGUAGE_ENV]: 'yes' });
    await session.say('Types pass.');
    await session.say('Now running the full test suite.');
    expect(await postToolUse(session.options)).toEqual({ continue: true });
    const misconfig = events.filter(
      (event) =>
        event.type === 'note' && event.text.includes('ALTEROID_REPORT_LANGUAGE の値が不正: yes'),
    );
    expect(misconfig).toHaveLength(1);
    expect(languageNotes(events)).toHaveLength(0);
  });

  it('起動行は実効の値を言う', async () => {
    await start({ [REPORT_LANGUAGE_ENV]: 'ja' });
    expect(hosts[0]?.reportLanguageLine()).toContain(
      '報告の言語の知らせ: ja（ALTEROID_REPORT_LANGUAGE。',
    );
  });
});
