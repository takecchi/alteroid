import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_FILE_WRITE_GUARD_ENV } from './bash-file-write-guard-mode.js';
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

const WRITING = 'cat > f.txt <<EOF\nhello\nEOF';

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-bash-file-write-guard-');
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

function notes(events: readonly RunnerEvent[]): { text: string; escalate?: boolean }[] {
  return events.filter((event) => event.type === 'note') as { text: string; escalate?: boolean }[];
}

type HookResult = { hookSpecificOutput?: Record<string, unknown> };

describe('ALTEROID_BASH_FILE_WRITE_GUARD=deny: ファイルを書く形をその場で拒否する（#4348）', () => {
  it('deny を返し、理由に代わりの道具を含め、「弾いた」note を出す', async () => {
    const { options, events } = await startSession({ [BASH_FILE_WRITE_GUARD_ENV]: 'deny' });
    const result = (await firePreToolUse(options, bash(WRITING))) as HookResult;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = String(result.hookSpecificOutput?.permissionDecisionReason);
    expect(reason).toContain('Write');
    expect(reason).toContain('Edit');
    const guard = notes(events).filter((n) => n.text.includes('Bash の呼び出しを弾いた'));
    expect(guard).toHaveLength(1);
    expect(guard[0]?.text).toContain('manager:mgr-1');
    expect(guard[0]?.text).toContain('形=heredoc-file-write');
    expect(guard[0]?.escalate).toBeUndefined();
  });

  it('作業者の呼び出しも deny で、note の actor は worker:', async () => {
    const { options, events } = await startSession({ [BASH_FILE_WRITE_GUARD_ENV]: 'deny' });
    const result = (await firePreToolUse(
      options,
      bash("sed -i 's/a/b/' f", { agent_id: 'agent-xyz', agent_type: 'worker' }),
    )) as HookResult;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(notes(events).find((n) => n.text.includes('弾いた'))?.text).toContain(
      'worker:mgr-1:worker',
    );
  });

  it('書かない呼び出しは今までどおり何も決めない', async () => {
    const { options, events } = await startSession({ [BASH_FILE_WRITE_GUARD_ENV]: 'deny' });
    expect(await firePreToolUse(options, bash('pnpm build > /dev/null 2>&1'))).toEqual({
      continue: true,
    });
    expect(notes(events).some((n) => n.text.includes('弾いた'))).toBe(false);
  });

  it('Bash 以外は見ない', async () => {
    const { options } = await startSession({ [BASH_FILE_WRITE_GUARD_ENV]: 'deny' });
    expect(
      await firePreToolUse(options, {
        hook_event_name: 'PreToolUse',
        tool_use_id: 'tu-1',
        tool_name: 'Read',
        tool_input: { command: WRITING },
      }),
    ).toEqual({ continue: true });
  });

  it('待つ形の門（ALTEROID_BASH_GUARD=ask）の挙動は変わらない', async () => {
    const { options } = await startSession({ [BASH_FILE_WRITE_GUARD_ENV]: 'deny' });
    const result = (await firePreToolUse(options, bash('tail -f /tmp/run.log'))) as HookResult;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
  });

  it('待つ形の門を off にしていても、ファイルを書く形は断る（互いに独立）', async () => {
    const { options } = await startSession({
      [BASH_FILE_WRITE_GUARD_ENV]: 'deny',
      [BASH_GUARD_ENV]: 'off',
    });
    const result = (await firePreToolUse(options, bash(WRITING))) as HookResult;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('ALTEROID_BASH_FILE_WRITE_GUARD が off・未設定: 何も変えない', () => {
  for (const env of [
    {},
    { [BASH_FILE_WRITE_GUARD_ENV]: 'off' },
    { [BASH_FILE_WRITE_GUARD_ENV]: '' },
  ]) {
    it(`${JSON.stringify(env)}: ファイルを書く形でも何も決めず、note も出さない`, async () => {
      const { options, events } = await startSession(env);
      expect(await firePreToolUse(options, bash(WRITING))).toEqual({ continue: true });
      expect(await firePreToolUse(options, bash('echo a > f'))).toEqual({ continue: true });
      expect(notes(events).some((n) => n.text.includes('弾いた'))).toBe(false);
    });
  }
});

describe('綴り違いは落とす', () => {
  it('不正な値だと runner を起こせない（黙って既定へ倒さない）', () => {
    const { fn } = fakeRunnerSdk();
    expect(() =>
      createRunnerHost({
        runnerId: 'runner-test',
        workspacePath: dir,
        emit: () => undefined,
        queryFn: fn,
        env: { [BASH_FILE_WRITE_GUARD_ENV]: 'on' },
      }),
    ).toThrow(/ALTEROID_BASH_FILE_WRITE_GUARD の値が不正/);
  });
});
