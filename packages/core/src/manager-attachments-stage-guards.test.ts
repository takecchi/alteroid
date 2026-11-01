import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { estimateAttachmentBodyBytes } from './manager-attachments.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerEvent,
  type RunnerResumeCommand,
  type RunnerStagedAttachmentMeta,
  type RunnerStartCommand,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// 添付の「下ろし」（#attachmentsRefusal・#stageAttachments）を Pool から切り出す前の縛り。
// 公開の口（manager_start / manager_send・hello の再送）だけで、上限の効き方・断る理由・押す順・期限を確かめる。
const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 100_000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};
const BIG = Buffer.alloc(500, 7);
const SMALL = Buffer.alloc(50, 3);

const CAPABLE = [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS, RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE];

interface FakeOptions {
  capabilities: string[];
  stageLimit?: number;
  bodyLimit?: number;
  withStage?: boolean;
  sendDelivers?: boolean;
  /** 指定が無ければ本文を読み切って返る。呼ばれた通し番号（0 始まり）と本文を受ける。 */
  stage?: (
    index: number,
    meta: RunnerStagedAttachmentMeta,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  /** 指定すると、`connect` から `hello` をこのミリ秒後に送る（偽の時計で進める）。 */
  helloAfterMs?: number;
}

interface Fake {
  runner: RunnerClient;
  log: string[];
  starts: RunnerStartCommand[];
  resumes: RunnerResumeCommand[];
  sends: { attachments: readonly RunnerAttachment[] | undefined }[];
  emit(event: RunnerEvent): void;
  hello(options: { capabilities: string[]; stageLimit?: number; bodyLimit?: number }): void;
}

function fakeRunner(options: FakeOptions): Fake {
  const runnerId = 'runner-x';
  const base = createLocalRunner({ runnerId, workspacePath: '/work/project', env: {} });
  const log: string[] = [];
  const starts: RunnerStartCommand[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const sends: Fake['sends'] = [];
  let emitter: ((event: RunnerEvent) => void) | null = null;
  const helloOf = (o: { capabilities: string[]; stageLimit?: number; bodyLimit?: number }) =>
    ({
      type: 'hello',
      runnerId,
      capabilities: o.capabilities,
      ...(o.stageLimit === undefined ? {} : { attachmentStageLimit: o.stageLimit }),
      ...(o.bodyLimit === undefined ? {} : { attachmentBodyLimit: o.bodyLimit }),
    }) satisfies RunnerEvent;
  let staged = 0;
  const runner: RunnerClient = Object.create(base) as RunnerClient;
  Object.assign(runner, {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent: (event: RunnerEvent) => void) {
      emitter = onEvent;
      if (options.helloAfterMs === undefined) onEvent(helloOf(options));
      else setTimeout(() => onEvent(helloOf(options)), options.helloAfterMs);
    },
    async start(command: RunnerStartCommand) {
      log.push('start');
      starts.push(command);
      return { cwd: command.cwd };
    },
    async resume(command: RunnerResumeCommand) {
      log.push('resume');
      resumes.push(command);
      return { cwd: command.cwd };
    },
    async send(_managerId: string, _text: string, attachments?: readonly RunnerAttachment[]) {
      log.push('send');
      sends.push({ attachments });
      return options.sendDelivers ?? true;
    },
    async list() {
      return [];
    },
  });
  if (options.withStage !== false) {
    Object.assign(runner, {
      async stageAttachment(
        _managerId: string,
        meta: RunnerStagedAttachmentMeta,
        body: AsyncIterable<Uint8Array>,
        opts?: { signal?: AbortSignal },
      ) {
        const index = staged++;
        log.push(`stage:${index}:begin`);
        if (options.stage !== undefined) await options.stage(index, meta, body, opts?.signal);
        else for await (const chunk of body) void chunk;
        log.push(`stage:${index}:end`);
      },
    });
  } else {
    (runner as { stageAttachment?: undefined }).stageAttachment = undefined;
  }
  return {
    runner,
    log,
    starts,
    resumes,
    sends,
    emit: (event) => emitter?.(event),
    hello: (o) => emitter?.(helloOf(o)),
  };
}

async function harness(fake: Fake) {
  const stores = {
    ...createMemoryStores(),
    attachments: new MemoryAttachmentStore({ limits: LIMITS }),
  };
  const registry = createRunnerRegistry([fake.runner]);
  const pool: ManagerPool = createManagerPool({ stores, post: () => undefined, runners: registry });
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
  const put = (name: string, bytes: Buffer) =>
    stores.attachments.put({ name, mediaType: 'application/octet-stream', bytes });
  const startManager = async (): Promise<string> => {
    const started = await call('manager_start', { request: '最初' });
    return /マネージャー (\S+) を起こした/.exec(started)?.[1] ?? '';
  };
  return {
    stores,
    pool,
    call,
    put,
    startManager,
    stop: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('manager_send でも、大きいファイルを下ろせなければ理由を言って何も送らない', () => {
  const cases: {
    name: string;
    options: FakeOptions;
    expected: string;
  }[] = [
    {
      name: '押す能力を名乗らない runner',
      options: { capabilities: [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS], stageLimit: 1000 },
      expected: RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
    },
    {
      name: 'size が上限を超える runner',
      options: { capabilities: CAPABLE, stageLimit: 499 },
      expected: '上限 499 バイト',
    },
    {
      name: '上限を名乗らない runner',
      options: { capabilities: CAPABLE },
      expected: '上限を名乗っていない',
    },
    {
      name: '押す口（stageAttachment）が無い接続',
      options: { capabilities: CAPABLE, stageLimit: 1000, withStage: false },
      expected: '押す口',
    },
    {
      name: '押すのに失敗する runner',
      options: {
        capabilities: CAPABLE,
        stageLimit: 1000,
        stage: async () => {
          throw new Error('runner PUT が失敗した (422)');
        },
      },
      expected: '(422)',
    },
  ];
  it.each(cases)('$name', async ({ options, expected }) => {
    const fake = fakeRunner(options);
    const { put, call, startManager, stop } = await harness(fake);
    const managerId = await startManager();
    const big = await put('big.bin', BIG);
    fake.log.length = 0;
    const out = await call('manager_send', { managerId, message: '続き', attachments: [big.id] });
    expect(out).toContain(expected);
    expect(out).toContain('何も送っていない');
    expect(fake.sends).toEqual([]);
    expect(fake.resumes).toEqual([]);
    expect(fake.log.filter((entry) => entry === 'send' || entry === 'resume')).toEqual([]);
    await stop();
  });
});
