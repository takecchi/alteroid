import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerEvent,
  type RunnerResumeCommand,
  type RunnerStartCommand,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

interface Fake {
  runner: RunnerClient;
  starts: RunnerStartCommand[];
  resumes: RunnerResumeCommand[];
  sends: {
    managerId: string;
    text: string;
    attachments: readonly RunnerAttachment[] | undefined;
  }[];
  emit(event: RunnerEvent): void;
}

function fakeRunner(options: {
  capable: boolean;
  sendDelivers?: boolean;
  bodyLimit?: number;
}): Fake {
  const runnerId = 'runner-x';
  const base = createLocalRunner({ runnerId, workspacePath: '/work/project', env: {} });
  const starts: RunnerStartCommand[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const sends: Fake['sends'] = [];
  let emitter: ((event: RunnerEvent) => void) | null = null;
  const runner: RunnerClient = Object.create(base) as RunnerClient;
  Object.assign(runner, {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent: (event: RunnerEvent) => void) {
      emitter = onEvent;
      onEvent({
        type: 'hello',
        runnerId,
        capabilities: options.capable ? [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS] : [],
        ...(options.bodyLimit === undefined ? {} : { attachmentBodyLimit: options.bodyLimit }),
      });
    },
    async start(command: RunnerStartCommand) {
      starts.push(command);
      return { cwd: command.cwd };
    },
    async resume(command: RunnerResumeCommand) {
      resumes.push(command);
      return { cwd: command.cwd };
    },
    async send(managerId: string, text: string, attachments?: readonly RunnerAttachment[]) {
      sends.push({ managerId, text, attachments });
      return options.sendDelivers ?? true;
    },
    async list() {
      return [];
    },
  });
  return { runner, starts, resumes, sends, emit: (event) => emitter?.(event) };
}

const BYTES = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

