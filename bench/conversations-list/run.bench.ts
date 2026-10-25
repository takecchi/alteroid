import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  createClone,
  createLocalRunner,
  createRunnerRegistry,
  loadConversationReadView,
  readConversationPage,
  type JournalEntry,
  type JournalEntryInput,
  type JournalQuery,
  type JournalStore,
  type Stores,
} from '@alteroid/core';
import type { PgStores } from '@alteroid/storage-pg';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/daemon/src/app.js';
import { createJournalBus } from '../../apps/daemon/src/journal-bus.js';

import { nowIso, openStoresNoWait, rawQuery, round, stats } from './common.js';

// BENCH_STEP:
//   env      環境（SHOW・表と索引の大きさ・種別ごとの行数・索引の有効性）
//   warm     温まった口の時間（21 回の中央値ほか）・2 頁目・unread-count・内訳（SQL 全部と JS 側）
//   cold     PG を再起動した直後の最初の呼び（BENCH_EVICT=1 で日誌の関係ファイルの OS キャッシュも落とす）
//   explain  主な SQL の EXPLAIN (ANALYZE, BUFFERS)。温まった状態と、冷えた状態（PG 再起動のみ・再起動 + OS キャッシュ落とし）
//   route    BENCH_ROUTE（progress / reports / reports7）の温まった口の時間・SQL の内訳（`BENCH_ROUTE` を渡した `cold` / `explain` も同じ口を測る）
//   rows     journal の daily_report・github_observation の行数と、commitments・jobs の行数
// 出力は stdout と bench/conversations-list/out/<step>-<時刻>.txt の両方へ。
const step = process.env['BENCH_STEP'] ?? '';
const PG_BIN = process.env['BENCH_PG_BIN'] ?? '/usr/lib/postgresql/17/bin';
const PG_DATA = process.env['BENCH_PG_DATA'] ?? '/tmp/mgr-bd7bd1b3-pg/data';
const PG_LOG = process.env['BENCH_PG_LOG'] ?? '/tmp/mgr-bd7bd1b3-pg/pg.log';
const PG_SOCK = process.env['BENCH_PG_SOCK'] ?? '/tmp/mgr-bd7bd1b3-pg/sock';
const PG_PORT = process.env['BENCH_PG_PORT'] ?? '55931';
const REPEAT = Number(process.env['BENCH_REPEAT'] ?? '21');
const LIMIT = Number(process.env['BENCH_LIMIT'] ?? '30');
const OUT_DIR = join(import.meta.dirname, 'out');
const OUT_FILE = join(
  OUT_DIR,
  `${step}-${process.env['BENCH_ROUTE'] === undefined ? '' : `${process.env['BENCH_ROUTE']}-`}${process.env['BENCH_WRAP'] ?? 'bus'}${process.env['BENCH_EVICT'] === '1' ? '-evict' : ''}-${nowIso().replaceAll(':', '')}.txt`,
);

function out(line: string): void {
  console.log(line);
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(OUT_FILE, `${line}\n`);
}

const quietSdk = (() => {
  async function* generate(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 's',
      uuid: 'u-init',
      model: 'claude-fake',
      claude_code_version: '9.9.9',
      apiKeySource: 'user',
      permissionMode: 'default',
      mcp_servers: [],
    } as unknown as SDKMessage;
  }
  return Object.assign(generate(), {
    close: () => undefined,
    interrupt: async () => undefined,
  }) as unknown as Query;
}) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;

// BENCH_WRAP=bus（既定）: 本番のデーモン（apps/daemon/src/index.ts）と同じく、日誌のストアを `createJournalBus` で包んで app に渡す。
//   この包みは append/list/listPage/get/oldestAt/clear しか渡さないので、pg の細い口が落ちて本文ごと読む道に倒れる。
// BENCH_WRAP=none: 包まず pg のストアをそのまま渡す。
// BENCH_WRAP=legacy: #5262 の前の `createJournalBus` の再現。append / list / listPage / get / oldestAt / clear の6つだけを並べた包み（本番の今の形）。
//   今の `bus` は #5262 の後（`wrapJournalStore` で残りの口を中身へ通す）。
const WRAP = process.env['BENCH_WRAP'] ?? 'bus';

