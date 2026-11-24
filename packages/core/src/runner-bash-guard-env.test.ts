import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_ENV_GUARD_ENV } from './bash-env-guard.js';
import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: { options: Options }[] } {
  const started: { options: Options }[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

function bash(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    tool_input: { command },
    ...extra,
  };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-bash-guard-env-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

async function startSession(
  env: NodeJS.ProcessEnv,
): Promise<{ options: Options; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env,
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const options = started[0]?.options;
  if (options === undefined) throw new Error('セッションが開いていない');
  return { options, events };
}

function decisionOf(result: HookJSONOutput): unknown {
  return (result as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
    ?.permissionDecision;
}

function notes(events: readonly RunnerEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'note' ? [event.text] : []));
}

describe('runner の PreToolUse: 環境変数の値を出す Bash を断る（#6864）', () => {
  it('既定で、作業者の `env` を deny にし、note に形と actor を残す', async () => {
    const { options, events } = await startSession({});
    const result = await firePreToolUse(
      options,
      bash('env', { agent_id: 'agent-1', agent_type: 'worker' }),
    );
    expect(decisionOf(result)).toBe('deny');
    expect(
      String(
        (result as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
          ?.permissionDecisionReason,
      ),
    ).toContain('compgen -e');
    const note = notes(events).find((t) => t.includes('形=env'));
    expect(note).toContain('Bash の呼び出しを弾いた');
    expect(note).toContain('worker:mgr-1:worker');
  });

  it('マネージャー自身の `printenv` も deny', async () => {
    const { options } = await startSession({});
    expect(decisionOf(await firePreToolUse(options, bash('printenv')))).toBe('deny');
  });

  it('`ALTEROID_BASH_GUARD=off` でも deny（待ちの歯とは切り離してある）', async () => {
    const { options } = await startSession({ [BASH_GUARD_ENV]: 'off' });
    expect(decisionOf(await firePreToolUse(options, bash('cat /proc/1/environ')))).toBe('deny');
  });

  it('`ALTEROID_BASH_ENV_GUARD=off` で開く', async () => {
    const { options } = await startSession({ [BASH_ENV_GUARD_ENV]: 'off' });
    expect(await firePreToolUse(options, bash('env'))).toEqual({ continue: true });
  });

  it('値を出さない形は何も決めない', async () => {
    const { options } = await startSession({});
    expect(await firePreToolUse(options, bash('compgen -e'))).toEqual({ continue: true });
  });

  it('綴り違いは素通しにせず確認に倒す', async () => {
    const { options } = await startSession({ [BASH_ENV_GUARD_ENV]: 'deny' });
    expect(decisionOf(await firePreToolUse(options, bash('echo hi')))).toBe('ask');
  });

  it('作業者とマネージャーのプロンプトに、断られる形と通る書き方が載る', async () => {
    const { options } = await startSession({});
    const worker = Object.values(options.agents ?? {})[0]?.prompt ?? '';
    expect(worker).toContain('環境変数の値を出す Bash の形');
    expect(worker).toContain('compgen -e');
    const system = JSON.stringify(options.systemPrompt);
    expect(system).toContain('環境変数の値を出す Bash の形');
  });

  it('歯が off ならプロンプトに節を載せない', async () => {
    const { options } = await startSession({ [BASH_ENV_GUARD_ENV]: 'off' });
    const worker = Object.values(options.agents ?? {})[0]?.prompt ?? '';
    expect(worker).not.toContain('環境変数の値を出す Bash の形');
  });
});
