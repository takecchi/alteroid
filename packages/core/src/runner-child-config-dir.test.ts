import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createRunnerHost, type RunnerChildUser, type RunnerHost } from './runner.js';

function fakeSdk(): { fn: typeof sdkQuery; options: Options[] } {
  const options: Options[] = [];
  const fn = ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    options.push(params.options ?? {});
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt) {
        void message;
        yield {
          type: 'result',
          subtype: 'success',
          result: '終わった',
          session_id: 'sess-1',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, options };
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function sessionEnvOf(input: {
  childUser?: RunnerChildUser;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, string | undefined>> {
  const fake = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-config-dir',
    workspacePath: '/workspace',
    emit: () => undefined,
    queryFn: fake.fn,
    env: input.env ?? { PATH: '/usr/bin' },
    ...(input.childUser === undefined ? {} : { childUser: input.childUser }),
    outboxRoot: await makeTempDir('runner-config-dir-outbox-'),
    outboxStagedRoot: await makeTempDir('runner-config-dir-staged-'),
    outboxRemoveContentsAsChild: () => undefined,
    scratchSweep: false,
    cwdExistsFn: () => true,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-abc123', request: '依頼', cwd: '/workspace' });
  await vi.waitFor(() => expect(fake.options).toHaveLength(1));
  return fake.options[0]?.env as Record<string, string | undefined>;
}

const ownIds = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

// SDK は生ログの写しを `env.CLAUDE_CONFIG_DIR ?? <runner の homedir>/.claude` の `projects` の下にあるときだけ預ける。子の HOME だけを差し替えると、子の書くパスがその外になり、1行も預からない。
describe('Host: 子の設定ディレクトリを SDK に見せる', () => {
  it('子の home が決まっていれば、セッションの env に CLAUDE_CONFIG_DIR=<home>/.claude を置く', async () => {
    const env = await sessionEnvOf({ childUser: { ...ownIds, home: '/home/worker' } });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/worker/.claude');
  });

  it('既に CLAUDE_CONFIG_DIR が置かれていれば上書きしない（子も SDK も同じ値を見る）', async () => {
    const env = await sessionEnvOf({
      childUser: { ...ownIds, home: '/home/worker' },
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/srv/claude-config' },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/srv/claude-config');
  });

  it('子の home が決まっていなければ置かない（子は runner と同じ HOME で書く）', async () => {
    const withoutHome = await sessionEnvOf({ childUser: ownIds });
    expect(withoutHome.CLAUDE_CONFIG_DIR).toBeUndefined();
    const withoutChild = await sessionEnvOf({});
    expect(withoutChild.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
