import { mkdirSync } from 'node:fs';
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

// 依頼文で作業場を /tmp/mgr-<役割名> と指定された担当は、決まり（/tmp/mgr-<委譲 id の頭>）の外で git を打つ（2026-10-13、担当4本が指摘）

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

// 1ターン目で、渡された Bash のコマンドを、渡された cwd で PostToolUse まで走らせる偽の SDK
function fakeSdk(calls: readonly { command: string; cwd: string }[]) {
  let seq = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-hints',
        uuid: `uuid-init-${String(++seq)}`,
      } as unknown as SDKMessage;
      const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const next = await iterator.next();
      if (next.done === true) return;
      const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
      for (const call of calls) {
        await hook?.(
          { tool_name: 'Bash', tool_input: { command: call.command }, cwd: call.cwd } as never,
          undefined,
          { signal: new AbortController().signal } as never,
        );
      }
      yield {
        type: 'result',
        subtype: 'success',
        result: '済んだ',
        session_id: 'sess-hints',
        uuid: `uuid-result-${String(++seq)}`,
      } as unknown as SDKMessage;
      await iterator.next();
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
  dir = makeTempDirSync('alteroid-runner-git-hints-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function runAndStop(calls: readonly { command: string; cwd: string }[]) {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fakeSdk(calls),
    env: { PATH: '/usr/bin' },
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '直して', cwd: '/work/project' });
  await vi.waitFor(() => {
    if (!events.some((event) => event.type === 'report')) throw new Error('報告待ち');
  });
  await host.stop('mgr-1');
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

describe('決まりの外で git を打った作業ツリーは、片付けで消さず、終わるときに note でパスを知らせる', () => {
  it('cd の先・git -C の先の作業ツリー（下の階層から根へ遡る）を note に出す', async () => {
    const roleDir = makeTempDirSync('alteroid-role-workdir-');
    const repoA = join(roleDir, 'a');
    const repoB = join(roleDir, 'b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoA, 'apps', 'web'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    const notes = await runAndStop([
      { command: 'cd a/apps/web && git status', cwd: roleDir },
      { command: `git -C ${repoB} push origin x`, cwd: '/work/project' },
    ]);

    const note = notes.find((n) => n.text.includes('決まり（担当の作業場か /tmp/mgr-'));
    expect(note?.text).toContain('runner の片付けは消さない');
    expect(note?.text).toContain(repoA);
    expect(note?.text).toContain(repoB);
  });

  it('対照: 決まり（/tmp/mgr-<16進>）の下の作業ツリーだけなら note を出さない（そちらは片付けが扱う）', async () => {
    const scratch = makeTempDirSync('mgr-abcd1234-');
    mkdirSync(join(scratch, 'repo', '.git'), { recursive: true });

    const notes = await runAndStop([{ command: 'git status', cwd: join(scratch, 'repo') }]);

    expect(notes.some((n) => n.text.includes('決まり（担当の作業場か /tmp/mgr-'))).toBe(false);
  });
});
