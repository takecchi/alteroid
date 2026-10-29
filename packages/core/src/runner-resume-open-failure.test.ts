import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// resume で作り直したセッションの CLI の起動（`#driver.open`）が同期で投げたら、開いていないセッションを名簿に残さない（#5500）。
// `start` は同じ失敗を片付けている。外から見える結果（list・次の resume・start）で測る。

function flakyQuery(failures: number): { fn: typeof sdkQuery; calls: () => number } {
  let calls = 0;
  const fn = (() => {
    calls += 1;
    if (calls <= failures) throw new Error('boom');
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${calls}`,
        uuid: `uuid-init-${calls}`,
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
  return { fn, calls: () => calls };
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(failures: number) {
  const fake = flakyQuery(failures);
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-open-fail',
    workspacePath: '/workspace',
    emit: (event) => events.push(event),
    queryFn: fake.fn,
    env: { PATH: '/usr/bin' },
    scratchSweep: false,
    cwdExistsFn: () => true,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
  });
  hosts.push(host);
  return { host, fake, events };
}

const resumeCommand = {
  managerId: 'mgr-abc123',
  sessionId: 'sess-old',
  cwd: '/workspace',
  request: '元の依頼',
};

describe('resume で CLI の起動が投げた回', () => {
  it('reject した後、名簿に開いていないセッションが残らない', async () => {
    const { host } = setup(1);
    await expect(host.resume(resumeCommand)).rejects.toThrow('boom');
    expect(host.list()).toHaveLength(0);
  });

  it('次の resume は生きたセッションと答えず、作り直す', async () => {
    const { host, fake } = setup(1);
    await expect(host.resume(resumeCommand)).rejects.toThrow('boom');
    const result = await host.resume(resumeCommand);
    expect(result.reusedLiveSession).toBe(false);
    expect(fake.calls()).toBe(2);
    expect(host.list()).toHaveLength(1);
  });

  it('同じ managerId の start が「既に走っている」で断られない', async () => {
    const { host } = setup(1);
    await expect(host.resume(resumeCommand)).rejects.toThrow('boom');
    await expect(
      host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' }),
    ).resolves.toBeDefined();
    await vi.waitFor(() => expect(host.list()).toHaveLength(1));
  });
});