// BENCH_ROUTE: 測る口。既定は `/conversations`（Web の一覧と同じ limit=30）。
//   progress = `GET /progress`（Web の useProgress() の既定。windowHours を渡さない）
//   reports  = `GET /reports?limit=1`（Web のダッシュボード dashboard-report.tsx の useReports(1)）
//   reports7 = `GET /reports?limit=7`（useReports の既定 limit = 7。packages/swr/src/hooks/queries.ts）
const ROUTE = process.env['BENCH_ROUTE'] ?? 'conversations';
const ROUTE_PATHS: Record<string, string> = {
  conversations: `/conversations?limit=${LIMIT}`,
  progress: '/progress',
  reports: '/reports?limit=1',
  reports7: '/reports?limit=7',
};
const ROUTE_PATH = ROUTE_PATHS[ROUTE] ?? '';
if (ROUTE_PATH === '')
  throw new Error(`BENCH_ROUTE は ${Object.keys(ROUTE_PATHS).join(' / ')}: ${ROUTE}`);

function legacyJournalBus(inner: JournalStore): JournalStore {
  const listeners = new Set<(entry: JournalEntry) => void>();
  let notified: Promise<void> = Promise.resolve();
  return {
    async append(entry: JournalEntryInput): Promise<JournalEntry> {
      const appended = await inner.append(entry);
      if (listeners.size === 0) return appended;
      const step = notified.then(async () => {
        for (const listener of listeners) listener(appended);
      });
      notified = step;
      await step;
      return appended;
    },
    list: (query?: JournalQuery) => inner.list(query),
    listPage: (query?: JournalQuery) => inner.listPage(query),
    get: (id: string) => inner.get(id),
    oldestAt: () => inner.oldestAt(),
    clear: () => inner.clear(),
  };
}

function servedStores(raw: PgStores): Stores {
  if (WRAP === 'none') return raw;
  if (WRAP === 'legacy') return { ...raw, journal: legacyJournalBus(raw.journal) };
  if (WRAP !== 'bus') throw new Error(`BENCH_WRAP は legacy / bus / none: ${WRAP}`);
  return { ...raw, journal: createJournalBus(raw.journal).journal };
}

function appOver(raw: PgStores) {
  const stores = servedStores(raw);
  const clone = createClone({
    stores,
    queryFn: quietSdk,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: quietSdk, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return createApp({ clone, stores, token: 'bench-token', shutdown: () => undefined });
}

type App = ReturnType<typeof createApp>;
const AUTH = { authorization: 'Bearer bench-token' };

async function get(
  app: App,
  path: string,
): Promise<{ ms: number; status: number; text: string; timing: string | null }> {
  const t0 = performance.now();
  const res = await app.request(path, { headers: AUTH });
  const text = await res.text();
  return {
    ms: performance.now() - t0,
    status: res.status,
    text,
    timing: res.headers.get('server-timing'),
  };
}

// ---- SQL の計測（pg の Pool / Client の query を包む） ----
interface SqlRecord {
  seq: number;
  text: string;
  values: unknown[];
  ms: number;
  inTx: boolean;
  txHadJitOff: boolean;
}
const sqlLog: SqlRecord[] = [];
let sqlOn = false;

function textOf(arg: unknown): string {
  return typeof arg === 'string' ? arg : ((arg as { text?: string }).text ?? '');
}

function wrapQuery(
  target: { query: (...args: unknown[]) => unknown },
  state: { tx: boolean; jitOff: boolean },
): void {
  const original = target.query.bind(target) as (...args: unknown[]) => Promise<unknown>;
  target.query = (...args: unknown[]) => {
    if (!sqlOn || typeof args[args.length - 1] === 'function') return original(...args);
    const text = textOf(args[0]);
    const values = (
      Array.isArray(args[1]) ? args[1] : ((args[0] as { values?: unknown[] }).values ?? [])
    ) as unknown[];
    const lower = text.trim().toLowerCase();
    if (lower === 'begin' || lower.startsWith('begin ')) {
      state.tx = true;
      state.jitOff = false;
    }
    if (lower.includes("set_config('jit'")) state.jitOff = true;
    const record: SqlRecord = {
      seq: sqlLog.length,
      text,
      values,
      ms: 0,
      inTx: state.tx,
      txHadJitOff: state.jitOff,
    };
    const t0 = performance.now();
    const done = () => {
      record.ms = performance.now() - t0;
      sqlLog.push(record);
    };
    if (lower === 'commit' || lower === 'rollback') {
      state.tx = false;
      state.jitOff = false;
    }
    return original(...args).then(
      (value) => {
        done();
        return value;
      },
      (error: unknown) => {
        done();
        throw error;
      },
    );
  };
}

function instrument(stores: PgStores): void {
  const pool = (
    stores.db as unknown as {
      $client: {
        query: (...a: unknown[]) => unknown;
        connect: (...a: unknown[]) => Promise<{ query: (...a: unknown[]) => unknown }>;
      };
    }
  ).$client;
  wrapQuery(pool, { tx: false, jitOff: false });
  const connect = pool.connect.bind(pool);
  const seen = new WeakSet<object>();
  pool.connect = async (...args: unknown[]) => {
    // コールバック形式（pool.query の内部）はそのまま通す: `pool.query` の側を包んである
    if (typeof args[args.length - 1] === 'function')
      return (connect as (...a: unknown[]) => never)(...args);
    const client = await connect(...args);
    if (!seen.has(client)) {
      seen.add(client);
      wrapQuery(client, { tx: false, jitOff: false });
    }
    return client;
  };
}

function fingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 110);
}

