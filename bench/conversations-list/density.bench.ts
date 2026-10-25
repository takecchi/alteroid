import { describe, expect, it } from 'vitest';

import { nowIso, openStoresNoWait, rawQuery } from './common.js';

// BENCH_STEP=density: `BENCH_PG_URL` の DB（`create database alteroid_bench2 template alteroid_bench` で写した方）を本番に近い密度にする。元の DB には使わない。
//   1. daily_report を 1 日 1 行にする（日付ごとに最新の 1 行だけ残す。5 日だけ 2 行残す）
//   2. 消した daily_report の穴（seq・at）のうち 300 個に github_observation を入れる（seq と at を日誌の中の時刻順のまま散らすため）。形は本物の `append` で確かめる
//   3. 台帳（commitments）を約 1,500 行（未了 約 60）、jobs を約 3,000 行（running 5）。本物のストアの口（`commitments.open` / `close`・`jobs.putJob`）で書く
// 終わったら psql で `VACUUM ANALYZE` を打つ（README.md）。
const step = process.env['BENCH_STEP'] ?? '';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20261025);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (lo: number, hi: number): number => lo + random() * (hi - lo);

const WORDS =
  '依頼 確認 修正 テスト 報告 実装 調査 レビュー 画面 日誌 台帳 委譲 設定 反映 失敗 再試行 完了'.split(
    ' ',
  );
function text(length: number): string {
  let out = '';
  while (out.length < length) out += `${pick(WORDS)}${Math.floor(random() * 1000).toString(16)} `;
  return out.slice(0, length);
}

const PERIOD_START = Date.parse('2026-07-01T00:00:00Z');
const PERIOD_END = Date.parse('2026-10-24T00:00:00Z');
const iso = (ms: number): string => new Date(Math.min(ms, PERIOD_END)).toISOString();

