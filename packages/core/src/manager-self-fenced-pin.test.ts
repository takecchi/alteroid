import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobLease } from './schema.js';
import { createMemoryStores } from './testing.js';

// 出来事の処理が終わった印（`#onEvent` の `finally`）だけを控える: `closeSelfFenced` の完了が何周で戻るかを数えるため。見張りの本体は使わない。
const phases = vi.hoisted(() => [] as string[]);
vi.mock('./loop-stall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loop-stall.js')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

// `Pool#handleEvent` の `case 'closed'` のうち、自己失効の `closed`（`selfFenced: true`。切り出し前は `Pool` の `#closeSelfFenced`、
// いまは `manager-self-fenced.ts`）を、外から見える結果（日誌の全文と `with/role`・待ちの取り下げ・台帳の行・貸し出しの返却・
// 受信箱の知らせの全文・書き込みと知らせの順・像を外さないこと・引き取りの挑み直しの予約・microtask の周回数）だけで縛る。
// 期待の文字列は、切り出し前の作りの出力から生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流してマイクロタスクを流しきる。引き取りの挑み直しのタイマーは fake timers で進める。時計は注入する。

const JOB_ID = 'mgr-self-fenced-pin';
const NOW_ISO = '2026-11-01T00:00:00.000Z';
const GRANTED_ISO = '2026-10-31T23:50:00.000Z';
const REATTACH_BASE_MS = 1_000;

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

const LEASE: JobLease = {
  runnerId: 'runner-primary',
  instanceId: 'boot-1',
  fence: 3,
  grantedAt: GRANTED_ISO,
  seenAt: GRANTED_ISO,
  ttlMs: 600_000,
};

