import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerAttachment, RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

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
      if (
        gate.open !== null &&
        options?.recursive === true &&
        String(path).endsWith('mgr-abc123')
      ) {
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

function fakeSdk(): { fn: typeof sdkQuery; received: { content: unknown }[] } {
  const received: { content: unknown }[] = [];
  let count = 0;
  const fn = ((params: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    count += 1;
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${count}`,
        uuid: `uuid-init-${count}`,
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt)
          received.push({ content: message.message.content });
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
  return { fn, received };
}

async function yieldUntil(done: () => Promise<boolean>, maxTurns: number): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    if (await done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  gate.open = null;
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('畳みの添付削除が完了を待たない（onClosed の void removeManagerAttachments）', () => {
  it('畳み待ちから作り直した resume が置き直した添付を、遅れて走る前の畳みの削除が消さない', async () => {
    const root = await makeTempDir('runner-att-close-race-');
    const fake = fakeSdk();
    const events: RunnerEvent[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-att',
      workspacePath: '/workspace',
      emit: (event) => events.push(event),
      queryFn: fake.fn,
      env: { PATH: '/usr/bin' },
      attachmentsRoot: root,
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));

    let release: () => void = () => undefined;
    gate.open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resuming = host.resume({
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('中身X'))],
    });
    const stopping = host.stop('mgr-abc123');
    await stopping;
    expect(gate.blocked).toBeGreaterThan(0);
    const expected = join(root, 'mgr-abc123', 'att-1', 'a.txt');
    await yieldUntil(
      () =>
        access(expected).then(
          () => true,
          () => false,
        ),
      2000,
    );
    release();
    const result = await resuming;
    expect(result.reusedLiveSession).toBe(false);
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    await Promise.all(gate.done);
    const text = JSON.stringify(fake.received[1]?.content);
    const path = /path=(.+?)（Read/.exec(text)?.[1];
    expect(path).toBeDefined();
    await expect(readFile(path as string, 'utf8')).resolves.toBe('中身X');
  });

  it('添付の無い resume / send は、走り残った畳みの削除を待たない（#1660 の順序を変えない）', async () => {
    const root = await makeTempDir('runner-att-close-nowait-');
    const fake = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-att',
      workspacePath: '/workspace',
      emit: () => undefined,
      queryFn: fake.fn,
      env: { PATH: '/usr/bin' },
      attachmentsRoot: root,
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));

    let release: () => void = () => undefined;
    gate.open = new Promise<void>((resolve) => {
      release = resolve;
    });
    await host.stop('mgr-abc123');
    expect(gate.blocked).toBeGreaterThan(0);

    const resumed = await host.resume({
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
    });
    expect(resumed.reusedLiveSession).toBe(false);
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    await expect(host.send('mgr-abc123', '追加の一言')).resolves.toBe(true);
    await vi.waitFor(() => expect(fake.received).toHaveLength(3));

    release();
    await Promise.all(gate.done);
  });
});
