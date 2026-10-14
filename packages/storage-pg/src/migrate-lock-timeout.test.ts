import { describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import {
  AUTH_ACCOUNTS_EMAIL_LOWER_INDEX,
  migrate,
  OPEN_MANAGER_BODY_INDEX,
  STATEMENTS,
} from './migrate.js';
import { createEmptyTestDb } from './test-db.test-support.js';

// マイグレーションの文ごとにロックの待ちへ上限を掛け、取れなければ挑み直す（#4747）

// 指定の文の1回目だけ、指定の SQLSTATE で落とす（トランザクションの中の execute も横取りする）
function failingOnce(db: Db, statement: string, code: string): { db: Db; failed: () => number } {
  let failed = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === 'execute') {
          return (query: Parameters<Db['execute']>[0]) => {
            const text = (query as { queryChunks?: { value?: string[] }[] }).queryChunks
              ?.flatMap((chunk) => chunk.value ?? [])
              .join('');
            if (text === statement && failed === 0) {
              failed += 1;
              return Promise.reject(
                Object.assign(new Error(`仕込んだ失敗（code=${code}）`), { cause: { code } }),
              );
            }
            return (inner as unknown as Db).execute(query);
          };
        }
        if (property === 'transaction') {
          return (run: (tx: Db) => Promise<unknown>) =>
            (inner as unknown as Db).transaction((tx) => run(wrap(tx as unknown as Db)));
        }
        return Reflect.get(inner, property, receiver) as unknown;
      },
    });
  return { db: wrap(db), failed: () => failed };
}

// 文の頭で当てる版: 索引づくりの文は定数として外へ出していないため
function failingOnceWhere(
  db: Db,
  matches: (text: string) => boolean,
  code: string,
): { db: Db; failed: () => number } {
  let failed = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === 'execute') {
          return (query: Parameters<Db['execute']>[0]) => {
            const text = (query as { queryChunks?: { value?: string[] }[] }).queryChunks
              ?.flatMap((chunk) => chunk.value ?? [])
              .join('');
            if (text !== undefined && matches(text) && failed === 0) {
              failed += 1;
              return Promise.reject(
                Object.assign(new Error(`仕込んだ失敗（code=${code}）`), { cause: { code } }),
              );
            }
            return (inner as unknown as Db).execute(query);
          };
        }
        if (property === 'transaction') {
          return (run: (tx: Db) => Promise<unknown>) =>
            (inner as unknown as Db).transaction((tx) => run(wrap(tx as unknown as Db)));
        }
        return Reflect.get(inner, property, receiver) as unknown;
      },
    });
  return { db: wrap(db), failed: () => failed };
}

const ALTER = STATEMENTS.find((statement) => statement.startsWith('alter table memory'))!;

describe('migrate のロックの待ちと挑み直し（#4747）', () => {
  it('⭐ ロックが取れない（55P03）文は、少し置いて挑み直し、通れば警告を残して最後まで流す', async () => {
    const { db } = await createEmptyTestDb();
    const probe = failingOnce(db, ALTER, '55P03');
    const lines: string[] = [];

    await migrate(probe.db, (line) => lines.push(line), { retryDelayMs: 1 });

    expect(probe.failed()).toBe(1);
    expect(lines.join('')).toContain('code=55P03');
  });

  it('⭐ 2つのデーモンの同時の初回の競合（23505）も挑み直す', async () => {
    const { db } = await createEmptyTestDb();
    const probe = failingOnce(db, STATEMENTS[0]!, '23505');
    await migrate(probe.db, () => undefined, { retryDelayMs: 1 });
    expect(probe.failed()).toBe(1);
  });

  it('挑み直さない失敗（構文の誤りなど）は、そのまま投げる', async () => {
    const { db } = await createEmptyTestDb();
    const probe = failingOnce(db, ALTER, '42601');
    await expect(migrate(probe.db, () => undefined, { retryDelayMs: 1 })).rejects.toThrow(
      'code=42601',
    );
  });

  // 索引づくりの2関数の文も同じ道を通す（#4768）: 外に残すと、同時の初回で catalog の一意違反が出て起動が落ちるため
  for (const index of [AUTH_ACCOUNTS_EMAIL_LOWER_INDEX, OPEN_MANAGER_BODY_INDEX]) {
    it(`⭐ ${index} の作成が同時の初回の競合（23505）で落ちても挑み直す（#4768）`, async () => {
      const { db } = await createEmptyTestDb();
      const probe = failingOnceWhere(
        db,
        (text) => text.startsWith(`create unique index if not exists ${index}`),
        '23505',
      );
      await migrate(probe.db, () => undefined, { retryDelayMs: 1 });
      expect(probe.failed()).toBe(1);
    });
  }
});
