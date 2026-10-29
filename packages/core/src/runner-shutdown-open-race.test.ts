import { createHash } from 'node:crypto';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerAttachment } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// `host.shutdown()` が畳み始めた後、既に入って await していた resume / start / send が新しいセッションを開かない（#5506）。
// HTTP の門は入る前の要求しか止めないので、Host の側でも await の後に見直す。外から見える結果（偽の `queryFn` の呼び出し回数・list・戻り値）で測る。

// 畳みの添付削除（`rm` の再帰）を栓で止める: 添付の置き待ち（`#awaitAttachmentRemovals`）の窓を作るため
const gate = vi.hoisted(() => {
  const state: { open: Promise<void> | null; blocked: number; done: Promise<unknown>[] } = {
    open: null,
    blocked: 0,
    done: [],
  };
  return state;
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      if (gate.open !== null && options?.recursive === true && String(path).endsWith('mgr-sd')) {
        gate.blocked += 1;
        const finished = (async () => {
          await gate.open;
          await actual.rm(path, options);
        })();
        gate.done.push(finished);
        return finished;
      }
      return actual.rm(path, options);
    },
  };
});

function attachmentOf(id: string, name: string, bytes: Uint8Array): RunnerAttachment {
  return {
    id,
    name,
    mediaType: 'text/plain',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  };
}

// usage の問い合わせを栓で止める: `stop` が畳み終わるのを待つ窓を作るため
function fakeSdk() {
  let calls = 0;
  let releaseUsage: (() => void) | null = null;
  const usageGate = new Promise<undefined>((resolve) => {
    releaseUsage = () => resolve(undefined);
  });
  const fn = (() => {
    calls += 1;
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${String(calls)}`,
        uuid: `uuid-${String(calls)}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => usageGate,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, opened: () => calls, release: () => releaseUsage?.() };
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  gate.open = null;
  gate.blocked = 0;
  gate.done = [];
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function setup() {
  const sdk = fakeSdk();
  const root = await makeTempDir('runner-shutdown-open-race-');
  const host = createRunnerHost({
    runnerId: 'runner-shutdown-race',
    workspacePath: '/work/project',
    emit: () => undefined,
    queryFn: sdk.fn,
    env: { PATH: '/usr/bin' },
    attachmentsRoot: root,
    scratchSweep: false,
    cwdExistsFn: () => true,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
  });
  hosts.push(host);
  return { sdk, host };
}

const resumeCommand = {
  managerId: 'mgr-sd',
  sessionId: 'sess-previous',
  cwd: '/work/project',
  request: '続き',
  message: '一言',
};

describe('shutdown 中に飛んでいる resume', () => {
  it('畳み待ちの resume は、畳んだ後に新しいセッションを開かず reject する', async () => {
    const { sdk, host } = await setup();
    await host.start({ managerId: 'mgr-sd', request: '最初', cwd: '/work/project' });
    const stopped = host.stop('mgr-sd');
    const resumed = host.resume(resumeCommand);
    const outcome = expect(resumed).rejects.toThrow('畳み');
    const shutdown = host.shutdown();
    sdk.release();
    await Promise.all([stopped, outcome, shutdown]);
    expect(sdk.opened()).toBe(1);
    expect(host.list()).toHaveLength(0);
  });

  it('添付の置き待ちの resume も、畳んだ後に新しいセッションを開かず reject する', async () => {
    const { sdk, host } = await setup();
    await host.start({ managerId: 'mgr-sd', request: '最初', cwd: '/work/project' });
    let release: () => void = () => undefined;
    gate.open = new Promise<void>((resolve) => {
      release = resolve;
    });
    sdk.release();
    await host.stop('mgr-sd');
    expect(gate.blocked).toBeGreaterThan(0);
    const resumed = host.resume({
      ...resumeCommand,
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('中身'))],
    });
    const outcome = expect(resumed).rejects.toThrow('畳み');
    const shutdown = host.shutdown();
    release();
    await Promise.all([outcome, shutdown, ...gate.done]);
    expect(sdk.opened()).toBe(1);
    expect(host.list()).toHaveLength(0);
  });

  it('対照: 畳んでいなければ、畳み待ちの resume は待ってから作り直す', async () => {
    const { sdk, host } = await setup();
    await host.start({ managerId: 'mgr-sd', request: '最初', cwd: '/work/project' });
    const stopped = host.stop('mgr-sd');
    const resumed = host.resume(resumeCommand);
    sdk.release();
    const [, result] = await Promise.all([stopped, resumed]);
    expect(result.reusedLiveSession).toBe(false);
    expect(sdk.opened()).toBe(2);
    expect(host.list()).toHaveLength(1);
  });
});

describe('shutdown 中に飛んでいる start', () => {
  it('添付の置き待ちの start は、畳んだ後に新しいセッションを開かず reject する', async () => {
    const { sdk, host } = await setup();
    await host.start({ managerId: 'mgr-sd', request: '最初', cwd: '/work/project' });
    let release: () => void = () => undefined;
    gate.open = new Promise<void>((resolve) => {
      release = resolve;
    });
    sdk.release();
    await host.stop('mgr-sd');
    expect(gate.blocked).toBeGreaterThan(0);
    const started = host.start({
      managerId: 'mgr-sd',
      request: '二度目',
      cwd: '/work/project',
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('中身'))],
    });
    const outcome = expect(started).rejects.toThrow('畳み');
    const shutdown = host.shutdown();
    release();
    await Promise.all([outcome, shutdown, ...gate.done]);
    expect(sdk.opened()).toBe(1);
    expect(host.list()).toHaveLength(0);
  });
});

describe('shutdown 中に飛んでいる send', () => {
  it('添付の置き待ちの send は、畳んだ後 false を返す（今も畳み中の確認で守られている）', async () => {
    const { sdk, host } = await setup();
    await host.start({ managerId: 'mgr-sd', request: '最初', cwd: '/work/project' });
    sdk.release();
    const sent = host.send('mgr-sd', '一言', [attachmentOf('att-1', 'a.txt', Buffer.from('中身'))]);
    const shutdown = host.shutdown();
    await expect(sent).resolves.toBe(false);
    await shutdown;
    expect(sdk.opened()).toBe(1);
    expect(host.list()).toHaveLength(0);
  });
});
