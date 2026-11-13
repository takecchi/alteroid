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
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { AgentToken } from './token-pool.js';
import type { TokenRotatorObservation } from './token-rotator.js';

// 出来事の処理の完了を `phases` へ記す: `report` の処理の完了が何周で戻るかを数えるため（仕組みは test-support の注記）。
const phases: string[] = [];
let settledTracker: { restore(): void } | undefined;
beforeAll(() => {
  settledTracker = trackEventSettled(phases);
});
afterAll(() => {
  settledTracker?.restore();
});

// `Pool#handleEvent` の `case 'report'` の段 2（報告の中身を台帳 `record.job` へ写す同期の段。切り出し前は `Pool` の `#applyReportToJob`、
// いまは `manager-report-apply.ts`）を、外から見える結果だけで縛る: `#persist` が最初に書いた台帳の行（＝この段が書いた値そのもの）・
// 最後の台帳の行・`list()` の枠の印（`usageStopped` の Set の中身）と `resetTimeSkewMatch`（`resetTimeSkewMatches` の Map の中身）・
// 回し手への観測（`markedByFailure` の戻り）・microtask の周回数。
// 期待の値は、切り出し前の作りの出力から生成して目で読んで確かめたもの（仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流してマイクロタスクを流しきる。時計は注入する。

const JOB_ID = 'mgr-report-apply-pin';
const NOW_ISO = '2026-09-14T20:19:00.000Z';
const OLD_ISO = '2026-09-14T00:00:00.000Z';
const RESET_TARGET = Date.parse('2026-09-15T00:30:00.000Z');
const NOTICE_TEXT = "You've hit your session limit · resets 9:30am (Asia/Tokyo)";

const opened: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  phases.length = 0;
  for (const pool of opened.splice(0)) await pool.stop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

/** 前の値が全部載っている台帳: 各欄が「写される」か「下りる」かを見分けるため。 */
const RICH: Partial<Job> = {
  lastReport: '前の報告',
  lastReportAt: OLD_ISO,
  lastReportStatus: 'running',
  lastFoldedTurn: { text: '畳んだ本文', at: OLD_ISO },
  lastSystemError: { code: 'EAGAIN', errno: -11, syscall: 'spawn', at: OLD_ISO },
  lastCgroupEvents: { pidsMaxDelta: 2, oomKillDelta: 1, at: OLD_ISO },
  lastFailure: { code: 'old/500', via: 'result_subtype', at: OLD_ISO },
  lastUnreported: { reason: '前の理由', at: OLD_ISO },
  awaitingBackgroundSince: OLD_ISO,
};

interface Spec {
  job?: Partial<Job>;
  asks?: number;
  sessionAlive?: boolean;
  tokens?: boolean;
  /** 先に枠の通知（`usage_notice`）を流して、枠の印と resets 時刻の突き合わせを立てておく */
  reachedFirst?: boolean;
}