/** 台帳の状態 `job` で、待ちを `asks` 件積んだ委譲を作り、`closed` を流せる状態にする。 */
async function open(
  job: Partial<Job> = {},
  asks: { id: string; summary: string }[] = [],
  { sessionAlive = true }: { sessionAlive?: boolean } = {},
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let emit = null as ((event: RunnerEvent) => void) | null;
  let listCalls = 0;
  let sends = 0;
  let resumes = 0;
  // 終端（lost / failed）の台帳は runner に居ない形で起こす: 居ると起動時の取り直しが running へ戻す
  const alive: RunnerManagerState[] = sessionAlive
    ? [
        {
          liveBackgroundTasks: 0,
          managerId: JOB_ID,
          status: 'running',
          cwd: '/work/project',
          request: '調べて',
          waiting: [],
          sessionId: 'sess-1',
        },
      ]
    : [];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent;
    },
    async list() {
      listCalls += 1;
      return [...alive];
    },
    async send() {
      sends += 1;
      return true;
    },
    async resume(command) {
      resumes += 1;
      return { cwd: command.cwd };
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    lease: LEASE,
    ...job,
  });
  // 台帳・日誌・知らせの書き込みを 1 本の列に残す
  const order: string[] = [];
  const journal = stores.journal;
  const append = journal.append.bind(journal);
  journal.append = (entry) => {
    if (entry.type === 'exchange') order.push('journal');
    if (entry.type === 'escalation') order.push('escalation');
    return append(entry);
  };
  const jobs = stores.jobs;
  const putJob = jobs.putJob.bind(jobs);
  jobs.putJob = (row) => {
    order.push(`put:${row.status}/${row.lease?.releasedAt ?? '-'}`);
    return putJob(row);
  };
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    now: () => Date.parse(NOW_ISO),
    post: (event) => {
      order.push('post');
      inbox.push(event);
    },
    runners: createRunnerRegistry([runner]),
  });
  await pool.restore();
  await settle();
  for (const ask of asks) {
    emit?.({
      type: 'ask',
      managerId: JOB_ID,
      requestId: ask.id,
      kind: 'question',
      summary: ask.summary,
      askedAt: NOW_ISO,
    });
    await settle();
  }
  // 像を台帳から作り直させ、外されたかを見る目印（拒否 1 件）を載せる
  emit?.({
    type: 'permission_denied',
    managerId: JOB_ID,
    toolUseId: 'tu-1',
    tool: 'Bash',
    via: 'result',
  });
  await settle();
  expect(pool.denials(JOB_ID)).toHaveLength(1);
  inbox.length = 0;
  order.length = 0;
  listCalls = 0;
  const exchangeBefore = (await stores.journal.list({ types: ['exchange'] })).length;
  const escalationBefore = (await stores.journal.list({ types: ['escalation'] })).length;
  const timersBefore = vi.getTimerCount();
  return {
    pool,
    stores,
    inbox,
    order,
    async push(event: RunnerEvent): Promise<void> {
      emit?.(event);
      await settle();
    },
    /** 出来事を流した直後から、各観測が初めて成り立つまでの microtask の周回数（`await Promise.resolve()` の回数）。 */
    async hops(event: RunnerEvent): Promise<{
      put: number;
      journal: number;
      post: number;
      timer: number;
      settled: number;
      retired: number;
    }> {
      const seen = { put: -1, journal: -1, post: -1, timer: -1, settled: -1, retired: -1 };
      phases.length = 0;
      emit?.(event);
      for (let i = 1; i <= 200; i += 1) {
        await Promise.resolve();
        if (seen.settled < 0 && phases.includes('runner-event-settled:closed')) seen.settled = i;
        if (seen.put < 0 && order.some((entry) => entry.startsWith('put:'))) seen.put = i;
        if (seen.journal < 0 && order.includes('journal')) seen.journal = i;
        if (seen.post < 0 && order.includes('post')) seen.post = i;
        if (seen.timer < 0 && vi.getTimerCount() > timersBefore) seen.timer = i;
        if (seen.retired < 0 && pool.denials(JOB_ID).length === 0) seen.retired = i;
      }
      return seen;
    },
    /** 予約された引き取りの挑み直しが、`ms` 進めたあとに `runner.list()` へ届いた回数 */
    async advance(ms: number): Promise<number> {
      listCalls = 0;
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
      return listCalls;
    },
    /** 次の `manager_send` が、生きたセッションへ直に渡る（`send`）か、起こし直し（`resume`）に回るか */
    async sendOnce(): Promise<{ sends: number; resumes: number }> {
      sends = 0;
      resumes = 0;
      await pool.send(JOB_ID, '続けて');
      await settle();
      return { sends, resumes };
    },
    timersAdded(): number {
      return vi.getTimerCount() - timersBefore;
    },
    retired(): boolean {
      return pool.denials(JOB_ID).length === 0;
    },
    async exchanges(): Promise<{ text: string; roleLine: string }[]> {
      const entries = await stores.journal.list({ types: ['exchange'] });
      return entries
        .flatMap((entry) =>
          entry.type === 'exchange'
            ? [{ text: entry.text, roleLine: `${entry.with}/${entry.role}` }]
            : [],
        )
        .reverse()
        .slice(exchangeBefore);
    },
    async escalations(): Promise<unknown[]> {
      const entries = await stores.journal.list({ types: ['escalation'] });
      return entries
        .reverse()
        .slice(escalationBefore)
        .map((entry) =>
          Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'at')),
        );
    },
    async job(): Promise<Job | null> {
      return stores.jobs.getJob(JOB_ID);
    },
    async listed(): Promise<{ status: string; waiting: unknown } | undefined> {
      const item = (await pool.list()).find((entry) => entry.managerId === JOB_ID);
      return item === undefined ? undefined : { status: item.status, waiting: item.waiting };
    },
    messages(): { kind: string; text: string; statusAtDelivery?: string }[] {
      return inbox.flatMap((event) =>
        event.type === 'manager_message'
          ? [
              {
                kind: event.kind,
                text: event.text,
                ...(event.statusAtDelivery === undefined
                  ? {}
                  : { statusAtDelivery: event.statusAtDelivery }),
              },
            ]
          : [],
      );
    },
  };
}

const REASON = 'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）。';

function closed(
  status: 'done' | 'failed' | 'lost',
  reason: string = REASON,
  selfFenced: true | null = true,
): Extract<RunnerEvent, { type: 'closed' }> {
  return {
    type: 'closed',
    managerId: JOB_ID,
    status,
    reason,
    ...(selfFenced === null ? {} : { selfFenced }),
  };
}

