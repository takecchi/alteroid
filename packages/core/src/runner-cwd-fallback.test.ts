import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

function fakeSdk(): {
  fn: typeof sdkQuery;
  cwds: string[];
} {
  const cwds: string[] = [];

  const fn = ((params: {
    options?: { cwd?: string };
    prompt: AsyncIterable<{ message: { content: unknown } }>;
  }) => {
    cwds.push(params.options?.cwd ?? '');
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${cwds.length}`,
        uuid: `uuid-init-${cwds.length}`,
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt) {
          void message;
        }
      })();

      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, cwds };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(
  options: {
    existingDirs: readonly string[];
  } & Partial<Pick<RunnerHostOptions, 'workspacePath'>>,
): {
  host: RunnerHost;
  events: RunnerEvent[];
  fake: ReturnType<typeof fakeSdk>;
  cwdChecks: string[];
} {
  const events: RunnerEvent[] = [];
  const fake = fakeSdk();
  const cwdChecks: string[] = [];
  const existing = new Set(options.existingDirs);
  const host = createRunnerHost({
    runnerId: 'runner-cwd-fallback',
    workspacePath: options.workspacePath ?? '/workspace',
    emit: (event) => events.push(event),
    queryFn: fake.fn,
    env: { PATH: '/usr/bin' },
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    cwdExistsFn: (cwd) => {
      cwdChecks.push(cwd);
      return existing.has(cwd);
    },
  });
  hosts.push(host);
  return { host, events, fake, cwdChecks };
}

describe('Host#resolveCwd（Issue #1783） — start', () => {
  it('明示された cwd が実在すれば、そのまま開く', async () => {
    const { host, fake, cwdChecks } = setup({ existingDirs: ['/work/project'] });
    await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '/work/project' });
    expect(fake.cwds).toEqual(['/work/project']);
    expect(host.list()[0]?.cwd).toBe('/work/project');
    expect(cwdChecks).toEqual(['/work/project']);
  });

  it('明示された cwd がこの器に実在しなければ、workspacePath へ倒して開く', async () => {
    const { host, fake } = setup({
      existingDirs: [],
      workspacePath: '/workspace',
    });
    await host.start({
      managerId: 'mgr-1',
      request: '依頼',
      cwd: '/workspace/mgr-old/repo-that-no-longer-exists',
    });
    expect(fake.cwds).toEqual(['/workspace']);
    expect(host.list()[0]?.cwd).toBe('/workspace');
  });

  it('cwd を省く（空文字）と、今までどおり workspacePath へ倒す（既存の既定を壊さない）', async () => {
    const { host, fake, cwdChecks } = setup({ existingDirs: [], workspacePath: '/workspace' });
    await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '' });
    expect(fake.cwds).toEqual(['/workspace']);
    expect(cwdChecks).toEqual([]);
  });
});

describe('Host#resolveCwd（Issue #1783） — resume', () => {
  it('明示された cwd がこの器（移送先）に実在しなければ、workspacePath へ倒して開く', async () => {
    const { host, fake } = setup({ existingDirs: [], workspacePath: '/workspace' });
    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-old',
      cwd: '/workspace/mgr-old/repo-that-no-longer-exists',
      request: '続きの依頼',
    });
    expect(fake.cwds).toEqual(['/workspace']);
    expect(host.list()[0]?.cwd).toBe('/workspace');
  });

  it('明示された cwd がこの器に実在すれば、そのまま resume する', async () => {
    const { host, fake } = setup({ existingDirs: ['/work/project'] });
    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-old',
      cwd: '/work/project',
      request: '続きの依頼',
    });
    expect(fake.cwds).toEqual(['/work/project']);
    expect(host.list()[0]?.cwd).toBe('/work/project');
  });
});
