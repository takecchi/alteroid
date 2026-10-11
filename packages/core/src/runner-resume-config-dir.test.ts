import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerEvent } from './runner-protocol.js';
import { chownTreeSync, sdkResumeConfigDirOf } from './runner-resume-config-dir.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

describe('sdkResumeConfigDirOf: SDK の resume の一時ディレクトリだけを拾う', () => {
  it('tmpdir の直下の claude-resume-* を返す', () => {
    expect(sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: '/tmp/claude-resume-abc' }, '/tmp')).toBe(
      '/tmp/claude-resume-abc',
    );
  });

  it('子の設定ディレクトリ・tmpdir の外・名前の違うもの・未設定は拾わない', () => {
    expect(sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: '/home/worker/.claude' }, '/tmp')).toBe(
      undefined,
    );
    expect(sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: '/var/claude-resume-abc' }, '/tmp')).toBe(
      undefined,
    );
    expect(sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: '/tmp/x/claude-resume-abc' }, '/tmp')).toBe(
      undefined,
    );
    expect(sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' }, '/tmp')).toBe(
      undefined,
    );
    expect(sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: '' }, '/tmp')).toBe(undefined);
    expect(sdkResumeConfigDirOf({}, '/tmp')).toBe(undefined);
  });
});

describe('chownTreeSync: 中身を先に、根を最後に移し、symlink は辿らない', () => {
  it('木の全部の持ち主を移し、根は最後', async () => {
    const root = await makeTempDir('resume-chown-');
    const outside = await makeTempDir('resume-chown-outside-');
    await mkdir(join(root, 'projects', 'key'), { recursive: true });
    await writeFile(join(root, 'projects', 'key', 'sess.jsonl'), '{}\n');
    await writeFile(join(root, '.credentials.json'), '{}');
    await writeFile(join(outside, 'secret'), 'x');
    await symlink(outside, join(root, 'link'));

    const calls: string[] = [];
    chownTreeSync(root, 1001, 1001, (path, uid, gid) => {
      expect([uid, gid]).toEqual([1001, 1001]);
      calls.push(path);
    });

    expect(calls.at(-1)).toBe(root);
    expect(new Set(calls)).toEqual(
      new Set([
        root,
        join(root, 'projects'),
        join(root, 'projects', 'key'),
        join(root, 'projects', 'key', 'sess.jsonl'),
        join(root, '.credentials.json'),
        join(root, 'link'),
      ]),
    );
    expect(calls).not.toContain(join(root, 'link', 'secret'));
    expect(calls.indexOf(join(root, 'projects', 'key', 'sess.jsonl'))).toBeLessThan(
      calls.indexOf(join(root, 'projects')),
    );
  });
});

function fakeSdk(sessions: Options[]): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.push(params.options ?? {});
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

function fakeChild(): never {
  return {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => true,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as never;
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function startWith(handOver: (dir: string, uid: number, gid: number) => void): Promise<{
  spawn: (env: Record<string, string | undefined>) => void;
  events: RunnerEvent[];
  spawned: Record<string, string | undefined>[];
}> {
  const sessions: Options[] = [];
  const events: RunnerEvent[] = [];
  const spawned: Record<string, string | undefined>[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-resume-dir',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: fakeSdk(sessions),
    env: {},
    childUser: { uid: 1001, gid: 1002 },
    spawnAgentProcessFn: (options) => {
      spawned.push(options.env);
      return fakeChild();
    },
    handOverResumeConfigDirFn: handOver,
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
  const options = sessions[0] as Options;
  return {
    spawn: (env) =>
      void options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env,
        signal: new AbortController().signal,
      }),
    events,
    spawned,
  };
}

describe('Host: SDK の resume の一時ディレクトリを、子を起こす前に子へ渡す', () => {
  it('子の env が resume の一時ディレクトリを指していれば、子の uid・gid へ渡してから起こす', async () => {
    const calls: [string, number, number][] = [];
    const { spawn, spawned } = await startWith((dir, uid, gid) => {
      expect(spawned).toHaveLength(0);
      calls.push([dir, uid, gid]);
    });
    const dir = join((await import('node:os')).tmpdir(), 'claude-resume-0000');
    spawn({ CLAUDE_CONFIG_DIR: dir });
    expect(calls).toEqual([[dir, 1001, 1002]]);
    expect(spawned).toHaveLength(1);
  });

  it('子の設定ディレクトリを指すいつもの起動では何もしない', async () => {
    const calls: string[] = [];
    const { spawn, spawned } = await startWith((dir) => calls.push(dir));
    spawn({ CLAUDE_CONFIG_DIR: '/home/worker/.claude' });
    spawn({});
    expect(calls).toEqual([]);
    expect(spawned).toHaveLength(2);
  });

  it('渡せなくても起こすのは止めず、理由を note に残す', async () => {
    const { spawn, spawned, events } = await startWith(() => {
      throw new Error('EPERM（テストの偽物）');
    });
    spawn({ CLAUDE_CONFIG_DIR: join((await import('node:os')).tmpdir(), 'claude-resume-1111') });
    expect(spawned).toHaveLength(1);
    const notes = events
      .map((event) => (event.type === 'note' ? event.text : ''))
      .filter((text) => text.includes('resume の材料の置き場'));
    expect(notes).toEqual([expect.stringContaining('EPERM（テストの偽物）')]);
  });
});
