import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { RunnerAttachmentRejectedError } from './runner-attachments.js';
import { createLocalRunner } from './runner-local.js';
import type { RunnerAttachment, RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function attachmentOf(
  id: string,
  name: string,
  bytes: Uint8Array,
  mediaType: string,
): RunnerAttachment {
  return {
    id,
    name,
    mediaType,
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
});

async function setup(): Promise<{
  host: RunnerHost;
  root: string;
  fake: ReturnType<typeof fakeSdk>;
}> {
  const root = await makeTempDir('runner-att-host-');
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
  return { host, root, fake };
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

function split(content: unknown): { text: string; images: unknown[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const blocks = content as { type: string; text?: string }[];
  return {
    text: blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    images: blocks.filter((b) => b.type === 'image'),
  };
}

describe('Host: 担い手への添付（Issue #3111 段3）', () => {
  it('start: 同じ中身で置かれ、最初の入力に通知行（path）と image ブロックが載る', async () => {
    const { host, root, fake } = await setup();
    const log = Buffer.from('ログの中身\n');
    await host.start({
      managerId: 'mgr-abc123',
      request: '調べて',
      cwd: '/workspace',
      attachments: [
        attachmentOf('att-log', 'run.log', log, 'text/plain'),
        attachmentOf('att-img', 'shot.png', PNG, 'image/png'),
      ],
    });
    await until(() => fake.received.length === 1);

    const logPath = join(root, 'mgr-abc123', 'att-log', 'run.log');
    expect(await readFile(logPath)).toEqual(log);
    expect(await readFile(join(root, 'mgr-abc123', 'att-img', 'shot.png'))).toEqual(PNG);

    const { text, images } = split(fake.received[0]?.content);
    expect(text).toContain('調べて');
    expect(text).toContain(`path=${logPath}（Read で開ける）`);
    expect(text).toContain(`path=${join(root, 'mgr-abc123', 'att-img', 'shot.png')}`);
    expect(images).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
      },
    ]);
  });

  it('start: 添付が無ければ入力は文字列のままで、何も置かない（従来どおり）', async () => {
    const { host, root, fake } = await setup();
    await host.start({ managerId: 'mgr-abc123', request: '普通の依頼', cwd: '/workspace' });
    await until(() => fake.received.length === 1);
    expect(fake.received[0]?.content).toBe('普通の依頼');
    expect(await readdir(root)).toEqual([]);
  });

  it('start: sha256 が合わなければセッションを作らずに断る（置いたものも残らない）', async () => {
    const { host, root, fake } = await setup();
    const tampered = {
      ...attachmentOf('att-1', 'a.txt', Buffer.from('original'), 'text/plain'),
      data: Buffer.from('tampered!').toString('base64'),
    };
    await expect(
      host.start({
        managerId: 'mgr-abc123',
        request: '依頼',
        cwd: '/workspace',
        attachments: [tampered],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    expect(host.list()).toEqual([]);
    expect(fake.received).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('send: 走っている担い手へ添付つきの追加指示が届き、画像は image ブロックになる', async () => {
    const { host, root, fake } = await setup();
    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await until(() => fake.received.length === 1);
    const delivered = await host.send('mgr-abc123', '画像も見て', [
      attachmentOf('att-img', 'shot.png', PNG, 'image/png'),
    ]);
    expect(delivered).toBe(true);
    await until(() => fake.received.length === 2);
    const { text, images } = split(fake.received[1]?.content);
    expect(text).toContain('画像も見て');
    expect(text).toContain(`path=${join(root, 'mgr-abc123', 'att-img', 'shot.png')}`);
    expect(images).toHaveLength(1);
    expect(await readFile(join(root, 'mgr-abc123', 'att-img', 'shot.png'))).toEqual(PNG);
  });

  it('send: sha256 の不一致は積まずに断り、セッションが無ければ false（何も置かない）', async () => {
    const { host, root, fake } = await setup();
    expect(
      await host.send('mgr-none', 'x', [
        attachmentOf('att-1', 'a.txt', Buffer.from('x'), 'text/plain'),
      ]),
    ).toBe(false);
    expect(await readdir(root)).toEqual([]);

    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await until(() => fake.received.length === 1);
    const tampered = {
      ...attachmentOf('att-1', 'a.txt', Buffer.from('original'), 'text/plain'),
      data: Buffer.from('tampered!').toString('base64'),
    };
    await expect(host.send('mgr-abc123', 'x', [tampered])).rejects.toBeInstanceOf(
      RunnerAttachmentRejectedError,
    );
    expect(fake.received).toHaveLength(1);
  });

  it('resume: message に添付を載せると、新しく開いたセッションの最初の入力に載る', async () => {
    const { host, root, fake } = await setup();
    await host.resume({
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [attachmentOf('att-img', 'shot.png', PNG, 'image/png')],
    });
    await until(() => fake.received.length === 1);
    const { text, images } = split(fake.received[0]?.content);
    expect(text).toContain('続きです');
    expect(text).toContain(`path=${join(root, 'mgr-abc123', 'att-img', 'shot.png')}`);
    expect(images).toHaveLength(1);
  });

  it('担い手が畳まれると、その委譲の置き場も消える', async () => {
    const { host, root, fake } = await setup();
    await host.start({
      managerId: 'mgr-abc123',
      request: '依頼',
      cwd: '/workspace',
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('x'), 'text/plain')],
    });
    await until(() => fake.received.length === 1);
    expect(await readdir(root)).toEqual(['mgr-abc123']);
    await host.stop('mgr-abc123');
    await until(() => host.list().length === 0);
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
  });
});

describe('ローカル構成（同一プロセスの LocalRunner）でも同じ経路を通る', () => {
  it('LocalRunner の start / send が添付を Host へ運び、置かれて入力に載る', async () => {
    const root = await makeTempDir('runner-att-local-');
    const fake = fakeSdk();
    const runner = createLocalRunner({
      runnerId: 'local-att',
      workspacePath: '/workspace',
      queryFn: fake.fn,
      env: { PATH: '/usr/bin' },
      attachmentsRoot: root,
    });
    try {
      await runner.start({
        managerId: 'mgr-abc123',
        request: '最初',
        cwd: '/workspace',
        attachments: [attachmentOf('att-img', 'shot.png', PNG, 'image/png')],
      });
      await until(() => fake.received.length === 1);
      expect(split(fake.received[0]?.content).images).toHaveLength(1);

      const log = Buffer.from('追加のログ');
      expect(
        await runner.send('mgr-abc123', '追加', [
          attachmentOf('att-log', 'x.log', log, 'text/plain'),
        ]),
      ).toBe(true);
      await until(() => fake.received.length === 2);
      expect(split(fake.received[1]?.content).text).toContain(
        `path=${join(root, 'mgr-abc123', 'att-log', 'x.log')}`,
      );
      expect(await readFile(join(root, 'mgr-abc123', 'att-log', 'x.log'))).toEqual(log);
    } finally {
      await runner.stop('mgr-abc123').catch(() => undefined);
    }
  });
});

describe('Host: 取りこぼした置き場の定期掃除（#3205）', () => {
  it('周期で古い置き場は消え、生きた委譲の置き場は古くても残る', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const root = await makeTempDir('runner-att-live-');
      const scratch = await makeTempDir('runner-att-scratch-');
      const fake = fakeSdk();
      const host = createRunnerHost({
        runnerId: 'runner-att',
        workspacePath: '/workspace',
        emit: () => undefined,
        queryFn: fake.fn,
        env: { PATH: '/usr/bin' },
        attachmentsRoot: root,
        scratchSweep: { tmpRoot: scratch, intervalMs: 20 },
        cwdExistsFn: () => true,
        readCgroupEventCountersFn: async () => ({}),
        finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
      });
      hosts.push(host);
      await host.start({
        managerId: 'mgr-live',
        request: '調べて',
        cwd: '/workspace',
        attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('x'), 'text/plain')],
      });
      await mkdir(join(root, 'mgr-dead', 'att-1'), { recursive: true });
      const old = new Date(Date.now() - 25 * 60 * 60_000);
      await utimes(join(root, 'mgr-live'), old, old);
      await utimes(join(root, 'mgr-dead'), old, old);
      await vi.advanceTimersByTimeAsync(20);
      for (let i = 0; i < 5000 && (await readdir(root)).includes('mgr-dead'); i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(await readdir(root)).toEqual(['mgr-live']);
    } finally {
      vi.useRealTimers();
    }
  });
});
