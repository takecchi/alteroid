import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

interface Started {
  options: Options;
}

function fakeSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

let dir: string;
let host: RunnerHost;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-cred-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

describe('runner が配る鍵', () => {
  it('起動時の env に凍らせず、器の現在値を配る', async () => {
    const fake = fakeSdk();
    const credentials = createCredentialStore({
      dir: join(dir, 'creds'),
      seed: { GH_TOKEN: 'ghp_old' },
      names: ['GH_TOKEN'],
    });
    await credentials.flush();

    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fake.fn,
      env: { PATH: process.env.PATH ?? '', GH_TOKEN: 'ghp_old' },
      credentials,
    });

    await host.start({ managerId: 'mgr-1', request: '古い鍵で走る', cwd: dir });
    expect(fake.started[0]?.options.env?.GH_TOKEN).toBe('ghp_old');

    await host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp_new' }]);

    await host.start({ managerId: 'mgr-2', request: '新しい鍵で走る', cwd: dir });
    expect(fake.started[1]?.options.env?.GH_TOKEN).toBe('ghp_new');

    const file = fake.started[0]?.options.env?.ALTEROID_GH_TOKEN_FILE;
    expect(file).toBe(join(dir, 'creds', 'GH_TOKEN'));
    expect(readFileSync(file as string, 'utf8')).toBe('ghp_new');
  });

  it('器の env に在るだけの鍵は、子へ1文字も渡らない（出所はクローンが降ろしたものだけ）', async () => {
    const fake = fakeSdk();
    const credentials = createCredentialStore({ dir: join(dir, 'creds'), seed: {} });

    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fake.fn,
      env: {
        PATH: process.env.PATH ?? '',
        GH_TOKEN: 'ghp_from_the_runner_env',
        GITHUB_TOKEN: 'ghp_from_the_runner_env',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-from-the-runner-env',
        SOME_OTHER_VALUE: '鍵ではないものは落とさない',
      },
      credentials,
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const env = fake.started[0]?.options.env ?? {};

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.SOME_OTHER_VALUE).toBe('鍵ではないものは落とさない');
  });

  it('クローンが降ろせば、同じ名前が子へ渡る（能力は落ちていない）', async () => {
    const fake = fakeSdk();
    const credentials = createCredentialStore({ dir: join(dir, 'creds'), seed: {} });

    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fake.fn,
      env: { PATH: process.env.PATH ?? '', GH_TOKEN: 'ghp_from_the_runner_env' },
      credentials,
    });

    await host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp_from_the_clone' }]);

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });

    expect(fake.started[0]?.options.env?.GH_TOKEN).toBe('ghp_from_the_clone');
  });

  it('記憶へ到達する鍵は伏せたまま（配るのは下向きの鍵だけ）', async () => {
    const fake = fakeSdk();
    const credentials = createCredentialStore({
      dir: join(dir, 'creds'),
      seed: { GH_TOKEN: 'ghp_x' },
      names: ['GH_TOKEN'],
    });

    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fake.fn,
      env: {
        PATH: process.env.PATH ?? '',
        GH_TOKEN: 'ghp_x',
        ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
        ALTEROID_RUNNER_TOKEN: 'raw-key',
      },
      credentials,
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const env = fake.started[0]?.options.env ?? {};

    expect(env.GH_TOKEN).toBe('ghp_x');
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
    expect(env.ALTEROID_RUNNER_TOKEN).toBeUndefined();
  });

  it('指紋は出すが、値は出さない', async () => {
    const credentials = createCredentialStore({
      dir: join(dir, 'creds'),
      seed: { GH_TOKEN: 'ghp_secret' },
      names: ['GH_TOKEN'],
    });
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fakeSdk().fn,
      env: {},
      credentials,
    });

    expect(JSON.stringify(host.credentials())).not.toContain('ghp_secret');
    expect(host.credentials()[0]?.name).toBe('GH_TOKEN');
  });

  it('器を持たない runner では差し替えを黙って捨てない', async () => {
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fakeSdk().fn,
      env: {},
    });

    await expect(host.setCredentials([{ name: 'GH_TOKEN', value: 'x' }])).rejects.toThrow();
    expect(host.credentials()).toEqual([]);
  });
});

describe('鍵が伏せる仕組みを越えないこと', () => {
  it('伏せた環境変数を、鍵として注入し直せない', async () => {
    const fake = fakeSdk();
    const credentials = createCredentialStore({
      dir: join(dir, 'creds'),
      seed: { GH_TOKEN: 'ghp_x' },
      names: ['GH_TOKEN'],
    });

    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fake.fn,
      env: {
        PATH: process.env.PATH ?? '',
        ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
      },
      credentials,
    });

    await credentials.set([{ name: 'GH_TOKEN', value: 'ghp_y' }]);
    (credentials as unknown as { values(): Record<string, string> }).values = () => ({
      GH_TOKEN: 'ghp_y',
      ALTEROID_DATABASE_URL: 'postgres://stolen',
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const env = fake.started[0]?.options.env ?? {};

    expect(env.GH_TOKEN).toBe('ghp_y');
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
  });
});
