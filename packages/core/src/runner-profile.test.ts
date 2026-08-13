import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfileVessel } from './profile.js';
import { createRunnerHost, WITHHELD_ENV_KEYS, type RunnerHost } from './runner.js';

/**
 * 実行環境プロファイルが**マネージャーに実際に効く**こと。
 *
 * ここが無いと、「プロファイルを置けた」と「マネージャーの環境が変わった」が
 * 別々のまま通ってしまう。固定するのは2つ:
 *
 * - **評価済みの env**（本命）。これを継承した先でマネージャーも作業者も
 *   MCP サーバも走る ＝ これから起こす仕事には即座に効く
 * - **`BASH_ENV` の所在**。効く場面のための口で、**走行中の仕事への配達を
 *   ここに期待しない**（`bash -c` では読まれず、SDK の Bash は永続シェルである）。
 *   走行中へ届くのは `gh` シムがファイルを読み直す経路だけ
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
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-profile-'));
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

function makeHost(env: NodeJS.ProcessEnv, fake = fakeSdk()): { fake: ReturnType<typeof fakeSdk> } {
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fake.fn,
    env,
    // **本番と同じ形で作る。** 器に伏せる一覧を渡すのを忘れると、`unset` の
    // 書かれないプロファイルが配られる（そこが検査の対象そのものである）。
    profile: createProfileVessel({
      path: join(dir, 'profile', 'profile.sh'),
      withheldEnvKeys: WITHHELD_ENV_KEYS,
    }),
  });
  return { fake };
}

describe('マネージャーに効く実行環境プロファイル', () => {
  it('本文が export したものが、マネージャーの env に載る', async () => {
    const { fake } = makeHost({ PATH: process.env.PATH ?? '' });

    const result = await host.setProfile('export SOME_API_TOKEN=abc123');
    expect(result.ok).toBe(true);

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const env = fake.started[0]?.options.env ?? {};

    // Bash を経由しない子（MCP サーバなど）にも効く
    expect(env.SOME_API_TOKEN).toBe('abc123');
    // `BASH_ENV` の所在も渡る（効く場面のための口）
    expect(env.BASH_ENV).toBe(join(dir, 'profile', 'profile.sh'));
    // **読み込み済みの印は配らない。** 配ると入れ子ではなく最初のシェルが
    // 読み飛ばし、差し替えが走行中のマネージャーへ届かなくなる。
    expect(env.ALTEROID_PROFILE_SOURCED).toBeUndefined();
  });

  it('器を作り直さずに差し替えられる（これから起こす仕事には即座に効く）', async () => {
    const { fake } = makeHost({ PATH: process.env.PATH ?? '' });

    await host.setProfile('export SOME_API_TOKEN=old');
    await host.start({ managerId: 'mgr-1', request: '古い環境で走る', cwd: dir });
    expect(fake.started[0]?.options.env?.SOME_API_TOKEN).toBe('old');

    await host.setProfile('export SOME_API_TOKEN=new');

    // これから起こすマネージャーには即座に
    await host.start({ managerId: 'mgr-2', request: '新しい環境で走る', cwd: dir });
    expect(fake.started[1]?.options.env?.SOME_API_TOKEN).toBe('new');

    // 器の場所は変わらない。走行中の仕事のうち `gh` / `git` は、この同じ
    // ファイルを呼び出しのたびに読み直すので新しい本文を拾う（`credentials.ts`
    // と同じ形）。**それ以外のコマンドには届かない** — そこは次の仕事からになる。
    expect(fake.started[0]?.options.env?.BASH_ENV).toBe(fake.started[1]?.options.env?.BASH_ENV);
  });

  it('プロファイルは鍵より後に効く（人間が明示的に書いたほうが勝つ）', async () => {
    const { fake } = makeHost({ PATH: process.env.PATH ?? '', GH_TOKEN: 'from-env' });

    await host.setProfile('export GH_TOKEN=from-profile');
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });

    expect(fake.started[0]?.options.env?.GH_TOKEN).toBe('from-profile');
  });

  it('上（記憶）へ到達する鍵は、プロファイル経由でも注入し直せない', async () => {
    const { fake } = makeHost({
      PATH: process.env.PATH ?? '',
      ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
    });

    const result = await host.setProfile(
      'export ALTEROID_DATABASE_URL=postgres://stolen\nexport OK=1',
    );
    expect(result.ok).toBe(true);

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const env = fake.started[0]?.options.env ?? {};

    expect(env.OK).toBe('1');
    // 器が書いた `unset` / 評価側の削除 / 合成順序の三重で塞いである
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
    expect(result.names).not.toContain('ALTEROID_DATABASE_URL');
  });

  it('壊れたプロファイルは置かない（マネージャーの環境を壊さない）', async () => {
    const { fake } = makeHost({ PATH: process.env.PATH ?? '' });

    await host.setProfile('export SOME_API_TOKEN=good');
    const broken = await host.setProfile('if [ ; then');

    expect(broken.ok).toBe(false);
    expect(broken.error).toBeDefined();

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    // 前のものがそのまま効いている
    expect(fake.started[0]?.options.env?.SOME_API_TOKEN).toBe('good');
    expect(host.profile()).toBeDefined();
  });

  it('器を持たない runner では差し替えを黙って捨てない', async () => {
    const fake = fakeSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fake.fn,
      env: {},
    });

    await expect(host.setProfile('export OK=1')).rejects.toThrow();
    expect(host.profile()).toBeUndefined();
  });

  it('指紋は出すが、本文は出さない', async () => {
    makeHost({ PATH: process.env.PATH ?? '' });
    await host.setProfile('export SOME_API_TOKEN=super-secret');

    expect(JSON.stringify(host.profile())).not.toContain('super-secret');
    expect(host.profile()?.sha256).toMatch(/^[0-9a-f]{12}$/);
  });
});