async function harness(fake: Fake, overrides: Partial<ToolContext> = {}) {
  const stores = createMemoryStores();
  const registry = createRunnerRegistry([fake.runner]);
  const pool: ManagerPool = createManagerPool({ stores, post: () => undefined, runners: registry });
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
    ...overrides,
  };
  const tools = createCloneTools(context);
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    const out = await tool!.handler(args as never, {} as never);
    return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  return {
    stores,
    pool,
    call,
    stop: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('manager_start の attachments（Issue #3111 段3）', () => {
  it('命令の本文に中身（base64）・メタデータが載り、日誌には参照だけが残る（中身は残らない）', async () => {
    const fake = fakeRunner({ capable: true });
    const { stores, call, stop } = await harness(fake);
    const meta = await stores.attachments.put({
      name: 'build.log',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const out = await call('manager_start', { request: 'ログを調べて', attachments: [meta.id] });
    expect(out).toContain('を起こした');

    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]?.attachments).toEqual([
      {
        id: meta.id,
        name: 'build.log',
        mediaType: 'text/plain',
        size: BYTES.length,
        sha256: meta.sha256,
        data: Buffer.from(BYTES).toString('base64'),
      },
    ]);

    const journal = await stores.journal.list();
    const outbound = journal.find((e) => e.type === 'exchange' && e.with === 'manager');
    expect(outbound).toMatchObject({
      type: 'exchange',
      role: 'outbound',
      attachments: [
        {
          id: meta.id,
          name: 'build.log',
          mediaType: 'text/plain',
          size: BYTES.length,
          sha256: meta.sha256,
        },
      ],
    });
    expect(JSON.stringify(journal)).not.toContain(Buffer.from(BYTES).toString('base64'));
    await stop();
  });

  it('添付の引数が無ければ、命令に attachments 欄を載せない（従来どおり）', async () => {
    const fake = fakeRunner({ capable: false });
    const { call, stop } = await harness(fake);
    await call('manager_start', { request: '普通に' });
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).not.toHaveProperty('attachments');
    await stop();
  });

  it('見つからない添付があれば、命令を送らず日誌にも書かず、エラー文を返す', async () => {
    const fake = fakeRunner({ capable: true });
    const { stores, call, stop } = await harness(fake);
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const out = await call('manager_start', {
      request: '依頼',
      attachments: [meta.id, 'no-such-attachment'],
    });
    expect(out).toContain('見つからない');
    expect(out).toContain('no-such-attachment');
    expect(out).toContain('何も送っていない');
    expect(fake.starts).toEqual([]);
    expect(await stores.journal.list()).toEqual([]);
    await stop();
  });

  it('個数・合計の上限を超えれば、命令を送らずに断る', async () => {
    const fake = fakeRunner({ capable: true });
    const { stores, call, stop } = await harness(fake, {
      attachmentLimits: {
        maxImageBytes: 1024,
        maxFileBytes: 1024,
        maxPerMessage: 1,
        maxTotalBytes: 1024,
        retentionDays: 30,
      },
    });
    const a = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const b = await stores.attachments.put({
      name: 'b.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const out = await call('manager_start', { request: '依頼', attachments: [a.id, b.id] });
    expect(out).toContain('1 発言に添えられるのは 1 個まで');
    expect(fake.starts).toEqual([]);
    await stop();
  });

  it('添付の受け渡しを名乗らない旧い runner へは、黙って捨てられるので送らずに断る', async () => {
    const fake = fakeRunner({ capable: false });
    const { stores, call, stop, pool } = await harness(fake);
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const out = await call('manager_start', { request: '依頼', attachments: [meta.id] });
    expect(out).toContain('名乗っていない');
    expect(fake.starts).toEqual([]);
    expect(await pool.list()).toEqual([]);
    await stop();
  });
});

describe('manager_send の attachments（Issue #3111 段3）', () => {
  it('走行中の担い手へ、添付つきで runner.send が呼ばれ、日誌に参照だけが残る', async () => {
    const fake = fakeRunner({ capable: true });
    const { stores, call, stop } = await harness(fake);
    const started = await call('manager_start', { request: '最初' });
    const managerId = /マネージャー (\S+) を起こした/.exec(started)?.[1] ?? '';
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });

    const out = await call('manager_send', {
      managerId,
      message: 'これも見て',
      attachments: [meta.id],
    });
    expect(out).toContain('届けた');
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.attachments).toEqual([
      expect.objectContaining({
        id: meta.id,
        sha256: meta.sha256,
        data: Buffer.from(BYTES).toString('base64'),
      }),
    ]);
    const sent = (await stores.journal.list()).filter(
      (e) => e.type === 'exchange' && e.role === 'outbound' && e.text.includes('これも見て'),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ attachments: [{ id: meta.id, name: 'a.txt' }] });
    await stop();
  });

  it('見つからない添付があれば、何も送らない', async () => {
    const fake = fakeRunner({ capable: true });
    const { call, stop } = await harness(fake);
    const started = await call('manager_start', { request: '最初' });
    const managerId = /マネージャー (\S+) を起こした/.exec(started)?.[1] ?? '';
    const out = await call('manager_send', {
      managerId,
      message: 'これも見て',
      attachments: ['gone'],
    });
    expect(out).toContain('見つからない');
    expect(fake.sends).toEqual([]);
    expect(fake.resumes).toEqual([]);
    await stop();
  });

  it('runner にセッションが無く resume で入り直す回も、添付を落とさず resume の命令に載せる', async () => {
    const fake = fakeRunner({ capable: true, sendDelivers: false });
    const { stores, call, stop } = await harness(fake);
    const started = await call('manager_start', { request: '最初' });
    const managerId = /マネージャー (\S+) を起こした/.exec(started)?.[1] ?? '';
    fake.emit({ type: 'session', managerId, sessionId: 'sess-1' });
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });

    await call('manager_send', { managerId, message: '続きを', attachments: [meta.id] });
    expect(fake.resumes).toHaveLength(1);
    expect(fake.resumes[0]?.message).toContain('続きを');
    expect(fake.resumes[0]?.attachments).toEqual([
      expect.objectContaining({ id: meta.id, data: Buffer.from(BYTES).toString('base64') }),
    ]);
    await stop();
  });

  it('確認への回答（requestId / decision）には載せられず、何も送らない', async () => {
    const fake = fakeRunner({ capable: true });
    const { stores, pool, stop } = await harness(fake);
    const started = await pool.start({ request: '最初' });
    fake.emit({
      type: 'ask',
      managerId: started.managerId,
      requestId: 'req-1',
      kind: 'permission',
      summary: 'rm -rf を実行してよいか',
    });
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: BYTES,
    });
    const result = await pool.send(started.managerId, '許す', {
      decision: 'allow',
      requestId: 'req-1',
      attachments: [
        {
          id: meta.id,
          name: 'a.txt',
          mediaType: 'text/plain',
          size: BYTES.length,
          sha256: meta.sha256,
          data: 'AAEC',
        },
      ],
    });
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('添付を載せられない');
    expect(fake.sends).toEqual([]);
    await stop();
  });
});

