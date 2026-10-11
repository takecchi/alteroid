import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentChildProcess, AgentSpawnOptions } from './agent-session.js';
import { signalOfSubreaperExit, subreapedProcess, underSubreaper } from './delegation-subreaper.js';
import { createRunnerHost } from './runner.js';

type ExitArgs = [number | null, NodeJS.Signals | null];

// 親の env を丸ごと継がない（#1971）: `sh` を引ける PATH だけを渡す。
const SH_OPTIONS = { stdio: 'pipe', env: { PATH: process.env.PATH } } as const;

function exitOf(child: AgentChildProcess, via: 'on' | 'once'): Promise<ExitArgs> {
  return new Promise((resolve) => {
    child[via]('exit', (code, signal) => resolve([code, signal]));
  });
}

describe('委譲の CLI の引き取り手（#4494）', () => {
  it('underSubreaper: CLI を `<tini> -s --` の子として起こす命令に書き換え、他は変えない', () => {
    const signal = new AbortController().signal;
    const options: AgentSpawnOptions = {
      command: '/usr/local/bin/claude',
      args: ['--print', '--verbose'],
      cwd: '/work',
      env: { A: '1' },
      signal,
    };
    expect(underSubreaper(options, '/usr/bin/tini')).toEqual({
      command: '/usr/bin/tini',
      args: ['-s', '--', '/usr/local/bin/claude', '--print', '--verbose'],
      cwd: '/work',
      env: { A: '1' },
      signal,
    });
  });

  it('signalOfSubreaperExit: 128+N をシグナルへ読み戻す。128 以下と null は読み戻さない', () => {
    expect(signalOfSubreaperExit(134)).toBe('SIGABRT');
    expect(signalOfSubreaperExit(137)).toBe('SIGKILL');
    expect(signalOfSubreaperExit(143)).toBe('SIGTERM');
    expect(signalOfSubreaperExit(128)).toBeUndefined();
    expect(signalOfSubreaperExit(1)).toBeUndefined();
    expect(signalOfSubreaperExit(0)).toBeUndefined();
    expect(signalOfSubreaperExit(null)).toBeUndefined();
  });

  it('subreapedProcess: tini が 134 で終わったら、SIGABRT で死んだ子として見せる（実プロセス）', async () => {
    const child = subreapedProcess(spawn('sh', ['-c', 'exit 134'], SH_OPTIONS));
    const viaOn = exitOf(child, 'on');
    const viaOnce = exitOf(child, 'once');
    expect(await viaOn).toEqual([null, 'SIGABRT']);
    expect(await viaOnce).toEqual([null, 'SIGABRT']);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe('SIGABRT');
  });

  it('subreapedProcess: ふつうの終了コードはそのまま通す（実プロセス）', async () => {
    const child = subreapedProcess(spawn('sh', ['-c', 'exit 3'], SH_OPTIONS));
    expect(await exitOf(child, 'once')).toEqual([3, null]);
    expect(child.exitCode).toBe(3);
    expect(child.signalCode).toBeNull();
  });

  it('subreapedProcess: tini 自身がシグナルで死んだ回はそのまま通す（実プロセス）', async () => {
    const raw = spawn('sh', ['-c', 'sleep 30'], SH_OPTIONS);
    const child = subreapedProcess(raw);
    const exited = exitOf(child, 'once');
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(child.killed).toBe(true);
  });

  it('subreapedProcess: off で外した exit の listener は呼ばれない。pid・stdio・stderr は写す', async () => {
    const raw = spawn('sh', ['-c', 'echo out; echo err >&2; exit 0'], SH_OPTIONS);
    const child = subreapedProcess(raw);
    expect(child.pid).toBe(raw.pid);
    expect(child.stdin).toBe(raw.stdin);
    expect(child.stdout).toBe(raw.stdout);
    expect((child as { stderr?: unknown }).stderr).toBe(raw.stderr);
    const removed: ExitArgs[] = [];
    const listener = (code: number | null, signal: NodeJS.Signals | null): void => {
      removed.push([code, signal]);
    };
    child.on('exit', listener);
    child.off('exit', listener);
    expect(await exitOf(child, 'once')).toEqual([0, null]);
    expect(removed).toEqual([]);
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
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

function inertProcess(pid: number): AgentChildProcess {
  return {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => true,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  };
}

describe('委譲の引き取り手の配線（#4494。RunnerHost の delegationSubreaper）', () => {
  async function spawnedCommandWith(
    delegationSubreaper: string | undefined,
  ): Promise<{ spawned: AgentSpawnOptions[]; live: ReadonlySet<number> }> {
    const sessions: Options[] = [];
    const spawned: AgentSpawnOptions[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: fakeSdk(sessions),
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: (options) => {
        spawned.push(options);
        return inertProcess(5150);
      },
      ...(delegationSubreaper === undefined ? {} : { delegationSubreaper }),
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
    sessions[0]?.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: ['--print'],
      env: {},
      signal: new AbortController().signal,
    });
    const { live } = host.delegationSessionPids();
    await host.shutdown();
    return { spawned, live };
  }

  it('渡されたら、委譲の CLI を `<tini> -s --` の子として起こし、tini の pid を委譲の pid として追う', async () => {
    const { spawned, live } = await spawnedCommandWith('/usr/bin/tini');
    expect(spawned.map(({ command, args }) => [command, args])).toEqual([
      ['/usr/bin/tini', ['-s', '--', 'claude', '--print']],
    ]);
    expect(live).toEqual(new Set([5150]));
  });

  it('対照: 渡されなければ CLI を直に起こす', async () => {
    const { spawned } = await spawnedCommandWith(undefined);
    expect(spawned.map(({ command, args }) => [command, args])).toEqual([['claude', ['--print']]]);
  });
});
