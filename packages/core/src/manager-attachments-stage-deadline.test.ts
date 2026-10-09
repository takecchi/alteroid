import { describe, expect, it } from 'vitest';

import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  type RunnerClient,
  type RunnerEvent,
  type RunnerStagedAttachmentMeta,
  type RunnerStartCommand,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// 期限は注入（stageDeadlineMs）で短くする: 実時間の待ち（`setTimeout` の定数待ち）を作らない
const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 100_000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};
const BIG = Buffer.alloc(500, 7);

async function setup(onStage: (signal: AbortSignal | undefined) => Promise<void>) {
  const runnerId = 'runner-x';
  const base = createLocalRunner({ runnerId, workspacePath: '/work/project', env: {} });
  const log: string[] = [];
  const runner: RunnerClient = Object.create(base) as RunnerClient;
  Object.assign(runner, {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent: (event: RunnerEvent) => void) {
      onEvent({
        type: 'hello',
        runnerId,
        capabilities: [
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
        ],
        attachmentStageLimit: 1000,
      });
    },
    async start(command: RunnerStartCommand) {
      log.push('start');
      return { cwd: command.cwd };
    },
    async send() {
      log.push('send');
      return true;
    },
    async list() {
      return [];
    },
    async stageAttachment(
      _managerId: string,
      _meta: RunnerStagedAttachmentMeta,
      _body: AsyncIterable<Uint8Array>,
      options?: { signal?: AbortSignal },
    ) {
      log.push('stage');
      await onStage(options?.signal);
    },
  });
  const stores = {
    ...createMemoryStores(),
    attachments: new MemoryAttachmentStore({ limits: LIMITS }),
  };
  const registry = createRunnerRegistry([runner]);
  const requested: number[] = [];
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    stageDeadlineMs: (size) => {
      requested.push(size);
      return 20;
    },
  });
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
    attachmentLimits: LIMITS,
  };
  const tools = createCloneTools(context);
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    const out = await tool!.handler(args as never, {} as never);
    return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  const big = await stores.attachments.put({
    name: 'big.bin',
    mediaType: 'application/octet-stream',
    bytes: BIG,
  });
  return {
    big,
    call,
    log,
    requested,
    stop: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('(f) 押す処理の期限（#4128 段3b）', () => {
  it('signal を見ずに待ち続ける runner は、期限で断られ、命令は送られない。期限は大きさから決まる', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const { big, call, log, requested, stop } = await setup((signal) => {
      seen.push(signal);
      return new Promise<void>(() => undefined); // 本文を読まず、永遠に返らない
    });
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('時間の上限');
    expect(out).toContain('runner へ下ろせなかった');
    expect(out).toContain('マネージャーは起こしていない');
    expect(log).toEqual(['stage']);
    expect(requested).toEqual([500]);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(true);
    await stop();
  });

  it('signal で拒否する runner（fetch と同じ振る舞い）も、時間切れとして断られる', async () => {
    const { big, call, log, stop } = await setup(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        }),
    );
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('時間の上限');
    expect(log).toEqual(['stage']);
    await stop();
  });

  it('期限内に押し終えれば、命令は送られる', async () => {
    const { big, call, log, stop } = await setup(async () => undefined);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('を起こした');
    expect(log).toEqual(['stage', 'start']);
    await stop();
  });
});
