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

function bash(command: string, worker: boolean): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    tool_input: { command },
    ...(worker ? { agent_id: 'agent-xyz', agent_type: 'worker' } : {}),
  };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-bash-worker-shape-');
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

function noteTexts(events: readonly RunnerEvent[]): string[] {
  return events
    .filter((event) => event.type === 'note')
    .map((event) => (event as { text: string }).text);
}

type Out = { continue?: boolean; hookSpecificOutput?: Record<string, unknown> };

describe('作業者の Bash の形の歯（#4947）', () => {
  for (const mode of [undefined, 'ask', 'deny'] as const) {
    it(`ALTEROID_BASH_GUARD=${mode ?? '未設定'}: 作業者の 2>&1 は deny で、代わりの道を返し、note に作業者と形を残す`, async () => {
      const { options, events } = await startSession(
        mode === undefined ? {} : { [BASH_GUARD_ENV]: mode },
      );
      const result = (await firePreToolUse(options, bash('pnpm test 2>&1', true))) as Out;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('| tail');
      const note = noteTexts(events).find((t) => t.includes('Bash の呼び出しを弾いた'));
      expect(note).toContain('worker:mgr-1:worker');
      expect(note).toContain('形=worker-fd-dup');
      expect(noteTexts(events).some((t) => t.includes('確認に上げた'))).toBe(false);
    });
  }

  it.each([
    ['cat <<EOF\nx\nEOF', 'worker-heredoc', 'Write'],
    ['echo hi > f', 'worker-redirect', 'Write'],
    ["sed -i 's/a/b/' f", 'worker-sed-in-place', 'Edit'],
    ["node -e '1'", 'worker-node-eval', 'Write'],
    ["python3 -c 'x'", 'worker-python-c', 'Write'],
    ["perl -e '1'", 'worker-perl-eval', 'Write'],
  ])('作業者の %j は deny（形=%s）', async (command, form, hint) => {
    const { options, events } = await startSession({});
    const result = (await firePreToolUse(options, bash(command, true))) as Out;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain(hint);
    expect(noteTexts(events).some((t) => t.includes(`形=${form}`))).toBe(true);
  });

  it('マネージャーの 2>&1 は通す', async () => {
    const { options, events } = await startSession({});
    expect(await firePreToolUse(options, bash('pnpm test 2>&1 | tail -n 20', false))).toEqual({
      continue: true,
    });
    expect(noteTexts(events).some((t) => t.includes('形='))).toBe(false);
  });

  it('ALTEROID_BASH_GUARD=off なら作業者の形も通す', async () => {
    const { options } = await startSession({ [BASH_GUARD_ENV]: 'off' });
    expect(await firePreToolUse(options, bash('pnpm test 2>&1', true))).toEqual({
      continue: true,
    });
  });

  it('誤検知の例（引用符の中・bash -c）は作業者でも通す', async () => {
    const { options } = await startSession({});
    for (const command of [
      'gh pr create --body "a > b"',
      "timeout 300 bash -c 'sleep 1; echo done'",
      'sort < in.txt',
    ]) {
      const result = (await firePreToolUse(options, bash(command, true))) as Out;
      expect(result.continue).toBe(true);
      // timeout の引き上げ（書き換え）は付きうるので、deny・ask が無いことだけを見る
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    }
  });

  it('形の歯に掛からない作業者の待ち形は、今までどおり wait-guard が確認に上げる', async () => {
    const { options } = await startSession({});
    const result = (await firePreToolUse(options, bash('tail -f /tmp/run.log', true))) as Out;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
  });
});
