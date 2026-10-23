import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 2026-10-23 heosterra（#5195）: 枠で落ちた担当を新しい鍵で起こし直した（新しい世代）が、新しいセッションは何も出さないまま、
// 起こし直す前の古いセッションが生きてターンを回し続けた。デーモンは新しい世代だけを追い、古い世代の完遂の報告を全部捨てていた。
// 新しい世代がまだ1つも出来事を出していないうちは、古い世代の報告を捨てずに配る。

const OLD = 'gen-old-2c6c905d';
const NEW = 'gen-new-b7933494';
const START = Date.parse('2026-10-23T13:33:00.000Z');

function endTurnLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
}

class Runner implements RunnerClient {
  readonly runnerId = 'runner-5';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly resumes: RunnerResumeCommand[] = [];
  alive: RunnerManagerState[] = [];
  liveTranscript: string | null = null;
  #emit: ((event: RunnerEvent) => unknown) | null = null;

  async emit(event: RunnerEvent): Promise<void> {
    await this.#emit?.(event);
  }
  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(onEvent: (event: RunnerEvent) => unknown): Promise<void> {
    this.#emit = onEvent;
    await onEvent({
      type: 'hello',
      runnerId: this.runnerId,
      capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
    });
  }
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(
    command: RunnerResumeCommand,
  ): Promise<{ cwd?: string; sessionGeneration?: string }> {
    this.resumes.push(command);
    this.alive = [
      {
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      },
    ];
    return { sessionGeneration: NEW };
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return this.alive;
  }
  async transcript(): Promise<string | null> {
    return this.liveTranscript;
  }
  async transcriptTail(): Promise<string | null> {
    return this.liveTranscript;
  }
  async credentials() {
    return [];
  }
  async setCredentials() {
    return [];
  }
  async profile() {
    return undefined;
  }
  async setProfile() {
    return { ok: true as const };
  }
  async close(): Promise<void> {}
}

const JOB: Job = {
  id: 'mgr-landrule',
  createdAt: '2026-10-23T12:00:00.000Z',
  updatedAt: '2026-10-23T13:00:00.000Z',
  status: 'running',
  summary: '取り込みと片付け',
  request: '取り込んで',
  cwd: '/work/project',
  runnerId: 'runner-5',
  sessionId: 'sess-landrule',
  lastReport: '13:33Z の失敗',
  lastReportAt: '2026-10-23T13:33:00.000Z',
};

/** 再起動の引き取りで runner にセッションが居ないので resume し、新しい世代（NEW）を追う状態まで進める。 */
async function harness() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const runner = new Runner();
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const posted: InboxEvent[] = [];
  let clock = START;
  const pool = createManagerPool({
    stores,
    post: (event) => posted.push(event),
    runners: registry,
    now: () => clock,
  });
  await pool.restore();
  await vi.waitFor(() => expect(runner.resumes).toHaveLength(1));
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();
  return {
    pool,
    runner,
    settle,
    inboxText: () => posted.map((event) => JSON.stringify(event)).join('\n'),
    job: async () => (await stores.jobs.listJobs()).find((job) => job.id === JOB.id),
    journalText: async () => JSON.stringify(await stores.journal.list({})),
    setClock: (iso: string) => {
      clock = Date.parse(iso);
    },
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

function oldReport(text: string, reportId: string, extra: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    type: 'report',
    managerId: JOB.id,
    reportId,
    status: 'done',
    text,
    sessionGeneration: OLD,
    ...extra,
  } as RunnerEvent;
}

describe('起こし直した新しいセッションが黙っている間の、古いセッションの報告（#5195）', () => {
  it('⭐ 新しい世代がまだ何も出していなければ、古い世代の報告を捨てずに配る。台帳の status は書き換えない', async () => {
    const h = await harness();
    await h.runner.emit(oldReport('#4184 を出し直した。完遂。', 'r-1402'));
    await h.settle();

    const inbox = h.inboxText();
    expect(inbox).toContain('#4184 を出し直した。完遂。');
    expect(inbox).toContain('起こし直す前の古いセッションからの報告');
    const job = await h.job();
    expect(job?.lastReport).toBe('#4184 を出し直した。完遂。');
    expect(job?.lastReportStatus).toBe('done');
    // 台帳が追っているのは新しいセッション: 古い側の done で書き換えない
    expect(job?.status).toBe('running');
    const journal = await h.journalText();
    expect(journal).toContain('捨てずにクローンへ配る（#5195）');
    expect(journal).toContain(`いま追っている世代=${NEW}`);
    expect(journal).not.toContain('古いセッションの出来事のため無視');

    // 同じ報告がもう一度届いても二度は配らない（reportId）
    await h.runner.emit(oldReport('#4184 を出し直した。完遂。', 'r-1402'));
    await h.settle();
    expect(h.inboxText().match(/#4184 を出し直した。完遂。/g)).toHaveLength(1);
    await h.close();
  });

  it('新しい世代が一度でも出来事を出していれば、古い世代の報告は今どおり捨てる', async () => {
    const h = await harness();
    await h.runner.emit({
      type: 'report',
      managerId: JOB.id,
      reportId: 'r-new',
      status: 'running',
      text: '新しいセッションの報告',
      sessionGeneration: NEW,
    });
    await h.settle();
    await h.runner.emit(oldReport('古いセッションの遅れた報告', 'r-old'));
    await h.settle();

    const inbox = h.inboxText();
    expect(inbox).toContain('新しいセッションの報告');
    expect(inbox).not.toContain('古いセッションの遅れた報告');
    expect((await h.job())?.lastReport).toBe('新しいセッションの報告');
    expect(await h.journalText()).toContain('古いセッションの出来事のため無視');
    await h.close();
  });

  it('古い世代の失敗の報告は、新しい世代が黙っていても今どおり捨てる（古い鍵の失敗で枠の印・回転を動かさない）', async () => {
    const h = await harness();
    await h.runner.emit(
      oldReport('429 で落ちた', 'r-fail', {
        failure: { code: 'rate_limit', via: 'result', status: 429 },
      } as Partial<RunnerEvent>),
    );
    await h.settle();

    expect(h.inboxText()).not.toContain('429 で落ちた');
    expect((await h.job())?.lastReport).toBe('13:33Z の失敗');
    expect(await h.journalText()).toContain('古いセッションの出来事のため無視');
    await h.close();
  });

  it('⭐ 捨てられた報告も、ターンの終わりから10分後の見回り（#5200 の受け皿）が生ログから拾ってクローンへ配る', async () => {
    const h = await harness();
    // 新しい世代が一度出来事を出した後の、捨てられる側の形で確かめる
    await h.runner.emit({
      type: 'session',
      managerId: JOB.id,
      sessionId: 'sess-landrule',
      sessionGeneration: NEW,
    } as RunnerEvent);
    await h.settle();
    await h.runner.emit(oldReport('15:19 の完遂の報告', 'r-1519'));
    await h.settle();
    expect(h.inboxText()).not.toContain('15:19 の完遂の報告');

    h.runner.liveTranscript = endTurnLine('15:19 の完遂の報告', '2026-10-23T15:19:38.000Z');
    h.setClock('2026-10-23T15:31:00.000Z');
    await h.pool.probeTurnEnds();
    await h.settle();

    const inbox = h.inboxText();
    expect(inbox).toContain('生ログの末尾から拾って配る');
    expect(inbox).toContain('15:19 の完遂の報告');
    await h.close();
  });
});
