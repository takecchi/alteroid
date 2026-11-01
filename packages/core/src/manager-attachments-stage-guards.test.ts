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

describe('押す順と、失敗したときの後始末', () => {
  it('複数のファイルは1つずつ順に押し、途中で失敗したら残りは押さず、命令も送らず、台帳にも跡を残さない（start）', async () => {
    const bodies: Readable[] = [];
    const fake = fakeRunner({
      capabilities: CAPABLE,
      stageLimit: 1000,
      stage: async (index, _meta, body) => {
        bodies.push(body as Readable);
        if (index === 1) throw new Error('2 本目で壊れた');
        for await (const chunk of body) void chunk;
      },
    });
    const { put, call, pool, stop } = await harness(fake);
    const a = await put('a.bin', BIG);
    const b = await put('b.bin', Buffer.alloc(501, 1));
    const c = await put('c.bin', Buffer.alloc(502, 2));
    const out = await call('manager_start', { request: '調べて', attachments: [a.id, b.id, c.id] });
    expect(out).toContain('2 本目で壊れた');
    expect(out).toContain('マネージャーは起こしていない');
    // 1 本目が終わってから 2 本目に入り、3 本目には進まない
    expect(fake.log).toEqual(['stage:0:begin', 'stage:0:end', 'stage:1:begin']);
    expect(fake.starts).toEqual([]);
    expect(await pool.list()).toEqual([]);
    // 読み切らずに断られた回に、置き場の読みを残さない
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.destroyed).toBe(true);
    await stop();
  });

  it('押す失敗でも、置き場の読みは閉じる（send）。大きくない添付は押さず、命令に載る', async () => {
    const bodies: Readable[] = [];
    const fake = fakeRunner({
      capabilities: CAPABLE,
      stageLimit: 1000,
      stage: async (_index, _meta, body) => {
        bodies.push(body as Readable);
        throw new Error('壊れた');
      },
    });
    const { put, call, startManager, stop } = await harness(fake);
    const managerId = await startManager();
    const big = await put('big.bin', BIG);
    const out = await call('manager_send', { managerId, message: '続き', attachments: [big.id] });
    expect(out).toContain('壊れた');
    expect(bodies[0]?.destroyed).toBe(true);
    await stop();
  });

  it('send が届かず resume で入り直す回も、押してから resume の命令を出す', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 1000, sendDelivers: false });
    const { put, call, startManager, stop } = await harness(fake);
    const managerId = await startManager();
    fake.emit({ type: 'session', managerId, sessionId: 'sess-1' });
    const big = await put('big.bin', BIG);
    const small = await put('small.bin', SMALL);
    fake.log.length = 0;
    await call('manager_send', { managerId, message: '続きを', attachments: [small.id, big.id] });
    expect(fake.log.slice(0, 2)).toEqual(['stage:0:begin', 'stage:0:end']);
    expect(fake.log).toContain('resume');
    expect(fake.log.indexOf('resume')).toBeGreaterThan(fake.log.indexOf('stage:0:end'));
    expect(fake.resumes[0]?.attachments).toEqual([
      expect.objectContaining({ id: small.id, data: SMALL.toString('base64') }),
      expect.objectContaining({ id: big.id, staged: true }),
    ]);
    expect(fake.resumes[0]?.attachments?.[1]?.data).toBeUndefined();
    await stop();
  });
});

