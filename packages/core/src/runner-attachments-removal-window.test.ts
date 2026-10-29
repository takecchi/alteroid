import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerAttachment } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// 畳みの片付け（`removeManagerAttachments`）の「始まり」と「終わり」を試験が握る。片付けの本体は、最初の置く処理が
// 終わるまで動かさない: 置いた後に消えれば、再試行されない版では添付が置き場から消える（実時間の待ちは使わない）
const control = vi.hoisted(() => ({
  afterPlace: undefined as (() => void) | undefined,
  removalGate: undefined as Promise<void> | undefined,
  removals: [] as Promise<void>[],
  events: [] as string[],
}));

vi.mock('./runner-attachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner-attachments.js')>();
  return {
    ...actual,
    placeRunnerAttachments: async (
      ...args: Parameters<typeof actual.placeRunnerAttachments>
    ): ReturnType<typeof actual.placeRunnerAttachments> => {
      try {
        return await actual.placeRunnerAttachments(...args);
      } finally {
        control.afterPlace?.();
      }
    },
    stageRunnerAttachment: (
      ...args: Parameters<typeof actual.stageRunnerAttachment>
    ): ReturnType<typeof actual.stageRunnerAttachment> => {
      control.events.push('stage-begin');
      return actual.stageRunnerAttachment(...args);
    },
    removeManagerAttachments: (root: string, managerId: string): Promise<void> => {
      const removal = (async () => {
        await control.removalGate;
        await actual.removeManagerAttachments(root, managerId);
        control.events.push('removal-end');
      })();
      control.removals.push(removal);
      return removal;
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

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
  control.afterPlace = undefined;
  control.removalGate = undefined;
  control.removals = [];
  control.events = [];
});

async function setup() {
  const root = await makeTempDir('runner-att-window-');
  const fake = fakeSdk();
  let failNextOpen = false;
  const host = createRunnerHost({
    runnerId: 'runner-att',
    workspacePath: '/workspace',
    emit: () => undefined,
    queryFn: ((...args: Parameters<typeof sdkQuery>) => {
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('open failed');
      }
      return fake.fn(...args);
    }) as typeof sdkQuery,
    env: { PATH: '/usr/bin' },
    attachmentsRoot: root,
    scratchSweep: false,
    cwdExistsFn: () => true,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
  });
  hosts.push(host);
  return {
    host,
    fake,
    // 開けずに落ちる start は、同期の区間で担当の置き場の片付けを始める（`start` の catch）
    startFailingToOpen: async () => {
      failNextOpen = true;
      await expect(
        host.start({ managerId: 'mgr-abc123', request: '別の依頼', cwd: '/workspace' }),
      ).rejects.toThrow('open failed');
    },
  };
}

describe('大きい添付の別口（stageAttachment）の、片付けの待ちを抜けた直後の窓', () => {
  it('窓で始まった片付けが終わってから置き始める（流れてくる本文は置き直せないため）', async () => {
    const { host, startFailingToOpen } = await setup();
    let release!: () => void;
    control.removalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = Buffer.from('中身Y');
    const staging = host.stageAttachment(
      'mgr-abc123',
      {
        id: 'att-1',
        name: 'big.bin',
        mediaType: 'application/octet-stream',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      (async function* () {
        yield new Uint8Array(bytes);
      })(),
    );
    await startFailingToOpen();
    // 片付けの本体を、置き始めに十分な数の microtask だけ遅らせてから動かす（実時間は使わない）
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    release();
    await staging;
    await Promise.all(control.removals);
    expect(control.events).toEqual(['removal-end', 'stage-begin']);
  });
});

describe('添付を置く前の片付けの待ちを抜けた直後に、別の畳みの片付けが始まった回', () => {
  // 窓は「待ちの最後の確認」から「開始数を読む」までの microtask 数個ぶん。k はその前後を覆う
  const ticks = [0, 1, 2, 3, 4, 5, 6, 8];
  it.each(ticks)(
    '片付けの始まりを %i microtask 遅らせても、添付は置き直されて置き場から読める',
    async (k) => {
      const { host, fake, startFailingToOpen } = await setup();
      const placed = new Promise<void>((resolve) => {
        control.afterPlace = resolve;
      });
      control.removalGate = placed;

      const resuming = host.resume({
        managerId: 'mgr-abc123',
        sessionId: 'sess-old',
        cwd: '/workspace',
        request: '元の依頼',
        message: '続きです',
        attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('中身X'))],
      });
      for (let i = 0; i < k; i += 1) await Promise.resolve();
      await startFailingToOpen();

      await resuming;
      await vi.waitFor(() => expect(fake.received).toHaveLength(1));
      await Promise.all(control.removals);
      const text = JSON.stringify(fake.received[0]?.content);
      const path = /path=(.+?)（Read/.exec(text)?.[1];
      expect(path).toBeDefined();
      await expect(readFile(path as string, 'utf8')).resolves.toBe('中身X');
    },
  );
});
