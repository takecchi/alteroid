import { describe, expect, it } from 'vitest';

import { DEFAULT_ATTACHMENT_LIMITS, readRunnerAttachmentStageLimit } from './attachment.js';
import type { AttachmentLimits } from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITIES,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  runnerAttachmentSchema,
  runnerEventSchema,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerEvent,
  type RunnerStagedAttachmentMeta,
  type RunnerStartCommand,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 100_000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};

const BIG = Buffer.alloc(500, 7);

interface Fake {
  runner: RunnerClient;
  log: string[];
  starts: RunnerStartCommand[];
  sends: { attachments: readonly RunnerAttachment[] | undefined }[];
  staged: { managerId: string; meta: RunnerStagedAttachmentMeta; bytes: number }[];
}

function fakeRunner(options: {
  capabilities: string[];
  stageLimit?: number;
  withStage?: boolean;
  stageFails?: string;
}): Fake {
  const runnerId = 'runner-x';
  const base = createLocalRunner({ runnerId, workspacePath: '/work/project', env: {} });
  const log: string[] = [];
  const starts: RunnerStartCommand[] = [];
  const sends: Fake['sends'] = [];
  const staged: Fake['staged'] = [];
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
        capabilities: options.capabilities,
        ...(options.stageLimit === undefined ? {} : { attachmentStageLimit: options.stageLimit }),
      });
    },
    async start(command: RunnerStartCommand) {
      log.push('start');
      starts.push(command);
      return { cwd: command.cwd };
    },
    async resume(command: { cwd: string }) {
      return { cwd: command.cwd };
    },
    async send(_managerId: string, _text: string, attachments?: readonly RunnerAttachment[]) {
      log.push('send');
      sends.push({ attachments });
      return true;
    },
    async list() {
      return [];
    },
  });
  if (options.withStage !== false) {
    Object.assign(runner, {
      async stageAttachment(
        managerId: string,
        meta: RunnerStagedAttachmentMeta,
        body: AsyncIterable<Uint8Array>,
      ) {
        log.push('stage');
        if (options.stageFails !== undefined) throw new Error(options.stageFails);
        let bytes = 0;
        for await (const chunk of body) bytes += chunk.byteLength;
        staged.push({ managerId, meta, bytes });
      },
    });
  } else {
    (runner as { stageAttachment?: undefined }).stageAttachment = undefined;
  }
  return { runner, log, starts, sends, staged };
}