function printSqlLog(label: string, records: readonly SqlRecord[]): void {
  out(
    `--- SQL ${label}: ${records.length} 本、client 側の合計 ${round(records.reduce((a, r) => a + r.ms, 0))} ms（往復込み・直列）`,
  );
  for (const r of records)
    out(
      `  #${String(r.seq).padStart(2, '0')} ${String(round(r.ms)).padStart(8)} ms  ${fingerprint(r.text)}`,
    );
}

async function callWithLog<T>(fn: () => Promise<T>): Promise<{ value: T; records: SqlRecord[] }> {
  const start = sqlLog.length;
  sqlOn = true;
  let value: T;
  try {
    value = await fn();
  } finally {
    sqlOn = false;
  }
  return { value, records: sqlLog.slice(start) };
}
// ---- PG の再起動・OS キャッシュ ----
function pgctl(...args: string[]): string {
  return execFileSync(
    join(PG_BIN, 'pg_ctl'),
    ['-D', PG_DATA, '-l', PG_LOG, '-o', `-k ${PG_SOCK} -h 127.0.0.1 -p ${PG_PORT}`, '-w', ...args],
    { encoding: 'utf8' },
  );
}

async function evictOsCache(stores: PgStores): Promise<string> {
  const rels = await rawQuery<{ path: string; relname: string }>(
    stores,
    `select pg_relation_filepath(c.oid) as path, c.relname from pg_class c
     where c.oid = 'journal'::regclass or c.oid = (select reltoastrelid from pg_class where oid = 'journal'::regclass)
        or c.oid in (select indexrelid from pg_index where indrelid = 'journal'::regclass)
        or c.oid in (select indexrelid from pg_index where indrelid = (select reltoastrelid from pg_class where oid = 'journal'::regclass))`,
  );
  let files = 0;
  for (const rel of rels) {
    const dir = join(PG_DATA, rel.path, '..');
    const base = rel.path.split('/').pop()!;
    for (const name of readdirSync(dir)) {
      if (
        name === base ||
        (name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1)))
      ) {
        execFileSync('dd', [`if=${join(dir, name)}`, 'iflag=nocache', 'count=0'], {
          stdio: 'ignore',
        });
        files += 1;
      }
    }
  }
  return `OS キャッシュを落とした（dd iflag=nocache count=0）: ${rels.length} 関係 / ${files} ファイル`;
}

