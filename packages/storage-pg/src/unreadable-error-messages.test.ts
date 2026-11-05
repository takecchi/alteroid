import {
  UnreadableActiveTokenError,
  UnreadablePracticeError,
  UnreadableScheduleError,
  UnreadableTaskError,
  UnreadableTokenSettingsError,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import {
  agentTokenActive,
  agentTokenSettings,
  practices,
  practiceVersions,
  schedulePhases,
  schedules,
  tasks,
} from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('rejected されるはずが、解決した');
}

/** zod の `error.message` は issues を整形した JSON で、それがそのまま理由として文末へ入る。 */
const issuesJson = (issues: unknown[]): string => JSON.stringify(issues, null, 2);

const missingString = (field: string): Record<string, unknown> => ({
  expected: 'string',
  code: 'invalid_type',
  path: [field],
  message: 'Invalid input: expected string, received undefined',
});

/** `kind: ''` の行を `safeParse` したときの issues（空文字の検査と、NUL だけの値の検査の2つが同じ欄に立つ）。 */
const EMPTY_KIND_ISSUES = [
  {
    origin: 'string',
    code: 'too_small',
    minimum: 1,
    inclusive: true,
    path: ['kind'],
    message: 'Too small: expected string to have >=1 characters',
  },
  { code: 'custom', path: ['kind'], message: 'NUL（\\u0000）だけの値は空と同じ' },
];

describe('pg ストア — 読めない行の例外の文面を逐語で固定する', () => {
  it('tasks: UnreadableTaskError の文面', async () => {
    await db.insert(tasks).values({
      id: 'broken',
      rank: 1,
      task: { id: 'broken', createdAt: '2026-01-01T00:00:00.000Z', status: 'weird' },
    });

    const error = await rejection(stores.tasks.get('broken'));

    expect(error).toBeInstanceOf(UnreadableTaskError);
    expect(error.name).toBe('UnreadableTaskError');
    expect(error.message).toBe(
      `task broken が読めない形で入っている: ${issuesJson([
        missingString('updatedAt'),
        {
          code: 'invalid_value',
          values: ['queued', 'waiting', 'needs_decision', 'done', 'cancelled'],
          path: ['status'],
          message:
            'Invalid option: expected one of "queued"|"waiting"|"needs_decision"|"done"|"cancelled"',
        },
        {
          code: 'invalid_value',
          values: ['human', 'manager', 'external', 'self'],
          path: ['origin'],
          message: 'Invalid option: expected one of "human"|"manager"|"external"|"self"',
        },
        missingString('title'),
        missingString('body'),
      ])}`,
    );
  });

  it('schedules: get() の UnreadableScheduleError の文面と kind', async () => {
    await db.insert(schedules).values({
      kind: 'bad-kind',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      plan: {
        kind: 'bad-kind',
        spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
        request: 'r',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    });

    const error = await rejection(stores.schedules.get('bad-kind'));

    expect(error).toBeInstanceOf(UnreadableScheduleError);
    expect(error.name).toBe('UnreadableScheduleError');
    expect((error as UnreadableScheduleError).kind).toBe('bad-kind');
    expect(error.message).toBe(
      `継続中の依頼 bad-kind が読めない形で入っている（消されたのではない）: ${issuesJson([
        {
          code: 'invalid_union',
          errors: [],
          note: 'No matching discriminator',
          discriminator: 'type',
          options: ['daily', 'every', 'cron'],
          path: ['spec', 'type'],
          message: "Invalid discriminator value. Expected 'daily' | 'every' | 'cron'",
        },
      ])}`,
    );
  });

  it('schedules: getPhase() が読めない行で投げる例外の文面（クラスは素の Error）', async () => {
    await db.insert(schedulePhases).values({
      kind: 'bad-kind',
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      phase: { kind: 'bad-kind', lastRunAt: 12345 },
    });

    const error = await rejection(stores.schedules.getPhase('bad-kind'));

    expect(error.name).toBe('Error');
    expect(error.message).toBe(
      `定期ジョブ bad-kind の位相が読めない形で入っている（まだ動いていないのではない）: ${issuesJson(
        [
          {
            expected: 'string',
            code: 'invalid_type',
            path: ['lastRunAt'],
            message: 'Invalid input: expected string, received number',
          },
        ],
      )}`,
    );
  });

  it('practices: read() の UnreadablePracticeError の文面・slug・version', async () => {
    await db.insert(practices).values({
      slug: 'bad-practice',
      kind: '',
      title: 't',
      content: 'c\n',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    });

    const error = await rejection(stores.practices.read('bad-practice'));

    expect(error).toBeInstanceOf(UnreadablePracticeError);
    expect(error.name).toBe('UnreadablePracticeError');
    expect((error as UnreadablePracticeError).slug).toBe('bad-practice');
    expect((error as UnreadablePracticeError).version).toBeUndefined();
    expect(error.message).toBe(
      `やり方 bad-practice が読めない形で入っている（消されたのではない）: ${issuesJson(EMPTY_KIND_ISSUES)}`,
    );
  });

  it('practices: readVersion() の UnreadablePracticeError の文面・slug・version', async () => {
    await db.insert(practiceVersions).values({
      slug: 'bad-version',
      version: 2,
      kind: '',
      title: 't',
      content: 'c\n',
      at: new Date('2026-09-02T00:00:00.000Z'),
    });

    const error = await rejection(stores.practices.readVersion('bad-version', 2));

    expect(error).toBeInstanceOf(UnreadablePracticeError);
    expect((error as UnreadablePracticeError).slug).toBe('bad-version');
    expect((error as UnreadablePracticeError).version).toBe(2);
    expect(error.message).toBe(
      `やり方 bad-version の版 2 が読めない形で入っている（消されたのではない）: ${issuesJson(EMPTY_KIND_ISSUES)}`,
    );
  });

  it('token-pool: readSettings() の UnreadableTokenSettingsError の文面', async () => {
    await db.insert(agentTokenSettings).values({
      id: 'default',
      rotateOn: 'not-a-real-policy',
      cooldownMs: 1000,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const error = await rejection(stores.tokens.readSettings());

    expect(error).toBeInstanceOf(UnreadableTokenSettingsError);
    expect(error.name).toBe('UnreadableTokenSettingsError');
    expect(error.message).toBe(
      '認証トークンの回転設定（settings）が読めない形で入っている（消されたのではない）: 不正な欄: rotateOn',
    );
  });

  it('token-pool: readActive() の UnreadableActiveTokenError の文面', async () => {
    await db.insert(agentTokenActive).values({
      id: 'default',
      tokenId: '',
      generation: 1,
      rotatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const error = await rejection(stores.tokens.readActive());

    expect(error).toBeInstanceOf(UnreadableActiveTokenError);
    expect(error.name).toBe('UnreadableActiveTokenError');
    expect(error.message).toBe(
      '現役の認証トークンの指名（active）が読めない形で入っている（消されたのではない）: 不正な欄: tokenId',
    );
  });
});
