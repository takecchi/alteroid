import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { systemErrorFactsOf, withSystemErrorNote } from './system-error.js';

function throwingSdk(error: unknown): typeof sdkQuery {
  return ((): Query => {
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<never>> => Promise.reject(error),
      return: (): Promise<IteratorResult<never>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
    return Object.assign(stream, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function hostThatThrows(error: unknown): {
  host: RunnerHost;
  waitForClosed: () => Promise<Extract<RunnerEvent, { type: 'closed' }>>;
} {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-713',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: throwingSdk(error),
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  const waitForClosed = async (): Promise<Extract<RunnerEvent, { type: 'closed' }>> => {
    let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
    await vi.waitFor(() => {
      closed = events.find(
        (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
      );
      if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    });
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    return closed;
  };
  return { host, waitForClosed };
}

async function closedAfterThrowing(
  error: unknown,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const { host, waitForClosed } = hostThatThrows(error);
  await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });
  return waitForClosed();
}

async function lostAfterThrowing(
  error: unknown,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const { host, waitForClosed } = hostThatThrows(error);
  await host.resume({
    managerId: 'mgr-1',
    sessionId: 'sess-dead',
    cwd: '/work/project',
    request: '最初の依頼',
    message: '続きの一言',
  });
  return waitForClosed();
}

function throughDaemonBoundary(event: RunnerEvent): Extract<RunnerEvent, { type: 'closed' }> {
  const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
  if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
  if (parsed.data.type !== 'closed') throw new Error(`closed ではない: ${parsed.data.type}`);
  return parsed.data;
}

function eagainSpawnError(): Error {
  return Object.assign(new Error('spawn /app/node_modules/.bin/claude EAGAIN'), {
    code: 'EAGAIN',
    errno: -11,
    syscall: 'spawn /app/node_modules/.bin/claude',
  });
}

describe('落ちた理由の分類が、判定できる形で closed に載る（#713 段1）', () => {
  it('code を持つ例外は、closed.systemError にその code が乗って daemon まで届く', async () => {
    const closed = await closedAfterThrowing(eagainSpawnError());
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.systemError).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
  });

  it('errno / syscall が無くても code だけは乗る（SDK が包み直した回の形）', async () => {
    const wrapped = Object.assign(
      new Error('Failed to spawn Claude Code process: spawn /app/…/claude EAGAIN'),
      { code: 'EAGAIN' },
    );
    const delivered = throughDaemonBoundary(await closedAfterThrowing(wrapped));

    expect(delivered.systemError).toEqual({ code: 'EAGAIN' });
    expect(Object.hasOwn(delivered.systemError as object, 'errno')).toBe(false);
    expect(Object.hasOwn(delivered.systemError as object, 'syscall')).toBe(false);
  });

  it('code を持たない例外では、欄そのものが付かない（「取れなかった」を値で埋めない）', async () => {
    const closed = await closedAfterThrowing(new Error('何か'));

    expect(Object.hasOwn(closed, 'systemError')).toBe(false);
    expect(closed.systemError).toBeUndefined();

    const delivered = throughDaemonBoundary(closed);
    expect(Object.hasOwn(delivered, 'systemError')).toBe(false);
    expect(delivered.systemError).toBeUndefined();
  });

  it('lost（戻れないと確定した回）にも同じ分類が乗る（枝を片方だけ測らない）', async () => {
    const closed = await lostAfterThrowing(eagainSpawnError());
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.status).toBe('lost');
    expect(delivered.systemError).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    expect(delivered.reason).toBe('Error: spawn /app/node_modules/.bin/claude EAGAIN');
  });

  it('lost でも、code を持たない例外では欄そのものが付かない', async () => {
    const delivered = throughDaemonBoundary(await lostAfterThrowing(new Error('何か')));

    expect(delivered.status).toBe('lost');
    expect(Object.hasOwn(delivered, 'systemError')).toBe(false);
    expect(delivered.systemError).toBeUndefined();
  });

  it('reason（人が読む一文）はこれまでと変わらない', async () => {
    const withCode = await closedAfterThrowing(eagainSpawnError());
    const withoutCode = await closedAfterThrowing(new Error('何か'));

    expect(withCode.reason).toBe(
      'マネージャーのセッションが落ちた: Error: spawn /app/node_modules/.bin/claude EAGAIN',
    );
    expect(withoutCode.reason).toBe('マネージャーのセッションが落ちた: Error: 何か');
    expect(withCode.status).toBe('failed');
    expect(withoutCode.status).toBe('failed');
  });
});

describe('systemErrorFactsOf は「取れなかった」を値で埋めない', () => {
  it('code を持たないものは undefined（欄を作らない）', () => {
    expect(systemErrorFactsOf(new Error('素の Error'))).toBeUndefined();
    expect(systemErrorFactsOf('投げられた文字列')).toBeUndefined();
    expect(systemErrorFactsOf(null)).toBeUndefined();
    expect(systemErrorFactsOf(undefined)).toBeUndefined();
    expect(systemErrorFactsOf(Object.assign(new Error('数値'), { code: 111 }))).toBeUndefined();
    expect(systemErrorFactsOf(Object.assign(new Error('空'), { code: '' }))).toBeUndefined();
  });

  it('取れた欄だけを載せる', () => {
    expect(systemErrorFactsOf(eagainSpawnError())).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    expect(systemErrorFactsOf(Object.assign(new Error('code だけ'), { code: 'ENOENT' }))).toEqual({
      code: 'ENOENT',
    });
  });
});

describe('withSystemErrorNote は base を変えず、末尾に分類の1行を足す（#713 段2）', () => {
  const base = 'マネージャーのセッションが落ちた: Error: 何か';

  it('base（event.reason）は1文字も変わらない——先頭が base + 改行のまま', () => {
    const withFacts = withSystemErrorNote(base, { code: 'EAGAIN' });
    const withoutFacts = withSystemErrorNote(base, undefined);
    expect(withFacts.startsWith(`${base}\n`)).toBe(true);
    expect(withoutFacts.startsWith(`${base}\n`)).toBe(true);
  });

  it('B: systemError が在るとき、code / errno / syscall を言い換えずにそのまま連ねる', () => {
    const decorated = withSystemErrorNote(base, {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    expect(decorated).toContain('code=EAGAIN');
    expect(decorated).toContain('errno=-11');
    expect(decorated).toContain('syscall=spawn /app/node_modules/.bin/claude');
  });

  it('B: errno / syscall が無い回（SDK が包み直した回の形）は、その欄を書かない', () => {
    const decorated = withSystemErrorNote(base, { code: 'EAGAIN' });
    expect(decorated).toContain('code=EAGAIN');
    expect(decorated).not.toContain('errno=');
    expect(decorated).not.toContain('syscall=');
  });

  it(
    'D: systemError が無いとき、withRecoveryNote と違って行を省略しない。' +
      '「取れなかった」を明示的な1行として書く',
    () => {
      const decorated = withSystemErrorNote(base, undefined);
      expect(decorated.length).toBeGreaterThan(base.length);
      expect(decorated).toContain('器の資源');
    },
  );

  it(
    'D の行は「器の資源の軸」に限定して名乗り、他の軸（枠・セッション切断）は' +
      'この欄の対象外だと明示する——A（枠）を D に飲み込ませない',
    () => {
      const decorated = withSystemErrorNote(base, undefined);
      expect(decorated).toContain('枠');
      expect(decorated).toContain('lastFailure');
    },
  );

  it(
    'D の行は、枠（A）で落ちた回の本文（reason）を上書きしない——' +
      '合成した最終本文には枠の文言と D の行が両方残る',
    () => {
      const quotaReason =
        'マネージャーのセッションが落ちた: Error: ' +
        "You've hit your individual spend limit for this account.";
      const decorated = withSystemErrorNote(quotaReason, undefined);
      expect(decorated).toContain("You've hit your individual spend limit for this account.");
      expect(decorated).toContain('器の資源による落ち方かどうかは');
    },
  );
});
