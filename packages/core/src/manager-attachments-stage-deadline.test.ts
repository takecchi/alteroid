import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { createManagerPool } from './manager.js';
import { OUTBOX_FETCH_FILE_TIMEOUT_MS, outboxFetchDeadlineMs } from './manager-outbox-fetch.js';
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

// 期限は既定の値（`outboxFetchDeadlineMs`）のまま、偽の時計で進める。本体は `AbortSignal.timeout` で期限を作るが、
// これは `vi.useFakeTimers` で止まらないので、`setTimeout` で abort する signal に差し替える（実時間の待ちを作らない）
const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 100_000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};
const BIG = Buffer.alloc(500, 7);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup(onStage: (signal: AbortSignal | undefined) => Promise<void>) {
  const requested: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    requested.push(ms);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );
    }, ms);
    return controller.signal;
  });
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
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
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
    const calling = call('manager_start', { request: '調べて', attachments: [big.id] });
    let settled = false;
    void calling.finally(() => (settled = true));
    // 小さいファイルの既定の期限（30 秒）の1ms 手前では、まだ待っている
    await vi.advanceTimersByTimeAsync(OUTBOX_FETCH_FILE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await calling;
    expect(out).toContain('時間の上限');
    expect(out).toContain('runner へ下ろせなかった');
    expect(out).toContain('マネージャーは起こしていない');
    expect(log).toEqual(['stage']);
    expect(requested).toEqual([outboxFetchDeadlineMs(500)]);
    expect(outboxFetchDeadlineMs(500)).toBe(OUTBOX_FETCH_FILE_TIMEOUT_MS);
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
    const calling = call('manager_start', { request: '調べて', attachments: [big.id] });
    await vi.advanceTimersByTimeAsync(OUTBOX_FETCH_FILE_TIMEOUT_MS);
    const out = await calling;
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
