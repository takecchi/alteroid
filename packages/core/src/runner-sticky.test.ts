import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerCommand,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `list()` は数えない: 宛先の解決ではなく生死の確認で、Pool は全台に聞く。
class StickyRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly sends: { managerId: string; text: string }[] = [];
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  readonly transcripts: string[] = [];
  readonly answers: { managerId: string; answer: RunnerAnswerCommand }[] = [];
  #onEvent: ((event: RunnerEvent) => void) | null = null;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  // `connect()` 前は例外にする: 黙って空振りさせない。
  ask(
    managerId: string,
    requestId: string,
    summary = '許可確認',
    askedAt: string = new Date().toISOString(),
  ): void {
    if (this.#onEvent === null) {
      throw new Error(`${this.runnerId} はまだ connect していない（ask を流せない）`);
    }
    this.#onEvent({ type: 'ask', managerId, requestId, kind: 'permission', summary, askedAt });
  }

  // 経路を足したときにここへ足し忘れると保証が静かに緩む。
  get receivedCount(): number {
    return (
      this.sends.length +
      this.resumes.length +
      this.stops.length +
      this.transcripts.length +
      this.answers.length
    );
  }

  hold(managerId: string, status: RunnerManagerState['status'] = 'running'): void {
    this.sessions.set(managerId, {
      managerId,
      status,
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.#onEvent = onEvent;
  }
  async start(command: { managerId: string }): Promise<{ cwd?: string }> {
    this.hold(command.managerId);
    return {};
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
    this.resumes.push(command);
    this.hold(command.managerId);
    return {};
  }
  async send(managerId: string, text: string): Promise<boolean> {
    this.sends.push({ managerId, text });
    return true;
  }
  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    this.answers.push({ managerId, answer });
    // `delivered: false` だと `Pool#send` が `unknown` を返し `answered` を
    // 主張できない。`settled` も流す: `Pool#send` は自分では `record.waiting`
    // から取り除かず、実 runner が上げる `settled` で消える。
    this.#onEvent?.({ type: 'settled', managerId, requestId: answer.requestId });
    return { delivered: true };
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    // 一覧から消さないと `abort` の探りが `not_stopped` を返す。
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    return [...this.sessions.values()];
  }
  async transcript(managerId: string): Promise<string | null> {
    this.transcripts.push(managerId);
    return `[生ログ] ${this.runnerId} / ${managerId}\n`;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface Fleet {
  pool: ManagerPool;
  registry: RunnerRegistry;
  stores: Stores;
  inbox: InboxEvent[];
  runners: StickyRunner[];
  close: () => Promise<void>;
}

// `createRunnerRegistry([a, b, c])` を使わない: label に `runnerId` を使うので、
// 同じ `runnerId` の2台が Map で畳まれて1台になる。
async function fleetOf(specs: { label: string; runnerId: string }[]): Promise<Fleet> {
  const runners = specs.map((spec) => new StickyRunner(spec.runnerId));
  const registry = createRunnerRegistry();
  for (const [index, spec] of specs.entries()) {
    const runner = runners[index] as StickyRunner;
    await registry.register({ label: spec.label, open: async () => runner });
  }
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  return {
    pool,
    registry,
    stores,
    inbox,
    runners,
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const THREE = [
  { label: 'http://runner-a:8080', runnerId: 'runner-a' },
  { label: 'http://runner-b:8080', runnerId: 'runner-b' },
  { label: 'http://runner-c:8080', runnerId: 'runner-c' },
];

// `pool.start({ runnerId })` で作らない: 指名の不具合でルーティングの試験まで
// 巻き添えに落ちるのを避け、台帳（`Job.runnerId`）を直に置く。
function jobFor(managerId: string, runnerId: string, extra: Partial<Job> = {}): Job {
  const at = '2026-08-01T00:00:00.000Z';
  return {
    id: managerId,
    managerId,
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: `${managerId} の仕事`,
    request: `${managerId} の依頼`,
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId,
    ...extra,
  };
}

async function attachedFleet(): Promise<Fleet> {
  const fleet = await fleetOf(THREE);
  for (const runner of fleet.runners) {
    const managerId = `mgr-on-${runner.runnerId}`;
    await fleet.stores.jobs.putJob(jobFor(managerId, runner.runnerId));
    runner.hold(managerId);
  }
  await fleet.pool.restore();
  return fleet;
}

describe('manager_id → runner_id の貼り付き（M5 受け入れ基準2 / 3台同時）', () => {
  it('manager_send は台帳の runnerId が指す器へ届き、他の2台は1度も受けない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];
    expect([a.receivedCount, b.receivedCount, c.receivedCount]).toEqual([0, 0, 0]);

    const result = await fleet.pool.send('mgr-on-runner-b', 'B の続きを進めて');

    expect(result.outcome).toBe('delivered');
    expect(b.sends).toEqual([{ managerId: 'mgr-on-runner-b', text: 'B の続きを進めて' }]);
    expect(a.receivedCount).toBe(0);
    expect(c.receivedCount).toBe(0);

    await fleet.close();
  });

  it('abort も台帳の runnerId が指す器へ届き、他の2台は1度も受けない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    const result = await fleet.pool.abort('mgr-on-runner-c', '要らなくなった', 'clone');

    expect(result.outcome).toBe('stopped');
    expect(c.stops).toEqual(['mgr-on-runner-c']);
    expect(a.receivedCount).toBe(0);
    expect(b.receivedCount).toBe(0);

    await fleet.close();
  });

  it('transcript は台帳の runnerId が指す器から取り、他の2台には聞きに行かない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    const result = await fleet.pool.transcript('mgr-on-runner-a');

    expect(result).toEqual({ kind: 'body', body: '[生ログ] runner-a / mgr-on-runner-a\n' });
    expect(a.transcripts).toEqual(['mgr-on-runner-a']);
    expect(b.transcripts).toEqual([]);
    expect(c.transcripts).toEqual([]);

    await fleet.close();
  });

  it('restore は、それぞれの器のジョブだけを起こし直す（3台に1本ずつ）', async () => {
    const fleet = await fleetOf(THREE);
    for (const runner of fleet.runners) {
      await fleet.stores.jobs.putJob(jobFor(`mgr-on-${runner.runnerId}`, runner.runnerId));
    }
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    const restored = await fleet.pool.restore();

    expect(restored.map((summary) => summary.managerId).sort()).toEqual([
      'mgr-on-runner-a',
      'mgr-on-runner-b',
      'mgr-on-runner-c',
    ]);
    expect(a.resumes.map((command) => command.managerId)).toEqual(['mgr-on-runner-a']);
    expect(b.resumes.map((command) => command.managerId)).toEqual(['mgr-on-runner-b']);
    expect(c.resumes.map((command) => command.managerId)).toEqual(['mgr-on-runner-c']);
    expect(a.resumes[0]?.sessionId).toBe('sess-mgr-on-runner-a');
    expect([a.receivedCount, b.receivedCount, c.receivedCount]).toEqual([1, 1, 1]);

    await fleet.close();
  });

  it('台帳の runnerId が名簿に無い器を指すなら、別の器へは回さない（3台とも受けない）', async () => {
    const fleet = await fleetOf(THREE);
    await fleet.stores.jobs.putJob(jobFor('mgr-orphan', 'runner-ghost'));

    const result = await fleet.pool.send('mgr-orphan', 'まだ生きていたら続けて');

    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('runner-ghost');
    for (const runner of fleet.runners) expect(runner.receivedCount).toBe(0);

    await fleet.close();
  });

  // 現状の穴を固定しているだけで、正しい振る舞いの宣言ではない。期待値を
  // 「どちらの1台か」に固定しない: 走査順を仕様として守ってしまうか、
  // `Registry#get` が直ったときに嘘の失敗になる。
  it('同じ runnerId を名乗る器が2台あると、指示は片方だけへ行く（現状の穴。Registry#get の一意性は #200 で未解決）', async () => {
    const fleet = await fleetOf([
      { label: 'http://runner-dup-1:8080', runnerId: 'runner-dup' },
      { label: 'http://runner-dup-2:8080', runnerId: 'runner-dup' },
      { label: 'http://runner-other:8080', runnerId: 'runner-other' },
    ]);
    const [dup1, dup2, other] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];
    expect(
      fleet.registry.entries().filter((entry) => entry.runnerId === 'runner-dup'),
    ).toHaveLength(2);
    await fleet.stores.jobs.putJob(jobFor('mgr-dup', 'runner-dup', { status: 'done' }));

    const result = await fleet.pool.send('mgr-dup', '続けて');

    expect(result.outcome).toBe('delivered');
    const reached = [dup1, dup2].filter((runner) => runner.receivedCount > 0);
    expect(reached).toHaveLength(1);
    expect(dup1.resumes.length + dup2.resumes.length).toBe(1);
    expect(other.receivedCount).toBe(0);

    await fleet.close();
  });

  it('許可確認の回答（answer）は台帳の runnerId が指す器にだけ届き、他の2台は1度も受けない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];
    expect([a.receivedCount, b.receivedCount, c.receivedCount]).toEqual([0, 0, 0]);

    b.ask('mgr-on-runner-b', 'req-1', 'Bash の実行許可: ls', '2026-08-01T00:00:00.000Z');
    await tick();
    expect(
      (await fleet.pool.list()).find((m) => m.managerId === 'mgr-on-runner-b')?.waiting,
    ).toEqual([
      {
        requestId: 'req-1',
        summary: 'Bash の実行許可: ls',
        kind: 'permission',
        askedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const result = await fleet.pool.send('mgr-on-runner-b', '許可します', {
      requestId: 'req-1',
      decision: 'allow',
    });

    expect(result.outcome).toBe('answered');
    expect(b.answers).toEqual([
      {
        managerId: 'mgr-on-runner-b',
        answer: { requestId: 'req-1', message: '許可します', decision: 'allow' },
      },
    ]);
    expect(a.receivedCount).toBe(0);
    expect(c.receivedCount).toBe(0);
    await tick();
    expect(
      (await fleet.pool.list()).find((m) => m.managerId === 'mgr-on-runner-b')?.waiting,
    ).toEqual([]);

    await fleet.close();
  });

  // 答える側を a にしない: `#runnerOf` が常に名簿の先頭を返す壊れ方をしても、
  // a が相手だと偶然通ってしまう。
  it('同じ requestId を2つの器が同時に持っていても、答えは managerId が指す器にしか届かない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    a.ask('mgr-on-runner-a', 'req-shared', 'A の確認', '2026-08-01T00:00:00.000Z');
    c.ask('mgr-on-runner-c', 'req-shared', 'C の確認', '2026-08-01T00:00:01.000Z');
    await tick();
    const waitingOf = async (managerId: string) =>
      (await fleet.pool.list()).find((m) => m.managerId === managerId)?.waiting;
    expect(await waitingOf('mgr-on-runner-a')).toEqual([
      {
        requestId: 'req-shared',
        summary: 'A の確認',
        kind: 'permission',
        askedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(await waitingOf('mgr-on-runner-c')).toEqual([
      {
        requestId: 'req-shared',
        summary: 'C の確認',
        kind: 'permission',
        askedAt: '2026-08-01T00:00:01.000Z',
      },
    ]);

    const result = await fleet.pool.send('mgr-on-runner-c', 'C を許可', {
      requestId: 'req-shared',
      decision: 'allow',
    });

    expect(result.outcome).toBe('answered');
    expect(c.answers).toEqual([
      {
        managerId: 'mgr-on-runner-c',
        answer: { requestId: 'req-shared', message: 'C を許可', decision: 'allow' },
      },
    ]);
    await tick();
    expect(await waitingOf('mgr-on-runner-a')).toEqual([
      {
        requestId: 'req-shared',
        summary: 'A の確認',
        kind: 'permission',
        askedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(a.receivedCount).toBe(0);
    expect(b.receivedCount).toBe(0);

    await fleet.close();
  });
});
