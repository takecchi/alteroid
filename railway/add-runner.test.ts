/**
 * `railway/add-runner.sh` が**既に在るものから何を写し、何を写さないか**を固定する。
 *
 * ここが静かにずれる形は3つあり、どれも動いて見える:
 *
 * 1. **`runner_id` が重複する** — `RunnerRegistry#get` は線形一致なので、委譲した先とは
 *    別の器へ `manager_send` が届く（docs/roadmap.md M5、#106 の申し送り）
 * 2. **記憶ストアの鍵が2台目へ広がる** — runner の中の子プロセス（＝マネージャー）が
 *    `/proc/1/environ` から鍵を取れる状態に戻る
 * 3. **人間が後から足した変数が2台目にだけ無い** — 同じ仕事を頼んだのに、当たった
 *    runner によってできることが違う（能力の削除。north_star 禁止1）
 *
 * 偽の `railway` を PATH の先に置き、**在る状態を state.json で作ってから**通す。
 * ネットワークにも本物の Railway にも触らない。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { childEnv, makeFakeRailway, type FakeState } from './test-support.js';

const ADD_RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'add-runner.sh');

const BRANCH = 'release/prod';
const REPO = 'takecchi/alteroid';

/** 走っている本番と同じ形（app / runner / PostgreSQL）。 */
function baseState(): FakeState {
  return {
    services: [
      {
        id: 'id-Postgres',
        name: 'Postgres',
        config: null,
        image: 'postgres-ssl:18',
        vars: { DATABASE_URL: 'postgres://pg/db' },
      },
      {
        id: 'id-app',
        name: 'app',
        config: '/railway/daemon.json',
        source: { repo: REPO, branch: BRANCH },
        vars: {
          ALTEROID_DATABASE_URL: 'postgres://pg/db',
          ALTEROID_GOOGLE_CLIENT_SECRET: 'goog-secret',
          ALTEROID_RUNNER_TOKEN: 'deadbeef',
          ALTEROID_RUNNER_URL: 'http://runner.railway.internal:4518',
          RAILWAY_PRIVATE_DOMAIN: 'app.railway.internal',
        },
      },
      {
        id: 'id-runner',
        name: 'runner',
        config: '/railway/runner.json',
        source: { repo: REPO, branch: BRANCH },
        vars: {
          ALTEROID_RUNNER_TOKEN: 'deadbeef',
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test',
          ALTEROID_RUNNER_ID: 'runner-primary',
          ALTEROID_RUNNER_BIND: '::',
          ALTEROID_RUNNER_PORT: '4518',
          ALTEROID_RUNNER_URL: 'http://runner.railway.internal:4518',
          GH_TOKEN: 'github_pat_test',
          GIT_AUTHOR_NAME: 'tester',
          GIT_AUTHOR_EMAIL: 't@example.com',
          TZ: 'Asia/Tokyo',
          ALTEROID_MANAGER_MODEL: 'opus',
          RAILWAY_RUN_UID: '0',
          RAILWAY_PRIVATE_DOMAIN: 'runner.railway.internal',
          RAILWAY_SERVICE_NAME: 'runner',
          RAILWAY_ENVIRONMENT: 'production',
        },
      },
    ],
  };
}

type Upsert = {
  serviceId: string;
  variables: Record<string, string>;
  replace: boolean;
  skipDeploys: boolean;
};

type Run = {
  /** その Service へ置こうとした変数（複数回に分かれていればマージ） */
  vars: (serviceId: string) => Record<string, string>;
  upserts: Upsert[];
  calls: string[];
  apiLog: string;
  /** 再デプロイを起こした Service 名 */
  redeploys: string[];
  exitCode: number;
  stderr: string;
};

function run(state: FakeState, args: string[] = [], allowFailure = false): Run {
  const { dir, bin } = makeFakeRailway(state);

  // **落ちなかったときの stderr も読む。** 進捗と警告は stderr へ出る（値を返す関数を
  // `$(…)` で受けるので、stdout には出せない）。`execFileSync` は成功時の stderr を
  // 返さないので、両方を必ず持って帰る `spawnSync` を使う
  const proc = spawnSync('bash', [ADD_RUNNER, '--yes', ...args], {
    env: childEnv(process.env, bin, { FAKE_STATE: dir }),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const exitCode = proc.status ?? 1;
  const stderr = proc.stderr ?? '';
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`add-runner.sh が ${exitCode} で終わった\n${stderr}`);
  }

  const readIfExists = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };

  const upserts = readIfExists('payloads.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { input: Upsert }).input);

  return {
    upserts,
    vars: (serviceId) =>
      upserts
        .filter((u) => u.serviceId === serviceId)
        .reduce<Record<string, string>>((acc, u) => ({ ...acc, ...u.variables }), {}),
    calls: readIfExists('calls.log').split('\n').filter(Boolean),
    apiLog: readIfExists('api.log'),
    redeploys: readIfExists('redeploys.log').split('\n').filter(Boolean),
    exitCode,
    stderr,
  };
}

