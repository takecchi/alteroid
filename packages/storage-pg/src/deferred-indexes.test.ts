import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { buildDeferredIndexes, DEFERRED_INDEX_NAMES } from './deferred-indexes.js';
import { JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 起動の後に作る索引の、索引ごとの結果（デーモンが日誌へ残し、本番の DB を見ずに索引が有効かを確かめるための材料）

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

describe('buildDeferredIndexes', () => {
  it('⭐ 無い索引は作って built、既に在って有効な索引は valid と答える（並びは作る順）', async () => {
    const first = await buildDeferredIndexes(db, { warn: () => undefined });
    expect(first.map((outcome) => [outcome.index, outcome.state])).toEqual(
      DEFERRED_INDEX_NAMES.map((name) => [name, 'built']),
    );

    const second = await buildDeferredIndexes(db, { warn: () => undefined });
    expect(second.map((outcome) => [outcome.index, outcome.state])).toEqual(
      DEFERRED_INDEX_NAMES.map((name) => [name, 'valid']),
    );
  });

  it('⭐ 作りかけで無効になった索引は、作り直して built と答える', async () => {
    await buildDeferredIndexes(db, { warn: () => undefined });
    await client.exec(
      `update pg_index set indisvalid = false where indexrelid = '${JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX}'::regclass`,
    );

    const outcomes = await buildDeferredIndexes(db, { warn: () => undefined });

    expect(
      outcomes.find((outcome) => outcome.index === JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX)?.state,
    ).toBe('built');
  });

  it('作れなければ投げず、failed と理由（作る関数が出した警告）を答える', async () => {
    const warnings: string[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('接続が切れた')),
    } as unknown as Db;

    const outcomes = await buildDeferredIndexes(broken, { warn: (line) => warnings.push(line) });

    expect(outcomes.map((outcome) => outcome.state)).toEqual(
      DEFERRED_INDEX_NAMES.map(() => 'failed'),
    );
    expect(outcomes[0]?.reason).toContain(DEFERRED_INDEX_NAMES[0]);
    expect(outcomes[0]?.reason).toContain('接続が切れた');
    expect(warnings).toHaveLength(DEFERRED_INDEX_NAMES.length);
  });

  it('かかった時間を、確かめ始めてから結果が決まるまでで測る', async () => {
    let clock = 0;
    const outcomes = await buildDeferredIndexes(db, {
      warn: () => undefined,
      now: () => {
        clock += 1000;
        return clock;
      },
    });
    for (const outcome of outcomes) expect(outcome.ms).toBe(1000);
  });
});
