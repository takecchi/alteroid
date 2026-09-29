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

/**
 * `usage_daily` の `unreadable_*` 6列の追加（Issue #2086）は2回通しても壊れない。
 *
 * **`archive の指紋・連続性列` と同じ形の歯。** 1周目（`beforeEach` の
 * `migrate(db)`）の後に実際に列へ値の入った行を `PgUsageStore.record` で
 * 積んでから2周目を当てる——空の DB に対して2回通すだけでは、列が既に
 * 埋まった状態での `add column if not exists` が本当に no-op かを見落とす。
 */
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

    // 2周目——unreadable 列に値が入った行が実在する状態で当てる。
    await migrate(db);

    // 2周目のあとも、加算の upsert が引き続き効くこと（列が壊れて0スタートに
    // 戻っていないこと）を確かめる。
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

/**
 * `archive` の autovacuum の reloptions（#698）。
 *
 * **`toast.` の付いた2行が、TOAST 側の `reloptions` に載っているかがこの歯の
 * 要点である。** 親の `alter table ... set (...)` は親の `pg_class.reloptions`
 * にしか効かず、TOAST 側は既定で継承しない（`migrate.ts` の #698 の doc）。
 * 親だけ見るテストは「`toast.` を書き忘れて親だけ効いている」を緑のまま通す
 * ので、TOAST 側を別に引く。
 */
describe('migrate（archive の autovacuum reloptions。#698）', () => {
  let client: PGlite;
  let db: Db;

  /** `archive` の親と TOAST、両方の `reloptions` を引く。 */
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
    // ⭐ ここが要点 —— TOAST 側にも載っている（親に書いただけでは載らない）。
    expect(toast).toEqual(
      expect.arrayContaining([
        'autovacuum_vacuum_threshold=10000',
        'autovacuum_vacuum_scale_factor=0.0',
      ]),
    );
  });

  /**
   * **2周目でだけ壊れる状態を挟む**（`migrate.ts` 冒頭の doc と同じ作法）。
   * `alter table ... set (...)` は create/drop index の罠には当たらないが、
   * 「1周目の後に実データが積まれた状態」で2周目を当てても落ちないこと、
   * かつ reloptions が変わらず載ったままであることを、実行で固定する。
   */
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

/**
 * **`commitments_open_manager_body_idx`（#1041）だけは無条件に当てられない。**
 *
 * `STATEMENTS` は起動のたびに頭から通る。既存の重複行が1組でも在ると
 * `create unique index` は `could not create unique index` で落ちるので、この文を
 * 配列へ置けば**デーモンが二度と上がらなくなる**（2026-08-25 に `usage_daily_key_idx`
 * で実際に起きた形。`migrate.ts` 冒頭の doc）。だから `ensureOpenManagerBodyIndex`
 * が重複を数えてから作る。
 *
 * **ここで測るのは「落ちないこと」だけではない。** 索引を作らずに進んだことが
 * **逐語で外へ出ている**ことまで測る —— 出ていなければ、DB が拒む段が無い状態で
 * 運用へ出たことに誰も気づけない。
 *
 * ⚠️ **「重複を器が畳んで索引を作る」形は採っていない**（`ensureOpenManagerBodyIndex`
 * の doc）。クローンが閉じていない行を器が閉じたら、閉じた行は未了の一覧から消える
 * ので、クローンはそれに気づけない。
 */
describe('migrate（台帳の畳み込みの索引。#1041）', () => {
  // **既定の 5s では足りない。** 他の migrate の歯は `beforeEach`（hookTimeout は
  // 10s）で1周目を通すが、ここは警告の逐語と索引の在り無しを制御するため
  // `migrate` を本体で通す。PGlite の起動と migrate を全体の並列実行の中で
  // 走らせると 5s を超えることがあり、実際に全体を回して踏んだ。
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

  /**
   * **索引が在るなら、台帳を1行も走査しない。**
   *
   * `migrate` は起動のたびに通る。`findOpenManagerBodyDuplicates` は未了の全行を
   * group by するので、索引が在る（＝重複はもう作れない）状態でも毎回走らせると、
   * **起動の費用が台帳の齢に比例して増える。** 実際、全体を並列で回したときに
   * `beforeEach`（`new PGlite()` + `migrate`）が既定の 10s を超えて落ちた。
   *
   * **測り方は「走査する問い合わせを発行したら落ちる `db`」を渡すことである。**
   * 「速いこと」を時間で測ると器の混み具合で揺れるので、**発行そのものの有無**を
   * 見る（揺れない）。
   */
  it('⭐ 索引が在るなら、重複を数える問い合わせを発行しない（起動の費用を台帳の齢に比例させない）', async () => {
    await migrate(db);

    let scanned = false;
    const watched = {
      ...db,
      execute: (query: unknown) => {
        // 走査の問い合わせだけを見分ける（`pg_class` を引くほうは通す）
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
    // 1周目は空の DB なので索引が作られる。**その索引を消してから重複を積む**
    // ——「#1035 以前に積まれた重複を持つ DB が、この変更を初めて受け取る」を模す。
    await migrate(db);
    await db.execute(sql.raw(`drop index ${OPEN_MANAGER_BODY_INDEX}`));
    await managerRow('dup-a', '同じ一言');
    await managerRow('dup-b', '同じ一言');
    await managerRow('single', '別の一言');

    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));

    // 落ちない。しかし索引は作られていない。
    expect(await indexExists()).toBe(false);
    // **件数と id が逐語で出ている**（人間がその行を読んで自分で決める材料）。
    expect(warnings.join('')).toContain('1 組 / 2 行');
    expect(warnings.join('')).toContain('dup-a, dup-b');
    expect(warnings.join('')).toContain(OPEN_MANAGER_BODY_INDEX);
    // 重複していない行は警告に出さない（読む側の材料を薄めない）
    expect(warnings.join('')).not.toContain('single');
    // ⛔ 器が勝手に閉じていない（3行とも未了のまま）
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

    // 人間が片方を閉じた、を模す（器ではなく人間が決めた）
    await db
      .update(commitments)
      .set({ closedAt: new Date('2026-09-18T00:00:00.000Z') })
      .where(eq(commitments.id, 'dup-b'));

    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));
    expect(await indexExists()).toBe(true);
    expect(warnings).toEqual([]);
  }, 30_000);

  /**
   * **2周目でだけ壊れる状態を挟む**（`migrate.ts` 冒頭の doc と、直上の
   * `archive` の歯と同じ作法）。索引が既に在る DB に、その索引が許した行
   * （＝同じ source の別本文）を積んでから、もう一度 `migrate` を通す。
   */
  it('索引が在る DB に行を積んでから2周目を通しても落ちない', async () => {
    await migrate(db);
    await managerRow('row-1', '一言め');
    await managerRow('row-2', '二言め');
    await migrate(db);
    expect(await indexExists()).toBe(true);
  }, 30_000);
});

