import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCredentialStore } from './credentials.js';
import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

function fakeSdk(captured: Options[] = []): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    captured.push(params.options ?? {});
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

function setup(
  rescueIntervalMs: number,
  captured: Options[] = [],
): { host: RunnerHost; events: RunnerEvent[] } {
  const events: RunnerEvent[] = [];
  const credentials = createCredentialStore({
    dir: path.join(root, 'cred'),
    seed: { GH_TOKEN: 'test-token-value-for-rescue' },
  });
  const host = createRunnerHost({
    runnerId: 'runner-1266r',
    workspacePath: repo,
    emit: (event) => events.push(event),
    queryFn: fakeSdk(captured),
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

    // 偽の時計にしない: 周期は本物の git の子プロセスを起こすので回らない。実時間で待つ（scripts/wallclock-waits-baseline.json に載せてある）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rescueEvents(events)).toHaveLength(1);

    await writeFile(path.join(repo, 'a.txt'), 'edited again\n');
    await vi.waitFor(() => expect(rescueEvents(events)).toHaveLength(2), { timeout: 5000 });
  });

  it('畳む直前（shutdown）にも1回撃つ。周期が長くても', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited at shutdown\n');
    const { host, events } = setup(3_600_000);
    await host.start({ managerId: 'mgr-abcd1234', request: '依頼', cwd: repo });
    expect(rescueEvents(events)).toHaveLength(0);

    await host.shutdown();

    // shutdown_unpushed_work は退避（最大20秒）を待たず先に emit する: 待つと通知の窓が広がる。
    const types = events.map((e) => e.type);
    expect(types.indexOf('shutdown_unpushed_work')).toBeLessThan(types.indexOf('rescue_ref'));
    const found = rescueEvents(events);
    expect(found).toHaveLength(1);
    expect(g(bare, 'show', `${found[0]?.worktrees[0]?.pushed?.ref as string}:a.txt`)).toBe(
      'edited at shutdown\n',
    );
  });
});

describe('30 分以上残っている未追跡のファイルの知らせ（#4863 案C）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const bash = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: '', stderr: '' },
  };
  const contextOf = (result: unknown): string | undefined =>
    (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
      ?.additionalContext;

  it('初出から 30 分たつと、担当本人と作業者の道具の結果に添え、担当本人の回だけ日誌へ note を残す', async () => {
    await writeFile(path.join(repo, 'drawing.png'), 'x');
    const captured: Options[] = [];
    const { host, events } = setup(40, captured);
    await host.start({ managerId: 'mgr-4863', request: '依頼', cwd: repo });
    const fire = (extra: Record<string, unknown> = {}) => {
      const hook = captured[0]?.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
      return hook({ ...bash, ...extra } as never, undefined, {
        signal: new AbortController().signal,
      });
    };

    // 記録は退避の周期で付く。最初の報告が届いた時点で付いている
    await vi.waitFor(() => expect(rescueEvents(events)).toHaveLength(1), { timeout: 5000 });
    expect(contextOf(await fire())).toBeUndefined();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60_000);

    const own = contextOf(await fire());
    expect(own).toContain('30 分以上 commit されていない未追跡のファイルがある');
    expect(own).toContain('drawing.png');
    const byWorker = contextOf(await fire({ agent_id: 'agent-1', agent_type: 'worker' }));
    expect(byWorker).toContain('drawing.png');
    expect(contextOf(await fire())).toBeUndefined();
    expect(
      events.filter((e) => e.type === 'note' && e.text.includes('未追跡のファイルがある')),
    ).toHaveLength(1);
  });
});

