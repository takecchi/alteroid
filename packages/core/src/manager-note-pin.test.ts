import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  EVENT_SETTLED,
  EVENT_SETTLED_LAG,
  trackEventSettled,
} from './manager-event-settled.test-support.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 出来事の処理の完了を `phases` へ記す: `note` の処理の完了が何周で戻るかを数えるため（仕組みは test-support の注記）。
const phases: string[] = [];
let settledTracker: { restore(): void } | undefined;
beforeAll(() => {
  settledTracker = trackEventSettled(phases);
});
afterAll(() => {
  settledTracker?.restore();
});

// `Pool#handleEvent` の `case 'note'` が呼ぶ 3 つの段（`#markWorkerLimitStopped`・`#journalNote`・`#emitNoteNotices`。
// 切り出し前は `Pool` の中、いまは `manager-note.ts`）を、外から見える結果だけで縛る:
// 日誌の行の全文（reply の exchange／subagent_stall の欄）・受信箱の知らせの全文と欄・台帳の `workerLimitStopped`・
// 印の Map（`resumeStoppedByUsage` が読む側）・`list()` の `tokenGeneration`・microtask の周回数。
// 期待の値は、切り出し前の作りの出力から生成して目で読んで確かめたもの（仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流してマイクロタスクを流しきる。時計は注入する。

const JOB_ID = 'mgr-note-pin';
const NOW_ISO = '2026-11-02T03:04:05.000Z';
const TURN_STARTED_AT = '2026-11-02T03:00:00.000Z';
const OLD_ISO = '2026-11-02T00:00:00.000Z';
const SESSION_LIMIT =
  "You've hit your session limit · resets 12:20am (Asia/Tokyo) · /extra-usage to continue";

const opened: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  phases.length = 0;
  for (const pool of opened.splice(0)) await pool.stop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

interface Spec {
  job?: Partial<Job>;
  /** 担当の鍵の世代（`tokenIdentity`）を与える。与えないと `#rememberTokenIdentity` は何も覚えない */
  generation?: number;
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

async function open(spec: Spec = {}) {
  let emit = null as ((event: RunnerEvent) => void) | null;
  const alive: RunnerManagerState[] = [
    {
      liveBackgroundTasks: 0,
      managerId: JOB_ID,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-1',
    },
  ];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent;
    },
    async resume(command): Promise<{ cwd: string }> {
      alive.push({
        liveBackgroundTasks: 0,
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: OLD_ISO,
    updatedAt: OLD_ISO,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...spec.job,
  });
  // 台帳・日誌・鍵のプール・受信箱の「最初に成り立った順」を控える（呼び元の await の並びを数えるため）
  const order: string[] = [];
  const rows: Job[] = [];
  const journal = stores.journal;
  const append = journal.append.bind(journal);
  journal.append = (entry) => {
    if (entry.type === 'exchange' || entry.type === 'subagent_stall') order.push('journal');
    return append(entry);
  };
  const jobs = stores.jobs;
  const putJob = jobs.putJob.bind(jobs);
  jobs.putJob = (row) => {
    order.push('put');
    rows.push(structuredClone(row));
    return putJob(row);
  };
  const tokens = stores.tokens;
  const listTokens = tokens.list.bind(tokens);
  tokens.list = () => {
    order.push('tokens');
    return listTokens();
  };
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    now: () => Date.parse(NOW_ISO),
    post: (event) => {
      order.push('emit');
      inbox.push(event);
    },
    runners: createRunnerRegistry([runner]),
    ...(spec.generation === undefined
      ? {}
      : { tokenIdentity: () => ({ tokenId: 'tok-7', generation: spec.generation as number }) }),
  });
  opened.push(pool);
  await pool.restore();
  await settle();
  inbox.length = 0;
  order.length = 0;
  rows.length = 0;
  const journalBefore = (await stores.journal.list({ types: ['exchange', 'subagent_stall'] }))
    .length;
  return {
    pool,
    stores,
    /** note を 1 件流し、日誌・受信箱・台帳・印の Map の観測を返す。 */
    async note(fields: Partial<NoteEvent>) {
      emit?.({ type: 'note', managerId: JOB_ID, text: 'T', ...fields } as RunnerEvent);
      await settle();
      const entries = (await stores.journal.list({ types: ['exchange', 'subagent_stall'] }))
        .reverse()
        .slice(journalBefore);
      const lines = entries.map((entry) =>
        Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'at')),
      );
      const final = await stores.jobs.getJob(JOB_ID);
      return {
        lines,
        notices: inbox
          .filter((event) => event.type === 'manager_message')
          .map((event) => ({ ...event, id: 'ID' })),
        ledger: {
          workerLimitStopped: final?.workerLimitStopped,
          turnStartedAt: final?.turnStartedAt,
        },
        persisted: rows.map((row) => ({
          workerLimitStopped: row.workerLimitStopped,
          updatedAt: row.updatedAt,
        })),
      };
    },
    /** note を流した直後から、各段が初めて成り立つまでの microtask の周回数と、成り立った順。 */
    async hops(fields: Partial<NoteEvent>) {
      const seen: Record<string, number> = {
        put: -1,
        tokens: -1,
        journal: -1,
        emit: -1,
        settled: -1,
      };
      phases.length = 0;
      order.length = 0;
      emit?.({ type: 'note', managerId: JOB_ID, text: 'T', ...fields } as RunnerEvent);
      let seenOrder = 0;
      const sequence: string[] = [];
      for (let i = 1; i <= 200; i += 1) {
        await Promise.resolve();
        if (seen['settled'] === -1 && phases.includes(EVENT_SETTLED)) {
          seen['settled'] = i - EVENT_SETTLED_LAG;
        }
        for (; seenOrder < order.length; seenOrder += 1) {
          const label = order[seenOrder] as string;
          if (seen[label] === -1) seen[label] = i;
          sequence.push(`${label}@${String(i)}`);
        }
      }
      return { seen, sequence };
    },
    /** ターンの終わり（担当が `done` になる）。印の Map は `done` の担当にだけ効く */
    async done(): Promise<void> {
      emit?.({
        type: 'report',
        managerId: JOB_ID,
        text: '終わった',
        status: 'done',
      } as RunnerEvent);
      await settle();
    },
    /** 印の Map の観測: 担当を起こす掃き（`resumeStoppedByUsage`）が拾うか */
    async resume(): Promise<string[]> {
      return this.pool.resumeStoppedByUsage();
    },
    async tokenGeneration(): Promise<number | undefined> {
      return (await pool.list()).find((entry) => entry.managerId === JOB_ID)?.tokenGeneration;
    },
  };
}