describe('1台目から2台目を足す', () => {
  const r = run(baseState());

  it('名前と runner_id は既存とぶつからない値になる', () => {
    expect(r.calls).toContain('add --service runner-2');
    expect(r.vars('id-runner-2').ALTEROID_RUNNER_ID).toBe('runner-2');
  });

  it('人間が後から足した変数も写る（allowlist にしない）', () => {
    // ここを allowlist にすると、後から足した鍵が2台目にだけ無い状態になり、
    // 「同じ仕事を頼んだのに、当たった runner によってできることが違う」が生まれる
    const v = r.vars('id-runner-2');
    expect(v.GH_TOKEN).toBe('github_pat_test');
    expect(v.GIT_AUTHOR_NAME).toBe('tester');
    expect(v.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-test');
    expect(v.TZ).toBe('Asia/Tokyo');
    // 層とモデル帯の対応（人間の承認の置き場）も同じでなければ、当たった runner で帯が変わる
    expect(v.ALTEROID_MANAGER_MODEL).toBe('opus');
    expect(v.ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
  });

  it('Railway が注入する変数は写さない（RAILWAY_RUN_UID だけ残す）', () => {
    const v = r.vars('id-runner-2');
    expect(v).not.toHaveProperty('RAILWAY_PRIVATE_DOMAIN');
    expect(v).not.toHaveProperty('RAILWAY_SERVICE_NAME');
    expect(v).not.toHaveProperty('RAILWAY_ENVIRONMENT');
    // 無いと runner は起動を拒む（子プロセスを uid 1001 へ降ろすのに特権が要る）
    expect(v.RAILWAY_RUN_UID).toBe('0');
  });

  it('記憶ストアの鍵は2台目にも無い', () => {
    expect(r.vars('id-runner-2')).not.toHaveProperty('ALTEROID_DATABASE_URL');
    expect(r.vars('id-runner-2')).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
  });

  it('待ち受けは :: のまま（Railway の private network は IPv6）', () => {
    expect(r.vars('id-runner-2').ALTEROID_RUNNER_BIND).toBe('::');
    expect(r.vars('id-runner-2').ALTEROID_RUNNER_PORT).toBe('4518');
  });

  it('app の名簿は2台になり、参照のまま置かれる', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS).toBe(
      'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518,http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
    );
  });

  it('app に触るのは名簿だけ（他の変数を書き換えない）', () => {
    // ここが広がると、記憶ストアの鍵や Google の鍵を「写し直す」経路が生まれる
    const appUpserts = r.upserts.filter((u) => u.serviceId === 'id-app');
    expect(appUpserts).toHaveLength(1);
    expect(Object.keys(appUpserts[0].variables)).toEqual(['ALTEROID_RUNNER_URLS']);
  });

  it('追記であって置き換えではなく、デプロイは自分で起こす', () => {
    for (const u of r.upserts) {
      expect(u.replace).toBe(false);
      expect(u.skipDeploys).toBe(true);
    }
  });

  it('繋ぐ枝は写し元と同じ（ローカルの git や既定値から決めない）', () => {
    // 1台だけ main を見ていると、そこだけがマージのたびに畳まれる
    expect(r.calls).toContain(
      `service source connect --repo ${REPO} --branch ${BRANCH} --service runner-2`,
    );
  });

  it('Config as Code を指す（無いと役が決まらない）', () => {
    expect(r.apiLog).toContain('/railway/runner.json');
  });

  it('変数と Config as Code は source を繋ぐ前に置く', () => {
    // 繋いだ瞬間にデプロイが走りうるので、後から置くと初回が必ず失敗する
    const connect = r.calls.findIndex((c) => c.includes('source connect'));
    const upsert = r.calls.findIndex((c) => c.includes('VariableCollectionUpsert'));
    const config = r.calls.findIndex((c) => c.includes('serviceInstanceUpdate'));
    expect(upsert).toBeGreaterThanOrEqual(0);
    expect(upsert).toBeLessThan(connect);
    expect(config).toBeLessThan(connect);
  });

  it('app を再デプロイする（変数を置いただけでは走っているデーモンに届かない）', () => {
    expect(r.redeploys).toContain('app');
  });

  it('app の再デプロイは新しい runner が上がった後（先に落とさない）', () => {
    const newRunnerDeploy = r.calls.findIndex((c) =>
      c.startsWith('deployment list --service runner-2'),
    );
    const appRedeploy = r.calls.findIndex((c) => c.includes('redeploy') && c.includes('app'));
    expect(newRunnerDeploy).toBeGreaterThanOrEqual(0);
    expect(appRedeploy).toBeGreaterThan(newRunnerDeploy);
  });

  it('秘密を引数で渡さない（プロセス一覧に出る）', () => {
    expect(r.apiLog).not.toContain('sk-ant-test');
    expect(r.apiLog).not.toContain('github_pat_test');
    expect(r.calls.join('\n')).not.toContain('sk-ant-test');
    expect(r.calls.join('\n')).not.toContain('github_pat_test');
  });

  it('ボリュームを作らない（workspace は Git 再構築）', () => {
    expect(r.calls.some((c) => c.includes('volume'))).toBe(false);
  });

  it('Service の指定を省かない（省くと最後に作ったものへ黙って向く）', () => {
    const risky = r.calls.filter(
      (c) => /^(variable|up|deployment|domain)\b/.test(c) && !c.includes('--service'),
    );
    expect(risky).toEqual([]);
  });
});

