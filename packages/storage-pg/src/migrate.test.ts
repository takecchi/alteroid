import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrate, STATEMENTS } from './migrate.js';
import { archive } from './schema.js';

/**
 * **`migrate` の配列そのものを構造で見る歯。**
 *
 * `migrate` は起動のたびにこの配列を頭から通す。だから「作ってから、同じ配列の
 * 後ろで drop する」索引が1つでもあると、**2周目はその create が本当に走る**
 * （`if not exists` が名前で一致しないため）。そして2周目が走るころには、新しい
 * 鍵が許した行 — 古い鍵から見れば重複 — が積まれている。
 * `could not create unique index … is duplicated` で `migrate` が落ち、
 * **デーモンが2度と起動できなくなる**（実際に起きた。2026-08-25、
 * `usage_daily_key_idx`）。
 *
 * **振る舞いの歯（`usage.test.ts` の「起動を2回通す」）だけでは足りない。**
 * あちらは `usage_daily` の1件を見るもので、**別のテーブルで同じ形を作ったら
 * 何も言わない。** ここは配列の全体を1つの規則で見るので、次に誰かが
 * `drop index` を足したときに、その場で落ちる。
 */
describe('migrate の配列（起動のたびに頭から通るもの）', () => {
  /** `create [unique] index if not exists <名前>` の名前。 */
  function createdIndexNames(statement: string): string[] {
    return [
      ...statement.matchAll(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+(\w+)/gi),
    ].map((match) => match[1] as string);
  }

  /** `drop index if exists <名前>` の名前。 */
  function droppedIndexNames(statement: string): string[] {
    return [...statement.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?(\w+)/gi)].map(
      (match) => match[1] as string,
    );
  }

  it('drop する索引を、同じ配列のどこかで create していない（2周目が作りに戻らない）', () => {
    const dropped = new Set(STATEMENTS.flatMap(droppedIndexNames));
    const created = new Set(STATEMENTS.flatMap(createdIndexNames));

    // **前後は問わない。** create が drop より前でも後でも、配列は毎回頭から
    // 通るので同じ事故になる（後ろに置けば「作って残す」つもりが drop され、
    // 前に置けば「消したはずのものを作りに戻る」）。名前が両方に出た時点で誤り。
    const both = [...dropped].filter((name) => created.has(name));
    expect(both).toEqual([]);
  });

  /**
   * 上のテストが**測れていることの確認ではない**（それは変異試験の仕事）。
   * ここが見るのは「この歯が空振りしていないか」— drop も create も1つも
   * 拾えていない正規表現なら、上は常に緑になる。
   */
  it('歯が実際に文を拾えている（正規表現が空振りしていない）', () => {
    expect(STATEMENTS.flatMap(droppedIndexNames)).toContain('usage_daily_key_idx');
    expect(STATEMENTS.flatMap(createdIndexNames)).toContain('usage_daily_token_key_idx');
  });
});

/**
 * `archive` の指紋・連続性判定の3列（`body_chars` / `body_md5` /
 * `continuity`。#698）の追加は2回通しても壊れない。
 *
 * **⚠️ 同じ入り口を2回呼ぶだけでは測ったことにならない**（AGENTS.md
 * 「2回通しても壊れないを測るテストは…『2周目でだけ壊れる状態』を挟む
 * こと」）——1周目（`beforeEach` の `migrate(db)`）の後に**実際に3列へ値の
 * 入った行を積んでから**2周目を当てる。`alter table ... add column
 * if not exists` は列が既に在れば2周目は本当の no-op になるはずだが、それを
 * 「空の DB に対して2回通す」だけで確かめると、`usage_daily_key_idx` の事故
 * （`migrate.ts` 冒頭の doc）と同じ形で見落とす。
 */
describe('migrate（archive の指紋・連続性列。#698）', () => {
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

  it('body_chars / body_md5 / continuity に値が入った行が、2周目のあとも生き残る', async () => {
    await db.insert(archive).values({
      id: 'session-migrate-continuity-1.jsonl',
      sessionId: 'session-migrate-continuity',
      at: new Date('2026-09-12T00:00:00.000Z'),
      body: 'BODY\n',
      bodyChars: 5,
      bodyMd5: 'deadbeefdeadbeefdeadbeefdeadbeef',
      continuity: 'continues',
    });

    // 2周目——3列に値が入った行が実在する状態で当てる。
    await migrate(db);

    const rows = await db
      .select({
        bodyChars: archive.bodyChars,
        bodyMd5: archive.bodyMd5,
        continuity: archive.continuity,
      })
      .from(archive)
      .where(eq(archive.id, 'session-migrate-continuity-1.jsonl'));
    expect(rows).toEqual([
      { bodyChars: 5, bodyMd5: 'deadbeefdeadbeefdeadbeefdeadbeef', continuity: 'continues' },
    ]);
  });
});
