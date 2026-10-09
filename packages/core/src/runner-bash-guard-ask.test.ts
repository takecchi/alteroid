import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

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

const WAITING = 'tail -f /tmp/run.log';

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-bash-guard-ask-');
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

describe('既定（ask）: 弾く形は確認に上げる（#2884）', () => {
  it('tail -f は permissionDecision: ask を返し、理由に代替を含める', async () => {
    const { options, events } = await startSession({});
    const result = (await firePreToolUse(options, bash(WAITING))) as {
      continue?: boolean;
      hookSpecificOutput?: Record<string, unknown>;
    };
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('gh run watch');

    const guard = notes(events).filter((n) => n.text.includes('確認に上げた'));
    expect(guard).toHaveLength(1);
    expect(guard[0]?.text).toContain('manager:mgr-1');
    expect(guard[0]?.text).toContain('形=tail-f');
    expect(guard[0]?.escalate).toBeUndefined();
    expect(notes(events).some((n) => n.text.includes('Bash の呼び出しを弾いた'))).toBe(false);
  });

  it('作業者の呼び出しも ask で、note の actor は worker:', async () => {
    const { options, events } = await startSession({});
    const result = (await firePreToolUse(
      options,
      bash('while ! test -f done.txt; do sleep 10; done', {
        agent_id: 'agent-xyz',
        agent_type: 'worker',
      }),
    )) as { hookSpecificOutput?: Record<string, unknown> };
    expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(notes(events).find((n) => n.text.includes('確認に上げた'))?.text).toContain(
      'worker:mgr-1:worker',
    );
  });

  it('弾かない形は今までどおり何も決めない', async () => {
    const { options, events } = await startSession({});
    expect(await firePreToolUse(options, bash('echo hi'))).toEqual({ continue: true });
    expect(notes(events).some((n) => n.text.includes('確認に上げた'))).toBe(false);
  });
});

describe('ALTEROID_BASH_GUARD=deny: 従来どおり止める', () => {
  it('permissionDecision: deny を返し、「弾いた」note を出す', async () => {
    const { options, events } = await startSession({ [BASH_GUARD_ENV]: 'deny' });
    const result = (await firePreToolUse(options, bash(WAITING))) as {
      hookSpecificOutput?: Record<string, unknown>;
    };
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(notes(events).some((n) => n.text.includes('Bash の呼び出しを弾いた'))).toBe(true);
  });
});

describe('ALTEROID_BASH_GUARD=off: 門を掛けない', () => {
  it('弾く形でも何も決めず、note も出さない', async () => {
    const { options, events } = await startSession({ [BASH_GUARD_ENV]: 'off' });
    expect(await firePreToolUse(options, bash(WAITING))).toEqual({ continue: true });
    expect(
      notes(events).some(
        (n) => n.text.includes('確認に上げた') || n.text.includes('Bash の呼び出しを弾いた'),
      ),
    ).toBe(false);
  });
});

describe('綴り違いは落とす', () => {
  it('不正な値だと runner を起こせない（黙って既定へ倒さない）', async () => {
    const { fn } = fakeRunnerSdk();
    expect(() =>
      createRunnerHost({
        runnerId: 'runner-test',
        workspacePath: dir,
        emit: () => undefined,
        queryFn: fn,
        env: { [BASH_GUARD_ENV]: 'of' },
      }),
    ).toThrow(/ALTEROID_BASH_GUARD の値が不正/);
  });
});

const RELEASE_PROD = 'gh workflow run release-prod.yml';

describe('本番デプロイの起動（release-prod）は、off でも確認に上げる（#2884）', () => {
  for (const env of [{}, { [BASH_GUARD_ENV]: 'ask' }, { [BASH_GUARD_ENV]: 'off' }]) {
    it(`ALTEROID_BASH_GUARD=${env[BASH_GUARD_ENV] ?? '(未設定)'}: ask を返し、理由に release-prod を含める`, async () => {
      const { options, events } = await startSession(env);
      const result = (await firePreToolUse(options, bash(RELEASE_PROD))) as {
        hookSpecificOutput?: Record<string, unknown>;
      };
      expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('release-prod');
      const asked = notes(events).filter((n) => n.text.includes('確認に上げた'));
      expect(asked).toHaveLength(1);
      expect(asked[0]?.text).toContain('形=gh-release-prod');
    });
  }

  it('deny の設定では deny を返す', async () => {
    const { options } = await startSession({ [BASH_GUARD_ENV]: 'deny' });
    const result = (await firePreToolUse(options, bash(RELEASE_PROD))) as {
      hookSpecificOutput?: Record<string, unknown>;
    };
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('作業者の呼び出しでも ask（actor は worker:）', async () => {
    const { options, events } = await startSession({ [BASH_GUARD_ENV]: 'off' });
    const result = (await firePreToolUse(
      options,
      bash(RELEASE_PROD, { agent_id: 'agent-xyz', agent_type: 'worker' }),
    )) as { hookSpecificOutput?: Record<string, unknown> };
    expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(notes(events).find((n) => n.text.includes('確認に上げた'))?.text).toContain(
      'worker:mgr-1:worker',
    );
  });

  it('別のワークフローの起動は、off なら何も決めない', async () => {
    const { options } = await startSession({ [BASH_GUARD_ENV]: 'off' });
    expect(await firePreToolUse(options, bash('gh workflow run ci.yml'))).toEqual({
      continue: true,
    });
  });
});