function summarize(text: string): string {
  try {
    const body = JSON.parse(text) as {
      conversations?: unknown[];
      scanned?: number;
      reachedStart?: boolean;
      hiddenByLimit?: number;
      nextCursor?: string;
    };
    return `conversations=${body.conversations?.length} scanned=${body.scanned} reachedStart=${body.reachedStart} hiddenByLimit=${body.hiddenByLimit} nextCursor=${body.nextCursor === undefined ? 'なし' : 'あり'} bytes=${text.length}`;
  } catch {
    return `JSON でない応答 bytes=${text.length}: ${text.slice(0, 200)}`;
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'env')('env', () => {
  it('環境を出す', async () => {
    const stores = await openStoresNoWait();
    out(`# env ${nowIso()}`);
    for (const name of [
      'shared_buffers',
      'work_mem',
      'jit',
      'random_page_cost',
      'effective_cache_size',
      'track_io_timing',
      'max_parallel_workers_per_gather',
      'default_statistics_target',
      'server_version',
      'lc_messages',
    ]) {
      const rows = await rawQuery<Record<string, string>>(stores, `show ${name}`);
      out(`SHOW ${name} = ${Object.values(rows[0] ?? {})[0]}`);
    }
    const sizes = await rawQuery<Record<string, string>>(
      stores,
      `select c.relname, c.relkind, pg_size_pretty(pg_relation_size(c.oid)) as rel_size, pg_relation_size(c.oid) as rel_bytes,
              pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
       from pg_class c where c.oid = 'journal'::regclass
          or c.oid = (select reltoastrelid from pg_class where oid = 'journal'::regclass)
          or c.oid in (select indexrelid from pg_index where indrelid = 'journal'::regclass)
          or c.oid in (select indexrelid from pg_index where indrelid = (select reltoastrelid from pg_class where oid = 'journal'::regclass))
       order by c.relkind, pg_relation_size(c.oid) desc`,
    );
    out('--- 表・TOAST・索引の大きさ（relkind: r=表 t=TOAST i=索引）');
    for (const r of sizes)
      out(
        `  ${r['relkind']} ${String(r['relname']).padEnd(48)} rel=${String(r['rel_size']).padStart(10)}  total=${String(r['total_size']).padStart(10)}`,
      );
    const whole = await rawQuery<Record<string, string>>(
      stores,
      `select pg_size_pretty(pg_table_size('journal')) as table_incl_toast, pg_size_pretty(pg_relation_size('journal')) as heap,
              pg_size_pretty(pg_indexes_size('journal')) as indexes, pg_size_pretty(pg_total_relation_size('journal')) as total,
              (select reltuples::bigint from pg_class where oid = 'journal'::regclass) as reltuples,
              (select relpages from pg_class where oid = 'journal'::regclass) as relpages`,
    );
    out(`--- journal 全体 ${JSON.stringify(whole[0])}`);
    const valid = await rawQuery<Record<string, unknown>>(
      stores,
      `select c.relname, i.indisvalid, i.indisready from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = 'journal'::regclass order by 1`,
    );
    out('--- journal の索引の有効性');
    for (const r of valid) out(`  ${JSON.stringify(r)}`);
    const types = await rawQuery<{ type: string; with: string | null; n: number }>(
      stores,
      `select type, entry->>'with' as with, count(*)::int as n from journal group by 1, 2 order by n desc`,
    );
    const total = types.reduce((a, r) => a + r.n, 0);
    out(`--- 種別ごとの行数（合計 ${total}）`);
    for (const r of types)
      out(
        `  ${r.type.padEnd(22)} with=${String(r.with).padEnd(8)} ${String(r.n).padStart(8)}  ${round((r.n / total) * 100)}%`,
      );
    const conv = await rawQuery<Record<string, unknown>>(
      stores,
      `select count(distinct entry->>'conversationId')::int as human_conversations,
              count(*) filter (where entry->>'role' = 'inbound')::int as inbound, count(*) filter (where entry->>'role' = 'outbound')::int as outbound,
              count(*) filter (where entry->>'clientMessageId' is not null)::int as with_client_message_id,
              count(*) filter (where entry->>'supersedes' is not null)::int as with_supersedes,
              count(*) filter (where entry->>'turnFailure' is not null)::int as with_turn_failure,
              round(avg(length(entry->>'text')) filter (where entry->>'role' = 'outbound'))::int as avg_outbound_chars,
              min(length(entry->>'text')) filter (where entry->>'role' = 'outbound') as min_outbound_chars,
              max(length(entry->>'text')) filter (where entry->>'role' = 'outbound') as max_outbound_chars
       from journal where type = 'exchange' and entry->>'with' = 'human'`,
    );
    out(`--- with=human の内訳 ${JSON.stringify(conv[0])}`);
    const extra = await rawQuery<Record<string, unknown>>(
      stores,
      `select (select count(*) from journal where type = 'conversation_deleted')::int as tombstones,
              (select count(*) from journal where type = 'exchange' and entry->>'with' = 'self' and entry->>'withdrawnClientMessageId' is not null)::int as withdrawals,
              (select count(*) from conversation_read)::int as conversation_read_rows,
              (select count(*) from conversation_outbound_latest)::int as outbound_latest_rows,
              (select min(at) from journal) as first_at, (select max(at) from journal) as last_at,
              (select count(*) from journal where pg_column_size(entry) > 2000)::int as rows_over_2000_bytes`,
    );
    out(`--- ${JSON.stringify(extra[0])}`);
    await stores.close();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'warm')('warm', () => {
  it('温まった口の時間と内訳', async () => {
    const stores = await openStoresNoWait();
    instrument(stores);
    const app = appOver(stores);
    out(
      `# warm ${nowIso()}  wrap=${WRAP}  limit=${LIMIT} repeat=${REPEAT}  GET /conversations?limit=${LIMIT}（scan は既定）`,
    );

    // 最初の1回（このプロセスでは冷え: 器・JS・planner のキャッシュが空。PG は温まっている）
    const first = await callWithLog(() => get(app, `/conversations?limit=${LIMIT}`));
    out(
      `first(process-cold, pg-warm) /conversations: ${round(first.value.ms)} ms status=${first.value.status} ${summarize(first.value.text)}`,
    );
    printSqlLog('first call', first.records);

    for (let i = 0; i < 3; i += 1) await get(app, `/conversations?limit=${LIMIT}`);
    const times: number[] = [];
    const timings: string[] = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const r = await get(app, `/conversations?limit=${LIMIT}`);
      expect(r.status).toBe(200);
      times.push(r.ms);
      if (r.timing !== null) timings.push(r.timing);
    }
    out(
      `warm /conversations?limit=${LIMIT} ${JSON.stringify(stats(times))} (ms, ${REPEAT} 回, 3 回の助走の後) times=${JSON.stringify(times.map(round))}`,
    );
    out(`server-timing(最後の1回) ${timings[timings.length - 1] ?? '無し'}`);

    // 内訳: 1 回ぶんの SQL を全部
    const detail = await callWithLog(() => get(app, `/conversations?limit=${LIMIT}`));
    out(`breakdown call: total ${round(detail.value.ms)} ms  ${summarize(detail.value.text)}`);
    printSqlLog('warm call (内訳)', detail.records);
    const byPrint = new Map<string, { n: number; ms: number }>();
    for (const r of detail.records) {
      const key = fingerprint(r.text);
      const e = byPrint.get(key) ?? { n: 0, ms: 0 };
      e.n += 1;
      e.ms += r.ms;
      byPrint.set(key, e);
    }
    out('--- 文ごとの本数と client 側の合計');
    for (const [key, e] of [...byPrint].sort((a, b) => b[1].ms - a[1].ms))
      out(`  x${e.n} ${String(round(e.ms)).padStart(8)} ms  ${key}`);
    const sqlSum = detail.records.reduce((a, r) => a + r.ms, 0);
    out(`JS 側（total − SQL の client 合計）≈ ${round(detail.value.ms - sqlSum)} ms`);

    // JS 側を段ごとに: loadConversationReadView / readConversationPage / 整形
    const served = servedStores(stores);
    const phaseRows: { read: number; page: number; serialize: number }[] = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const read = await timed(() =>
        loadConversationReadView(stores.conversationReads, new Date().toISOString()),
      );
      const page = await timed(() =>
        readConversationPage(served.journal, { limit: LIMIT, scan: 2000, readView: read.value }),
      );
      const ser = await timed(async () =>
        JSON.stringify({
          conversations: page.value.conversations.map(({ unread, ...s }) => ({
            ...s,
            unreadCount: unread,
          })),
        }),
      );
      phaseRows.push({ read: read.ms, page: page.ms, serialize: ser.ms });
    }
    out(`phase loadConversationReadView ${JSON.stringify(stats(phaseRows.map((r) => r.read)))}`);
    out(`phase readConversationPage     ${JSON.stringify(stats(phaseRows.map((r) => r.page)))}`);
    out(
      `phase 整形(map+JSON.stringify) ${JSON.stringify(stats(phaseRows.map((r) => r.serialize)))}`,
    );
    const readView = await loadConversationReadView(
      stores.conversationReads,
      new Date().toISOString(),
    );
    out(
      `readView: positions=${Object.keys(readView.positions).length} baseline=${readView.baseline} unreadable=${readView.unreadable ?? 'なし'}`,
    );

    // 2 頁目
    const body = JSON.parse(first.value.text) as { nextCursor?: string };
    if (body.nextCursor === undefined) {
      out('page2: nextCursor が無い（1 頁目で終わり）');
    } else {
      const url = `/conversations?limit=${LIMIT}&cursor=${encodeURIComponent(body.nextCursor)}`;
      const p2first = await callWithLog(() => get(app, url));
      out(
        `page2 first: ${round(p2first.value.ms)} ms status=${p2first.value.status} ${summarize(p2first.value.text)}`,
      );
      printSqlLog('page2 first call', p2first.records);
      const t2: number[] = [];
      for (let i = 0; i < REPEAT; i += 1) {
        const r = await get(app, url);
        expect(r.status).toBe(200);
        t2.push(r.ms);
      }
      out(
        `warm page2 /conversations?limit=${LIMIT}&cursor=… ${JSON.stringify(stats(t2))} (ms, ${REPEAT} 回) times=${JSON.stringify(t2.map(round))}`,
      );
      const p2detail = await callWithLog(() => get(app, url));
      printSqlLog('page2 warm call (内訳)', p2detail.records);
    }

    // unread-count（左ナビが別に呼ぶ）
    const u1 = await callWithLog(() => get(app, '/conversations/unread-count'));
    out(
      `unread-count first(process-cold, 返答の覚え空): ${round(u1.value.ms)} ms status=${u1.value.status} body=${u1.value.text}`,
    );
    printSqlLog('unread-count first call', u1.records);
    const tu: number[] = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const r = await get(app, '/conversations/unread-count');
      expect(r.status).toBe(200);
      tu.push(r.ms);
    }
    out(
      `warm /conversations/unread-count ${JSON.stringify(stats(tu))} (ms, ${REPEAT} 回) times=${JSON.stringify(tu.map(round))}`,
    );
    const ud = await callWithLog(() => get(app, '/conversations/unread-count'));
    printSqlLog('unread-count warm call (内訳)', ud.records);

    // 並行（Web を開いた瞬間: 一覧と未読数と...を同時に）
    const par = await timed(() =>
      Promise.all([
        get(app, `/conversations?limit=${LIMIT}`),
        get(app, '/conversations/unread-count'),
      ]),
    );
    out(
      `並行 1 回: /conversations ${round(par.value[0].ms)} ms + unread-count ${round(par.value[1].ms)} ms（同時, 全体 ${round(par.ms)} ms）`,
    );
    await stores.close();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'rows')('rows', () => {
  it('journal の種別と台帳・jobs の行数', async () => {
    const stores = await openStoresNoWait();
    out(`# rows ${nowIso()}`);
    const rows = await rawQuery<Record<string, unknown>>(
      stores,
      `select (select count(*) from journal where type = 'daily_report')::int as daily_report,
              (select count(distinct entry->>'date') from journal where type = 'daily_report')::int as daily_report_distinct_dates,
              (select count(*) from journal where type = 'github_observation')::int as github_observation,
              (select count(*) from commitments)::int as commitments,
              (select count(*) from commitments where closed_at is null)::int as commitments_open,
              (select count(*) from jobs)::int as jobs,
              (select count(*) from journal)::int as journal_total`,
    );
    out(JSON.stringify(rows[0]));
    await stores.close();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'route')('route', () => {
  it('BENCH_ROUTE の温まった口の時間と内訳', async () => {
    const stores = await openStoresNoWait();
    instrument(stores);
    const app = appOver(stores);
    out(`# route ${nowIso()}  route=${ROUTE} path=${ROUTE_PATH} wrap=${WRAP} repeat=${REPEAT}`);
    const first = await callWithLog(() => get(app, ROUTE_PATH));
    out(
      `first(process-cold, pg-warm) ${ROUTE_PATH}: ${round(first.value.ms)} ms status=${first.value.status} bytes=${first.value.text.length}`,
    );
    printSqlLog('first call', first.records);
    for (let i = 0; i < 3; i += 1) await get(app, ROUTE_PATH);
    const times: number[] = [];
    let lastTiming: string | null = null;
    for (let i = 0; i < REPEAT; i += 1) {
      const r = await get(app, ROUTE_PATH);
      expect(r.status).toBe(200);
      times.push(r.ms);
      lastTiming = r.timing;
    }
    out(
      `warm ${ROUTE_PATH} ${JSON.stringify(stats(times))} (ms, ${REPEAT} 回, 3 回の助走の後) times=${JSON.stringify(times.map(round))}`,
    );
    out(`server-timing(最後の1回) ${lastTiming ?? '無し'}`);
    const detail = await callWithLog(() => get(app, ROUTE_PATH));
    out(`breakdown call: total ${round(detail.value.ms)} ms bytes=${detail.value.text.length}`);
    printSqlLog('warm call (内訳)', detail.records);
    const byPrint = new Map<string, { n: number; ms: number }>();
    for (const r of detail.records) {
      const key = fingerprint(r.text);
      const e = byPrint.get(key) ?? { n: 0, ms: 0 };
      e.n += 1;
      e.ms += r.ms;
      byPrint.set(key, e);
    }
    out('--- 文ごとの本数と client 側の合計');
    for (const [key, e] of [...byPrint].sort((a, b) => b[1].ms - a[1].ms)) {
      out(`  x${e.n} ${String(round(e.ms)).padStart(8)} ms  ${key}`);
    }
    const sqlSum = detail.records.reduce((a, r) => a + r.ms, 0);
    out(`JS 側（total − SQL の client 合計）≈ ${round(detail.value.ms - sqlSum)} ms`);
    await stores.close();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'serverlog')('serverlog', () => {
  it('log_min_duration_statement = 0 で、温まった 1 回ぶんの SQL をサーバ側の時間で読む', async () => {
    const stores = await openStoresNoWait();
    const app = appOver(stores);
    out(
      `# serverlog ${nowIso()}  wrap=${WRAP}（サーバのログ ${PG_LOG} の、この呼びの間の増分。duration はサーバ側の実行時間で、往復・JS 側を含まない）`,
    );
    for (let i = 0; i < 3; i += 1) {
      await get(app, `/conversations?limit=${LIMIT}`);
      await get(app, '/conversations/unread-count');
    }
    await rawQuery(stores, 'alter system set log_min_duration_statement = 0');
    await rawQuery(stores, 'select pg_reload_conf()');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const targets = [`/conversations?limit=${LIMIT}`, '/conversations/unread-count'];
    try {
      for (const target of targets) {
        const before = statSync(PG_LOG).size;
        const r = await get(app, target);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const text = readFileSync(PG_LOG, 'utf8').slice(before);
        const lines = text.split('\n').filter((line) => line.includes('duration:'));
        out(
          `\n=== ${target}  http ${round(r.ms)} ms status=${r.status}  ログの duration 行 ${lines.length} 本、合計 ${round(lines.reduce((a, l) => a + Number(/duration: ([\d.]+) ms/.exec(l)?.[1] ?? 0), 0))} ms`,
        );
        for (const line of lines) out(line.length > 260 ? `${line.slice(0, 260)}…` : line);
      }
    } finally {
      await rawQuery(stores, 'alter system reset log_min_duration_statement');
      await rawQuery(stores, 'select pg_reload_conf()');
      await stores.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'cold')('cold', () => {
  it('PG 再起動直後の最初の呼び', async () => {
    const evict = process.env['BENCH_EVICT'] === '1';
    out(`# cold ${nowIso()}  wrap=${WRAP} evict_os_cache=${evict}`);
    // 再起動の前に、器を開いて OS キャッシュを落とす対象の関係を数える
    if (evict) {
      const pre = await openStoresNoWait();
      out(await evictOsCache(pre));
      await pre.close();
    }
    out(`pg_ctl restart: ${pgctl('restart').trim().split('\n').pop()}`);
    if (evict) {
      const pre = await openStoresNoWait();
      out(await evictOsCache(pre));
      await pre.close();
    }
    const stores = await openStoresNoWait();
    instrument(stores);
    const app = appOver(stores);
    const calls: { label: string; ms: number }[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = await callWithLog(() => get(app, ROUTE_PATH));
      calls.push({ label: `call#${i}`, ms: r.value.ms });
      out(
        `cold curve ${ROUTE_PATH} call#${i}: ${round(r.value.ms)} ms status=${r.value.status} ${i === 1 ? (ROUTE === 'conversations' ? summarize(r.value.text) : `bytes=${r.value.text.length}`) : ''}`,
      );
      if (i <= 2) printSqlLog(`cold call#${i}`, r.records);
    }
    const pages = await rawQuery<Record<string, unknown>>(
      stores,
      `select (select count(*) from pg_stat_database where datname = current_database()) as x, (select blks_read from pg_stat_database where datname = current_database()) as blks_read, (select blks_hit from pg_stat_database where datname = current_database()) as blks_hit`,
    );
    out(`pg_stat_database（再起動後の累計）${JSON.stringify(pages[0])}`);
    await stores.close();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(step !== 'explain')('explain', () => {
  it('主な SQL の EXPLAIN (ANALYZE, BUFFERS)', async () => {
    out(`# explain ${nowIso()}  wrap=${WRAP}`);
    let stores = await openStoresNoWait();
    instrument(stores);
    const app = appOver(stores);
    // 1 頁目・2 頁目で流れる SQL（初回の呼びと、温まってからの呼びでは流れる文が違いうる: 墓標の印が変わらなければ集合の引き直しは無い）
    await get(app, ROUTE_PATH);
    const page1 = await callWithLog(() => get(app, ROUTE_PATH));
    const isConversations = ROUTE === 'conversations';
    const cursor = isConversations
      ? (JSON.parse(page1.value.text) as { nextCursor?: string }).nextCursor
      : undefined;
    const page2 =
      cursor === undefined
        ? { records: [] as SqlRecord[] }
        : await callWithLog(() =>
            get(app, `/conversations?limit=${LIMIT}&cursor=${encodeURIComponent(cursor)}`),
          );
    const unread = isConversations
      ? await callWithLog(() => get(app, '/conversations/unread-count'))
      : { records: [] as SqlRecord[] };
    const candidates = [
      ...page1.records.map((r) => ({ origin: 'page1', r })),
      ...page2.records.map((r) => ({ origin: 'page2', r })),
      ...unread.records.map((r) => ({ origin: 'unread', r })),
    ];
    const seen = new Set<string>();
    const picked: { origin: string; r: SqlRecord }[] = [];
    for (const c of candidates) {
      const lower = c.r.text.trim().toLowerCase();
      if (!(lower.startsWith('select') || lower.startsWith('with'))) continue;
      if (lower.includes('set_config')) continue;
      const key = c.r.text;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(c);
    }
    if (!isConversations) {
      // 口が別のときは client 側で長かった文から BENCH_TOP 本（既定 3）だけ EXPLAIN する
      picked.sort((a, b) => b.r.ms - a.r.ms);
      picked.splice(Number(process.env['BENCH_TOP'] ?? '3'));
      out(`長かった順: ${picked.map((c) => `${round(c.r.ms)} ms`).join(', ')}`);
    }
    out(
      `EXPLAIN 対象 ${picked.length} 文（page1=${page1.records.length} 本・page2=${page2.records.length} 本・unread=${unread.records.length} 本のうち、select/with の重複を除く）`,
    );
    await stores.close();

    const only = process.env['BENCH_ONLY'];
    const explainOne = async (
      s: PgStores,
      c: { origin: string; r: SqlRecord },
    ): Promise<string> => {
      const pool = (
        s.db as unknown as {
          $client: {
            connect: () => Promise<{
              query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
              release: () => void;
            }>;
          };
        }
      ).$client;
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (c.r.txHadJitOff) await client.query("select set_config('jit', 'off', true)");
        await client.query("select set_config('track_io_timing', 'on', true)");
        const res = await client.query(
          `explain (analyze, buffers, settings) ${c.r.text}`,
          c.r.values,
        );
        await client.query('rollback');
        return res.rows.map((row) => row['QUERY PLAN']).join('\n');
      } finally {
        client.release();
      }
    };

    for (const [index, c] of picked.entries()) {
      const label = `S${index + 1} (${c.origin}${c.r.txHadJitOff ? ', jit=off' : ''})`;
      if (only !== undefined && only !== String(index + 1)) continue;
      out(`\n===== ${label}: ${fingerprint(c.r.text)}`);
      out(
        `  params: ${JSON.stringify(c.r.values.map((v) => (Array.isArray(v) ? `[array len=${v.length}]` : typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}…` : v)))}`,
      );
      // 温まった: 3 回流して最後を出す
      stores = await openStoresNoWait();
      let warm = '';
      for (let i = 0; i < 3; i += 1) warm = await explainOne(stores, c);
      out(`--- ${label} 温まった状態（3 回目）\n${warm}`);
      await stores.close();
      // 冷え 1: PG 再起動のみ（shared_buffers が空。OS キャッシュは温かいまま）
      pgctl('restart');
      stores = await openStoresNoWait();
      out(
        `--- ${label} 冷え（PG 再起動直後の最初の1回。OS キャッシュは温かい）\n${await explainOne(stores, c)}`,
      );
      await stores.close();
      // 冷え 2: PG 再起動 + OS キャッシュ落とし
      const probe = await openStoresNoWait();
      const note = await evictOsCache(probe);
      await probe.close();
      pgctl('restart');
      const probe2 = await openStoresNoWait();
      await evictOsCache(probe2);
      await probe2.close();
      stores = await openStoresNoWait();
      out(
        `--- ${label} 冷え（PG 再起動 + OS キャッシュ落とし。${note}）\n${await explainOne(stores, c)}`,
      );
      await stores.close();
    }
    out(`\n(OUT: ${OUT_FILE})`);
  });
});
