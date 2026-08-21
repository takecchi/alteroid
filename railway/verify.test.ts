/**
 * `railway/verify.sh` が**何台を見て、何を通さないか**を固定する。
 *
 * ここで見ているのは probe の中身（`/proc/1/environ` を読めるか、`su` で降りられるか）
 * ではない — それは器の中でしか確かめられない。固定するのは**判定**である:
 *
 * - **台数を数え落とさない。** 1台だけ見て「境界は立っている」と名乗ると、後から
 *   足した1台が確かめられていないことが出力から消える
 * - **「1台だった」と「名簿を引けなかった」を同じ顔にしない**
 * - **`runner_id` の重複を落とす。** 同じ id が2台並ぶと、委譲した先とは別の器へ
 *   `manager_send` が届く（`RunnerRegistry#get` は線形一致）。1台構成では起きえないので、
 *   増やした後に初めて意味を持つ
 * - **「app が知っている委譲先の数」と食い違ったら落とす。** 変数を置いただけでは
 *   走っているデーモンに届かないので、これが `app` の再デプロイ忘れの唯一の兆候である
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { childEnv, makeFakeRailway, type FakeService, type FakeState } from './test-support.js';

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), 'verify.sh');

/** 境界が立っている runner の probe 出力。 */
function healthyRunnerProbe(runnerId: string): string {
  return [
    'db_key=absent',
    'raw_token=absent',
    'sha256=present',
    'google=absent',
    'gh_token=present',
    `runner_id=${runnerId}`,
    'control=401',
    'livez={"ok":true}',
    'db_dns=resolvable',
    'gh_auth=ok',
    '',
  ].join('\n');
}

function appProbe(seeds: number): string {
  return [
    `health={"ok":true,"memory":"PostgreSQL","auth":{"enabled":true}}`,
    `seeds=${seeds}`,
    '',
  ].join('\n');
}

function runner(name: string, runnerId: string): FakeService {
  return {
    id: `id-${name}`,
    name,
    config: '/railway/runner.json',
    vars: { GH_TOKEN: 'github_pat_test', ALTEROID_RUNNER_ID: runnerId },
    probe: healthyRunnerProbe(runnerId),
  };
}

function state(runners: FakeService[], seeds = runners.length): FakeState {
  return {
    services: [
      {
        id: 'id-app',
        name: 'app',
        config: '/railway/daemon.json',
        vars: { ALTEROID_DATABASE_URL: 'postgres://pg/db' },
        probe: appProbe(seeds),
      },
      ...runners,
    ],
  };
}

type Result = { exitCode: number; stdout: string };

function verify(s: FakeState, args: string[] = []): Result {
  const { dir, bin } = makeFakeRailway(s);
  const proc = spawnSync('bash', [VERIFY, ...args], {
    env: childEnv(process.env, bin, { FAKE_STATE: dir }),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { exitCode: proc.status ?? 1, stdout: proc.stdout ?? '' };
}

describe('runner が2台のとき', () => {
  it('2台とも見て、通る', () => {
    const r = verify(state([runner('runner', 'runner-primary'), runner('runner-2', 'runner-2')]));
    expect(r.stdout).toContain('runner の中を見る（runner）');
    expect(r.stdout).toContain('runner の中を見る（runner-2）');
    expect(r.exitCode).toBe(0);
  });

  it('runner_id がぶつかっていたら落とす', () => {
    // 同じ id の2台のうち先に見つかった方が返るので、委譲した先とは別の器へ命令が届く
    const r = verify(
      state([runner('runner', 'runner-primary'), runner('runner-2', 'runner-primary')]),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('runner-primary');
    expect(r.stdout).toContain('別の器へ命令が届く');
  });

  it('app が知っている委譲先が足りなければ落とす（app の再デプロイ忘れ）', () => {
    const r = verify(
      state([runner('runner', 'runner-primary'), runner('runner-2', 'runner-2')], 1),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('redeploy');
  });

  it('片方が上がっていなければ落とす（1台だけ通ったことを緑にしない）', () => {
    const dead = runner('runner-2', 'runner-2');
    delete dead.probe;
    const r = verify(state([runner('runner', 'runner-primary'), dead]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('runner に入れなかった');
  });

  it('-r で指定すればその台だけ見る（名簿を引きに行かない）', () => {
    const r = verify(
      state([runner('runner', 'runner-primary'), runner('runner-2', 'runner-2')], 2),
      ['-r', 'runner-2'],
    );
    expect(r.stdout).toContain('runner の中を見る（runner-2）');
    expect(r.stdout).not.toContain('runner の中を見る（runner）\n');
    // 指定した台数（1）と app が知っている数（2）は食い違うので、黙って緑にはしない
    expect(r.stdout).toContain('見た runner');
  });
});

describe('名簿を引けなかったとき', () => {
  it('既定の1台だけを見て、引けなかったことを言う（! を立てる）', () => {
    // **「1台だった」と「引けなかった」を同じ顔にしない。** 同じにすると、足した台が
    // 確かめられていないことが出力から消える
    const s = state([runner('runner', 'runner-primary')], 1);
    // Config as Code を消す ＝ 役の持ち主が居ない状態
    for (const svc of s.services) svc.config = null;
    const r = verify(s);
    expect(r.stdout).toContain('名簿を引けなかった');
    expect(r.stdout).toContain('runner の中を見る（runner）');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('確かめられなかったものが');
  });
});

describe('境界が壊れているとき', () => {
  it('記憶ストアの鍵が runner にあったら「!!」で落とす', () => {
    const broken = runner('runner-2', 'runner-2');
    broken.probe = healthyRunnerProbe('runner-2').replace('db_key=absent', 'db_key=present');
    const r = verify(state([runner('runner', 'runner-primary'), broken]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('!! 記憶ストアの鍵がある');
  });

  it('素の合鍵が残っていたら「!!」で落とす', () => {
    const broken = runner('runner', 'runner-primary');
    broken.probe = healthyRunnerProbe('runner-primary').replace(
      'raw_token=absent',
      'raw_token=present',
    );
    const r = verify(state([broken]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('!! 素の合鍵が残っている');
  });

  it('GH_TOKEN を置いたのに走っている runner に無ければ落とす（デグレード）', () => {
    const degraded = runner('runner', 'runner-primary');
    degraded.probe = healthyRunnerProbe('runner-primary').replace(
      'gh_token=present',
      'gh_token=absent',
    );
    const r = verify(state([degraded]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('デグレード');
  });
});