describe.skipIf(step !== 'density')('density', () => {
  it('本番に近い密度にする', async () => {
    const dbName = new URL(process.env['BENCH_PG_URL'] ?? 'x://y/z').pathname;
    expect(dbName, 'BENCH_PG_URL で別 DB を指すこと（元の alteroid_bench は壊さない）').not.toBe(
      '/alteroid_bench',
    );
    expect(dbName).not.toBe('/z');
    const stores = await openStoresNoWait();
    const q = <T = Record<string, unknown>>(sql: string) => rawQuery<T>(stores, sql);
    console.log(`# density ${nowIso()} db=${dbName}`);

    // 1. daily_report
    const before = await q<{ n: string; d: string }>(
      `select count(*) n, count(distinct entry->>'date') d from journal where type = 'daily_report'`,
    );
    console.log(`daily_report before ${JSON.stringify(before[0])}`);
    await q('drop table if exists bench_holes');
    await q(`create table bench_holes as
      with ranked as (
        select seq, at, entry->>'date' as d, row_number() over (partition by entry->>'date' order by at desc, seq desc) as rn
        from journal where type = 'daily_report'
      ), keep_two as (select d from ranked where rn = 1 order by md5(d) limit 5)
      select seq, at from ranked where rn > 2 or (rn = 2 and d not in (select d from keep_two))`);
    const holes = await q<{ n: string }>('select count(*) n from bench_holes');
    await q('delete from journal where seq in (select seq from bench_holes)');
    const after = await q<{ n: string; d: string }>(
      `select count(*) n, count(distinct entry->>'date') d from journal where type = 'daily_report'`,
    );
    console.log(`daily_report deleted=${holes[0]!.n} after ${JSON.stringify(after[0])}`);

    // 2. github_observation: 形を本物の append で確かめる（末尾に 1 行できるので読み戻して消す）
    const probe = await stores.journal.append({
      type: 'github_observation',
      observedBy: 'clone',
      repo: 'takecchi/alteroid',
      query: 'is:open',
      limit: 500,
      result: {
        status: 'ok',
        openIssues: 12,
        openPulls: 3,
        truncated: false,
        ci: { pulls: 3, success: 2, failure: 1, pending: 0, checks: 'ci: 2 success / 1 failure' },
      },
    });
    const probeRows = await q<{ entry: unknown }>(
      `select entry from journal where id = '${probe.id}'`,
    );
    console.log(`PROBE github_observation ${JSON.stringify(probeRows[0]?.entry)}`);
    await q(`delete from journal where id = '${probe.id}'`);
    await q(`insert into journal (seq, id, at, type, entry)
      select h.seq, gen_random_uuid()::text, h.at, 'github_observation',
        jsonb_strip_nulls(jsonb_build_object(
          'observedBy', 'clone',
          'repo', (array['takecchi/alteroid', 'takecchi/alteroid', 'takecchi/alteroid-web'])[1 + (abs(hashtext(h.seq::text)) % 3)],
          'query', 'is:open',
          'limit', 500,
          'result', case when abs(hashtext(h.seq::text)) % 20 = 0
            then jsonb_build_object('status', 'failed', 'reason', 'rate limited')
            else jsonb_build_object('status', 'ok', 'openIssues', abs(hashtext(h.seq::text)) % 40, 'openPulls', abs(hashtext(h.seq::text || 'p')) % 10, 'truncated', false,
              'ci', jsonb_build_object('pulls', 6, 'success', 3, 'failure', 2, 'pending', 1, 'checks', 'ci: 3 success / 2 failure / 1 pending'))
          end))
      from (select seq, at from bench_holes order by md5(seq::text) limit 300) h`);
    await q('drop table bench_holes');
    const gh = await q<{ n: string }>(
      `select count(*) n from journal where type = 'github_observation'`,
    );
    const ghRead = await stores.journal.list({ types: ['github_observation'], limit: 1000 });
    console.log(`github_observation rows=${gh[0]!.n} readable=${ghRead.length}`);
    expect(ghRead.length).toBe(Number(gh[0]!.n));

    // 3. 台帳と jobs
    const live = await q<{ id: string; last: string }>(
      `select entry->>'conversationId' as id, max(at)::text as last from journal
       where type = 'exchange' and entry->>'with' = 'human' and entry->>'conversationId' is not null
         and entry->>'conversationId' not in (select entry->>'deletedConversationId' from journal where type = 'conversation_deleted')
       group by 1 order by max(at) desc`,
    );
    const recent = live.slice(0, 120).map((r) => r.id);
    const anyLive = live.map((r) => r.id);
    console.log(
      `生きている人間との会話 ${anyLive.length}（未了の台帳の会話 id は新しい 120 から取る）`,
    );

    const OPEN = 60;
    const COMMITMENTS = 1500;
    for (let i = 0; i < COMMITMENTS; i += 1) {
      const isOpen = i < OPEN;
      const originRoll = random();
      const origin =
        originRoll < 0.6
          ? 'human'
          : originRoll < 0.85
            ? 'manager'
            : originRoll < 0.95
              ? 'self'
              : 'external';
      const at = isOpen
        ? between(PERIOD_END - 20 * 86_400_000, PERIOD_END - 3_600_000)
        : between(PERIOD_START, PERIOD_END - 86_400_000);
      const source =
        origin === 'human'
          ? pick(isOpen ? recent : anyLive)
          : origin === 'manager'
            ? `mgr-${1 + Math.floor(random() * 6)}`
            : undefined;
      const id = `bench-commitment-${String(i).padStart(5, '0')}`;
      const opened = await stores.commitments.open({
        id,
        at: iso(at),
        origin,
        ...(source === undefined ? {} : { source }),
        body: `#${i} ${text(Math.floor(between(60, 1800)))}`,
      });
      expect(opened.opened).toBe(true);
      if (!isOpen) {
        const closed = await stores.commitments.close(
          id,
          iso(at + between(3_600_000, 5 * 86_400_000)),
          `完了 ${text(60)}`,
          pick(['clone', 'clone', 'human', 'daemon'] as const),
        );
        expect(closed).toBe(true);
      }
    }
    const list = await stores.commitments.list({ includeClosed: true });
    console.log(
      `commitments entries=${list.entries.length} unreadable=${list.unreadable.length} open=${list.entries.filter((e) => e.closedAt === undefined).length}`,
    );

    const JOBS = 3000;
    const RUNNING = 5;
    for (let i = 0; i < JOBS; i += 1) {
      const running = i < RUNNING;
      const waiting = i === RUNNING;
      const createdAt = running
        ? between(PERIOD_END - 3_600_000 * 6, PERIOD_END - 60_000)
        : between(PERIOD_START, PERIOD_END - 86_400_000);
      const status = running
        ? 'running'
        : waiting
          ? 'waiting_human'
          : pick(['done', 'done', 'done', 'done', 'failed', 'stopped', 'lost'] as const);
      await stores.jobs.putJob({
        id: `bench-job-${String(i).padStart(5, '0')}`,
        createdAt: iso(createdAt),
        updatedAt: iso(
          running || waiting ? createdAt + 600_000 : createdAt + between(60_000, 6 * 3_600_000),
        ),
        status,
        managerId: `mgr-${1 + Math.floor(random() * 6)}`,
        ...(random() < 0.5 ? { conversationId: pick(anyLive) } : {}),
        summary: `#${i} ${text(Math.floor(between(30, 160)))}`,
        request: text(Math.floor(between(200, 2500))),
        ...(running
          ? {}
          : {
              lastReport: text(Math.floor(between(100, 1500))),
              lastReportAt: iso(createdAt + 300_000),
            }),
      });
    }
    const jobs = await stores.jobs.listJobs();
    const unreadable = await stores.jobs.listUnreadableJobs();
    console.log(
      `jobs entries=${jobs.length} unreadable=${unreadable.length} running=${jobs.filter((j) => j.status === 'running').length}`,
    );
    expect(jobs.length).toBeGreaterThanOrEqual(JOBS);
    expect(unreadable.length).toBe(0);
    await stores.close();
  });
});
