import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry, type RunnerEvent } from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool#handleEvent` の `case 'closed'` のうち、状態を動かさずに `#retire` で畳む 2 本
// （`lost` 確定後の `closed` ＝ `closeAfterLost`、`failed` 確定済みへの重複 `closed(failed)` ＝ `closeDuplicateFailed`。
// 切り出し前は `Pool` の `#closeAfterLost`・`#closeDuplicateFailed`、いまは `manager-closed-front.ts`）を、
// 外から見える結果（日誌の全文と `with/role`・台帳の行・受信箱の知らせ・書き込みと知らせの順・像が畳まれたか・microtask の周回数）だけで縛る。
// 期待の文字列は、切り出し前の作りの出力から生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流し、そのたびにマイクロタスクを流しきる。時計は注入する。

const JOB_ID = 'mgr-closed-front-pin';
const NOW_ISO = '2026-11-01T00:00:00.000Z';

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

/** 台帳の状態 `job` で出来事 `event` を 1 件流す。像が畳まれたかは、先に数えた拒否が `denials()` から消えるかで見る。 */
async function open(job: Partial<Job>) {
  let emit = null as ((event: RunnerEvent) => void) | null;
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent;
    },
    async list() {
      return [];
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
    ...job,
  });
  // 書き込みと知らせの順を 1 本の列に残す（台帳へ書いた時点の `lateDoneNotifiedAt` も控える）
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
    order.push(`put:${row.lateDoneNotifiedAt ?? '-'}`);
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
  // 像を台帳から作り直させ、畳まれたかを見る目印（拒否 1 件）を載せる
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
  const exchangeBefore = (await stores.journal.list({ types: ['exchange'] })).length;
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
    async hops(event: RunnerEvent): Promise<{ journal: number; post: number; retired: number }> {
      const seen: { journal: number; post: number; retired: number } = {
        journal: -1,
        post: -1,
        retired: -1,
      };
      emit?.(event);
      for (let i = 1; i <= 200; i += 1) {
        await Promise.resolve();
        if (seen.journal < 0 && order.includes('journal')) seen.journal = i;
        if (seen.post < 0 && order.includes('post')) seen.post = i;
        if (seen.retired < 0 && pool.denials(JOB_ID).length === 0) seen.retired = i;
      }
      return seen;
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
    async job(): Promise<Job | null> {
      return stores.jobs.getJob(JOB_ID);
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

function closed(
  status: 'done' | 'failed' | 'lost',
  reason: string,
): Extract<RunnerEvent, { type: 'closed' }> {
  return { type: 'closed', managerId: JOB_ID, status, reason };
}

const LATE_DONE_NOTICE = [
  `この委譲 ${JOB_ID} は \`lost\` と確定していたが、後から runner が \`closed\`（status=done）を届けた。`,
  '台帳の状態は `lost` のまま変えていない。',
  '**成果が出ている可能性がある** — `lost` は成果を誰も確かめていない状態なので、成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。確かめるまで「終わった」とも「終わっていない」とも言わない。',
  'closed の reason: 遅れて来た完了',
].join('\n');

describe('lost 確定後の closed（closeAfterLost）', () => {
  it('closed(done) 1 回目: 日誌・知らせの全文、印の永続 → 知らせの順、status は lost のまま、像は畳まれる', async () => {
    const s = await open({ status: 'lost' });

    await s.push(closed('done', '遅れて来た完了'));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: `[判断] [${JOB_ID}] （lost 確定済みのため status は動かさない）runner 側の終了イベント（status=done）を受け取った: 遅れて来た完了。done なのでクローンへ知らせる: ${LATE_DONE_NOTICE}`,
      },
    ]);
    expect(s.messages()).toEqual([
      { kind: 'report', text: LATE_DONE_NOTICE, statusAtDelivery: 'lost' },
    ]);
    // 日誌 → 印を書いた台帳 → 知らせ（印を先に永続してから出す）
    expect(s.order).toEqual(['journal', `put:${NOW_ISO}`, 'post']);
    const job = await s.job();
    expect(job?.status).toBe('lost');
    expect(job?.lateDoneNotifiedAt).toBe(NOW_ISO);
    expect(s.retired()).toBe(true);
    await s.pool.stop();
  });

  it('closed(done) 2 回目（既に知らせた）: 日誌だけ。知らせも台帳の書き込みも無く、像は畳まれる', async () => {
    const s = await open({ status: 'lost', lateDoneNotifiedAt: '2026-10-31T00:00:00.000Z' });

    await s.push(closed('done', '2回目'));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: `[判断] [${JOB_ID}] （lost 確定済みのため status は動かさない）runner 側の終了イベント（status=done）を受け取った: 2回目。done は既に知らせてあるので重ねて知らせない`,
      },
    ]);
    expect(s.messages()).toEqual([]);
    expect(s.order).toEqual(['journal']);
    const job = await s.job();
    expect(job?.status).toBe('lost');
    expect(job?.lateDoneNotifiedAt).toBe('2026-10-31T00:00:00.000Z');
    expect(s.retired()).toBe(true);
    await s.pool.stop();
  });

  it.each(['failed', 'lost'] as const)(
    'closed(%s): 日誌だけ（受信箱へは出さない）。台帳は書かず、像は畳まれる',
    async (late) => {
      const s = await open({ status: 'lost' });

      await s.push(closed(late, '遅れて来た'));

      expect(await s.exchanges()).toEqual([
        {
          roleLine: 'manager/inbound',
          text: `[判断] [${JOB_ID}] （lost 確定済みのため status は動かさない）runner 側の終了イベント（status=${late}）を受け取った: 遅れて来た。受信箱へは出さない`,
        },
      ]);
      expect(s.messages()).toEqual([]);
      expect(s.order).toEqual(['journal']);
      const job = await s.job();
      expect(job?.status).toBe('lost');
      expect(job?.lateDoneNotifiedAt).toBeUndefined();
      expect(s.retired()).toBe(true);
      await s.pool.stop();
    },
  );
});

