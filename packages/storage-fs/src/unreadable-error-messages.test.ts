import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  UnreadableActiveTokenError,
  UnreadablePracticeError,
  UnreadableScheduleError,
  UnreadableTaskError,
  UnreadableTokenSettingsError,
} from '@alteroid/core';
import type { AgentToken } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

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

async function editJson(
  path: string,
  edit: (raw: Record<string, unknown[]>) => void,
): Promise<void> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown[]>;
  edit(raw);
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}

describe('fs ストア — 読めない行の例外の文面を逐語で固定する', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  it('tasks: UnreadableTaskError の文面', async () => {
    const stores = createFsStores(root);
    await stores.tasks.add({
      id: 'ok',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      origin: 'self',
      title: 't',
      body: 'b',
    });
    await editJson(join(root, 'jobs', 'tasks.json'), (raw) => {
      raw.tasks?.push({
        rank: 1,
        task: { id: 'broken', createdAt: '2026-01-01T00:00:00.000Z', status: 'weird' },
      });
    });

    const error = await rejection(createFsStores(root).tasks.get('broken'));

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
    const stores = createFsStores(root);
    await stores.schedules.put({
      kind: 'good-kind',
      spec: { type: 'every', minutes: 60 },
      request: 'r',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    await editJson(join(root, 'jobs', 'schedules.json'), (raw) => {
      raw.schedules?.push({
        kind: 'bad-kind',
        spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
        request: 'r',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
    });

    const error = await rejection(createFsStores(root).schedules.get('bad-kind'));

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
    const stores = createFsStores(root);
    await stores.schedules.putPhase({ kind: 'good-kind', lastRunAt: '2026-09-01T00:00:00.000Z' });
    await editJson(join(root, 'jobs', 'schedules.json'), (raw) => {
      raw.phases?.push({ kind: 'bad-kind', lastRunAt: 12345 });
    });

    const error = await rejection(createFsStores(root).schedules.getPhase('bad-kind'));

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
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(
      join(root, 'jobs', 'practices.json'),
      `${JSON.stringify({
        practices: [
          {
            slug: 'bad-practice',
            title: 't',
            content: 'c\n',
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z',
          },
        ],
        practiceVersions: [],
      })}\n`,
    );

    const error = await rejection(createFsStores(root).practices.read('bad-practice'));

    expect(error).toBeInstanceOf(UnreadablePracticeError);
    expect(error.name).toBe('UnreadablePracticeError');
    expect((error as UnreadablePracticeError).slug).toBe('bad-practice');
    expect((error as UnreadablePracticeError).version).toBeUndefined();
    expect(error.message).toBe(
      `やり方 bad-practice が読めない形で入っている（消されたのではない）: ${issuesJson([
        missingString('kind'),
      ])}`,
    );
  });

  it('practices: readVersion() の UnreadablePracticeError の文面・slug・version', async () => {
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(
      join(root, 'jobs', 'practices.json'),
      `${JSON.stringify({
        practices: [],
        practiceVersions: [
          {
            slug: 'bad-version',
            version: 2,
            kind: '実装',
            title: 't',
            at: '2026-09-02T00:00:00.000Z',
          },
        ],
      })}\n`,
    );

    const error = await rejection(createFsStores(root).practices.readVersion('bad-version', 2));

    expect(error).toBeInstanceOf(UnreadablePracticeError);
    expect((error as UnreadablePracticeError).slug).toBe('bad-version');
    expect((error as UnreadablePracticeError).version).toBe(2);
    expect(error.message).toBe(
      `やり方 bad-version の版 2 が読めない形で入っている（消されたのではない）: ${issuesJson([
        missingString('content'),
      ])}`,
    );
  });

  describe('token-pool', () => {
    const GOOD_TOKEN: AgentToken = {
      id: 'tok-good',
      label: 'primary',
      value: 'secret-good',
      source: 'stored',
      order: 0,
    };

    it('readSettings() の UnreadableTokenSettingsError の文面', async () => {
      const stores = createFsStores(root);
      await stores.tokens.replace([GOOD_TOKEN]);
      await editJson(stores.paths.tokens, (raw) => {
        (raw as Record<string, unknown>).settings = {
          rotateOn: 'not-a-real-policy',
          cooldownMs: 1000,
        };
      });

      let error: Error | undefined;
      await captureStderr(async () => {
        error = await rejection(createFsStores(root).tokens.readSettings());
      });

      expect(error).toBeInstanceOf(UnreadableTokenSettingsError);
      expect(error?.name).toBe('UnreadableTokenSettingsError');
      expect(error?.message).toBe(
        '認証トークンの回転設定（settings）が読めない形で入っている（消されたのではない）: 不正な欄: rotateOn',
      );
    });

    it('readActive() の UnreadableActiveTokenError の文面', async () => {
      const stores = createFsStores(root);
      await stores.tokens.replace([GOOD_TOKEN]);
      await editJson(stores.paths.tokens, (raw) => {
        (raw as Record<string, unknown>).active = {
          generation: 1,
          rotatedAt: '2026-09-01T00:00:00.000Z',
        };
      });

      let error: Error | undefined;
      await captureStderr(async () => {
        error = await rejection(createFsStores(root).tokens.readActive());
      });

      expect(error).toBeInstanceOf(UnreadableActiveTokenError);
      expect(error?.name).toBe('UnreadableActiveTokenError');
      expect(error?.message).toBe(
        '現役の認証トークンの指名（active）が読めない形で入っている（消されたのではない）: 不正な欄: tokenId',
      );
    });
  });
});