async function harness(fake: Fake) {
  const stores = {
    ...createMemoryStores(),
    attachments: new MemoryAttachmentStore({ limits: LIMITS }),
  };
  const registry = createRunnerRegistry([fake.runner]);
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
    stores,
    big,
    call,
    stop: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

const CAPABLE = [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS, RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE];

describe('能力と上限の名乗り（#4128 段3a）', () => {
  it('この版の runner は manager-attachments-stage を名乗る', () => {
    expect(RUNNER_CAPABILITIES).toContain(RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE);
  });

  it('hello の attachmentStageLimit は任意（旧い runner は送らない）で、正の整数', () => {
    const base = { type: 'hello', runnerId: 'r' };
    expect(runnerEventSchema.safeParse(base).success).toBe(true);
    expect(runnerEventSchema.safeParse({ ...base, attachmentStageLimit: 123 }).success).toBe(true);
    expect(runnerEventSchema.safeParse({ ...base, attachmentStageLimit: 0 }).success).toBe(false);
  });

  it('readRunnerAttachmentStageLimit は ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES を読み、不正・未設定は既定の 2 GiB', () => {
    expect(readRunnerAttachmentStageLimit({})).toBe(2048 * 1024 * 1024);
    expect(readRunnerAttachmentStageLimit({ ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: '4096' })).toBe(
      4096,
    );
    for (const bad of ['abc', '-1', '0', '1.5', '']) {
      expect(
        readRunnerAttachmentStageLimit({ ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: bad }),
      ).toBe(2048 * 1024 * 1024);
    }
  });

  it('runnerAttachmentSchema は data と staged のちょうど一方を要求する', () => {
    const item = {
      id: 'a',
      name: 'n',
      mediaType: 'x/y',
      size: 1,
      sha256: 'abc',
    };
    expect(runnerAttachmentSchema.safeParse({ ...item, data: 'AA==' }).success).toBe(true);
    expect(runnerAttachmentSchema.safeParse({ ...item, staged: true }).success).toBe(true);
    expect(runnerAttachmentSchema.safeParse(item).success).toBe(false);
    expect(runnerAttachmentSchema.safeParse({ ...item, data: 'AA==', staged: true }).success).toBe(
      false,
    );
    expect(runnerAttachmentSchema.safeParse({ ...item, staged: false }).success).toBe(false);
  });
});

describe('大きいファイルを別口で押してから命令を送る（#4128 段3a。偽の runner）', () => {
  it('manager_start: 押してから start を送り、命令は staged の参照だけを運ぶ', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 1000 });
    const { big, call, stop } = await harness(fake);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('を起こした');
    expect(fake.log).toEqual(['stage', 'start']);
    expect(fake.staged).toHaveLength(1);
    expect(fake.staged[0]?.bytes).toBe(500);
    expect(fake.staged[0]?.meta).toEqual({
      id: big.id,
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      size: 500,
      sha256: big.sha256,
    });
    // 押した managerId は、命令の managerId と同じ（start では先にデーモンが払い出す）
    expect(fake.staged[0]?.managerId).toBe(fake.starts[0]?.managerId);
    expect(fake.starts[0]?.attachments).toEqual([
      {
        id: big.id,
        name: 'big.bin',
        mediaType: 'application/octet-stream',
        size: 500,
        sha256: big.sha256,
        staged: true,
      },
    ]);
    await stop();
  });

  it('manager_send: 押してから send を送る', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 1000 });
    const { big, call, stop } = await harness(fake);
    const started = await call('manager_start', { request: '最初' });
    const managerId = /マネージャー (\S+) を起こした/.exec(started)?.[1];
    fake.log.length = 0;
    await call('manager_send', { managerId, message: '続き', attachments: [big.id] });
    expect(fake.log).toEqual(['stage', 'send']);
    expect(fake.sends[0]?.attachments?.[0]).toMatchObject({ id: big.id, staged: true });
    expect(fake.sends[0]?.attachments?.[0]?.data).toBeUndefined();
    await stop();
  });
});

describe('大きいファイルを下ろせない相手には、理由を言って何も送らない（#4128 段3a）', () => {
  it('能力を名乗らない runner（manager-attachments だけ）には、押さず送らず、理由を言う', async () => {
    const fake = fakeRunner({
      capabilities: [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS],
      stageLimit: 1000,
    });
    const { big, call, stop } = await harness(fake);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain(RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE);
    expect(out).toContain('マネージャーは起こしていない');
    expect(fake.log).toEqual([]);
    await stop();
  });

  it('上限の小さい runner（size が上限超え）には、押さず送らず、上限を言う', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 499 });
    const { big, call, stop } = await harness(fake);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('上限 499 バイト');
    expect(fake.log).toEqual([]);
    // size ちょうどは通る
    const fit = fakeRunner({ capabilities: CAPABLE, stageLimit: 500 });
    const h2 = await harness(fit);
    expect(await h2.call('manager_start', { request: '調べて', attachments: [h2.big.id] })).toContain(
      'を起こした',
    );
    await h2.stop();
    await stop();
  });

  it('上限を名乗らない runner には、押さず送らない', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE });
    const { big, call, stop } = await harness(fake);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('上限を名乗っていない');
    expect(fake.log).toEqual([]);
    await stop();
  });

  it('押す口（stageAttachment）が無い接続には、送らず理由を言う', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 1000, withStage: false });
    const { big, call, stop } = await harness(fake);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('押す口');
    expect(fake.log).toEqual([]);
    await stop();
  });

  it('押すのに失敗したら、理由を言って命令を送らない（start も send も）', async () => {
    const fake = fakeRunner({
      capabilities: CAPABLE,
      stageLimit: 1000,
      stageFails: 'runner PUT が失敗した (422)',
    });
    const { big, call, stop } = await harness(fake);
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('下ろせなかった');
    expect(out).toContain('(422)');
    expect(fake.log).toEqual(['stage']);
    expect(fake.starts).toHaveLength(0);
    await stop();
  });

  it('置き場から消えていたら、理由を言って命令を送らない', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 1000 });
    const { stores, big, call, stop } = await harness(fake);
    const original = stores.attachments.open.bind(stores.attachments);
    stores.attachments.open = async (id: string) => (id === big.id ? undefined : original(id));
    const out = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(out).toContain('置き場から消えた');
    expect(fake.log).toEqual([]);
    await stop();
  });
});