describe('hello が書いた上限は、下ろしの判定にそのまま効く（hello の再送）', () => {
  it('下ろしの上限: 後の hello が上書きし、上限を名乗らない hello は前の値を持ち越さない', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 499 });
    const { put, call, stop } = await harness(fake);
    const big = await put('big.bin', BIG);
    const start = () => call('manager_start', { request: '調べて', attachments: [big.id] });

    expect(await start()).toContain('上限 499 バイト');
    expect(fake.starts).toHaveLength(0);

    fake.hello({ capabilities: CAPABLE, stageLimit: 500 });
    expect(await start()).toContain('を起こした');
    expect(fake.starts).toHaveLength(1);

    fake.hello({ capabilities: CAPABLE });
    expect(await start()).toContain('上限を名乗っていない');
    expect(fake.starts).toHaveLength(1);

    fake.hello({ capabilities: CAPABLE, stageLimit: 1000 });
    expect(await start()).toContain('を起こした');
    expect(fake.starts).toHaveLength(2);

    // 能力を名乗らなくなった器（版が下がった）には、上限が残っていても押さない
    fake.hello({ capabilities: [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS], stageLimit: 1000 });
    expect(await start()).toContain(RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE);
    expect(fake.starts).toHaveLength(2);
    await stop();
  });

  it('本文の上限: 見積もりちょうどは通り、1 バイト足りなければ断る。上限を名乗らない hello は前の値を持ち越さない', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE });
    const { put, call, startManager, stop } = await harness(fake);
    const small = await put('small.bin', SMALL);
    const estimate = estimateAttachmentBodyBytes(
      [
        {
          id: small.id,
          name: 'small.bin',
          mediaType: 'application/octet-stream',
          size: SMALL.length,
          sha256: small.sha256,
          data: SMALL.toString('base64'),
        },
      ],
      '調べて',
    );
    const start = () => call('manager_start', { request: '調べて', attachments: [small.id] });

    await startManager(); // 接続して初めの hello を受けさせる（以降の hello がそれを上書きする）
    fake.starts.length = 0;
    fake.hello({ capabilities: CAPABLE, bodyLimit: estimate - 1 });
    const refused = await start();
    expect(refused).toContain(`見積もり ${estimate} バイト`);
    expect(refused).toContain(`上限 ${estimate - 1} バイトを超える`);
    expect(refused).toContain('runner が名乗った値');
    expect(fake.starts).toHaveLength(0);

    fake.hello({ capabilities: CAPABLE, bodyLimit: estimate });
    expect(await start()).toContain('を起こした');
    expect(fake.starts).toHaveLength(1);

    fake.hello({ capabilities: CAPABLE, bodyLimit: estimate - 1 });
    expect(await start()).toContain('見積もり');
    expect(fake.starts).toHaveLength(1);

    // 名乗らなくなったら、デーモン側の既定値で検める（前の小さい上限は残らない）
    fake.hello({ capabilities: CAPABLE });
    expect(await start()).toContain('を起こした');
    expect(fake.starts).toHaveLength(2);
    await stop();
  });

  it('本文の上限は、大きいファイル（staged）の中身を数えず、名前と本文だけを数える。先に下ろしの判定が走る', async () => {
    const fake = fakeRunner({ capabilities: CAPABLE, stageLimit: 1000 });
    const { put, call, startManager, stop } = await harness(fake);
    const big = await put('big.bin', BIG);
    await startManager();
    fake.starts.length = 0;
    const estimate = estimateAttachmentBodyBytes(
      [
        {
          id: big.id,
          name: 'big.bin',
          mediaType: 'application/octet-stream',
          size: BIG.length,
          sha256: big.sha256,
          staged: true,
        },
      ],
      '調べて',
    );
    fake.hello({ capabilities: CAPABLE, stageLimit: 1000, bodyLimit: estimate });
    expect(await call('manager_start', { request: '調べて', attachments: [big.id] })).toContain(
      'を起こした',
    );
    fake.hello({ capabilities: CAPABLE, stageLimit: 1000, bodyLimit: estimate - 1 });
    expect(await call('manager_start', { request: '調べて', attachments: [big.id] })).toContain(
      '見積もり',
    );
    // 下ろしの上限（押す側）の断りは、本文の上限より先に言う
    fake.hello({ capabilities: CAPABLE, stageLimit: 499, bodyLimit: estimate - 1 });
    const both = await call('manager_start', { request: '調べて', attachments: [big.id] });
    expect(both).toContain('上限 499 バイト');
    expect(both).not.toContain('見積もり');
    await stop();
  });
});

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
