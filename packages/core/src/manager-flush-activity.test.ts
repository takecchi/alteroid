import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';


interface FlushRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  setTranscript(managerId: string, body: string | null): void;
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: {
      awaitingBackground?: { count: number; breakdown: string };
      reportId?: string;
    },
  ): void;
}

function flushRunner(runnerId = 'runner-primary'): FlushRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const transcripts = new Map<string, string | null>();

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
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
    async transcript(managerId) {
      return transcripts.get(managerId) ?? null;
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
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    alive,
    setTranscript(managerId, body) {
      transcripts.set(managerId, body);
    },
    report(managerId, text, status, fields = {}) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: FlushRunner;
  advance: (ms: number) => void;
}

const START = '2026-09-01T00:00:00.000Z';

async function setup(managerId = 'mgr-flush'): Promise<Setup> {
  const job: Job = {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = flushRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  let clock = Date.parse(START);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake, advance: (ms) => (clock += ms) };
}

const PAST_QUIET_GATE_MS = 11 * 60_000;
const WITHHELD_REPORT_FLUSH_MS = 30 * 60_000;

const AWAITING = { count: 1, breakdown: 'shell×1' };

function assistantTextLine(
  text: string,
  options: { timestamp?: string; stopReason?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: options.timestamp ?? '2026-08-28T08:00:00.000Z',
    message: {
      role: 'assistant',
      id: 'msg_flush',
      content: [{ type: 'text', text }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

function assistantToolUseLine(
  toolUses: { id: string; name?: string }[],
  options: { timestamp?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: options.timestamp ?? '2026-08-28T08:00:00.000Z',
    message: {
      role: 'assistant',
      id: 'msg_flush_stall',
      content: toolUses.map((entry) => ({
        type: 'tool_use',
        id: entry.id,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        input: {},
      })),
      stop_reason: 'tool_use',
    },
  });
}

async function lastDeliveredText(inbox: InboxEvent[], marker: string): Promise<string> {
  return (
    await vi.waitFor(() => {
      const found = inbox.filter((event) => event.type === 'manager_message').at(-1) as
        { text: string } | undefined;
      if (!found || !found.text.includes(marker)) throw new Error('まだ届いていない');
      return found;
    })
  ).text;
}

describe('flushWithheldReports が配る文面に、manager_list と同じ判定（classifyManagerActivity）を添える', () => {
  it('止まっている（ターン終わり型）: probe が stalled を残した状態で report → flush すると ⚠ が付く', async () => {
    const { pool, fake, advance, inbox } = await setup();

    // probe は running のうちに行う: `probeTurnEnds` は running の委譲だけを対象にし、report で done へ移ると旗が凍る。timestamp は実時計に依存しないよう遠い未来に固定する。
    fake.setTranscript(
      'mgr-flush',
      assistantTextLine('本文', { timestamp: '2099-01-01T00:00:00.000Z', stopReason: 'end_turn' }),
    );
    advance(PAST_QUIET_GATE_MS);
    await pool.probeTurnEnds();

    fake.report('mgr-flush', '完了を待つ', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).toContain('⚠');
    expect(text).toContain('#567');

    await pool.stop();
  });

  it('止まっている（道具待ち型）: waiting が空のまま tool_use が固定された状態で report → flush すると ⚠ が付く', async () => {
    const { pool, fake, advance, inbox } = await setup();

    fake.setTranscript(
      'mgr-flush',
      assistantToolUseLine([{ id: 'toolu_1', name: 'AskUserQuestion' }]),
    );
    advance(PAST_QUIET_GATE_MS);
    await pool.probeTurnEnds();

    fake.report('mgr-flush', '完了を待つ', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).toContain('⚠');
    expect(text).toContain('#572');

    await pool.stop();
  });

  it('進んでいる／正常な待ち: probe が「正常に終わった」を残した状態で flush すると ⚠ は付かず、「進んでいる」の行が載る', async () => {
    const { pool, fake, advance, inbox } = await setup();

    // `job.lastReportAt` は実時計で書かれるので、timestamp は実行時刻に依存しないよう遠い過去に固定する。
    fake.setTranscript(
      'mgr-flush',
      assistantTextLine('本文', { timestamp: '2000-01-01T00:00:00.000Z', stopReason: 'end_turn' }),
    );
    advance(PAST_QUIET_GATE_MS);
    await pool.probeTurnEnds();

    fake.report('mgr-flush', '完了を待つ', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).not.toContain('⚠');
    expect(text).not.toContain('判定できない');
    expect(text).toContain('進んでいる');

    await pool.stop();
  });

  it('判定できない: 一度も probe されていない（record はあるが観測が無い）と「判定できない」が付く', async () => {
    const { pool, fake, advance, inbox } = await setup();

    fake.report('mgr-flush', '完了を待つ', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).toContain('判定できない');
    expect(text).not.toContain('⚠');

    await pool.stop();
  });

  // 「台帳に record が無い」ケースは書かない: `#retire()` が `#records` と `#withheldReports` を同じ呼び出しで消すので、公開 API だけからは作れない。
});

describe('flushWithheldReports の文面には240文字抜粋が無く、件数・firstAt/lastAt・journal_read の案内は残る', () => {
  it('抜粋（「最後の1本の冒頭」）は付かない', async () => {
    const { pool, fake, advance, inbox } = await setup();

    const longText = 'あ'.repeat(500);
    fake.report('mgr-flush', longText, 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).not.toContain('最後の1本の冒頭');
    expect(text).not.toContain(longText);

    await pool.stop();
  });

  it('件数・firstAt/lastAt・journal_read の案内は残る', async () => {
    const { pool, fake, advance, inbox } = await setup();

    fake.report('mgr-flush', '本文', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).toContain('背景処理の完了待ちで畳んだターンの報告を 1 本配っていない');
    expect(text).toContain('最初');
    expect(text).toContain('最後');
    expect(text).toContain('journal_read');

    await pool.stop();
  });
});