describe('担当を畳むときにも退避 ref を撃つ（#4677）', () => {
  it('⭐ デーモンの指示で止めた担当は、周期が長くても、止めた時点の変更を退避する', async () => {
    const { host, events } = setup(3_600_000);
    await host.start({ managerId: 'mgr-4677stop', request: '依頼', cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'edited before stop\n');
    expect(rescueEvents(events)).toHaveLength(0);

    await host.stop('mgr-4677stop');

    await vi.waitFor(() => expect(rescueEvents(events)).toHaveLength(1), { timeout: 10_000 });
    const found = rescueEvents(events)[0];
    expect(found?.managerId).toBe('mgr-4677stop');
    expect(g(bare, 'show', `${found?.worktrees[0]?.pushed?.ref as string}:a.txt`)).toBe(
      'edited before stop\n',
    );
  });
});

describe('畳む直前に止めた担当の退避を、畳みが待つ（#4789）', () => {
  it('⭐ デーモンの指示で止めた直後に runner を畳んでも、畳みが返った時点で止めた担当の退避は済んでいる', async () => {
    const { host, events } = setup(3_600_000);
    await host.start({ managerId: 'mgr-4789stop', request: '依頼', cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'edited before stop and shutdown\n');

    await host.stop('mgr-4789stop');
    await host.shutdown();

    const found = rescueEvents(events).filter((event) => event.managerId === 'mgr-4789stop');
    expect(found).toHaveLength(1);
    expect(g(bare, 'show', `${found[0]?.worktrees[0]?.pushed?.ref as string}:a.txt`)).toBe(
      'edited before stop and shutdown\n',
    );
  });
});

describe('担当が終わったときにも退避 ref を撃つ（#4677）', () => {
  it('結果を出さないまま CLI が終わった担当（#finish の経路）も、終わった時点の変更を退避する', async () => {
    const events: RunnerEvent[] = [];
    const credentials = createCredentialStore({
      dir: path.join(root, 'cred-finish'),
      seed: { GH_TOKEN: 'test-token-value-for-rescue' },
    });
    // init の直後に終わる（結果なしで終了）
    const endingSdk = ((params: { prompt: AsyncIterable<unknown> }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-end',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        void params;
      }
      return Object.assign(generate(), {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    await writeFile(path.join(repo, 'a.txt'), 'edited before the end\n');
    const host = createRunnerHost({
      runnerId: 'runner-4677',
      workspacePath: repo,
      emit: (event) => events.push(event),
      queryFn: endingSdk,
      env: { ...GIT_ENV },
      credentials,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: repo, worktrees: [] }),
      rescueIntervalMs: 3_600_000,
    });
    hosts.push(host);
    await host.start({ managerId: 'mgr-4677end', request: '依頼', cwd: repo });

    await vi.waitFor(() => expect(events.some((e) => e.type === 'closed')).toBe(true), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(rescueEvents(events)).toHaveLength(1), { timeout: 10_000 });
    const found = rescueEvents(events)[0];
    expect(g(bare, 'show', `${found?.worktrees[0]?.pushed?.ref as string}:a.txt`)).toBe(
      'edited before the end\n',
    );
  });
});

describe('退避から漏れた作業ツリーを note で知らせる（#4681）', () => {
  it('⭐ 作業ツリーが上限を超えたら、退避が漏れたことを note で知らせる（繰り返さないことは RescueListNotice の試験で見る）', async () => {
    const work = path.join(root, 'many');
    for (let i = 0; i < 21; i += 1) {
      const dir = path.join(work, `r${String(i).padStart(2, '0')}`);
      await mkdir(dir, { recursive: true });
      g(dir, 'init', '-q', '-b', 'main');
    }
    const { host, events } = setup(40);
    await host.start({ managerId: 'mgr-4681note', request: '依頼', cwd: work });
    const notes = () =>
      events.filter(
        (event) =>
          event.type === 'note' &&
          event.text.includes('退避 ref') &&
          event.text.includes('打ち切った'),
      );
    await vi.waitFor(() => expect(notes()).toHaveLength(1), { timeout: 5000 });
    // クローンの受信箱へも回す印を立て、境界（スキーマ）を通っても落ちない（#4685）
    const parsed = runnerEventSchema.parse(JSON.parse(JSON.stringify(notes()[0])));
    expect(parsed).toMatchObject({ type: 'note', notifyClone: true });
  });
});
