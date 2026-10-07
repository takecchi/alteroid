// pglite-prepay: not-needed（migrate そのものを測るので、各テストが冷えた new PGlite() から全 migrate を自分で流す。雛形は共有できず、前払いで消せる固定費が無い。#3034）
import { ZERO_USAGE } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PgAuthStore } from './auth.js';
import type { Db } from './db.js';
import {
  AUTH_ACCOUNTS_EMAIL_LOWER_INDEX,
  ensureOpenManagerBodyIndex,
  migrate,
  OPEN_MANAGER_BODY_INDEX,
  STATEMENTS,
} from './migrate.js';
import { archive, authAccounts, commitments } from './schema.js';
import { PgUsageStore } from './usage.js';

describe('migrate の配列（起動のたびに頭から通るもの）', () => {
  function createdIndexNames(statement: string): string[] {
    return [
      ...statement.matchAll(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+(\w+)/gi),
    ].map((match) => match[1] as string);
  }

  function droppedIndexNames(statement: string): string[] {
    return [...statement.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?(\w+)/gi)].map(
      (match) => match[1] as string,
    );
  }

  it('drop する索引を、同じ配列のどこかで create していない（2周目が作りに戻らない）', () => {
    const dropped = new Set(STATEMENTS.flatMap(droppedIndexNames));
    const created = new Set(STATEMENTS.flatMap(createdIndexNames));

    const both = [...dropped].filter((name) => created.has(name));
    expect(both).toEqual([]);
  });

  it('歯が実際に文を拾えている（正規表現が空振りしていない）', () => {
    expect(STATEMENTS.flatMap(droppedIndexNames)).toContain('usage_daily_key_idx');
    expect(STATEMENTS.flatMap(createdIndexNames)).toContain('usage_daily_token_key_idx');
  });
});

// 空の DB に2回通すだけにしない: 2周目でだけ壊れる状態（実際に3列へ値の入った行）を挟まないと、`usage_daily_key_idx` の事故と同じ形で見落とすため。
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

describe('migrate（usage_daily の unreadable 列。#2086）', () => {
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

  it('unreadable_* に値が入った行が2周目のあとも生き残り、以後の record でも足し込みが続く', async () => {
    const store = new PgUsageStore(db);
    await store.record({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-09-29',
      at: '2026-09-29T10:00:00.000Z',
      accumulation: 'cumulative',
      snapshot: { models: { opus: { ...ZERO_USAGE, costUsd: 1, unreadable: { inputTokens: 1 } } } },
    });

    await migrate(db);

    await store.record({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-09-29',
      at: '2026-09-29T11:00:00.000Z',
      accumulation: 'cumulative',
      snapshot: { models: { opus: { ...ZERO_USAGE, costUsd: 2, unreadable: { inputTokens: 1 } } } },
    });

    const { rows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals).toEqual({ ...ZERO_USAGE, costUsd: 2, unreadable: { inputTokens: 2 } });
  });
});

// 親だけ見ない: `toast.` を書き忘れて親だけ効いている状態を緑のまま通すため、TOAST 側の `reloptions` を別に引く。
describe('migrate（archive の autovacuum reloptions。#698）', () => {
  let client: PGlite;
  let db: Db;

  const archiveReloptions = async (): Promise<{
    parent: string[] | null;
    toast: string[] | null;
  }> => {
    const result = await db.execute(sql`
      select c.reloptions as parent_reloptions, t.reloptions as toast_reloptions
      from pg_class c
      left join pg_class t on t.oid = c.reltoastrelid
      where c.oid = 'archive'::regclass
    `);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    const row = rows[0] as
      { parent_reloptions: string[] | null; toast_reloptions: string[] | null } | undefined;
    return { parent: row?.parent_reloptions ?? null, toast: row?.toast_reloptions ?? null };
  };

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('親と TOAST の reloptions に、狙った値が実際に載っている', async () => {
    const { parent, toast } = await archiveReloptions();
    expect(parent).toEqual(
      expect.arrayContaining([
        'autovacuum_vacuum_threshold=50',
        'autovacuum_vacuum_scale_factor=0.0',
        'autovacuum_analyze_threshold=50',
        'autovacuum_analyze_scale_factor=0.0',
      ]),
    );
    expect(toast).toEqual(
      expect.arrayContaining([
        'autovacuum_vacuum_threshold=10000',
        'autovacuum_vacuum_scale_factor=0.0',
      ]),
    );
  });

  it('データが積まれた状態で2周目を通しても落ちず、reloptions は載ったまま', async () => {
    await db.insert(archive).values({
      id: 'session-migrate-reloptions-1.jsonl',
      sessionId: 'session-migrate-reloptions',
      at: new Date('2026-09-22T00:00:00.000Z'),
      body: 'BODY\n',
    });

    await migrate(db);

    const { parent, toast } = await archiveReloptions();
    expect(parent).toEqual(expect.arrayContaining(['autovacuum_vacuum_scale_factor=0.0']));
    expect(toast).toEqual(expect.arrayContaining(['autovacuum_vacuum_scale_factor=0.0']));

    const rows = await db
      .select({ id: archive.id })
      .from(archive)
      .where(eq(archive.id, 'session-migrate-reloptions-1.jsonl'));
    expect(rows).toHaveLength(1);
  });
});