describe('runner が名乗った本文の上限での検め（hello.attachmentBodyLimit。Issue #3111 段3）', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('名乗った上限を超える添付は、manager_start / manager_send とも送らずにエラー文を返す', async () => {
    const fake = fakeRunner({ capable: true, bodyLimit: 4000 });
    const { stores, call, stop } = await harness(fake);
    const big = await stores.attachments.put({
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(5000),
    });
    const started = await call('manager_start', { request: '依頼', attachments: [big.id] });
    expect(started).toContain('上限 4000 バイトを超える');
    expect(started).toContain('runner が名乗った値');
    expect(fake.starts).toEqual([]);

    const ok = await call('manager_start', { request: '最初' });
    const managerId = /マネージャー (\S+) を起こした/.exec(ok)?.[1] ?? '';
    const sent = await call('manager_send', { managerId, message: 'これ', attachments: [big.id] });
    expect(sent).toContain('上限 4000 バイトを超える');
    expect(sent).toContain('何も送っていない');
    expect(fake.sends).toEqual([]);
    expect(fake.resumes).toEqual([]);
    await stop();
  });

  it('名乗った上限の内側なら送られる', async () => {
    const fake = fakeRunner({ capable: true, bodyLimit: 4000 });
    const { stores, call, stop } = await harness(fake);
    const small = await stores.attachments.put({
      name: 's.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(1000),
    });
    await call('manager_start', { request: '依頼', attachments: [small.id] });
    expect(fake.starts).toHaveLength(1);
    await stop();
  });

  it('上限を名乗らない runner は、デーモン側の既定値（runnerAttachmentBodyLimit）で検める', async () => {
    vi.stubEnv('ALTEROID_ATTACHMENT_MAX_TOTAL_BYTES', '1000');
    const fake = fakeRunner({ capable: true });
    const { stores, call, stop } = await harness(fake, {
      attachmentLimits: {
        maxImageBytes: 8 * 1024 * 1024,
        maxFileBytes: 8 * 1024 * 1024,
        maxPerMessage: 10,
        maxTotalBytes: 16 * 1024 * 1024,
        retentionDays: 30,
      },
    });
    const big = await stores.attachments.put({
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(3 * 1024 * 1024),
    });
    const out = await call('manager_start', { request: '依頼', attachments: [big.id] });
    expect(out).toContain('上限を名乗らない版なので、デーモン側の既定値');
    expect(fake.starts).toEqual([]);
    const small = await stores.attachments.put({
      name: 's.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(1000),
    });
    await call('manager_start', { request: '依頼', attachments: [small.id] });
    expect(fake.starts).toHaveLength(1);
    await stop();
  });
});
