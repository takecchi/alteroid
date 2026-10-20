import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerAttachment } from './runner-protocol.js';

// 置いている最中に畳みの片付けが担当の置き場を消した形（mkdir が ENOENT で投げる）を、競りの順序に頼らずに作る:
// 1回目の呼び出しだけ、先に `hooks.duringPlace`（畳み）を走らせてから ENOENT で投げる
const hooks = vi.hoisted(() => ({ duringPlace: undefined as (() => Promise<void>) | undefined }));

vi.mock('./runner-attachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner-attachments.js')>();
  return {
    ...actual,
    placeRunnerAttachments: async (
      ...args: Parameters<typeof actual.placeRunnerAttachments>
    ): ReturnType<typeof actual.placeRunnerAttachments> => {
      const during = hooks.duringPlace;
      if (during !== undefined) {
        hooks.duringPlace = undefined;
        await during();
        throw Object.assign(new Error('ENOENT: no such file or directory, mkdir'), {
          code: 'ENOENT',
        });
      }
      return actual.placeRunnerAttachments(...args);
    },
  };
});

const { createRunnerHost } = await import('./runner.js');
type RunnerHost = ReturnType<typeof createRunnerHost>;

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

let hosts: RunnerHost[] = [];
afterEach(async () => {
  hooks.duringPlace = undefined;
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('添付を置いている最中に畳みの片付けが置き場を消しても、resume は失敗せず作り直しへ落ちる', () => {
  it('⭐ resume は成功し（reusedLiveSession は立たない）、作り直したセッションで添付が置き場から読める', async () => {
    const root = await makeTempDir('runner-att-fold-');
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

    hooks.duringPlace = async () => {
      await host.stop('mgr-abc123');
    };
    const result = await host.resume({
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('中身X'))],
    });

    expect(hooks.duringPlace).toBeUndefined();
    expect(result.reusedLiveSession).toBe(false);
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    const text = JSON.stringify(fake.received[1]?.content);
    expect(text).toContain('続きです');
    const path = /path=(.+?)（Read/.exec(text)?.[1];
    expect(path).toBeDefined();
    await expect(readFile(path as string, 'utf8')).resolves.toBe('中身X');
  });
});