describe('migrate（台帳の畳み込みの索引。#1041）', () => {
  // 既定の 5s にしない: `migrate` を本体で通し、並列実行の中で PGlite の起動と migrate が 5s を超えることがあるため。
  let client: PGlite;
  let db: Db;

  const managerRow = (id: string, body: string, source = 'mgr-1') =>
    db.insert(commitments).values({
      id,
      at: new Date('2026-09-17T00:00:00.000Z'),
      closedAt: null,
      commitment: { id, at: '2026-09-17T00:00:00.000Z', origin: 'manager', source, body },
    });

  const indexExists = async (): Promise<boolean> => {
    const result = await db.execute(
      sql`select 1 from pg_class where relname = ${OPEN_MANAGER_BODY_INDEX}`,
    );
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length > 0;
  };

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client);
  });

  afterEach(async () => {
    await client.close();
  });

  it('重複が無ければ索引を作る（警告は出さない）', async () => {
    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));
    expect(await indexExists()).toBe(true);
    expect(warnings).toEqual([]);
  }, 30_000);

  // 時間で測らない: 器の混み具合で揺れるため、走査する問い合わせを発行したら落ちる `db` を渡して発行の有無を見る。
  it('⭐ 索引が在るなら、重複を数える問い合わせを発行しない（起動の費用を台帳の齢に比例させない）', async () => {
    await migrate(db);

    let scanned = false;
    const watched = {
      ...db,
      execute: (query: unknown) => {
        const text = JSON.stringify(query);
        if (text.includes('group by')) {
          scanned = true;
          throw new Error('索引が在るのに台帳を走査した');
        }
        return db.execute(query as never);
      },
    } as unknown as Db;

    await ensureOpenManagerBodyIndex(watched, () => undefined);
    expect(scanned).toBe(false);
  }, 30_000);

  it('⭐ 既存の重複行が在っても migrate は落ちない —— 索引を作らず、件数と id を逐語で警告する', async () => {
    await migrate(db);
    await db.execute(sql.raw(`drop index ${OPEN_MANAGER_BODY_INDEX}`));
    await managerRow('dup-a', '同じ一言');
    await managerRow('dup-b', '同じ一言');
    await managerRow('single', '別の一言');

    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));

    expect(await indexExists()).toBe(false);
    expect(warnings.join('')).toContain('1 組 / 2 行');
    expect(warnings.join('')).toContain('dup-a, dup-b');
    expect(warnings.join('')).toContain(OPEN_MANAGER_BODY_INDEX);
    expect(warnings.join('')).not.toContain('single');
    const rows = await db.select({ id: commitments.id }).from(commitments);
    expect(rows).toHaveLength(3);
    const open = await db
      .select({ id: commitments.id })
      .from(commitments)
      .where(isNull(commitments.closedAt));
    expect(open).toHaveLength(3);
  }, 30_000);

  it('⭐ 重複が片付けば、次の起動で索引は黙って作られる', async () => {
    await migrate(db);
    await db.execute(sql.raw(`drop index ${OPEN_MANAGER_BODY_INDEX}`));
    await managerRow('dup-a', '同じ一言');
    await managerRow('dup-b', '同じ一言');
    await migrate(db, () => undefined);
    expect(await indexExists()).toBe(false);

    await db
      .update(commitments)
      .set({ closedAt: new Date('2026-09-18T00:00:00.000Z') })
      .where(eq(commitments.id, 'dup-b'));

    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));
    expect(await indexExists()).toBe(true);
    expect(warnings).toEqual([]);
  }, 30_000);

  it('索引が在る DB に行を積んでから2周目を通しても落ちない', async () => {
    await migrate(db);
    await managerRow('row-1', '一言め');
    await managerRow('row-2', '二言め');
    await migrate(db);
    expect(await indexExists()).toBe(true);
  }, 30_000);
});

