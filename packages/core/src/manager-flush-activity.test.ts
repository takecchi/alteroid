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

/**
 * 台帳 `028ee442` の指摘への直し——`flushWithheldReports()` が配る文面に、
 * `manager_list`（`tools.ts`）と**同じ判定**（`classifyManagerActivity`。
 * `manager-activity.ts`）を添える結線の統合の歯。
 *
 * 純関数そのもの（4状態の網羅・境界）は `manager-activity.test.ts` が持つ。
 * ここで測るのは「`ManagerPool` を実際に回したとき、その判定材料
 * （`this.#records` に積んである `turnEndReason` 等）が正しく flush の文面へ
 * 届くか」——`manager-withheld-reports.test.ts` の `manualRunner` /
 * `runningManualSetup` と同じ足場に、`manager-turn-end.test.ts` /
 * `manager-tool-stall.test.ts` の `setTranscript` を1本のランナーへ合流させて
 * 使う。
 *
 * ## なぜ「止まっている」系の判定材料が、withheld な委譲でも手に入るか
 *
 * `record.turnEndReason` / `record.toolUseStallPending` を書き換えるのは
 * `ManagerPool#probeTurnEnds`（`record.job.status === 'running'` のときだけ）
 * だけである。背景処理待ちの report が届くと `job.status` は `'done'` へ
 * 移るので、それ以降は `probeTurnEnds` に触られない——**旗は running を
 * 離れた時点で凍る**（`tools.ts` の `describeToolUseStall` の doc と同じ
 * 注記）。だからこの歯は「running のうちに probe → その後で report を
 * 起こして done へ落とす → flush する」という順で組む。これは実際の運用
 * でも起こりうる順序である（背景タスクの完了を待っている間に、末尾の
 * assistant 行が長く tool_use のまま固定されることがある）。
 */

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

/**
 * `manager-withheld-reports.test.ts` の `manualRunner` と
 * `manager-turn-end.test.ts` の `TranscriptRunner` を1本へ合流させた最小実装。
 */
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
    async start() {
      /* この検証では使わない */
    },
    async resume() {
      /* この検証では使わない */
    },
    async send() {
      /* この検証では使わない */
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

/** `TURN_END_PROBE_QUIET_MS`（`manager.ts`）を超えて `probeTurnEnds` の費用の門を開く。 */
const PAST_QUIET_GATE_MS = 11 * 60_000;
/** `WITHHELD_REPORT_FLUSH_MS`（`manager.ts` と同じ値）。 */
const WITHHELD_REPORT_FLUSH_MS = 30 * 60_000;

const AWAITING = { count: 1, breakdown: 'shell×1' };

/** JSONL の1行（assistant、本文つき）。 */
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

/** JSONL の1行（assistant、`tool_use` ブロックつき・応答なし）。 */
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

    // running のうちに probe。turnEndedAt を遠い未来に固定し、後で
    // job.lastReportAt（実時計）と比べても必ず「止まっている」側になる
    // ようにする（実行時刻に依存しないテストにするため）。
    fake.setTranscript(
      'mgr-flush',
      assistantTextLine('本文', { timestamp: '2099-01-01T00:00:00.000Z', stopReason: 'end_turn' }),
    );
    advance(PAST_QUIET_GATE_MS);
    await pool.probeTurnEnds();

    // ここで background 待ちの report が届き、status は 'done' へ落ちる
    // （旗は running を離れた時点の値のまま凍る）。
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

  it('進んでいる／正常な待ち: probe が「正常に終わった」を残した状態で flush すると ⚠ は付かない', async () => {
    const { pool, fake, advance, inbox } = await setup();

    // 実時計より確実に過去の timestamp にする——`job.lastReportAt` は
    // `new Date().toISOString()`（実時計）で書かれるので、遠い過去に
    // 固定すれば必ず「turnEndedAt <= lastReportAt」＝進んでいる側になる。
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

    await pool.stop();
  });

  it('判定できない: 一度も probe されていない（record はあるが観測が無い）と「判定できない」が付く', async () => {
    const { pool, fake, advance, inbox } = await setup();
    // **`probeTurnEnds` を一度も呼ばない**——transcript も設定しない。

    fake.report('mgr-flush', '完了を待つ', 'done', { awaitingBackground: AWAITING });
    await new Promise((resolve) => setTimeout(resolve, 20));

    advance(WITHHELD_REPORT_FLUSH_MS + 1);
    await pool.flushWithheldReports();

    const text = await lastDeliveredText(inbox, '配っていない');
    expect(text).toContain('判定できない');
    expect(text).not.toContain('⚠');

    await pool.stop();
  });

  // **「台帳に record が無い」（`this.#records.get(managerId)` が
  // `undefined`）を `ManagerPool` の公開 API だけから作る経路は無い。**
  // `#retire()`（`manager.ts`）が `this.#records.delete(managerId)` と
  // `this.#withheldReports.delete(managerId)` を**同じ呼び出しの中で**
  // 一緒に行うので（doc:「握り潰しの帳面も一緒に畳む」）、`#withheldReports`
  // にだけ積みが残り `#records` から消えている、という状態は作れない。
  // `flushWithheldReports()` 内の `this.#activityInputOfRecord(undefined)`
  // （`{ waitingCount: 0 }` を返し、`classifyManagerActivity` は必ず
  // `'unknown'` に落とす）は防御的な分岐——その入力の判定結果は
  // `manager-activity.test.ts` の「turnEndReason も toolUseStallPending も
  // 無ければ unknown」が既に測っている。ここでは「一度も probe されて
  // いない」（直上の歯）が、公開 API から到達できる「判定できない」の
  // 実例を統合レベルで確認している。
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
