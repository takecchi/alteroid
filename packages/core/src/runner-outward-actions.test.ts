import { join } from 'node:path';

import type {
  HookCallback,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

// 各ターンで、渡された Bash のコマンドを PostToolUse まで走らせてから結果を返す偽の SDK
function fakeSdk(turns: readonly (readonly { tool: string; command: string }[])[]) {
  let seq = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-outward',
        uuid: `uuid-init-${String(++seq)}`,
      } as unknown as SDKMessage;
      const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      for (let turn = 0; ; turn += 1) {
        const next = await iterator.next();
        if (next.done === true) return;
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        for (const call of turns[turn] ?? []) {
          await hook?.(
            { tool_name: call.tool, tool_input: { command: call.command } } as never,
            undefined,
            { signal: new AbortController().signal } as never,
          );
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: `ターン${String(turn + 1)}`,
          session_id: 'sess-outward',
          uuid: `uuid-result-${String(++seq)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return fn;
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-outward-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function runTurns(turns: readonly (readonly { tool: string; command: string }[])[]) {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fakeSdk(turns),
    env: { PATH: '/usr/bin' },
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '1つ目', cwd: '/work/project' });
  const reports = (): ReportEvent[] =>
    events.filter((event): event is ReportEvent => event.type === 'report');
  for (let turn = 1; turn < turns.length; turn += 1) {
    await vi.waitFor(() => {
      if (reports().length < turn) throw new Error(`${String(turn)}本目の報告待ち`);
    });
    await host.send('mgr-1', `${String(turn + 1)}つ目`);
  }
  await vi.waitFor(() => {
    if (reports().length < turns.length) throw new Error('最後の報告待ち');
  });
  return reports();
}

describe('報告に、そのターンまでに走った「外へ出す」コマンドの名前を載せる（outwardActions）', () => {
  it('Bash で打ったマージ・push を重複なしで載せ、次の報告では空に戻す', async () => {
    const reports = await runTurns([
      [
        { tool: 'Bash', command: 'gh pr merge 1006 --squash' },
        { tool: 'Bash', command: 'git push origin x' },
        { tool: 'Bash', command: 'git push origin y' },
      ],
      [{ tool: 'Bash', command: 'gh pr list' }],
    ]);

    expect(reports[0]?.outwardActions).toEqual(['gh pr merge', 'git push']);
    expect(reports[1]?.outwardActions).toBeUndefined();
  });

  it('Bash 以外の道具の入力に同じ文字列があっても載せない', async () => {
    const reports = await runTurns([[{ tool: 'Write', command: 'gh pr merge 1' }]]);

    expect(reports[0]?.outwardActions).toBeUndefined();
  });
});