/**
 * **`auth_accounts_email_lower_idx`（メールの大小文字を区別しない一意索引。issue #1702）。**
 *
 * `commitments_open_manager_body_idx`（#1041、直上）と同じ形の判断——既存の
 * 重複行が1組でも在ると `create unique index` は落ちるので、この文を
 * `STATEMENTS` に無条件で置けば**デーモンが二度と上がらなくなる**。
 * `ensureAuthAccountsEmailLowerIndex` が重複を数えてから作る。
 *
 * ここでの重複は「大小文字だけが違う検証済みメールを持つ2アカウント」——
 * #1702 以前（旧索引 `auth_accounts_email_idx` だけが在り、大小文字を区別する）
 * の DB にだけ実在しうる状態である。**旧形式の DB は自分で作る**（`makeOldFormatDb`）
 * ——空の DB へ `migrate` を通すと新索引がいきなり作られてしまい、この状態を
 * 再現できない（AGENTS.md「2回通しても壊れないを測るテストは…状態を挟む」と
 * 同じ理由——ここで挟むのは「新索引ができる前の、旧索引だけの状態」である）。
 */
describe('migrate（auth_accounts のメール大小文字索引。#1702）', () => {
  let client: PGlite;
  let db: Db;

  /** #1702 で `AUTH_ACCOUNTS_EMAIL_LOWER_INDEX` へ差し替えられた旧索引の名前。 */
  const OLD_INDEX = 'auth_accounts_email_idx';

  const indexExists = async (name: string): Promise<boolean> => {
    const result = await db.execute(sql`select 1 from pg_class where relname = ${name}`);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length > 0;
  };

  /**
   * **#1702 以前の DB（旧索引だけが在る）を自分で作る。** `migrate` を素直に
   * 通すと新索引がその場で作られてしまうので、通した直後に新索引を drop し、
   * 旧索引（大小文字を区別する、`email` だけの鍵）を手で作り直す。
   */
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

    // 落ちない。しかし新索引は作られておらず、旧索引は残ったまま。
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(false);
    expect(await indexExists(OLD_INDEX)).toBe(true);

    const warned = warnings.join('');
    expect(warned).toContain('1 組 / 2 行');
    expect(warned).toContain('acc-a, acc-b');
    expect(warned).toContain(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX);
    expect(warned).toContain('#1702');
    // メールアドレスそのものはログに出さない（個人情報をログへ出さない）。
    expect(warned).not.toContain('alice@example.test');
    expect(warned).not.toContain('ALICE@EXAMPLE.TEST');

    // ⛔ 器が勝手に統合・削除していない（2行とも無傷のまま）
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
    await migrate(db); // まだ重複がある → 何も変わらない
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(false);

    // 人間が重複を直した、を模す（器ではなく人間が決めた）
    await db.update(authAccounts).set({ email: null }).where(eq(authAccounts.id, 'acc-b'));

    const warnings: string[] = [];
    await migrate(db, (line) => warnings.push(line));
    expect(await indexExists(AUTH_ACCOUNTS_EMAIL_LOWER_INDEX)).toBe(true);
    expect(await indexExists(OLD_INDEX)).toBe(false);
    expect(warnings).toEqual([]);
  }, 30_000);

  /**
   * **2周目でだけ壊れる状態を挟む**（`migrate.ts` 冒頭の doc と同じ作法）。
   * 新索引ができた後に `migrate` をさらに2回通しても落ちないこと、そして
   * 新索引が実際に効いていること（大小文字違いの行を `putAccount` すると DB が
   * 拒むこと）までを確かめる——索引の有無だけを見るテストでは「作られたが
   * 実は何も強制していない」を見落とす。
   */
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
    // acc-a はまだ alice@example.test を持っている。大小文字だけが違う
    // メールを持つ新しいアカウントを putAccount すると、新索引が拒むはず。
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