const STALL = {
  agentId: 'agent-1',
  agentType: 'worker',
  ownedTaskCount: 1,
  sessionTaskCount: 2,
  wakeupCount: 1,
  outcome: 'woken',
} as const;

describe('note の日誌（#journalNote）', () => {
  it('stall 無し: reply の exchange（manager / inbound）。本文は `[managerId] text` で、escalate・notifyClone の有無で変えない', async () => {
    const s = await open();
    const plain = await s.note({ text: '旧 runner の note' });
    expect(plain.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 旧 runner の note",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
    const both = await s.note({ text: '両方立てた note', escalate: true, notifyClone: true });
    expect(both.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 旧 runner の note",
          "type": "exchange",
          "with": "manager",
        },
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 両方立てた note",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
  });

  it('stall 有り: subagent_stall の行。欄がそのまま渡り、text は `[managerId] event.text`（exchange は書かない）', async () => {
    const s = await open();
    const out = await s.note({ text: '起こし直した（1回目 / 上限 2）。', stall: STALL });
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "agentId": "agent-1",
          "agentType": "worker",
          "outcome": "woken",
          "ownedTaskCount": 1,
          "sessionTaskCount": 2,
          "text": "[mgr-note-pin] 起こし直した（1回目 / 上限 2）。",
          "type": "subagent_stall",
          "wakeupCount": 1,
        },
      ]
    `);
    expect(out.notices).toMatchInlineSnapshot(`[]`);
  });

  it('stall 有りで agentType が無ければ欄ごと無い。escalate を伴っても行は同じ', async () => {
    const s = await open();
    const out = await s.note({
      text: '起こし直さなかった',
      escalate: true,
      stall: {
        agentId: 'agent-1',
        ownedTaskCount: 1,
        sessionTaskCount: 2,
        wakeupCount: 1,
        outcome: 'limit_reached',
      },
    });
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "agentId": "agent-1",
          "outcome": "limit_reached",
          "ownedTaskCount": 1,
          "sessionTaskCount": 2,
          "text": "[mgr-note-pin] 起こし直さなかった",
          "type": "subagent_stall",
          "wakeupCount": 1,
        },
      ]
    `);
    expect(Object.keys(out.lines[0] ?? {})).not.toContain('agentType');
  });

  it('stall 有りでも workerLimit が在れば、subagent_stall の text には鍵の突き合わせの行は載らない（event.text のまま）', async () => {
    const s = await open();
    const out = await s.note({
      text: '落ちた',
      stall: STALL,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: false },
    });
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "agentId": "agent-1",
          "agentType": "worker",
          "outcome": "woken",
          "ownedTaskCount": 1,
          "sessionTaskCount": 2,
          "text": "[mgr-note-pin] 落ちた",
          "type": "subagent_stall",
          "wakeupCount": 1,
        },
      ]
    `);
  });
});

describe('note の知らせ（#emitNoteNotices）', () => {
  it('escalate: クローンへの report の全文（詳細は event.text。notifyClone は付けない）', async () => {
    const s = await open();
    const out = await s.note({
      text: '上限（2回）に達したため、起こし直さなかった',
      escalate: true,
    });
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 作業者が自分で起こした背景処理を残したまま畳もうとする回が、背景処理の完了を待つ上限（30分）に達して打ち切った。**この作業者は自動では再開しない**（委譲がここで止まっている）。
      詳細（何が残っているか・何回目だったか）: 上限（2回）に達したため、起こし直さなかった
      全件は日誌に残っている（\`journal_read\` で辿れる）。",
          "type": "manager_message",
        },
      ]
    `);
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 上限（2回）に達したため、起こし直さなかった",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
  });

  it('notifyClone: report の全文（本文は `[managerId] text`）。escalate は付けない', async () => {
    const s = await open();
    const out = await s.note({ text: '退避 ref の探索が途中で止まった', notifyClone: true });
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 退避 ref の探索が途中で止まった",
          "type": "manager_message",
        },
      ]
    `);
  });

  it('escalate と notifyClone の両方: escalate の知らせ → notifyClone の知らせの順に 2 本', async () => {
    const s = await open();
    const out = await s.note({ text: '両方', escalate: true, notifyClone: true });
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 作業者が自分で起こした背景処理を残したまま畳もうとする回が、背景処理の完了を待つ上限（30分）に達して打ち切った。**この作業者は自動では再開しない**（委譲がここで止まっている）。
      詳細（何が残っているか・何回目だったか）: 両方
      全件は日誌に残っている（\`journal_read\` で辿れる）。",
          "type": "manager_message",
        },
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 両方",
          "type": "manager_message",
        },
      ]
    `);
  });

  // 畳んで配っていない報告の在庫を抱えた担当の note: 知らせの末尾へ「配っていない」旨が付き、在庫は配り切った状態へ進む（'full'。'flush' なら在庫を残す）。
  // `emit` の第 6 引数（`withheldSuffixDetail`）の値は、ここでしか外から見えない。
  const WITHHELD = {
    count: 2,
    firstAt: '2026-11-02T02:00:00.000Z',
    lastAt: '2026-11-02T02:30:00.000Z',
    excerpts: [{ at: '2026-11-02T02:30:00.000Z', line: '畳んだ報告の冒頭' }],
    breakdown: 'b',
    taskCount: 1,
  };

  it('notifyClone: 抱えている在庫は知らせの末尾へ付いて配り切られる（台帳の写しも消える）', async () => {
    const s = await open({ job: { withheldReports: WITHHELD } });
    const out = await s.note({ text: '退避から漏れた', notifyClone: true });
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 退避から漏れた

      （この間に、背景処理の完了待ちで畳んだターンの報告を 2 本配っていない（最初 2026-11-02T02:00:00.000Z / 最後 2026-11-02T02:30:00.000Z）。全文は日誌に在る（\`journal_read q=mgr-note-pin\` since=最初の少し前 until=最後の少し後）。
      畳んだ報告の冒頭（古い順）:
      （古い 1 本の冒頭は字数の予算で省いた。全文は日誌に在る（\`journal_read\`））
      - 2026-11-02T02:30:00.000Z 畳んだ報告の冒頭
      ）",
          "type": "manager_message",
        },
      ]
    `);
    expect((await s.stores.jobs.getJob(JOB_ID))?.withheldReports).toMatchInlineSnapshot(
      `undefined`,
    );
  });

  it('escalate: 抱えている在庫は escalate の知らせの末尾へ付いて配り切られ、続く notifyClone の知らせには付かない', async () => {
    const s = await open({ job: { withheldReports: WITHHELD } });
    const out = await s.note({ text: '両方', escalate: true, notifyClone: true });
    expect(
      out.notices.map((notice) => (notice as { text: string }).text.includes('配っていない')),
    ).toEqual([true, false]);
    expect((await s.stores.jobs.getJob(JOB_ID))?.withheldReports).toMatchInlineSnapshot(
      `undefined`,
    );
  });

  it('どちらも無い note: 日誌にだけ残り、受信箱へは何も上がらない。escalate: false も同じ（=== true だけが効く）', async () => {
    const s = await open();
    const none = await s.note({ text: '静かな note' });
    expect(none.notices).toEqual([]);
    const falsy = await s.note({ text: '偽の欄', escalate: false });
    expect(falsy.notices).toEqual([]);
    expect(falsy.lines).toHaveLength(2);
  });
});

