import { describe, expect, it } from 'vitest';

import { collapseErrorCause } from './error-cause.js';

/** 孤立サロゲート（高だけ・低だけ）。`isWellFormed()` は tsconfig の lib に無いので直接探す。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('collapseErrorCause', () => {
  it('.cause を持たない error は name: message の1行目・200字切りのまま（reasonOf の既存契約を変えない）', () => {
    const result = collapseErrorCause(new Error('boom'));
    expect(result).toBe('Error: boom');
  });

  it('2行目のメッセージ（drizzle の params 行）は出さない——1行目だけを取る', () => {
    const result = collapseErrorCause(new Error('Failed query: select 1\nparams: SECRET-VALUE'));
    expect(result).toContain('Failed query: select 1');
    expect(result).not.toContain('SECRET-VALUE');
    expect(result).not.toContain('params:');
  });

  it('1段目の切り口が絵文字をまたいでも、孤立サロゲートを残さない', () => {
    for (let lead = 192; lead <= 200; lead += 1) {
      const result = collapseErrorCause(new Error(`${'あ'.repeat(lead)}😀😀`));
      expect(result.endsWith('…'), `lead=${lead}`).toBe(true);
      expect(LONE_SURROGATE.test(result), `lead=${lead}`).toBe(false);
    }
  });

  it('.cause の段と構造化欄の切り口が絵文字をまたいでも、孤立サロゲートを残さない', () => {
    for (let lead = 50; lead <= 125; lead += 1) {
      const cause = Object.assign(new Error(`${'あ'.repeat(lead)}😀😀`), {
        table: `${'あ'.repeat(lead)}😀😀`,
      });
      const result = collapseErrorCause(new Error('outer', { cause }));
      expect(LONE_SURROGATE.test(result), `lead=${lead}`).toBe(false);
    }
  });

  it('200字を超える1行は…付きで切る', () => {
    const result = collapseErrorCause(new Error('x'.repeat(500)));
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(230);
  });

  function fakeDrizzleQueryError(sql: string, params: string, pgError: Error): Error {
    const queryError = new Error(`Failed query: ${sql}\nparams: ${params}`);
    queryError.name = 'DrizzleQueryError';
    (queryError as { cause?: unknown }).cause = pgError;
    return queryError;
  }

  function fakeDatabaseError(fields: {
    message: string;
    code: string;
    constraint?: string;
    table?: string;
    schema?: string;
    column?: string;
    routine?: string;
    severity?: string;
    detail?: string;
    hint?: string;
    where?: string;
    internalQuery?: string;
  }): Error {
    const error = new Error(fields.message);
    error.name = 'error';
    Object.assign(error, fields);
    return error;
  }

  it('SQLSTATE（一意制約違反 23505）が、本文にも stderr 側にも出せる形で返る。detail の値は出さない', () => {
    const pgError = fakeDatabaseError({
      message: 'duplicate key value violates unique constraint "journal_pkey"',
      code: '23505',
      constraint: 'journal_pkey',
      table: 'journal',
      schema: 'public',
      severity: 'ERROR',
      detail: 'Key (id)=(11111111-2222-3333-4444-555555555555) already exists.',
      hint: 'ここにも値が来ることがある',
      where: 'PL/pgSQL 関数 foo() 内',
      internalQuery: 'select * from journal where id = $1',
    });
    const drizzleError = fakeDrizzleQueryError(
      'insert into "journal" ("seq", "id", "at", "type", "entry") values (default, $1, $2, $3, $4)',
      '["e6f5...","2026-09-18T18:23:33.000Z","decision","REAL ROW VALUE"]',
      pgError,
    );

    const result = collapseErrorCause(drizzleError);

    expect(result).toContain('code=23505');
    expect(result).toContain('constraint=journal_pkey');
    expect(result).toContain('table=journal');
    expect(result).toContain('schema=public');
    expect(result).toContain('severity=ERROR');

    expect(result).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(result).not.toContain('ここにも値が来ることがある');
    expect(result).not.toContain('PL/pgSQL 関数');
    expect(result).not.toContain('select * from journal where id');
    expect(result).not.toContain('REAL ROW VALUE');
  });

  it('トランザクション中断（25P02）でも code が出る', () => {
    const pgError = fakeDatabaseError({
      message: 'current transaction is aborted, commands ignored until end of transaction block',
      code: '25P02',
    });
    const drizzleError = fakeDrizzleQueryError(
      'insert into "approvals" (...) values (...)',
      '[]',
      pgError,
    );

    expect(collapseErrorCause(drizzleError)).toContain('code=25P02');
  });

  it('深さ上限（4段）を超えて連なっていても無限に伸びない', () => {
    let current = new Error('level-0');
    for (let i = 1; i <= 6; i += 1) {
      const next = new Error(`level-${i}`);
      (next as { cause?: unknown }).cause = current;
      current = next;
    }
    const result = collapseErrorCause(current);
    const levels = result.split(' <- ');
    expect(levels.length).toBeLessThanOrEqual(4);
    expect(result).not.toContain('level-0');
  });

  it('循環する cause でも無限ループしない', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;

    const result = collapseErrorCause(a);

    expect(result).toContain('循環');
  });

  it('Error でない値（文字列を投げた場合）でも落ちない', () => {
    expect(collapseErrorCause('boom')).toBe('boom');
    expect(collapseErrorCause(undefined)).toBe('');
    expect(collapseErrorCause(null)).toBe('');
  });

  it('構造化フィールドが数値・オブジェクトなど文字列でない場合は載せない（duck typing は string だけ）', () => {
    const error = new Error('weird');
    Object.assign(error, { code: 12345, constraint: { nested: true } });

    const result = collapseErrorCause(error);

    expect(result).toBe('Error: weird');
  });
});

describe('collapseErrorCause / 伏せ字（issue #2415）', () => {
  const FAKE = 'FAKE_SECRET_VALUE_2415B';

  it('drizzle の形（params が同じ行）: 値は出ず、SQL 文と印は残る', () => {
    const result = collapseErrorCause(
      new Error(`Failed query: insert into "t" ("a") values ($1) params: ${FAKE}`),
    );
    expect(result).not.toContain(FAKE);
    expect(result).toContain('Failed query: insert into "t" ("a") values ($1)');
    expect(result).toContain('params: [REDACTED]');
  });

  it('drizzle の形（params が2行目）: 値は出ない', () => {
    const result = collapseErrorCause(new Error(`Failed query: select 1\nparams: ${FAKE}`));
    expect(result).not.toContain(FAKE);
    expect(result).toContain('Failed query: select 1');
  });

  it('URL の資格: 値は出ず、host は残る', () => {
    const result = collapseErrorCause(new Error(`connect postgres://u:${FAKE}@db.internal:5432/x`));
    expect(result).not.toContain(FAKE);
    expect(result).toContain('db.internal:5432');
    expect(result).toContain('Error: connect postgres://u:[REDACTED]@');
  });

  it('Bearer: 値は出ない', () => {
    const result = collapseErrorCause(new Error(`401 Authorization: Bearer ${FAKE}`));
    expect(result).not.toContain(FAKE);
    expect(result).toContain('Bearer [REDACTED]');
  });

  it('cause の中の値も出ない（段ごとに伏せる）', () => {
    const cause = new Error(`connect postgres://u:${FAKE}@db.internal/x`);
    const result = collapseErrorCause(new Error('Failed query: select 1', { cause }));
    expect(result).not.toContain(FAKE);
    expect(result).toContain('Failed query: select 1');
    expect(result).toContain('db.internal');
  });

  it('Error でない値（文字列）も伏せる', () => {
    expect(collapseErrorCause(`Bearer ${FAKE}`)).not.toContain(FAKE);
  });

  it('切り口で割れる位置にトークンが来ても断片を残さない（伏せてから切る）', () => {
    const token = `ghp_${'1234567890abcdef1234567890abcdef1234'}`;
    const prefix = 'x'.repeat(200 - 10);
    const result = collapseErrorCause(new Error(`${prefix} ${token}`));
    expect(result).not.toContain('ghp_1234');
    expect(result).not.toContain('1234567890abcdef');
  });

  it('環境変数の値（秘密らしい名前・8文字以上）も伏せる', () => {
    const before = process.env.FAKE_2415B_API_TOKEN;
    process.env.FAKE_2415B_API_TOKEN = 'plain-fake-value-2415b';
    try {
      const result = collapseErrorCause(new Error('boom plain-fake-value-2415b end'));
      expect(result).not.toContain('plain-fake-value-2415b');
      expect(result).toContain('boom [REDACTED] end');
    } finally {
      if (before === undefined) delete process.env.FAKE_2415B_API_TOKEN;
      else process.env.FAKE_2415B_API_TOKEN = before;
    }
  });
});
