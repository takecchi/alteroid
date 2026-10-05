import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCredentialStore } from './credentials.js';
import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * **走行中の定期的な退避 ref の配線（Issue #1266）。** `rescue-ref.test.ts` が
 * 作り方（作業ツリーを動かさない・歯・分類）を持つ。ここは `RunnerHost` のタイマーが
 * 走行中の各セッションを撃ち、`rescue_ref` を（境界を通る形で）emit すること、
 * 前回と同じなら黙ること、畳む直前にも1回撃つことだけを、本物の git と
 * ローカルの bare リポジトリで固定する。
 */

function fakeSdk(): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt) void message;
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
}

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

let hosts: RunnerHost[] = [];
let root: string;
let repo: string;
let bare: string;

beforeEach(async () => {
  root = await makeTempDir('runner-rescue-');
  repo = path.join(root, 'repo');
  bare = path.join(root, 'origin.git');
  await mkdir(repo);
  g(root, 'init', '-q', '--bare', bare);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'remote', 'add', 'origin', bare);
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  g(repo, 'add', 'a.txt');
  g(repo, 'commit', '-qm', 'first');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'fetch', '-q', 'origin');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
  await rm(root, { recursive: true, force: true });
});

function setup(rescueIntervalMs: number): { host: RunnerHost; events: RunnerEvent[] } {
  const events: RunnerEvent[] = [];
  const credentials = createCredentialStore({
    dir: path.join(root, 'cred'),
    seed: { GH_TOKEN: 'test-token-value-for-rescue' },
  });
  const host = createRunnerHost({
    runnerId: 'runner-1266r',
    workspacePath: repo,
    emit: (event) => events.push(event),
    queryFn: fakeSdk(),
    env: { ...GIT_ENV },
    credentials,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: repo, worktrees: [] }),
    rescueIntervalMs,
  });
  hosts.push(host);
  return { host, events };
}

function rescueEvents(
  events: readonly RunnerEvent[],
): Extract<RunnerEvent, { type: 'rescue_ref' }>[] {
  return events.filter(
    (event): event is Extract<RunnerEvent, { type: 'rescue_ref' }> => event.type === 'rescue_ref',
  );
}

describe('走行中の退避 ref の配線（Issue #1266）', () => {
  it('周期で撃ち、変わらなければ黙り、変わればまた送る。境界を通っても壊れない', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'u');
    const { host, events } = setup(40);
    await host.start({ managerId: 'mgr-abcd1234', request: '依頼', cwd: repo });

    await vi.waitFor(() => expect(rescueEvents(events)).toHaveLength(1), { timeout: 5000 });
    const parsed = runnerEventSchema.parse(JSON.parse(JSON.stringify(rescueEvents(events)[0])));
    if (parsed.type !== 'rescue_ref') throw new Error('rescue_ref ではない');
    const tree = parsed.worktrees[0];
    expect(parsed.managerId).toBe('mgr-abcd1234');
    expect(tree?.pushed?.ref).toMatch(/^refs\/alteroid-rescue\/mgr-abcd1234\/root-[0-9a-f]{8}$/);
    expect(tree?.untracked?.paths).toEqual(['scratch.txt']);
    expect(g(bare, 'show', `${tree?.pushed?.ref as string}:a.txt`)).toBe('edited\n');

    // 何も変わらない周期は黙る。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rescueEvents(events)).toHaveLength(1);

    // 変わったらまた送る。
    await writeFile(path.join(repo, 'a.txt'), 'edited again\n');
    await vi.waitFor(() => expect(rescueEvents(events)).toHaveLength(2), { timeout: 5000 });
  });

  it('畳む直前（shutdown）にも1回撃つ。周期が長くても', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited at shutdown\n');
    const { host, events } = setup(3_600_000);
    await host.start({ managerId: 'mgr-abcd1234', request: '依頼', cwd: repo });
    expect(rescueEvents(events)).toHaveLength(0);

    await host.shutdown();

    // B3: 既存の shutdown_unpushed_work は退避（最大20秒）を待たず、先に emit する（#2749 の窓を広げない）。
    const types = events.map((e) => e.type);
    expect(types.indexOf('shutdown_unpushed_work')).toBeLessThan(types.indexOf('rescue_ref'));
    const found = rescueEvents(events);
    expect(found).toHaveLength(1);
    expect(g(bare, 'show', `${found[0]?.worktrees[0]?.pushed?.ref as string}:a.txt`)).toBe(
      'edited at shutdown\n',
    );
  });
});