describe('作業者の落ち（workerLimit）', () => {
  it('workerLimit 有り: 台帳へ印を写し（turnStartedAt はいまのターンの開始）、日誌と知らせの両方に同じ鍵の突き合わせの行が載る', async () => {
    const s = await open({ job: { turnStartedAt: TURN_STARTED_AT } });
    const out = await s.note({
      text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
      notifyClone: true,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: true },
    });
    expect(out.ledger).toMatchInlineSnapshot(`
      {
        "turnStartedAt": "2026-11-02T03:00:00.000Z",
        "workerLimitStopped": {
          "preRotationKey": true,
          "turnStartedAt": "2026-11-02T03:00:00.000Z",
        },
      }
    `);
    expect(out.persisted).toMatchInlineSnapshot(`
      [
        {
          "updatedAt": "2026-11-02T03:04:05.000Z",
          "workerLimitStopped": {
            "preRotationKey": true,
            "turnStartedAt": "2026-11-02T03:00:00.000Z",
          },
        },
      ]
    `);
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 作業者（tool_use toolu-1）だけが利用上限で落ちた。
      鍵の突き合わせ: 原文の resets（2026-11-02T15:20:00.000Z）に一致する鍵の枠は、プールの記録に無い。どの鍵のものかは言えない。",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 作業者（tool_use toolu-1）だけが利用上限で落ちた。
      鍵の突き合わせ: 原文の resets（2026-11-02T15:20:00.000Z）に一致する鍵の枠は、プールの記録に無い。どの鍵のものかは言えない。",
          "type": "manager_message",
        },
      ]
    `);
    const line = (out.lines[0] as { text: string }).text;
    const notice = (out.notices[0] as { text: string }).text;
    expect(line.split('\n').at(-1)).toBe(notice.split('\n').at(-1));
  });

  it('workerLimit 有り・escalate: 知らせの詳細は event.text のまま（鍵の行は足さない）。日誌は鍵の行つき', async () => {
    const s = await open({ job: { turnStartedAt: TURN_STARTED_AT } });
    const out = await s.note({
      text: '作業者が落ちた',
      escalate: true,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: false },
    });
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 作業者が自分で起こした背景処理を残したまま畳もうとする回が、背景処理の完了を待つ上限（30分）に達して打ち切った。**この作業者は自動では再開しない**（委譲がここで止まっている）。
      詳細（何が残っているか・何回目だったか）: 作業者が落ちた
      全件は日誌に残っている（\`journal_read\` で辿れる）。",
          "type": "manager_message",
        },
      ]
    `);
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 作業者が落ちた
      鍵の突き合わせ: 原文の resets（2026-11-02T15:20:00.000Z）に一致する鍵の枠は、プールの記録に無い。どの鍵のものかは言えない。",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
    expect(out.ledger).toMatchInlineSnapshot(`
      {
        "turnStartedAt": "2026-11-02T03:00:00.000Z",
        "workerLimitStopped": {
          "preRotationKey": false,
          "turnStartedAt": "2026-11-02T03:00:00.000Z",
        },
      }
    `);
  });

  it('workerLimit 無し: 台帳へ印を書かず、永続化もしない。鍵の行も足さない', async () => {
    const s = await open({ job: { turnStartedAt: TURN_STARTED_AT } });
    const out = await s.note({ text: '落ちではない note', notifyClone: true });
    expect(out.ledger).toMatchInlineSnapshot(`
      {
        "turnStartedAt": "2026-11-02T03:00:00.000Z",
        "workerLimitStopped": undefined,
      }
    `);
    expect(out.persisted).toEqual([]);
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 落ちではない note",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
    expect(out.notices).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-11-02T03:04:05.000Z",
          "id": "ID",
          "kind": "report",
          "managerId": "mgr-note-pin",
          "statusAtDelivery": "running",
          "text": "[mgr-note-pin] 落ちではない note",
          "type": "manager_message",
        },
      ]
    `);
  });

  it('印の Map: 立った担当は resumeStoppedByUsage が拾い（preRotationKey の真偽によらず）、無い担当は拾わない', async () => {
    const withMark = await open({ job: { turnStartedAt: TURN_STARTED_AT } });
    await withMark.note({ workerLimit: { raw: SESSION_LIMIT, preRotationKey: false } });
    await withMark.done();
    expect(await withMark.resume()).toEqual([JOB_ID]);

    const noMark = await open({ job: { turnStartedAt: TURN_STARTED_AT } });
    await noMark.note({ text: '落ちではない note', notifyClone: true });
    await noMark.done();
    expect(await noMark.resume()).toEqual([]);
  });

  it('台帳の turnStartedAt が無い担当: 印の turnStartedAt も無い（undefined を写す）', async () => {
    const s = await open();
    const out = await s.note({ workerLimit: { raw: SESSION_LIMIT, preRotationKey: true } });
    expect(out.ledger).toMatchInlineSnapshot(`
      {
        "turnStartedAt": undefined,
        "workerLimitStopped": {
          "preRotationKey": true,
          "turnStartedAt": undefined,
        },
      }
    `);
    expect(out.persisted).toMatchInlineSnapshot(`
      [
        {
          "updatedAt": "2026-11-02T03:04:05.000Z",
          "workerLimitStopped": {
            "preRotationKey": true,
            "turnStartedAt": undefined,
          },
        },
      ]
    `);
  });

  it('枠で止まった担当の印（usageStoppedAt）は立てない（#4903）', async () => {
    const s = await open({ job: { status: 'done' } });
    const out = await s.note({ workerLimit: { raw: SESSION_LIMIT, preRotationKey: true } });
    expect((await s.stores.jobs.getJob(JOB_ID))?.usageStoppedAt).toBeUndefined();
    expect(out.ledger.workerLimitStopped).toBeDefined();
  });
});

describe('世代の添え方と tokenRotation', () => {
  it('作業者の落ち（notifyClone・workerLimit）で、覚えた世代があれば movedFromGeneration を付ける', async () => {
    const s = await open({ generation: 7 });
    await s.note({ text: '開き直した', tokenRotation: true });
    expect(await s.tokenGeneration()).toBe(7);
    const out = await s.note({
      text: '作業者が落ちた',
      notifyClone: true,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: true },
    });
    expect(out.notices.at(-1)).toMatchInlineSnapshot(`
      {
        "at": "2026-11-02T03:04:05.000Z",
        "foldWhenBack": {
          "movedFromGeneration": 7,
        },
        "id": "ID",
        "kind": "report",
        "managerId": "mgr-note-pin",
        "statusAtDelivery": "running",
        "text": "[mgr-note-pin] 作業者が落ちた
      鍵の突き合わせ: 原文の resets（2026-11-02T15:20:00.000Z）に一致する鍵の枠は、プールの記録に無い。どの鍵のものかは言えない。",
        "type": "manager_message",
      }
    `);
  });

  it('覚えた世代が無ければ付けない（tokenRotation の note を流していない）', async () => {
    const s = await open({ generation: 7 });
    expect(await s.tokenGeneration()).toBeUndefined();
    const out = await s.note({
      text: '作業者が落ちた',
      notifyClone: true,
      workerLimit: { raw: SESSION_LIMIT, preRotationKey: true },
    });
    expect(out.notices.at(-1)).toMatchInlineSnapshot(`
      {
        "at": "2026-11-02T03:04:05.000Z",
        "id": "ID",
        "kind": "report",
        "managerId": "mgr-note-pin",
        "statusAtDelivery": "running",
        "text": "[mgr-note-pin] 作業者が落ちた
      鍵の突き合わせ: 原文の resets（2026-11-02T15:20:00.000Z）に一致する鍵の枠は、プールの記録に無い。どの鍵のものかは言えない。",
        "type": "manager_message",
      }
    `);
  });

  it('作業者の落ちでない notifyClone の note には、世代を覚えていても付けない', async () => {
    const s = await open({ generation: 7 });
    await s.note({ text: '開き直した', tokenRotation: true });
    const out = await s.note({ text: '退避から漏れた', notifyClone: true });
    expect(out.notices.at(-1)).toMatchInlineSnapshot(`
      {
        "at": "2026-11-02T03:04:05.000Z",
        "id": "ID",
        "kind": "report",
        "managerId": "mgr-note-pin",
        "statusAtDelivery": "running",
        "text": "[mgr-note-pin] 退避から漏れた",
        "type": "manager_message",
      }
    `);
  });

  it('tokenRotation: true だけが世代を覚えさせる（無しは覚えない）。覚えさせる note 自体は日誌に残り、知らせは出ない', async () => {
    const s = await open({ generation: 7 });
    await s.note({ text: '偽' });
    expect(await s.tokenGeneration()).toBeUndefined();
    const out = await s.note({ text: '開き直した', tokenRotation: true });
    expect(await s.tokenGeneration()).toBe(7);
    expect(out.lines).toMatchInlineSnapshot(`
      [
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 偽",
          "type": "exchange",
          "with": "manager",
        },
        {
          "role": "inbound",
          "text": "[応答] [mgr-note-pin] 開き直した",
          "type": "exchange",
          "with": "manager",
        },
      ]
    `);
    expect(out.notices).toEqual([]);
  });
});

describe('microtask の周回数（case note の await の並びを数える歯）', () => {
  // 協力者へ移したあと、呼び元で `await` で包む・`return` へまとめる・同期の emit を `await` で包む・口を `async` で包む・
  // `await` を足す／減らす・`describeWorkerLimitKey` の呼び位置を動かすと、ここの数と順が変わる。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('workerLimit 無し・notifyClone 有り: 日誌 → 同期の emit → 処理の完了', async () => {
    const s = await open();
    expect(await s.hops({ text: 'T', notifyClone: true })).toMatchInlineSnapshot(`
      {
        "seen": {
          "emit": 3,
          "journal": 1,
          "put": -1,
          "settled": 4,
          "tokens": -1,
        },
        "sequence": [
          "journal@1",
          "emit@3",
        ],
      }
    `);
  });

  it('workerLimit 無し・stall 有り・escalate 有り', async () => {
    const s = await open();
    expect(await s.hops({ text: 'T', escalate: true, stall: STALL })).toMatchInlineSnapshot(`
      {
        "seen": {
          "emit": 3,
          "journal": 1,
          "put": -1,
          "settled": 4,
          "tokens": -1,
        },
        "sequence": [
          "journal@1",
          "emit@3",
        ],
      }
    `);
  });

  it('workerLimit 有り・notifyClone 有り: 印の persist → 鍵のプールの読み取り → 日誌 → 同期の emit → 処理の完了', async () => {
    const s = await open({ job: { turnStartedAt: TURN_STARTED_AT } });
    expect(
      await s.hops({
        text: 'T',
        notifyClone: true,
        workerLimit: { raw: SESSION_LIMIT, preRotationKey: true },
      }),
    ).toMatchInlineSnapshot(`
      {
        "seen": {
          "emit": 10,
          "journal": 7,
          "put": 1,
          "settled": 11,
          "tokens": 4,
        },
        "sequence": [
          "put@1",
          "tokens@4",
          "journal@7",
          "emit@10",
        ],
      }
    `);
  });

  it('どちらも無い note: 日誌 → 処理の完了（emit は無い）', async () => {
    const s = await open();
    expect(await s.hops({ text: 'T' })).toMatchInlineSnapshot(`
      {
        "seen": {
          "emit": -1,
          "journal": 1,
          "put": -1,
          "settled": 4,
          "tokens": -1,
        },
        "sequence": [
          "journal@1",
        ],
      }
    `);
  });
});
