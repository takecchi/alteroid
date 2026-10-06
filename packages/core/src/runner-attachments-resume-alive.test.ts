import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerAttachment, RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

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
});

async function setup() {
  const root = await makeTempDir('runner-att-alive-');
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
  return { host, fake };
}

describe('resume が生きたセッションへ短絡した回の添付', () => {
  it('添付つきの message が生きたセッションへ届く（reusedLiveSession: true）', async () => {
    const { host, fake } = await setup();
    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    const result = await host.resume({
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('x'))],
    });
    expect(result.reusedLiveSession).toBe(true);
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
  });

  it('添付を置いている間に畳まれたら、成功（reusedLiveSession: true）と答えて黙って捨てない', async () => {
    const { host, fake } = await setup();
    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    const resuming = host
      .resume({
        managerId: 'mgr-abc123',
        sessionId: 'sess-old',
        cwd: '/workspace',
        request: '元の依頼',
        message: '続きです',
        attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('x'))],
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    // resume は添付を置く await で止まっている。その間に停止が掛かる。
    const stopping = host.stop('mgr-abc123');
    const outcome = await resuming;
    await stopping;
    // 「追加の一言は届いていないのに、reusedLiveSession: true で成功した」を許さない。
    // 届かなかったなら、成功と答えてはいけない（send は同じ競りで false を返す）。
    if (outcome.ok && outcome.value.reusedLiveSession) {
      expect(fake.received).toHaveLength(2);
    }
  });
});

describe('resume が添付を置いている間に畳まれた回は、作り直しへ落ちる（Issue #3235）', () => {
  async function raced() {
    const { host, fake } = await setup();
    await host.start({ managerId: 'mgr-abc123', request: '最初', cwd: '/workspace' });
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    const resuming = host.resume({
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('中身X'))],
    });
    const stopping = host.stop('mgr-abc123');
    const result = await resuming;
    await stopping;
    return { host, fake, result };
  }

  it('新しいセッションを作り、reusedLiveSession は立たない（世代も入れ替わる）', async () => {
    const { host, fake, result } = await raced();
    expect(result.reusedLiveSession).toBe(false);
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    expect(JSON.stringify(fake.received[1]?.content)).toContain('続きです');
    expect(host.list().map((state) => state.managerId)).toEqual(['mgr-abc123']);
  });

  it('作り直した新しいセッションで、添付が置き場から読める', async () => {
    const { fake } = await raced();
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    const text = JSON.stringify(fake.received[1]?.content);
    const path = /path=(.+?)（Read/.exec(text)?.[1];
    expect(path).toBeDefined();
    await expect(readFile(path as string, 'utf8')).resolves.toBe('中身X');
  });
});