describe('migrate（auth_accounts のメール大小文字索引。#1702）', () => {
  let client: PGlite;
  let db: Db;

  const OLD_INDEX = 'auth_accounts_email_idx';

  const indexExists = async (name: string): Promise<boolean> => {
    const result = await db.execute(sql`select 1 from pg_class where relname = ${name}`);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length > 0;
  };

  // `migrate` を素直に通さない: 新索引がその場で作られてしまい、旧索引だけの状態を再現できないため。
  const makeOldFormatDb = async (): Promise<void> => {
    await migrate(db);
    await db.execute(sql.raw(`drop index if exists ${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX}`));
    await db.execute(
      sql.raw(`create unique index if not exists ${OLD_INDEX} on auth_accounts (email)`),
    );
  };

  const insertAccount = (id: string, email: string | null) =>
    db.insert(authAccounts).values({ id, email, createdAt: new Date('2026-09-27T00:00:00.000Z') });

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client);
  });

  afterEach(async () => {
    await client.close();
  });

  it('空の DB から migrate すると、新索引が在り旧索引は無い', async () => {
    await migrate(db);
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(true);
    expect(await indexExists(OLD_INDEX)).toBe(false);
  }, 30_000);

  it('⭐ 旧形式の DB に大小文字だけ違う2行があっても migrate は落ちない —— 索引を作らず、件数と id を逐語で警告する（メールは載せない）', async () => {
    await makeOldFormatDb();
    await insertAccount('acc-a', 'alice@example.test');
    await insertAccount('acc-b', 'ALICE@EXAMPLE.TEST');

    const warnings: string[] = [];
    await expect(migrate(db, (line) => warnings.push(line))).resolves.toBeUndefined();

    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(false);
    expect(await indexExists(OLD_INDEX)).toBe(true);

    const warned = warnings.join('');
    expect(warned).toContain('1 組 / 2 行');
    expect(warned).toContain('acc-a, acc-b');
    expect(warned).toContain(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX);
    expect(warned).toContain('#1702');
    expect(warned).not.toContain('alice@example.test');
    expect(warned).not.toContain('ALICE@EXAMPLE.TEST');

    const rows = await db
      .select({ id: authAccounts.id, email: authAccounts.email })
      .from(authAccounts);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 'acc-a')?.email).toBe('alice@example.test');
    expect(rows.find((row) => row.id === 'acc-b')?.email).toBe('ALICE@EXAMPLE.TEST');
  }, 30_000);

  it('⭐ 重複が片付けば（片方のメールを空にする）、次の起動で新索引が在り旧索引は無くなる', async () => {
    await makeOldFormatDb();
    await insertAccount('acc-a', 'alice@example.test');
    await insertAccount('acc-b', 'ALICE@EXAMPLE.TEST');
    await migrate(db);
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(false);

    await db.update(authAccounts).set({ email: null }).where(eq(authAccounts.id, 'acc-b'));

    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(true);
    expect(await indexExists(OLD_INDEX)).toBe(false);
    expect(warnings).toEqual([]);
  }, 30_000);

  it('新索引ができた後に migrate をさらに2回通しても落ちず、大小文字違いは putAccount を DB が拒む', async () => {
    await makeOldFormatDb();
    await insertAccount('acc-a', 'alice@example.test');
    await insertAccount('acc-b', 'ALICE@EXAMPLE.TEST');
    await migrate(db);
    await db.update(authAccounts).set({ email: null }).where(eq(authAccounts.id, 'acc-b'));
    await migrate(db);
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(true);

    await expect(migrate(db)).resolves.toBeUndefined();
    await expect(migrate(db)).resolves.toBeUndefined();
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(true);
    expect(await indexExists(OLD_INDEX)).toBe(false);

    const store = new PgAuthStore(db);
    await expect(
      store.putAccount({
        id: 'acc-c',
        displayName: null,
        email: 'ALICE@EXAMPLE.TEST',
        createdAt: '2026-09-27T00:00:02.000Z',
        lastLoginAt: null,
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      }),
    ).rejects.toThrow();
  }, 30_000);
});
