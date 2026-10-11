import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, DELEGATION_STDERR_END_GRACE_MS, type RunnerHost } from './runner.js';

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

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed = false;
  readonly exitCode: number | null = null;
  kill(): boolean {
    return true;
  }
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
  vi.useRealTimers();
});

async function spawnFakeChild(
  childEnv: Record<string, string> = {},
  stop: AbortController = new AbortController(),
): Promise<{ child: FakeChild; events: RunnerEvent[]; host: RunnerHost }> {
  const sessions: Options[] = [];
  const events: RunnerEvent[] = [];
  const child = new FakeChild();
  const host = createRunnerHost({
    runnerId: 'runner-stderr',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: fakeSdk(sessions),
    env: {},
    childUser: { uid: 1001, gid: 1001 },
    spawnAgentProcessFn: () => child as never,
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work/project' });
  sessions[0]?.spawnClaudeCodeProcess?.({
    command: 'claude',
    args: [],
    env: childEnv,
    signal: stop.signal,
  });
  return { child, events, host };
}

async function drained(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function cliNotes(events: RunnerEvent[]): string[] {
  return events
    .map((event) => (event.type === 'note' ? event.text : ''))
    .filter((text) => text.includes('委譲の CLI'));
}

describe('自前で起こした委譲の CLI の stderr を読み、0 以外で終わったら末尾を note に残す', () => {
  it('⭐ exit code 1 で終わったら、stderr の末尾を添えて note を出す', async () => {
    const { child, events } = await spawnFakeChild();
    child.stderr.write('起動の途中で失敗した: Error: something broke\n');
    await drained();
    child.emit('exit', 1, null);
    child.stderr.end();
    await drained();

    const notes = cliNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('exit code 1');
    expect(notes[0]).toContain('something broke');
  });

  it('stderr が空なら、空だったと言う', async () => {
    const { child, events } = await spawnFakeChild();
    child.emit('exit', 1, null);
    child.stderr.end();
    await drained();

    expect(cliNotes(events)).toEqual([expect.stringContaining('stderr には何も出ていなかった')]);
  });

  it('signal で終わった回も言う', async () => {
    const { child, events } = await spawnFakeChild();
    child.emit('exit', null, 'SIGABRT');
    child.stderr.end();
    await drained();

    expect(cliNotes(events)).toEqual([expect.stringContaining('signal SIGABRT')]);
  });

  it('exit code 0 では何も言わない', async () => {
    const { child, events } = await spawnFakeChild();
    child.stderr.write('ふつうの出力\n');
    await drained();
    child.emit('exit', 0, null);

    expect(cliNotes(events)).toEqual([]);
  });

  it('末尾だけを持つ（大量に書かれても読み続け、最後の部分を残す）', async () => {
    const { child, events } = await spawnFakeChild();
    child.stderr.write(`${'x'.repeat(200_000)}\n最後の行`);
    await drained();
    child.emit('exit', 2, null);
    child.stderr.end();
    await drained();

    const [note] = cliNotes(events);
    expect(note).toContain('最後の行');
    expect((note ?? '').length).toBeLessThan(3000);
  });

  it('⭐ exit が stderr の最後の chunk より先に来ても、その chunk を note に入れる', async () => {
    const { child, events } = await spawnFakeChild();
    child.emit('exit', 1, null);
    expect(cliNotes(events)).toEqual([]);
    child.stderr.write('致命的エラー: 最後の一行\n');
    child.stderr.end();
    await drained();

    const notes = cliNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('致命的エラー: 最後の一行');
  });

  it('⭐ end が来ないまま猶予が切れても、その時点までの末尾で note を1回だけ出す', async () => {
    vi.useFakeTimers();
    const { child, events } = await spawnFakeChild();
    child.stderr.write('孫が握っていても読めた行\n');
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(DELEGATION_STDERR_END_GRACE_MS - 1);
    expect(cliNotes(events)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(cliNotes(events)).toEqual([expect.stringContaining('孫が握っていても読めた行')]);
    child.stderr.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(cliNotes(events)).toHaveLength(1);
  });

  it('⭐ 子に渡した env にだけある値は、パターンに当たらない形でも note に生で載らない', async () => {
    const { child, events } = await spawnFakeChild({ PROFILE_API_SECRET: 'zq-plain-secret-77' });
    child.stderr.write('接続に失敗: zq-plain-secret-77 は拒否された\n');
    child.emit('exit', 1, null);
    child.stderr.end();
    await drained();

    const [note] = cliNotes(events);
    expect(note).toContain('接続に失敗');
    expect(note).not.toContain('zq-plain-secret-77');
  });
});

describe('止めると決めた後に止め方どおりに終わった子は、異常終了の note を出さない（#4488）', () => {
  it.each([
    [null, 'SIGTERM'],
    [null, 'SIGKILL'],
    [143, null],
    [137, null],
  ] as const)(
    'SDK の close() が signal を abort した後の exit(%s, %s) は黙る',
    async (code, signal) => {
      const stop = new AbortController();
      const { child, events } = await spawnFakeChild({}, stop);
      stop.abort();
      child.emit('exit', code, signal);
      child.stderr.end();
      await drained();

      expect(cliNotes(events)).toEqual([]);
    },
  );

  it('runner が委譲を止めた（stop）後の SIGTERM も黙る', async () => {
    const { child, events, host } = await spawnFakeChild();
    const stopping = host.stop('mgr-1');
    child.emit('exit', null, 'SIGTERM');
    child.stderr.end();
    await stopping.catch(() => undefined);
    await drained();

    expect(cliNotes(events)).toEqual([]);
  });

  it('止めた後でも exit code 1 は言う（止める途中で本当に落ちたのかもしれない）', async () => {
    const stop = new AbortController();
    const { child, events } = await spawnFakeChild({}, stop);
    child.stderr.write('closing の途中で落ちた\n');
    await drained();
    stop.abort();
    child.emit('exit', 1, null);
    child.stderr.end();
    await drained();

    expect(cliNotes(events)).toEqual([expect.stringContaining('exit code 1')]);
  });

  it('止めていないのに SIGTERM で終わった回は、これまでどおり言う', async () => {
    const { child, events } = await spawnFakeChild();
    child.emit('exit', null, 'SIGTERM');
    child.stderr.end();
    await drained();

    expect(cliNotes(events)).toEqual([expect.stringContaining('signal SIGTERM')]);
  });
});