describe('failed 確定済みへの重複 closed(failed)（closeDuplicateFailed）', () => {
  it('日誌の全文だけを書き、知らせも台帳の書き込みも無く、status は failed のまま、像は畳まれる', async () => {
    const s = await open({ status: 'failed' });

    await s.push(closed('failed', 'また落ちた'));

    expect(await s.exchanges()).toEqual([
      {
        roleLine: 'manager/inbound',
        text: `[判断] [${JOB_ID}] （failed 確定済みのため status は動かさず、知らせも器の失敗の計上も重ねない）runner 側の終了イベント（status=failed）を受け取った: また落ちた`,
      },
    ]);
    expect(s.messages()).toEqual([]);
    expect(s.order).toEqual(['journal']);
    expect((await s.job())?.status).toBe('failed');
    expect(s.retired()).toBe(true);
    await s.pool.stop();
  });
});

describe('microtask の周回数（呼び元の await の段を数える歯）', () => {
  // 協力者へ移したあと、`async` で包み直す・口を `async` の皮で包む・`await` を足すと、ここの数が増える。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('lost 確定後の closed(done): 日誌・知らせ・像の畳みまでの周回数', async () => {
    const s = await open({ status: 'lost' });
    expect(await s.hops(closed('done', '遅れて来た完了'))).toEqual({
      journal: 1,
      post: 5,
      retired: 5,
    });
    await s.pool.stop();
  });

  it('重複 closed(failed): 日誌・像の畳みまでの周回数', async () => {
    const s = await open({ status: 'failed' });
    expect(await s.hops(closed('failed', 'また落ちた'))).toEqual({
      journal: 1,
      post: -1,
      retired: 2,
    });
    await s.pool.stop();
  });
});