const JOURNAL_RUNNING = `[復旧] [${JOB_ID}] 器が貸し出し期限で自分で畳んだ（自己失効）。台帳の状態（running）は動かさず、別の器で続きを起こし直す: ${REASON}`;
const NOTICE = `器がデーモンと連絡を失い、貸し出し期限で自分で畳みました（自己失効）。この委譲は終わっていません — 引き取りを自動で挑み直します: ${REASON}`;

describe('自己失効の closed（closeSelfFenced）', () => {
  it('日誌・知らせの全文と with/role、待ちの取り下げ、貸し出しの返却、書き込みと知らせの順を固定する。像は外さない', async () => {
    const s = await open({}, [
      { id: 'req-a', summary: 'A の確認' },
      { id: 'req-b', summary: 'B の確認' },
    ]);
    // 確認が積まれている間の status は waiting_human（自己失効はそれを動かさない）
    expect(await s.listed()).toMatchObject({ status: 'waiting_human' });
    expect((await s.listed())?.waiting).toHaveLength(2);

    await s.push(closed('lost'));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: JOURNAL_RUNNING.replace('（running）', '（waiting_human）'),
      },
    ]);
    expect(s.messages()).toEqual([
      { kind: 'report', text: NOTICE, statusAtDelivery: 'waiting_human' },
    ]);
    // 待ちの取り下げ（日誌 escalation 2 行）→ 台帳（status は動かさず、貸し出しは返却済み）→ 日誌 → 知らせ
    expect(s.order).toEqual([
      'escalation',
      'escalation',
      `put:waiting_human/${NOW_ISO}`,
      'journal',
      'post',
    ]);
    expect(await s.escalations()).toEqual([
      {
        type: 'escalation',
        question: 'A の確認',
        approvalId: 'req-a',
        managerId: JOB_ID,
        withdrawnAt: NOW_ISO,
        withdrawnReason: 'この確認への答えは届かない（器が貸し出し期限で自分で畳んだ）',
      },
      {
        type: 'escalation',
        question: 'B の確認',
        approvalId: 'req-b',
        managerId: JOB_ID,
        withdrawnAt: NOW_ISO,
        withdrawnReason: 'この確認への答えは届かない（器が貸し出し期限で自分で畳んだ）',
      },
    ]);
    const job = await s.job();
    expect(job?.status).toBe('waiting_human');
    expect(job?.lease).toEqual({ ...LEASE, releasedAt: NOW_ISO });
    expect(job?.lateDoneNotifiedAt).toBeUndefined();
    // 像は外さない（拒否の数えが残る）。待ちは空になり、status は一覧でも動かない
    expect(s.retired()).toBe(false);
    expect(await s.listed()).toEqual({ status: 'waiting_human', waiting: [] });
    // 引き取りの挑み直しはタイマー 1 本を予約する
    expect(s.timersAdded()).toBe(1);
    await s.pool.stop();
  });

  it('セッションは繋がっていない印（attached=false）になる: 自己失効の前は manager_send が生きたセッションへ直に渡り、後は起こし直しへ回る', async () => {
    const before = await open();
    expect(await before.sendOnce()).toEqual({ sends: 1, resumes: 0 });
    await before.pool.stop();

    const after = await open();
    await after.push(closed('lost'));
    expect(await after.sendOnce()).toEqual({ sends: 0, resumes: 1 });
    await after.pool.stop();
  });

  it('event.status は日誌にも台帳にも使わず、reason の文だけがそのまま日誌と知らせの末尾に載る', async () => {
    const s = await open();

    await s.push(closed('done', '別の文'));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: `[復旧] [${JOB_ID}] 器が貸し出し期限で自分で畳んだ（自己失効）。台帳の状態（running）は動かさず、別の器で続きを起こし直す: 別の文`,
      },
    ]);
    expect(s.messages()).toEqual([
      {
        kind: 'report',
        text: `器がデーモンと連絡を失い、貸し出し期限で自分で畳みました（自己失効）。この委譲は終わっていません — 引き取りを自動で挑み直します: 別の文`,
        statusAtDelivery: 'running',
      },
    ]);
    expect((await s.job())?.status).toBe('running');
    expect(s.retired()).toBe(false);
    await s.pool.stop();
  });

  it('貸し出しの記録が無い委譲では、貸し出しを作らず、それ以外は同じ順で進む', async () => {
    const s = await open({ lease: undefined });
    const before = await s.job();
    expect(before?.lease).toBeUndefined();

    await s.push(closed('lost'));

    expect(s.order).toEqual(['put:running/-', 'journal', 'post']);
    const job = await s.job();
    expect(job?.lease).toBeUndefined();
    expect(job?.status).toBe('running');
    expect(s.retired()).toBe(false);
    expect(s.timersAdded()).toBe(1);
    await s.pool.stop();
  });

  it('引き取りの挑み直しは、貸し出しを返した後の予約として 1 秒で runner を引き直す（その前には動かない）', async () => {
    const s = await open();

    await s.push(closed('lost'));

    expect(s.timersAdded()).toBe(1);
    expect(await s.advance(REATTACH_BASE_MS - 1)).toBe(0);
    expect(await s.advance(1)).toBeGreaterThan(0);
    await s.pool.stop();
  });

  // 宛先の runner が書かれていない委譲（`record.job.runnerId === undefined`）は pin に置けない: 起動時の `restore` が `runnerId` を書くので、
  // `createManagerPool` 経由ではその形の像に `closed` を流せない（試して、挑み直しのタイマーが 1 本立つことを確かめた）。

  it('枝の振り分け: selfFenced の印が無い closed(lost) は自己失効として扱わない（日誌も知らせも挑み直しの予約も出ない）', async () => {
    const s = await open({}, [], { sessionAlive: false });

    await s.push(closed('lost', '普通の終わり', null));

    const texts = (await s.exchanges()).map((entry) => entry.text);
    expect(texts.some((text) => text.includes('器が貸し出し期限で自分で畳んだ'))).toBe(false);
    expect(
      s.messages().some((message) => message.text.includes('引き取りを自動で挑み直します')),
    ).toBe(false);
    // 像を畳むと既存のタイマーが 1 本消えるので、増えない（0 以下）ことだけを言う
    expect(s.timersAdded()).toBeLessThanOrEqual(0);
    await s.pool.stop();
  });

  it('枝の振り分け: lost 確定済みなら selfFenced の印が付いていても lost の枝が先（自己失効の日誌も引き取りの予約も出ない）', async () => {
    const s = await open({ status: 'lost' }, [], { sessionAlive: false });

    await s.push(closed('lost'));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: `[判断] [${JOB_ID}] （lost 確定済みのため status は動かさない）runner 側の終了イベント（status=lost）を受け取った: ${REASON}。受信箱へは出さない`,
      },
    ]);
    expect(s.timersAdded()).toBe(0);
    expect(s.retired()).toBe(true);
    await s.pool.stop();
  });

  it('枝の振り分け: failed 確定済みへの closed(failed) は重複の枝が先。closed(done) なら自己失効の枝へ来る', async () => {
    const dup = await open({ status: 'failed' }, [], { sessionAlive: false });
    await dup.push(closed('failed'));
    expect((await dup.exchanges())[0]?.text).toContain(
      `[判断] [${JOB_ID}] （failed 確定済みのため`,
    );
    expect(dup.timersAdded()).toBe(0);
    expect(dup.retired()).toBe(true);
    await dup.pool.stop();

    const fenced = await open({ status: 'failed' }, [], { sessionAlive: false });
    await fenced.push(closed('done'));
    expect((await fenced.exchanges())[0]?.text).toContain('（自己失効）。台帳の状態（failed）');
    expect((await fenced.job())?.status).toBe('failed');
    expect(fenced.timersAdded()).toBe(1);
    expect(fenced.retired()).toBe(false);
    await fenced.pool.stop();
  });
});

describe('microtask の周回数（呼び元の await の段を数える歯）', () => {
  // 協力者へ移したあと、`async` で包み直す・口を `async` の皮で包む・`await` を足す／減らすと、ここの数が変わる。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('自己失効の closed: 台帳の書き込み・日誌・知らせ・挑み直しの予約までの周回数（像は外れない）', async () => {
    const s = await open();
    expect(await s.hops(closed('lost'))).toEqual({
      put: 1,
      journal: 3,
      post: 5,
      timer: 5,
      settled: 7,
      retired: -1,
    });
    await s.pool.stop();
  });
});
