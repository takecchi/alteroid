import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { migrateOnBoot, STATEMENTS } from './migrate.js';
import { createEmptyTestDb } from './test-db.test-support.js';

// 起動のたびに、何もしない ALTER でテーブルの ACCESS EXCLUSIVE を取りに行かない（#4731）

// `execute` の呼び出しを横取りする。文はトランザクションの中で流す（#4747）ので、`transaction` の `tx` の呼び出しも同じく横取りする
function intercepting(db: Db, onExecute: (text: string | undefined) => Error | undefined): Db {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === 'execute') {
          return (query: Parameters<Db['execute']>[0]) => {
            const text = (query as { queryChunks?: { value?: string[] }[] }).queryChunks
              ?.flatMap((chunk) => chunk.value ?? [])
              .join('');
            const failure = onExecute(text);
            if (failure !== undefined) return Promise.reject(failure);
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
  return wrap(db);
}

// `STATEMENTS` の文が実際に発行された回数を数える（`ensure*` の索引の確かめは数えない）
function counting(db: Db): { db: Db; statements: () => number } {
  let count = 0;
  const wanted = new Set<string>(STATEMENTS);
  const proxied = intercepting(db, (text) => {
    if (text !== undefined && wanted.has(text)) count += 1;
    return undefined;
  });
  return { db: proxied, statements: () => count };
}

describe('migrateOnBoot（#4731）', () => {
  it('空の DB では、すべての文を流す', async () => {
    const { db } = await createEmptyTestDb();
    const probe = counting(db);
    await migrateOnBoot(probe.db, () => undefined);
    expect(probe.statements()).toBe(STATEMENTS.length);
  });

  it('⭐ 同じ文の一覧で流し済みなら、次の起動では文を1本も流さない', async () => {
    const { db } = await createEmptyTestDb();
    await migrateOnBoot(db, () => undefined);
    const probe = counting(db);
    await migrateOnBoot(probe.db, () => undefined);
    expect(probe.statements()).toBe(0);
  });

  it('⭐ 記録された指紋が今の文の一覧と違えば（版が変わった）、頭から流し直す', async () => {
    const { db } = await createEmptyTestDb();
    await migrateOnBoot(db, () => undefined);
    await db.execute(
      sql`update daemon_state set value = 'sha256-of-an-older-release' where key = 'schema_statements_sha256'`,
    );
    const probe = counting(db);
    await migrateOnBoot(probe.db, () => undefined);
    expect(probe.statements()).toBe(STATEMENTS.length);
  });

  it('途中の文で落ちたら指紋を書かず、次の起動でもう一度流す', async () => {
    const { db } = await createEmptyTestDb();
    let calls = 0;
    const failing = intercepting(db, () => {
      calls += 1;
      return calls === 5 ? new Error('仕込んだ失敗（#4731）') : undefined;
    });
    await expect(migrateOnBoot(failing, () => undefined)).rejects.toThrow('仕込んだ失敗');
    const probe = counting(db);
    await migrateOnBoot(probe.db, () => undefined);
    expect(probe.statements()).toBe(STATEMENTS.length);
  });
});