async function open(spec: Spec = {}) {
  let emit = null as ((event: RunnerEvent) => void) | null;
  const alive: RunnerManagerState[] =
    spec.sessionAlive === false
      ? []
      : [
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
  if (spec.tokens === true) {
    const dropped: AgentToken = {
      id: 'tok-08',
      label: 'alteroid08',
      order: 0,
      cooldownUntil: RESET_TARGET,
      cooldownSource: 'quota_reset',
    };
    await stores.tokens.replace([dropped, { id: 'tok-09', label: 'alteroid09', order: 1 }]);
    await stores.tokens.writeActive({
      tokenId: 'tok-09',
      generation: 2,
      rotatedAt: '2026-09-14T20:00:00.000Z',
    });
  }
  const rows: Job[] = [];
  const order: string[] = [];
  const journal = stores.journal;
  const append = journal.append.bind(journal);
  journal.append = (entry) => {
    if (entry.type === 'exchange') order.push('journal');
    return append(entry);
  };
  const jobs = stores.jobs;
  const putJob = jobs.putJob.bind(jobs);
  jobs.putJob = (row) => {
    order.push('put');
    rows.push(structuredClone(row));
    return putJob(row);
  };
  const observations: TokenRotatorObservation[] = [];
  const pool = createManagerPool({
    stores,
    now: () => Date.parse(NOW_ISO),
    post: () => {},
    runners: createRunnerRegistry([runner]),
    onUsageObservation: async (observation) => {
      observations.push(observation);
    },
  });
  opened.push(pool);
  await pool.restore();
  await settle();
  for (let index = 0; index < (spec.asks ?? 0); index += 1) {
    emit?.({
      type: 'ask',
      managerId: JOB_ID,
      requestId: `req-${String(index)}`,
      kind: 'question',
      summary: `確認 ${String(index)}`,
      askedAt: NOW_ISO,
    });
    await settle();
  }
  if (spec.reachedFirst === true) {
    emit?.({
      type: 'usage_notice',
      managerId: JOB_ID,
      notice: { kind: 'reached', text: NOTICE_TEXT },
    } as RunnerEvent);
    await settle();
  }
  const summaryOf = async () => {
    const found = (await pool.list()).find((entry) => entry.managerId === JOB_ID);
    return {
      status: found?.status,
      usageStoppedAt: found?.usageStoppedAt,
      resetTimeSkewMatch: found?.resetTimeSkewMatch,
    };
  };
  const before = {
    summary: await summaryOf(),
    observations: observations.length,
  };
  rows.length = 0;
  order.length = 0;
  observations.length = 0;
  return {
    pool,
    stores,
    before,
    /** 報告を 1 件流し、台帳へ最初に書かれた行・最後の行・一覧の印・回し手への観測を返す。 */
    async report(event: RunnerEvent) {
      emit?.(event);
      await settle();
      const final = await stores.jobs.getJob(JOB_ID);
      return {
        persisted: rows[0],
        final,
        listed: await summaryOf(),
        rotationRequests: observations.map((entry) => entry.notice?.text),
      };
    },
    /** 報告を流した直後から、台帳への書き込みと日誌が初めて成り立つまでの microtask の周回数。 */
    async hops(event: RunnerEvent): Promise<{ put: number; journal: number; settled: number }> {
      const seen = { put: -1, journal: -1, settled: -1 };
      phases.length = 0;
      emit?.(event);
      for (let i = 1; i <= 200; i += 1) {
        await Promise.resolve();
        if (seen.settled < 0 && phases.includes(EVENT_SETTLED)) {
          seen.settled = i - EVENT_SETTLED_LAG;
        }
        if (seen.put < 0 && order.includes('put')) seen.put = i;
        if (seen.journal < 0 && order.includes('journal')) seen.journal = i;
      }
      return seen;
    },
  };
}

function report(
  fields: Partial<Extract<RunnerEvent, { type: 'report' }>> = {},
): Extract<RunnerEvent, { type: 'report' }> {
  return {
    type: 'report',
    managerId: JOB_ID,
    text: '調べ終えた',
    status: 'done',
    ...fields,
  } as Extract<RunnerEvent, { type: 'report' }>;
}

const QUOTA_FAILURE = { code: 'success/429', via: 'result_is_error', status: 429 };
const CRASH_FAILURE = { code: 'error_during_execution', via: 'result_subtype' };

describe('report の段 2（台帳への写し）', () => {
  it('成功した回: 本文を写し、failure・unreported・系の欄・畳んだ本文・背景待ちの印を下ろす。lastReportStatus は名乗った値', async () => {
    const s = await open({ job: RICH });
    const r = await s.report(report());
    expect(r.persisted).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-09-14T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-report-apply-pin",
        "lastReport": "調べ終えた",
        "lastReportAt": "2026-09-14T20:19:00.000Z",
        "lastReportStatus": "done",
        "request": "調べて",
        "runnerId": "runner-primary",
        "sessionId": "sess-1",
        "status": "done",
        "summary": "調べ物",
        "updatedAt": "2026-09-14T20:19:00.000Z",
        "workspace": {
          "kind": "unknown",
          "path": "/work/project",
          "reason": "器の workspace がボリュームかどうかを runner が名乗らないので、入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。",
          "runnerId": "runner-primary",
        },
      }
    `);
    // 最後の行との差は、報告の後で足される未 push の観測（`lastUnpushedWorkObservation`）だけ
    expect(r.final?.lastUnpushedWorkObservation).toMatchObject({ kind: 'unavailable' });
    expect({ ...r.final, lastUnpushedWorkObservation: undefined }).toEqual({
      ...r.persisted,
      lastUnpushedWorkObservation: undefined,
    });
    expect(r.listed).toMatchInlineSnapshot(`
      {
        "resetTimeSkewMatch": undefined,
        "status": "done",
        "usageStoppedAt": undefined,
      }
    `);
  });

  it('fullText が在れば lastReport には全文を残す（配る text ではなく）', async () => {
    const s = await open();
    const r = await s.report(report({ text: '結論', fullText: '途中の発言\n結論' }));
    expect(r.persisted?.lastReport).toBe('途中の発言\n結論');
    expect(r.persisted?.lastReportAt).toBe(NOW_ISO);
  });

  it('failure が在る（枠と無関係なクラッシュ）: lastFailure に code / via / at だけを書く。status は写さない。枠の印は立てず、回し手へも頼まない', async () => {
    const s = await open({ job: RICH });
    const r = await s.report(report({ failure: { ...CRASH_FAILURE, status: 500 } }));
    expect(r.persisted).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-09-14T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-report-apply-pin",
        "lastFailure": {
          "at": "2026-09-14T20:19:00.000Z",
          "code": "error_during_execution",
          "via": "result_subtype",
        },
        "lastReport": "調べ終えた",
        "lastReportAt": "2026-09-14T20:19:00.000Z",
        "lastReportStatus": "done",
        "request": "調べて",
        "runnerId": "runner-primary",
        "sessionId": "sess-1",
        "status": "done",
        "summary": "調べ物",
        "updatedAt": "2026-09-14T20:19:00.000Z",
        "workspace": {
          "kind": "unknown",
          "path": "/work/project",
          "reason": "器の workspace がボリュームかどうかを runner が名乗らないので、入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。",
          "runnerId": "runner-primary",
        },
      }
    `);
    expect(r.listed).toMatchInlineSnapshot(`
      {
        "resetTimeSkewMatch": undefined,
        "status": "done",
        "usageStoppedAt": undefined,
      }
    `);
    expect(r.rotationRequests).toMatchInlineSnapshot(`[]`);
  });

  it('failure が 429（枠）: usageStoppedAt を立て、一覧に印が出て、回し手へ失敗の本文で頼む（markedByFailure = true）', async () => {
    const s = await open({ job: RICH });
    const r = await s.report(report({ failure: QUOTA_FAILURE, text: '応答なし\nAPI Error: 429' }));
    expect(r.persisted).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-09-14T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-report-apply-pin",
        "lastFailure": {
          "at": "2026-09-14T20:19:00.000Z",
          "code": "success/429",
          "via": "result_is_error",
        },
        "lastReport": "応答なし
      API Error: 429",
        "lastReportAt": "2026-09-14T20:19:00.000Z",
        "lastReportStatus": "done",
        "request": "調べて",
        "runnerId": "runner-primary",
        "sessionId": "sess-1",
        "status": "done",
        "summary": "調べ物",
        "updatedAt": "2026-09-14T20:19:00.000Z",
        "usageStoppedAt": "2026-09-14T20:19:00.000Z",
        "workspace": {
          "kind": "unknown",
          "path": "/work/project",
          "reason": "器の workspace がボリュームかどうかを runner が名乗らないので、入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。",
          "runnerId": "runner-primary",
        },
      }
    `);
    expect(r.listed).toMatchInlineSnapshot(`
      {
        "resetTimeSkewMatch": undefined,
        "status": "done",
        "usageStoppedAt": "2026-09-14T20:19:00.000Z",
      }
    `);
    expect(r.rotationRequests).toMatchInlineSnapshot(`
      [
        "API Error: 429",
      ]
    `);
  });

  it('failure が枠の印（assistant_error / rate_limit）でも同じく立てる', async () => {
    const s = await open();
    const r = await s.report(
      report({ failure: { code: 'rate_limit', via: 'assistant_error' }, text: '枠' }),
    );
    expect(r.persisted?.usageStoppedAt).toBe(NOW_ISO);
    expect(r.listed.usageStoppedAt).toBe(NOW_ISO);
    expect(r.rotationRequests).toEqual(['枠']);
  });

  it('すでに印が在る（台帳から組み直した）ときの 429: 印を立て直さない（usageStoppedAt は古いまま）・回し手へ頼まない（markedByFailure = false）', async () => {
    const s = await open({ job: { usageStoppedAt: OLD_ISO } });
    expect(s.before.summary.usageStoppedAt).toBe(OLD_ISO);
    const r = await s.report(report({ failure: QUOTA_FAILURE }));
    expect(r.persisted?.usageStoppedAt).toBe(OLD_ISO);
    expect(r.listed.usageStoppedAt).toBe(OLD_ISO);
    expect(r.rotationRequests).toEqual([]);
  });

  it('印の Set に無いが台帳に usageStoppedAt が残る（後継へ引き継いだ前任）の 429: Set へ足すが、台帳の時刻は ??= で古いまま', async () => {
    const s = await open({ job: { usageStoppedAt: OLD_ISO, supersededBy: 'mgr-successor' } });
    expect(s.before.summary.usageStoppedAt).toBeUndefined();
    const r = await s.report(report({ failure: QUOTA_FAILURE }));
    expect(r.persisted?.usageStoppedAt).toBe(OLD_ISO);
    expect(r.listed.usageStoppedAt).toBe(OLD_ISO);
    expect(r.rotationRequests).toMatchInlineSnapshot(`
      [
        "調べ終えた",
      ]
    `);
  });

  it('成功した回: 枠の印・resets 時刻の突き合わせ・usageStoppedAt を掃除する', async () => {
    const s = await open({ tokens: true, reachedFirst: true });
    expect(s.before.summary.resetTimeSkewMatch).toBe('stale');
    expect(s.before.summary.usageStoppedAt).toBe(NOW_ISO);
    const r = await s.report(report());
    expect(r.persisted?.usageStoppedAt).toBeUndefined();
    expect(Object.hasOwn(r.persisted ?? {}, 'usageStoppedAt')).toBe(false);
    expect(r.listed.usageStoppedAt).toBeUndefined();
    expect(r.listed.resetTimeSkewMatch).toBeUndefined();
    // 台帳の欄は消えているので一覧では Set の中身が見えない: 枠の印が残っていれば鍵の回転の起こし直しの対象に入るので、そちらで見る
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
  });

  it('失敗した回は枠の印も resets 時刻の突き合わせも下ろさない（そこが起こし直したい相手）', async () => {
    const s = await open({ tokens: true, reachedFirst: true });
    const r = await s.report(report({ failure: CRASH_FAILURE }));
    expect(r.persisted?.usageStoppedAt).toBe(NOW_ISO);
    expect(r.listed.usageStoppedAt).toBe(NOW_ISO);
    expect(r.listed.resetTimeSkewMatch).toBe('stale');
  });

  it('unreported が在る: lastUnreported に reason と at を書く（failure とは独立）。status は名乗った値のまま', async () => {
    const s = await open({ job: RICH });
    const r = await s.report(report({ unreported: { reason: '畳む直前の書き出し' } }));
    expect(r.persisted).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-09-14T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-report-apply-pin",
        "lastReport": "調べ終えた",
        "lastReportAt": "2026-09-14T20:19:00.000Z",
        "lastReportStatus": "done",
        "lastUnreported": {
          "at": "2026-09-14T20:19:00.000Z",
          "reason": "畳む直前の書き出し",
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "sessionId": "sess-1",
        "status": "done",
        "summary": "調べ物",
        "updatedAt": "2026-09-14T20:19:00.000Z",
        "workspace": {
          "kind": "unknown",
          "path": "/work/project",
          "reason": "器の workspace がボリュームかどうかを runner が名乗らないので、入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。",
          "runnerId": "runner-primary",
        },
      }
    `);
  });

  it('unreported が在り status が failed / lost: 台帳を終端にしない（running のまま）。lastReportStatus は名乗った値', async () => {
    for (const status of ['failed', 'lost'] as const) {
      const s = await open();
      const r = await s.report(report({ status, unreported: { reason: '畳む直前' } }));
      expect(r.persisted?.status).toBe('running');
      expect(r.persisted?.lastReportStatus).toBe(status);
      expect(r.persisted?.lastUnreported).toEqual({ reason: '畳む直前', at: NOW_ISO });
    }
  });

  it('unreported が無く status が failed / lost: そのまま終端を書く', async () => {
    for (const status of ['failed', 'lost'] as const) {
      const s = await open();
      const r = await s.report(report({ status }));
      expect(r.persisted?.status).toBe(status);
      expect(r.persisted?.lastReportStatus).toBe(status);
    }
  });

  it('closed が書いた終端（failed / lost）を event.status で書き戻さない。他の欄（lastReport など）は写す', async () => {
    for (const status of ['failed', 'lost'] as const) {
      const s = await open({ job: { ...RICH, status }, sessionAlive: false });
      const r = await s.report(report({ status: 'done', text: '遅れて届いた' }));
      expect(r.persisted?.status).toBe(status);
      expect(r.persisted?.lastReport).toBe('遅れて届いた');
      expect(r.persisted?.lastReportAt).toBe(NOW_ISO);
      expect(r.persisted?.lastReportStatus).toBe('done');
      expect(r.persisted?.lastFoldedTurn).toBeUndefined();
      expect(r.persisted?.lastSystemError).toBeUndefined();
      expect(r.persisted?.lastCgroupEvents).toBeUndefined();
      expect(r.final?.status).toBe(status);
    }
  });

  it('終端が確定済みなら waiting_human の補正もしない（failed のまま）', async () => {
    const s = await open({ job: { status: 'failed' }, sessionAlive: false });
    const r = await s.report(report({ status: 'waiting_human' }));
    expect(r.persisted?.status).toBe('failed');
    expect(r.persisted?.lastReportStatus).toBe('waiting_human');
  });

  it('waiting_human と名乗っても waiting が空なら running。名乗った値は lastReportStatus に残る', async () => {
    const s = await open();
    const r = await s.report(report({ status: 'waiting_human' }));
    expect(r.persisted?.status).toBe('running');
    expect(r.persisted?.lastReportStatus).toBe('waiting_human');
  });

  it('waiting_human で waiting が在れば waiting_human のまま', async () => {
    const s = await open({ asks: 1 });
    expect(s.before.summary.status).toBe('waiting_human');
    const r = await s.report(report({ status: 'waiting_human' }));
    expect(r.persisted?.status).toBe('waiting_human');
    expect(r.persisted?.lastReportStatus).toBe('waiting_human');
  });

  it('awaitingBackground が在り status が done: 印を now で立てる', async () => {
    const s = await open({ job: { awaitingBackgroundSince: OLD_ISO } });
    const r = await s.report(report({ awaitingBackground: { count: 2, breakdown: 'bash x2' } }));
    expect(r.persisted?.status).toBe('done');
    expect(r.persisted?.awaitingBackgroundSince).toBe(NOW_ISO);
  });

  it('awaitingBackground が在っても status が done にならない（running / 畳み待ちの failed / 終端確定済み / 補正後）なら印は下ろす', async () => {
    const awaiting = { count: 1, breakdown: 'bash' };
    const running = await open({ job: { awaitingBackgroundSince: OLD_ISO } });
    const r1 = await running.report(report({ status: 'running', awaitingBackground: awaiting }));
    expect(r1.persisted?.awaitingBackgroundSince).toBeUndefined();

    const deferred = await open({ job: { awaitingBackgroundSince: OLD_ISO } });
    const r2 = await deferred.report(
      report({
        status: 'failed',
        unreported: { reason: '畳む直前' },
        awaitingBackground: awaiting,
      }),
    );
    expect(r2.persisted?.awaitingBackgroundSince).toBeUndefined();

    const settled = await open({
      job: { status: 'failed', awaitingBackgroundSince: OLD_ISO },
      sessionAlive: false,
    });
    const r3 = await settled.report(report({ awaitingBackground: awaiting }));
    expect(r3.persisted?.status).toBe('failed');
    expect(r3.persisted?.awaitingBackgroundSince).toBeUndefined();
  });

  it('awaitingBackground が無い報告: 印を下ろす（欄ごと無い）', async () => {
    // 前の値は status が done の台帳にだけ残る（done 以外へ動く書き込みは `#persist` が下ろすので、running から始めると前の値が先に消えて見分けられない）
    // 生きたセッションが居ると、起動時の取り直しが `running` へ戻して前の値を下ろす: 居ない形で起こす
    const s = await open({
      job: { status: 'done', awaitingBackgroundSince: OLD_ISO },
      sessionAlive: false,
    });
    expect((await s.stores.jobs.getJob(JOB_ID))?.awaitingBackgroundSince).toBe(OLD_ISO);
    const r = await s.report(report());
    expect(Object.hasOwn(r.persisted ?? {}, 'awaitingBackgroundSince')).toBe(false);
  });

  it('停止済み: 段 2 は通らない（status・lastReport などは動かさず、畳んだ本文だけを残す）', async () => {
    const s = await open({
      job: { ...RICH, status: 'stopped' },
      sessionAlive: false,
    });
    const r = await s.report(report({ text: '停止後に届いた', failure: QUOTA_FAILURE }));
    expect(r.persisted).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-09-14T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-report-apply-pin",
        "lastCgroupEvents": {
          "at": "2026-09-14T00:00:00.000Z",
          "oomKillDelta": 1,
          "pidsMaxDelta": 2,
        },
        "lastFailure": {
          "at": "2026-09-14T00:00:00.000Z",
          "code": "old/500",
          "via": "result_subtype",
        },
        "lastFoldedTurn": {
          "at": "2026-09-14T20:19:00.000Z",
          "text": "停止後に届いた",
        },
        "lastReport": "前の報告",
        "lastReportAt": "2026-09-14T00:00:00.000Z",
        "lastReportStatus": "running",
        "lastSystemError": {
          "at": "2026-09-14T00:00:00.000Z",
          "code": "EAGAIN",
          "errno": -11,
          "syscall": "spawn",
        },
        "lastUnreported": {
          "at": "2026-09-14T00:00:00.000Z",
          "reason": "前の理由",
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "sessionId": "sess-1",
        "status": "stopped",
        "summary": "調べ物",
        "updatedAt": "2026-09-14T20:19:00.000Z",
      }
    `);
    expect(r.listed).toMatchInlineSnapshot(`
      {
        "resetTimeSkewMatch": undefined,
        "status": "stopped",
        "usageStoppedAt": undefined,
      }
    `);
    expect(r.rotationRequests).toMatchInlineSnapshot(`[]`);
  });
});

describe('microtask の周回数（呼び元の await の段を数える歯）', () => {
  // 協力者へ移したあと、呼び元で `await` で包む・`persist` の後ろへ動かす・口を `async` で包む・`await` を足す／減らすと、ここの数が変わる。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('成功の報告: 台帳の書き込み・日誌・処理の完了までの周回数', async () => {
    const s = await open({ job: RICH });
    expect(await s.hops(report())).toMatchInlineSnapshot(`
      {
        "journal": 4,
        "put": 1,
        "settled": 12,
      }
    `);
    await s.pool.stop();
  });

  it('429 の報告（枠の印を立てる回）: 同じ周回数', async () => {
    const s = await open({ job: RICH });
    expect(await s.hops(report({ failure: QUOTA_FAILURE }))).toMatchInlineSnapshot(`
      {
        "journal": 4,
        "put": 1,
        "settled": 16,
      }
    `);
    await s.pool.stop();
  });
});
