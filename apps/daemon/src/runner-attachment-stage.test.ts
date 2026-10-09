import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createCloneTools,
  createLocalRunner,
  createManagerPool,
  createMemoryStores,
  createRunnerHost,
  createRunnerRegistry,
  DEFAULT_ATTACHMENT_LIMITS,
  MemoryAttachmentStore,
  type AttachmentLimits,
  type RunnerClient,
  type Stores,
  type ToolContext,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createHttpRunner } from './runner-client.js';

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 100_000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};

// 大きいファイルの中身（maxFileBytes を超える）。base64 にしても命令の本文に現れないことを確かめるため、目印を入れる。
const bigBytes = (seed: number) =>
  Buffer.from(`BIGCONTENT-${seed}-`.repeat(60), 'utf8').subarray(0, 500);

interface Rig {
  stores: Stores;
  inputs: string[];
  calls: { method: string; path: string; body: string | undefined }[];
  root: string;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

function fakeSdk(inputs: string[]): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(JSON.stringify(message.message.content));
        }
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

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function rig(kind: 'http' | 'local'): Promise<Rig> {
  const root = await makeTempDir('daemon-att-stage-');
  const workspace = await makeTempDir('daemon-att-stage-ws-');
  const inputs: string[] = [];
  const calls: Rig['calls'] = [];
  let runner: RunnerClient;
  let stopHost: () => Promise<void> = async () => undefined;
  if (kind === 'http') {
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-http',
      workspacePath: workspace,
      emit: (event) => outbox.push(event),
      queryFn: fakeSdk(inputs),
      env: { PATH: '/usr/bin' },
      attachmentsRoot: root,
      scratchSweep: false,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    runner = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        calls.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return app.request(`${url.pathname}${url.search}`, init as never);
      }) as typeof fetch,
    });
    stopHost = () => host.shutdown();
  } else {
    runner = createLocalRunner({
      runnerId: 'runner-local',
      workspacePath: workspace,
      queryFn: fakeSdk(inputs),
      env: { PATH: '/usr/bin' },
      attachmentsRoot: root,
    });
  }
  const stores: Stores = { ...createMemoryStores(), attachments: new MemoryAttachmentStore({ limits: LIMITS }) };
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
    attachmentLimits: LIMITS,
  };
  const tools = createCloneTools(context);
  const close = async () => {
    await pool.stop();
    await registry.stop();
    await stopHost();
  };
  closers.push(close);
  return {
    stores,
    inputs,
    calls,
    root,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      const out = await tool!.handler(args as never, {} as never);
      return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
    close,
  };
}

const putBig = (stores: Stores, seed: number) =>
  stores.attachments.put({
    name: 'big.bin',
    mediaType: 'application/octet-stream',
    bytes: bigBytes(seed),
  });

describe.each(['http', 'local'] as const)(
  '大きいファイルを添えた委譲（#4128 段3a。%s の runner）',
  (kind) => {
    it('manager_start: 別口へ押してから命令を送り、命令の本文に中身は載らず、担い手の添付の置き場に置かれる', async () => {
      const r = await rig(kind);
      const meta = await putBig(r.stores, 1);
      const out = await r.call('manager_start', { request: 'ビルドを調べて', attachments: [meta.id] });
      expect(out).toContain('を起こした');
      const managerId = /マネージャー (\S+) を起こした/.exec(out)?.[1];
      expect(managerId).toBeDefined();

      // 中身は、命令と同じ置き先（<root>/<managerId>/<id>/<名前>）に置かれている
      const path = join(r.root, managerId!, meta.id, 'big.bin');
      expect(await readFile(path)).toEqual(bigBytes(1));
      // 担い手が受けた最初のターンには、通知行（path つき）が載る
      await vi.waitFor(() => expect(r.inputs.join('\n')).toContain(`id=${meta.id}`));
      expect(r.inputs.join('\n')).toContain(`path=${path}`);

      if (kind === 'http') {
        const putIndex = r.calls.findIndex(
          (c) => c.method === 'PUT' && c.path === `/managers/${managerId}/attachments/${meta.id}`,
        );
        const startIndex = r.calls.findIndex((c) => c.method === 'POST' && c.path === '/managers');
        expect(putIndex).toBeGreaterThanOrEqual(0);
        expect(startIndex).toBeGreaterThan(putIndex);
        const body = r.calls[startIndex]?.body ?? '';
        const command = JSON.parse(body) as { attachments: Record<string, unknown>[] };
        expect(command.attachments).toEqual([
          {
            id: meta.id,
            name: 'big.bin',
            mediaType: 'application/octet-stream',
            size: 500,
            sha256: meta.sha256,
            staged: true,
          },
        ]);
        expect(body).not.toContain(Buffer.from(bigBytes(1)).toString('base64').slice(0, 40));
        expect(body.length).toBeLessThan(2000);
      }
    });

    it('manager_send: 追加指示でも同じに、別口へ押してから送る', async () => {
      const r = await rig(kind);
      const first = await r.call('manager_start', { request: '最初の依頼' });
      const managerId = /マネージャー (\S+) を起こした/.exec(first)?.[1];
      expect(managerId).toBeDefined();
      const meta = await putBig(r.stores, 2);
      const sent = await r.call('manager_send', {
        managerId,
        message: 'これも見て',
        attachments: [meta.id],
      });
      expect(sent).not.toContain('何も送っていない');
      const path = join(r.root, managerId!, meta.id, 'big.bin');
      expect(await readFile(path)).toEqual(bigBytes(2));
      await vi.waitFor(() => expect(r.inputs.join('\n')).toContain(`path=${path}`));
      if (kind === 'http') {
        const putIndex = r.calls.findIndex(
          (c) => c.method === 'PUT' && c.path === `/managers/${managerId}/attachments/${meta.id}`,
        );
        const sendIndex = r.calls.findIndex(
          (c) => c.method === 'POST' && c.path === `/managers/${managerId}/messages`,
        );
        expect(putIndex).toBeGreaterThanOrEqual(0);
        expect(sendIndex).toBeGreaterThan(putIndex);
        expect(r.calls[sendIndex]?.body ?? '').toContain('"staged":true');
        expect(r.calls[sendIndex]?.body ?? '').not.toContain('"data"');
      }
    });

    it('小さい添付と大きい添付を混ぜると、小さいほうは命令に載り、大きいほうだけが別口を通る', async () => {
      const r = await rig(kind);
      const big = await putBig(r.stores, 3);
      const small = await r.stores.attachments.put({
        name: 'small.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('small'),
      });
      const out = await r.call('manager_start', {
        request: '両方',
        attachments: [small.id, big.id],
      });
      const managerId = /マネージャー (\S+) を起こした/.exec(out)?.[1];
      expect(await readFile(join(r.root, managerId!, big.id, 'big.bin'))).toEqual(bigBytes(3));
      expect(await readFile(join(r.root, managerId!, small.id, 'small.txt'), 'utf8')).toBe('small');
      if (kind === 'http') {
        expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
      }
    });
  },
);
