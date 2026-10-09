import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';

function fakeSdk(): { fn: typeof sdkQuery; options: Options[] } {
  const options: Options[] = [];
  const fn = ((input: { options: Options }) => {
    options.push(input.options);
    let stop: () => void = () => undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        stop = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => stop(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, options };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-permission-denied-entry-note-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

async function run(extra: Record<string, unknown>, reason: string) {
  const { fn, options } = fakeSdk();
  const events: { type: string; text?: string }[] = [];
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event as { type: string; text?: string }),
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const hook = options[0]?.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PermissionDenied フックが登録されていない');
  await hook(
    {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
      reason,
      ...extra,
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
  return events.filter((e) => e.type === 'note').map((e) => e.text ?? '');
}

describe('PermissionDenied の入口の note（issue #1766）', () => {
  it('マネージャー本人の拒否で、入口の note が1行出る（理由は先頭だけ）', async () => {
    const notes = await run({}, '[Interfere With Workloads]\n' + 'x'.repeat(500));
    const entry = notes.filter((t) => t.includes('issue #1766'));
    expect(entry).toHaveLength(1);
    expect(entry[0]).toContain('manager:mgr-1');
    expect(entry[0]).toContain('Bash');
    expect(entry[0]).toContain('tool_use_id=tu-1');
    expect(entry[0]).toContain('[Interfere With Workloads]');
    expect(entry[0]!.length).toBeLessThan(300);
  });

  it('作業者の拒否でも、入口の note が1行出る', async () => {
    const notes = await run({ agent_id: 'a-1' }, '[Auto-Mode Bypass]');
    const entry = notes.filter((t) => t.includes('issue #1766'));
    expect(entry).toHaveLength(1);
    expect(entry[0]).toContain('worker:mgr-1:');
    expect(entry[0]).toContain('[Auto-Mode Bypass]');
  });
});
