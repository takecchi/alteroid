import { createHash } from 'node:crypto';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE } from './attachment.js';
import type { RunnerAttachment } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/** 担い手の画像1枚の上限が、runner の env（Bedrock / Vertex）で下がること（#3743）。 */

const CAP = ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE;

function pngOfSize(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function attachmentOf(id: string, bytes: Buffer): RunnerAttachment {
  return {
    id,
    name: `${id}.bin`,
    mediaType: 'application/octet-stream',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  };
}

function fakeSdk(): { fn: typeof sdkQuery; received: { content: unknown }[] } {
  const received: { content: unknown }[] = [];
  const fn = ((params: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init-1',
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

async function run(env: NodeJS.ProcessEnv): Promise<{ text: string; images: number }> {
  const root = await makeTempDir('runner-route-host-');
  const fake = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-route',
    workspacePath: '/workspace',
    emit: () => undefined,
    queryFn: fake.fn,
    env: { PATH: '/usr/bin', ...env },
    attachmentsRoot: root,
    scratchSweep: false,
    cwdExistsFn: () => true,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
  });
  hosts.push(host);
  await host.start({
    managerId: 'mgr-route1',
    request: '見て',
    cwd: '/workspace',
    attachments: [
      attachmentOf('att-ok', pngOfSize(CAP)),
      attachmentOf('att-over', pngOfSize(CAP + 1)),
    ],
  });
  await vi.waitFor(() => expect(fake.received.length).toBe(1));
  const content = fake.received[0]?.content;
  const blocks = (typeof content === 'string' ? [] : content) as { type: string; text?: string }[];
  return {
    text:
      typeof content === 'string'
        ? content
        : blocks
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(''),
    images: blocks.filter((b) => b.type === 'image').length,
  };
}

describe('Host: 担い手の画像1枚の上限は runner の env の経路で決まる（#3743）', () => {
  it('Bedrock: 3,750,000 バイトは画像、3,750,001 バイトは通知行だけ', async () => {
    const out = await run({ CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(out.images).toBe(1);
    expect(out.text).toContain(
      'この経路（Bedrock / Vertex）の画像1枚の上限（base64 で 5 MB）を超える',
    );
  });

  it('直: どちらも画像として渡る', async () => {
    const out = await run({});
    expect(out.images).toBe(2);
    expect(out.text).not.toContain('この経路');
  });
});
