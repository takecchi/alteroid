import { describe, expect, it } from 'vitest';

import { collapseErrorCause } from './error-cause.js';

/**
 * `Error.prototype.cause` の連鎖を1行へ畳む（Issue #1229）。
 *
 * ⭐ **受け入れ基準3が逐語で言う「歯は落ちた理由が伝わることを測ること。
 * 例外が投げられた、ではない」をここで直接測る。** `.cause` に SQLSTATE
 * （`code`）を持つ疑似エラー（`DrizzleQueryError` → node-postgres の
 * `DatabaseError` の実際の形を模したもの）を食わせて、返る1行に SQLSTATE と
 * その他の識別子が実際に出ることを見る——「投げた／投げなかった」ではなく
 * **文字列として何が載るか**を固定する。
 */
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

  it('200字を超える1行は…付きで切る', () => {
    const result = collapseErrorCause(new Error('x'.repeat(500)));
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(230);
  });

  /**
   * **本体: `DrizzleQueryError`（drizzle-orm@0.45.2）が node-postgres の
   * `DatabaseError` を `.cause` に持つ、という実際の形を模す。**
   * `errors.js`（`node_modules/.../drizzle-orm/errors.js`）の実装は
   * `this.cause = cause` を素通しするだけなので、`cause` は node-postgres
   * が投げるオブジェクトそのものである——`pg-protocol/src/parser.ts` の
   * `parseErrorMessage` が `severity` / `code` / `detail` / `hint` /
   * `internalPosition` / `internalQuery` / `where` / `schema` / `table` /
   * `column` / `dataType` / `constraint` / `file` / `line` / `routine` を
   * 生の `Error` インスタンスへ直接生やす（実測。このファイルの
   * `error-cause.ts` の doc にある通り）。
   */
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
    error.name = 'error'; // node-postgres の DatabaseError は name='error' で来る（実測）
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
      // **detail は行の値そのものを転記する**（PostgreSQL の一意制約違反の
      // 定型文）——ここに絶対に出てはいけない偽の「値」を置く。
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

    // SQLSTATE と構造化フィールドが出る。
    expect(result).toContain('code=23505');
    expect(result).toContain('constraint=journal_pkey');
    expect(result).toContain('table=journal');
    expect(result).toContain('schema=public');
    expect(result).toContain('severity=ERROR');

    // ⛔ detail / hint / where / internalQuery の値は出ない。
    expect(result).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(result).not.toContain('ここにも値が来ることがある');
    expect(result).not.toContain('PL/pgSQL 関数');
    expect(result).not.toContain('select * from journal where id');

    // ⛔ drizzle 側の params 行（本物の insert 値）も出ない。
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
    // 一番深い（最初に作った）段は出ない——上限で切れている証拠。
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
