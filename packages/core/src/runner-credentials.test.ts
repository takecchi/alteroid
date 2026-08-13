import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * 鍵が**凍らない**こと。
 *
 * runner のプロセスが起動した瞬間の `process.env` をそのまま配ると、人間が後から
 * 差し替えた鍵は器を作り直すまで届かない。届かないまま走り続けたマネージャーは
 * 「権限が無い」としか報告できず、鍵を正しく置いた人間との間ですれ違いが起きる。
 * ここで固定するのは「差し替えが届くこと」そのものである。
 */

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
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-cred-'));
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
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
      // **凍った env**。runner の起動時にはこれが入っていた。
      env: { PATH: process.env.PATH ?? '', GH_TOKEN: 'ghp_old' },
      credentials,
    });

    await host.start({ managerId: 'mgr-1', request: '古い鍵で走る', cwd: dir });
    expect(fake.started[0]?.options.env?.GH_TOKEN).toBe('ghp_old');

    // 人間が鍵を差し替える（器は作り直さない）
    await host.setCredentials([{ name: 'GH_TOKEN', value: 'ghp_new' }]);

    // 1. これから起こすマネージャーには即座に届く
    await host.start({ managerId: 'mgr-2', request: '新しい鍵で走る', cwd: dir });
    expect(fake.started[1]?.options.env?.GH_TOKEN).toBe('ghp_new');

    // 2. **既に走っている mgr-1** にも、器越しに届く。`git` も `gh` も呼ばれる
    //    たびにこのファイルを読むので、次の呼び出しから新しい鍵になる。
    const file = fake.started[0]?.options.env?.ALTEROID_GH_TOKEN_FILE;
    expect(file).toBe(join(dir, 'creds', 'GH_TOKEN'));
    expect(readFileSync(file as string, 'utf8')).toBe('ghp_new');
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

    // 下（外の世界）へ手を伸ばす鍵は渡る
    expect(env.GH_TOKEN).toBe('ghp_x');
    // 上（記憶）へ到達する鍵は落ちている
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

    // 名前検査をすり抜けたとしても、合成の順序で伏せが最後に効く
    await credentials.set([{ name: 'GH_TOKEN', value: 'ghp_y' }]);
    (credentials as unknown as { values(): Record<string, string> }).values = () => ({
      GH_TOKEN: 'ghp_y',
      ALTEROID_DATABASE_URL: 'postgres://stolen',
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const env = fake.started[0]?.options.env ?? {};

    expect(env.GH_TOKEN).toBe('ghp_y');
    // **伏せるのが最後。** ここが通ると記憶ストアの所在が子へ渡る
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
  });
});
