import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerStagedAttachmentMeta,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { UnreadableJobError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Pool#send`（`#send`）の早い return のうち、既存の試験が1本も縛っていなかったものを、
// 外から見える結果（戻り値の outcome / detail と runner への命令）だけで縛る。段（非公開メソッド）へ分けるときに
// 早い return や戻り値を取り違えると落ちる。
//   - 読めない行への送信を「居ない」と言い換えない（unreadable と unknown は daemon の `app-routes-managers.ts` で 409 / 404 に分かれる）
//   - 大きいファイルを下ろせなかった回は、命令を送らずに unknown で断る
//   - 取り直している最中に重なった2本目の送信は、resume を重ねずに busy で断る
//   - 送っている最中に止められた委譲は、台帳を running に書き戻さず session_missing（止めた意思を優先）を返す

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

interface Gate {
  entered: Promise<void>;
  opened: Promise<void>;
  markEntered: () => void;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  let markEntered!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return { entered, opened, markEntered, open };
}

interface FakeOptions {
  /** 指定すると、接続したときに hello を名乗る。 */
  hello?: { capabilities: string[]; stageLimit: number };
  /** 指定すると、`runner.send` はこの門が開くまで返らない。 */
  sendGate?: Gate;
  /** 指定すると、`runner.resume` はこの門が開くまで返らない。 */
  resumeGate?: Gate;
}

interface Fake {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  sends: string[];
  resumes: string[];
  resumeMessages: string[];
  stages: string[];
}

function fakeRunner(options: FakeOptions = {}): Fake {
  const runnerId = 'runner-primary';
  const alive: RunnerManagerState[] = [];
  const sends: string[] = [];
  const resumes: string[] = [];
  const resumeMessages: string[] = [];
  const stages: string[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
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
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      resumes.push(command.managerId);
      resumeMessages.push(command.message ?? '');
      if (options.resumeGate !== undefined) {
        options.resumeGate.markEntered();
        await options.resumeGate.opened;
      }
      return { cwd: command.cwd };
    },
    async send(_managerId, text) {
      sends.push(text);
      if (options.sendGate !== undefined) {
        options.sendGate.markEntered();
        await options.sendGate.opened;
      }
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
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
  return { runner, alive, sends, resumes, resumeMessages, stages };
}

function jobOf(managerId: string): Job {
  return {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: Fake;
}

function build(stores: Stores, fake: Fake): Setup {
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    now: () => CLOCK,
  });
  return { pool, stores, inbox, fake };
}

// 書き終えた後の続きは microtask だけなので、macrotask を1つ挟めば走り切っている。
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('send: 居ない・読めない委譲への早い return', () => {
  it('台帳に無い委譲は unknown（居ない）と全文で返す', async () => {
    const s = build(createMemoryStores(), fakeRunner());

    const result = await s.pool.send('mgr-nope', 'やあ');

    expect(result).toEqual({
      outcome: 'unknown',
      detail: 'mgr-nope というマネージャーは居ない。',
    });
    await s.pool.stop();
  });

  it('読めない形で在る行は「居ない」と言わず、unreadable と理由を全文で返して何も送らない', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      jobs: {
        ...base.jobs,
        getJob: async (id) => {
          if (id === 'mgr-broken') throw new UnreadableJobError({ id, reason: '壊れた行' });
          return base.jobs.getJob(id);
        },
        listUnreadableJobs: async () => [{ id: 'mgr-broken', reason: '壊れた行' }],
      },
    };
    const s = build(stores, fakeRunner());

    const result = await s.pool.send('mgr-broken', 'やあ');

    expect(result).toEqual({
      outcome: 'unreadable',
      detail:
        'マネージャー mgr-broken は読めない形で入っている（消されたのでも、畳まれたのでもない）。' +
        '理由: 壊れた行。本文はここでは取れない。送っていない。',
    });
    expect(s.fake.sends).toEqual([]);
    expect(s.fake.resumes).toEqual([]);
    await s.pool.stop();
  });
});

describe('send: 大きいファイルを下ろせなかった回の早い return', () => {
  it('置き場から消えていた大きいファイルは、命令を送らず unknown と全文で断る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf('mgr-stage'));
    const fake = fakeRunner({
      hello: {
        capabilities: [
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
        ],
        stageLimit: 1_000_000,
      },
    });
    const s = build(stores, fake);

    const result = await s.pool.send('mgr-stage', '大きい添付つきの指示', {
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
    });

    expect(result).toEqual({
      outcome: 'unknown',
      detail:
        '大きいファイル att-gone（big.bin, 500 バイト） は読む間に置き場から消えた（保持期限）' +
        '（何も送っていない）',
    });
    expect(fake.stages).toEqual([]);
    expect(fake.sends).toEqual([]);
    // 起動時の取り直しの resume は起きうる。断った本文がどの命令にも載っていないことを見る。
    expect(fake.resumeMessages.filter((text) => text.includes('大きい添付つきの指示'))).toEqual([]);
    await s.pool.stop();
  });
});

describe('send: 取り直している最中に重なった送信', () => {
  it('2本目は resume を重ねず、unknown（器の入れ替えから取り直している最中）と全文で断る。1本目はそのまま届く', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf('mgr-busy'));
    const resumeGate = gate();
    const fake = fakeRunner({ resumeGate });
    const s = build(stores, fake);

    const first = s.pool.send('mgr-busy', '1つ目の指示');
    await resumeGate.entered;

    const second = await s.pool.send('mgr-busy', '2つ目の指示');

    expect(second).toEqual({
      outcome: 'unknown',
      detail: 'mgr-busy は器の入れ替えから取り直している最中である。少し置いてから送り直すこと。',
    });
    expect(fake.resumes).toEqual(['mgr-busy']);

    resumeGate.open();
    const delivered = await first;
    expect(delivered.outcome).toBe('delivered');
    expect(fake.resumes).toEqual(['mgr-busy']);
    await s.pool.stop();
  });
});

describe('send: 送っている最中に止められた委譲', () => {
  it('台帳へ running を書き戻さず、session_missing（止めた意思を優先）を全文で返す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(jobOf('mgr-stop-send'));
    const sendGate = gate();
    const fake = fakeRunner({ sendGate });
    fake.alive.push({
      liveBackgroundTasks: 0,
      managerId: 'mgr-stop-send',
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-mgr-stop-send',
    });
    const s = build(stores, fake);
    await s.pool.restore();
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });

    const sending = s.pool.send('mgr-stop-send', '止められる前に出した指示');
    await sendGate.entered;

    const aborted = await s.pool.abort('mgr-stop-send', '人間が止めた');
    expect(aborted.outcome).toBe('stopped');

    sendGate.open();
    const result = await sending;
    await settle();

    expect(result).toEqual({
      outcome: 'session_missing',
      detail:
        'mgr-stop-send は resume している最中に止められた（止めた意思を優先し、' +
        '起こしかけた・起こしてしまったセッションは畳んだ）。台帳の status は ' +
        '`stopped` のまま——新しく起こし直さないこと。再開してよいかは、止めた側' +
        '（人間・クローン）の判断に従うこと。',
    });
    expect((await stores.jobs.getJob('mgr-stop-send'))?.status).toBe('stopped');
    await s.pool.stop();
  });
});
