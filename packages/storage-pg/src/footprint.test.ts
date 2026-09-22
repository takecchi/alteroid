import { randomBytes } from 'node:crypto';

import type { Commitment } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { measureStorageFootprint, STATEMENT_TIMEOUT_MS, type TableSizeStats } from './footprint.js';
import { migrate } from './migrate.js';
import { archive, commitments, inboxEvents, jobs, journal } from './schema.js';

/**
 * `pg_column_size` は**保存された（圧縮後の）**サイズを見る。`'x'.repeat(n)`
 * のような単純な繰り返し文字列は圧縮率が高すぎて、長さを変えても圧縮後サイズ
 * がほぼ変わらない——「大きい本文ほど値が増える」ことを確かめたいテストに
 * とっては罠になる。高エントロピーな本文（乱数の16進文字列）を使い、圧縮では
 * 潰れないサイズの違いを作る（このファイルでは「圧縮が効かない対照」としても
 * 使う——`storedBytes` と `textBytes` がほぼ一致することを示す側）。
 */
function randomBody(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString('hex')
    .slice(0, chars);
}

/**
 * **圧縮がよく効く本文**（alteroid が実際に貯めている本文の形に寄せた——
 * 日本語の定型文の繰り返し）。`repeatCount` を増やすほど圧縮率が上がる
 * （同じ文が何度も出るため）。
 *
 * 本物の PostgreSQL 17（`.claude/skills/postgres-in-container/`）で
 * `repeatCount=4000` を実測した数値（2026-09-22 観測。コミット時点で
 * 再実測すればいつでも同じ値が得られる——固定した文字列・固定した処理なので
 * 腐らない）:
 *
 * ```
 * pg_column_size(jsonb)        =     5,369 バイト（圧縮後・格納バイト）
 * octet_length(jsonb::text)    =   456,012 バイト（実テキスト）
 * ⟹ 約85倍
 * ```
 *
 * PGlite（このテストが使うドライバ）で同じ入力を実測しても、**バイト単位で
 * 完全に同じ値**が返ることを確認済み（PGlite は本物の PostgreSQL をそのまま
 * WASM へコンパイルしたものであり、圧縮の挙動も含めて本物と区別できない）。
 */
function compressiblePhrase(repeatCount: number): string {
  return '約束の台帳の手順・禁止領域について、この記録は同じ文面を繰り返す傾向がある。'.repeat(
    repeatCount,
  );
}

function emptyStats(): TableSizeStats {
  return { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 };
}

function emptyJournalWindow(): { rows: number; storedBytes: number; textBytes: number } {
  return { rows: 0, storedBytes: 0, textBytes: 0 };
}

/**
 * `measureStorageFootprint`（#1283、段2）の受け入れ確認。
 *
 * PGlite（インプロセスの実 PostgreSQL）を使う——`pg_column_size` /
 * `octet_length` / `FILTER (WHERE …)` / `statement_timeout` は素の Postgres
 * の機能なので、偽物の DB では確かめたことにならない（`index.test.ts` 冒頭の
 * doc と同じ理由）。
 *
 * ⚠️ **例外が1つある——`statement_timeout` は PGlite では実際には打ち切らない
 * ことを確認済みである**（2026-09-22 実測。`SHOW statement_timeout` は正しい
 * 値を返すのに、`pg_sleep(2)` を 1ms のタイムアウト下で実行しても打ち切られ
 * ない。PGlite は単一プロセス／WASM で動くため、本物の PostgreSQL が
 * `CHECK_FOR_INTERRUPTS` で使う非同期シグナル配送の仕組みを持たない、と
 * 考えられる——ただし PGlite 自身のドキュメントでそう明言されているわけでは
 * なく、これは実測からの推測である）。**本物の PostgreSQL 17 では実際に
 * 打ち切られることを、`.claude/skills/postgres-in-container/` の手順で別途
 * 確認した**（生ログは PR 本文）。⟹ このファイルでは
 * (1) `statement_timeout` を設定する SQL が実際に撃たれていること（配線）
 * (2) クエリが投げたとき（`statement_timeout` によるものを含め、原因を問わず）
 * 表が独立して `null` に倒れ、起動が止まらないこと（既存の「表が無い」歯が
 * 同じ catch 経路を通ることで実質的にカバーする）
 * の2つを歯にする。**打ち切りが実際に発火することそのものは、この環境の
 * PGlite では歯にできない。**
 */
let client: PGlite;
let db: Db;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
});

afterEach(async () => {
  await client.close();
});