describe('3台目を足す', () => {
  it('空いている番号を選び、名簿は3台になる', () => {
    const state = baseState();
    const runner2 = JSON.parse(JSON.stringify(state.services[2])) as FakeState['services'][number];
    runner2.id = 'id-runner-2';
    runner2.name = 'runner-2';
    runner2.vars = { ...runner2.vars, ALTEROID_RUNNER_ID: 'runner-2' };
    state.services.push(runner2);

    const r = run(state);
    expect(r.calls).toContain('add --service runner-3');
    expect(r.vars('id-runner-3').ALTEROID_RUNNER_ID).toBe('runner-3');
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS).toBe(
      [
        'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-3.RAILWAY_PRIVATE_DOMAIN}}:4518',
      ].join(','),
    );
  });
});

describe('足さずに止まる場合', () => {
  // **どれも「足してから気づく」形にしない。** 器を作ってから止まると、
  // 中途半端な Service が名簿に並ぶ
  const createdNothing = (r: Run): void => {
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.upserts).toEqual([]);
  };

  it('runner_id がぶつかるとき', () => {
    // 同じ id が2台並ぶと、委譲した先とは別の器へ命令が届く（しかも届いて見える）
    const r = run(baseState(), ['--id', 'runner-primary'], true);
    createdNothing(r);
    expect(r.stderr).toContain('runner-primary');
  });

  it('写し元に記憶ストアの鍵があるとき（境界が既に壊れている）', () => {
    // **黙って落とさない。** 落とすと、壊れている事実が出力から消えて2台目だけが健全に見える
    const state = baseState();
    state.services[2].vars = {
      ...state.services[2].vars,
      ALTEROID_DATABASE_URL: 'postgres://pg/db',
    };
    const r = run(state, [], true);
    createdNothing(r);
    expect(r.stderr).toContain('ALTEROID_DATABASE_URL');
  });

  it('写し元に入口の認証の鍵があるとき', () => {
    const state = baseState();
    state.services[2].vars = {
      ...state.services[2].vars,
      ALTEROID_GOOGLE_CLIENT_SECRET: 'goog-secret',
    };
    const r = run(state, [], true);
    createdNothing(r);
  });

  it('写し元に合鍵が無いとき（鍵の無い制御面はマネージャーからも叩ける）', () => {
    const state = baseState();
    const vars = { ...state.services[2].vars };
    delete vars.ALTEROID_RUNNER_TOKEN;
    state.services[2].vars = vars;
    const r = run(state, [], true);
    createdNothing(r);
  });

  it('runner が1台も無いとき（ここは既存の環境へ足す道具である）', () => {
    const state = baseState();
    state.services = state.services.filter((s) => s.name !== 'runner');
    const r = run(state, [], true);
    createdNothing(r);
    expect(r.stderr).toContain('setup.sh');
  });

  it('指定した名前が既に在るとき', () => {
    const r = run(baseState(), ['--name', 'app'], true);
    createdNothing(r);
  });

  it('写し元が runner でないとき（Config as Code で見る）', () => {
    const r = run(baseState(), ['--from', 'app'], true);
    createdNothing(r);
  });
});

describe('app を再デプロイしないとき（--no-redeploy-app）', () => {
  const r = run(baseState(), ['--no-redeploy-app']);

  it('名簿は置くが、再デプロイは起こさない', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS).toContain('runner-2');
    expect(r.redeploys).toEqual([]);
  });

  it('まだ委譲先ではないことを出力に書く（黙って終わらない）', () => {
    // 黙ると「足したのに委譲先が増えない」を Railway 側に探しに行くことになる
    expect(r.stderr).toContain('redeploy');
  });
});
