import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createCredentialStore } from './credentials.js';
import type { ManagerToolsSocketHost } from './manager-tools.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost } from './runner.js';

function idleQuery(): typeof sdkQuery {
  return (() => {
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    // eslint-disable-next-line require-yield
    async function* generate(): AsyncGenerator<never, void> {
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('Host#shutdown: セッションの停止が投げても、後の待ちと閉じは走る（#5972）', () => {
  it('⭐ 停止が投げても peer の口と道具の口を閉じ、投げた失敗は呼び手へ返す（stderr への跡は writeSync で出すので、ここでは見ない）', async () => {
    let peerClosed = 0;
    let toolsClosed = 0;
    const peerSocket: PeerSocketHost = {
      socketPath: '/run/alteroid/peer/peer.sock',
      register: () => 'tok-peer',
      close: () => {
        peerClosed += 1;
      },
    };
    const tools: ManagerToolsSocketHost = {
      socketPath: '/run/alteroid/manager/manager.sock',
      register: () => 'tok-tools',
      close: () => {
        toolsClosed += 1;
      },
    };
    const emit = vi.fn((event: RunnerEvent) => {
      // 畳みの途中（セッションの停止の中）で投げさせる
      if (event.type === 'shutdown_unpushed_work') throw new Error('停止の途中で投げた（試験）');
    });
    const host = createRunnerHost({
      runnerId: 'runner-5972',
      workspacePath: '/work',
      emit,
      queryFn: idleQuery(),
      env: {},
      credentials: createCredentialStore({
        dir: makeTempDirSync('alteroid-runner-shutdown-cred-'),
        seed: {},
      }),
      codexHome: makeTempDirSync('alteroid-runner-shutdown-codex-'),
      outboxStagedRoot: makeTempDirSync('alteroid-runner-shutdown-outbox-'),
      rescueStagedRoot: makeTempDirSync('alteroid-runner-shutdown-rescue-'),
      finishUnpushedWorkFn: async () => ({ cwd: '/work', worktrees: [] }),
      managerTools: { host: tools, childEntry: '/app/relay.js' },
      peer: {
        openSocket: async () => peerSocket,
        reportsUsage: () => true,
        childEntry: '/app/relay.js',
      },
    });
    await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
    await host.start({ managerId: 'mgr-5972', request: 'やって', cwd: '/work' });
    await expect(host.shutdown()).rejects.toThrow('停止の途中で投げた（試験）');

    expect(peerClosed).toBe(1);
    expect(toolsClosed).toBe(1);
  });
});