describe('measureStorageFootprint（空の DB）', () => {
  it('5つの表すべてで「実測して0」——nullではない', async () => {
    const footprint = await measureStorageFootprint(db);

    expect(footprint.jobs).toEqual(emptyStats());
    expect(footprint.commitments).toEqual({ open: emptyStats(), closed: emptyStats() });
    expect(footprint.inboxEvents).toEqual({ ...emptyStats(), maxDeliveries: 0 });
    expect(footprint.journal).toEqual({
      all: emptyJournalWindow(),
      recent3d: emptyJournalWindow(),
    });
    expect(footprint.archive).toEqual(emptyStats());
  });

  it('measurementMs は非負の実測値', async () => {
    const footprint = await measureStorageFootprint(db);
    expect(footprint.measurementMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(footprint.measurementMs)).toBe(true);
  });
});

describe('measureStorageFootprint（積んだぶんだけ増える）', () => {
  it('jobs: 行数と storedBytes/textBytes が増える', async () => {
    const before = await measureStorageFootprint(db);
    expect(before.jobs).toEqual(emptyStats());

    await db.insert(jobs).values({
      id: 'job-1',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { body: randomBody(1_000) },
    });
    const afterOne = await measureStorageFootprint(db);
    expect(afterOne.jobs.rows).toBe(1);
    expect(afterOne.jobs.storedBytes).not.toBeNull();
    expect(afterOne.jobs.textBytes).not.toBeNull();
    // jsonb はエンコードが変わるので厳密な一致は求めない——「本当に測っている」
    // ことだけを見る（`session-store.ts` の `measureSize` のテストと同じ判断）。
    expect(afterOne.jobs.storedBytes as number).toBeGreaterThan(900);
    expect(afterOne.jobs.textBytes as number).toBeGreaterThan(900);
    expect(afterOne.jobs.maxStoredBytes).toBe(afterOne.jobs.storedBytes);
    expect(afterOne.jobs.maxTextBytes).toBe(afterOne.jobs.textBytes);

    await db.insert(jobs).values({
      id: 'job-2',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { body: randomBody(5_000) },
    });
    const afterTwo = await measureStorageFootprint(db);
    expect(afterTwo.jobs.rows).toBe(2);
    expect(afterTwo.jobs.storedBytes as number).toBeGreaterThan(
      afterOne.jobs.storedBytes as number,
    );
    expect(afterTwo.jobs.textBytes as number).toBeGreaterThan(afterOne.jobs.textBytes as number);
    // 最大1行は job-2 のほうが大きい（両方の軸で）
    expect(afterTwo.jobs.maxStoredBytes as number).toBeGreaterThan(
      afterOne.jobs.maxStoredBytes as number,
    );
    expect(afterTwo.jobs.maxTextBytes as number).toBeGreaterThan(
      afterOne.jobs.maxTextBytes as number,
    );
  });

  it('commitments: 未了と片付きは独立して数える（storedBytes/textBytes とも）', async () => {
    const openEntry: Commitment = {
      id: 'c-open',
      at: '2026-09-20T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-1',
      body: randomBody(1_000),
    };
    const closedEntry: Commitment = {
      id: 'c-closed',
      at: '2026-09-19T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-1',
      body: randomBody(2_000),
    };
    await db.insert(commitments).values([
      { id: openEntry.id, at: new Date(openEntry.at), closedAt: null, commitment: openEntry },
      {
        id: closedEntry.id,
        at: new Date(closedEntry.at),
        closedAt: new Date('2026-09-19T01:00:00.000Z'),
        commitment: closedEntry,
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.commitments.open.rows).toBe(1);
    expect(footprint.commitments.closed.rows).toBe(1);
    expect(footprint.commitments.open.storedBytes as number).toBeGreaterThan(900);
    expect(footprint.commitments.open.textBytes as number).toBeGreaterThan(900);
    expect(footprint.commitments.closed.storedBytes as number).toBeGreaterThan(1_900);
    expect(footprint.commitments.closed.textBytes as number).toBeGreaterThan(1_900);
    // 未了の合計は片付きの本文を含まない（独立して数える。両方の軸で）
    expect(footprint.commitments.open.storedBytes as number).toBeLessThan(
      footprint.commitments.closed.storedBytes as number,
    );
    expect(footprint.commitments.open.textBytes as number).toBeLessThan(
      footprint.commitments.closed.textBytes as number,
    );
  });

  it('inbox_events: max(deliveries) を測る', async () => {
    await db.insert(inboxEvents).values([
      {
        id: 'ev-1',
        event: {
          type: 'human_message',
          id: 'ev-1',
          at: '2026-09-20T00:00:00.000Z',
          text: 'hi',
          conversationId: 'c1',
        },
        at: new Date('2026-09-20T00:00:00.000Z'),
        deliveries: 2,
      },
      {
        id: 'ev-2',
        event: {
          type: 'human_message',
          id: 'ev-2',
          at: '2026-09-20T00:00:00.000Z',
          text: 'yo',
          conversationId: 'c1',
        },
        at: new Date('2026-09-20T00:00:00.000Z'),
        deliveries: 7,
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.inboxEvents.rows).toBe(2);
    expect(footprint.inboxEvents.maxDeliveries).toBe(7);
  });

  it('journal: 全体と直近3日を別々に数える（storedBytes/textBytes とも）', async () => {
    const now = new Date();
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    await db.insert(journal).values([
      {
        id: 'j-old',
        at: fourDaysAgo,
        type: 'decision',
        entry: {
          type: 'decision',
          id: 'j-old',
          at: fourDaysAgo.toISOString(),
          decision: 'd',
          grounds: randomBody(500),
        },
      },
      {
        id: 'j-new',
        at: oneDayAgo,
        type: 'decision',
        entry: {
          type: 'decision',
          id: 'j-new',
          at: oneDayAgo.toISOString(),
          decision: 'd',
          grounds: randomBody(500),
        },
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.journal.all.rows).toBe(2);
    expect(footprint.journal.recent3d.rows).toBe(1);
    expect(footprint.journal.all.storedBytes as number).toBeGreaterThan(
      footprint.journal.recent3d.storedBytes as number,
    );
    expect(footprint.journal.all.textBytes as number).toBeGreaterThan(
      footprint.journal.recent3d.textBytes as number,
    );
  });

  it('archive: text 列も pg_column_size / octet_length で測る', async () => {
    await db.insert(archive).values({
      id: 'sess-1.jsonl',
      sessionId: 'sess-1',
      at: new Date('2026-09-20T00:00:00.000Z'),
      body: randomBody(3_000),
    });

    const footprint = await measureStorageFootprint(db);
    expect(footprint.archive.rows).toBe(1);
    expect(footprint.archive.storedBytes as number).toBeGreaterThan(2_900);
    expect(footprint.archive.textBytes as number).toBeGreaterThan(2_900);
    expect(footprint.archive.maxStoredBytes).toBe(footprint.archive.storedBytes);
    expect(footprint.archive.maxTextBytes).toBe(footprint.archive.textBytes);
  });
});

/**
 * ⭐ **いちばん効く歯——圧縮が効く本文では `storedBytes` が `textBytes` を
 * 大きく下回ることを固定する。** 直す前の実装（`bytes` 一本）は、この差を
 * 一切見せていなかった——`storedBytes` だけを見て「小さい」と判定すると、
 * 実際にいちばん危ない（実テキストが大きい）表を見逃す。
 */
describe('measureStorageFootprint（storedBytes と textBytes は別物——圧縮が効く本文で大きく食い違う）', () => {
  it('日本語の定型文の繰り返し（alteroid の実際の本文に近い形）では、storedBytes は textBytes を大きく下回る', async () => {
    await db.insert(jobs).values({
      id: 'job-compressible',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { note: compressiblePhrase(4000) },
    });

    const footprint = await measureStorageFootprint(db);
    const { storedBytes, textBytes } = footprint.jobs;
    expect(storedBytes).not.toBeNull();
    expect(textBytes).not.toBeNull();

    // 本物の PostgreSQL 17 で実測した値（このファイル冒頭の doc）と同じ桁。
    expect(textBytes as number).toBeGreaterThan(400_000);
    expect(storedBytes as number).toBeLessThan(10_000);

    // ⟹ 「格納バイトだけで判定すると、いちばん危ない表をいちばん小さく報告する」
    // ことそのものを数で示す——実テキストは格納バイトの10倍を優に超える
    // （実測は約85倍。余裕を持たせて10倍で固定する）。
    expect(textBytes as number).toBeGreaterThan((storedBytes as number) * 10);
  });

  it('⭐ 陰性対照——圧縮の効かない本文（乱数）では、storedBytes と textBytes はほぼ一致する', async () => {
    // これが無いと、上の食い違いが「実装のバグ」なのか「圧縮という原因」なのか
    // 切り分けられない。乱数（圧縮が効かない）で近い値になることを見せて、
    // 原因が圧縮であることを示す。
    await db.insert(jobs).values({
      id: 'job-incompressible',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { note: randomBody(20_000) },
    });

    const footprint = await measureStorageFootprint(db);
    const { storedBytes, textBytes } = footprint.jobs;
    expect(storedBytes).not.toBeNull();
    expect(textBytes).not.toBeNull();
    // jsonb のオーバーヘッド分の差はあるが、桁が変わるような食い違いは無い。
    expect(textBytes as number).toBeLessThan((storedBytes as number) * 2);
  });
});

describe('measureStorageFootprint（本文は Node のメモリへ載せない）', () => {
  /**
   * 撃った SQL そのもので見る（`session-store.ts` の `measureSize` のテストと
   * 同じ形）。**直した後の判定は「pg_column_size(...) の中でしか参照しない」
   * ではない**——`octet_length(col::text)` も本文の列に触れる正当な呼び出し
   * である。⛔ **歯を弱めるのではなく、測りたいこと自体を言い直す**: 本文の
   * 列は `pg_column_size(...)` か `octet_length(...::text)` の**中だけ**で
   * 参照され、それ以外（裸の列参照＝本文そのものを SELECT する形）が無い
   * ことを見る。**返ってくるのが数値だけであること**は、`describe` の次の
   * ブロック（積んだぶんだけ増える一連のテスト）が実際の戻り値の型
   * （`number | null`）で担保している。
   */
  it('5表分の SELECT は、本文の列を pg_column_size(...) / octet_length(...::text) の中でしか参照しない', async () => {
    const queries: string[] = [];
    const loggingDb = drizzle(client, {
      logger: { logQuery: (query: string) => queries.push(query) },
    });

    await measureStorageFootprint(loggingDb);

    const bodyColumnOf = (query: string): string | undefined => {
      if (query.includes('from "jobs"')) return 'job';
      if (query.includes('from "commitments"')) return 'commitment';
      if (query.includes('from "inbox_events"')) return 'event';
      if (query.includes('from "journal"')) return 'entry';
      if (query.includes('from "archive"')) return 'body';
      return undefined;
    };

    const selectQueries = queries.filter((q) => bodyColumnOf(q) !== undefined);
    // 5表分のSELECT。set_config(...) の呼び出しは対象外（下のテストで別に見る）。
    expect(selectQueries).toHaveLength(5);

    const seen = new Set<string>();
    for (const query of selectQueries) {
      const column = bodyColumnOf(query) as string;
      seen.add(column);

      const withoutSizeAndLengthCalls = query
        .replace(/pg_column_size\([^)]*\)/gi, '')
        .replace(/octet_length\([^)]*\)/gi, '');
      expect(withoutSizeAndLengthCalls, query).not.toContain(`"${column}"`);
    }
    expect(seen).toEqual(new Set(['job', 'commitment', 'event', 'entry', 'body']));
  });

  it("5表それぞれの測定が set_config('statement_timeout', …) を撃っている（配線の確認）", async () => {
    const queries: string[] = [];
    const loggingDb = drizzle(client, {
      logger: { logQuery: (query: string) => queries.push(query) },
    });

    await measureStorageFootprint(loggingDb, STATEMENT_TIMEOUT_MS);

    const timeoutQueries = queries.filter((q) => q.includes("set_config('statement_timeout'"));
    expect(timeoutQueries).toHaveLength(5);
  });
});

describe('measureStorageFootprint（測定は起動を止めない・表ごとに独立して倒れる）', () => {
  it('1表が測れなくても（表が無い等）、他の表は測り続け、関数自体は投げない', async () => {
    // journal だけ落とす——「クエリが投げる」状況を、モックではなく実際に作る。
    // statement_timeout による打ち切りも、この関数にとっては「クエリが投げた」
    // という同じ事実でしかない——catch の経路は共通なので、このテストが
    // 「原因を問わず表が独立して null に倒れる」ことを代表して固定する。
    await db.execute(sql`drop table journal`);

    const footprint = await measureStorageFootprint(db);

    // journal は測れなかった（null）。
    expect(footprint.journal).toEqual({
      all: { rows: null, storedBytes: null, textBytes: null },
      recent3d: { rows: null, storedBytes: null, textBytes: null },
    });
    // 他の4表は無事——「journal が落ちた」が伝播していない。
    expect(footprint.jobs).toEqual(emptyStats());
    expect(footprint.commitments).toEqual({ open: emptyStats(), closed: emptyStats() });
    expect(footprint.inboxEvents).toEqual({ ...emptyStats(), maxDeliveries: 0 });
    expect(footprint.archive).toEqual(emptyStats());
  });

  it('複数の表が同時に測れなくても、残りは測り続ける', async () => {
    await db.execute(sql`drop table journal`);
    await db.execute(sql`drop table archive`);

    const footprint = await measureStorageFootprint(db);

    expect(footprint.journal.all.rows).toBeNull();
    expect(footprint.archive.rows).toBeNull();
    expect(footprint.jobs.rows).toBe(0);
    expect(footprint.commitments.open.rows).toBe(0);
    expect(footprint.inboxEvents.rows).toBe(0);
  });
});
