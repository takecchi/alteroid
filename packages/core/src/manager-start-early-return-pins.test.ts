import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerStagedAttachmentMeta,
} from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool#start` の本体（`#startAfterSupersedeCheck`）の、末尾以外の抜け口（早い return は無く、条件で投げる throw が4つ）を、
// 外から見える結果（投げるメッセージの全文・`pool.list()`・runner への命令・受信箱）だけで縛る。
// 段（非公開メソッド）へ分けるときに、投げる条件や順番を取り違えると落ちる。
//   - 添付を受け渡せない runner へは、起こさずに断る
//   - cwd を省いて workspacePath を聞けていない runner へは、cwd の形のせいにせず断る
//   - 大きいファイルを下ろせなかった回は、命令を送らず台帳にも跡を残さずに断る
//   - runner.start が拒否したときは、一覧に起こしかけの行を残さず、元の例外をそのまま投げる（既存の試験は一覧を見ていなかった）

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

interface FakeOptions {
  /** 指定すると、接続したときに hello を名乗る。 */
  hello?: { capabilities: string[]; stageLimit: number };
  workspacePathKnown?: boolean;
  /** 指定すると、`runner.start` はこの例外で拒否する。 */
  startError?: Error;
}

interface Fake {
  runner: RunnerClient;
  starts: string[];
  stages: string[];
}

function fakeRunner(options: FakeOptions = {}): Fake {
  const runnerId = 'runner-primary';
  const starts: string[] = [];
  const stages: string[] = [];
  const known = options.workspacePathKnown ?? true;

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: known ? '/work/project' : '',
    workspacePathKnown: known,
    async connect(onEvent) {
      if (options.hello !== undefined) {
        onEvent({
          type: 'hello',
          runnerId,
          capabilities: options.hello.capabilities,
          attachmentStageLimit: options.hello.stageLimit,
        } satisfies RunnerEvent);
      }
    },
    async start(command): Promise<{ cwd: string }> {
      starts.push(command.managerId);
      if (options.startError !== undefined) throw options.startError;
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async stageAttachment(managerId: string, meta: RunnerStagedAttachmentMeta) {
      stages.push(`${managerId}:${meta.id}`);
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return { runner, starts, stages };
}

interface Setup {
  pool: ManagerPool;
  inbox: InboxEvent[];
  fake: Fake;
}

function build(fake: Fake): Setup {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: createMemoryStores(),
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    now: () => CLOCK,
  });
  return { pool, inbox, fake };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return '(投げなかった)';
}

describe('start: 断る抜け口（throw）', () => {
  it('添付を受け渡せない runner へは、起こさず ManagerAttachmentsRefusedError を全文で投げる', async () => {
    const fake = fakeRunner({ hello: { capabilities: [], stageLimit: 0 } });
    const s = build(fake);

    const message = await messageOf(
      s.pool.start({
        request: '調べて',
        attachments: [
          {
            id: 'att-1',
            name: 'a.txt',
            mediaType: 'text/plain',
            size: 1,
            sha256: 'x',
            data: 'eA==',
          },
        ],
      }),
    );

    expect(message).toBe(
      'ManagerAttachmentsRefusedError: runner（runnerId=runner-primary）は担い手への添付の受け渡しを名乗っていない' +
        '（旧い版か、名乗りをまだ受けていない）。添付は黙って捨てられるので送らない',
    );
    expect(fake.starts).toEqual([]);
    expect(await s.pool.list()).toEqual([]);
    expect(s.inbox).toEqual([]);
    await s.pool.stop();
  });

  it('cwd を省いて workspacePath を聞けていない runner へは、起こさず全文で投げる', async () => {
    const fake = fakeRunner({ workspacePathKnown: false });
    const s = build(fake);

    const message = await messageOf(s.pool.start({ request: '調べて' }));

    expect(message).toBe(
      'Error: runner（runnerId=runner-primary）から workspacePath をまだ一度も聞けていないため、' +
        'cwd を省いてマネージャーを起こせない（cwd の形が不正なのではない）。' +
        'cwd を明示して起こすか、runner が /health で workspacePath を名乗ってから起こすこと（#402）。',
    );
    expect(fake.starts).toEqual([]);
    expect(await s.pool.list()).toEqual([]);
    expect(s.inbox).toEqual([]);
    await s.pool.stop();
  });

  it('大きいファイルを下ろせなかった回は、命令を送らず台帳にも跡を残さず、全文で投げる', async () => {
    const fake = fakeRunner({
      hello: {
        capabilities: [
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
        ],
        stageLimit: 1_000_000,
      },
    });
    const s = build(fake);

    const message = await messageOf(
      s.pool.start({
        request: '調べて',
        attachments: [
          {
            id: 'att-gone',
            name: 'big.bin',
            mediaType: 'application/octet-stream',
            size: 500,
            sha256: 'abc',
            staged: true,
          },
        ],
      }),
    );

    expect(message).toBe(
      'ManagerAttachmentsRefusedError: 大きいファイル att-gone（big.bin, 500 バイト） は読む間に置き場から消えた（保持期限）',
    );
    expect(fake.stages).toEqual([]);
    expect(fake.starts).toEqual([]);
    expect(await s.pool.list()).toEqual([]);
    expect(s.inbox).toEqual([]);
    await s.pool.stop();
  });
});

describe('start: runner.start が拒否した回', () => {
  it('元の例外をそのまま投げ、起こしかけの行を一覧に残さない', async () => {
    const boom = new Error('runner が起動を断った');
    const fake = fakeRunner({ startError: boom });
    const s = build(fake);

    await expect(s.pool.start({ request: '調べて' })).rejects.toBe(boom);

    expect(fake.starts).toHaveLength(1);
    expect(await s.pool.list()).toEqual([]);
    expect(s.inbox).toEqual([]);
    await s.pool.stop();
  });
});
