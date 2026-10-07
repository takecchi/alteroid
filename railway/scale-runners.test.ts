// 偽の `railway` を PATH の先に置いて確かめる: ネットワークにも本物の Railway にも触らない。
// `cli-stub.ts` の偽 `ssh` は渡された node スクリプトを実際に子プロセスとして実行する: 偽 `railway` が引数を記録するだけだと、vacate の待ち方・資格の読み方・出力に資格を出さないことがテストから抜け落ちるため。
// `it` はプロセスを起こさず、起動は `prepareScenarios` の1つの `beforeAll` に集める: 直列に起こすと、器が混んでいる時間だけ `it` の所要時間が伸びて既定の `testTimeout` に近づくため。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { cpus } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';
import { RAILWAY_DIR, type Run, runScriptAsync, scenarioCollector } from './cli-stub.js';

const EXISTING = [
  { id: 'id-app', name: 'app', source: { repo: 'takecchi/alteroid', image: null } },
  { id: 'id-Postgres', name: 'Postgres', source: { repo: null, image: 'postgres-ssl:18' } },
  { id: 'id-runner', name: 'runner', source: { repo: 'takecchi/alteroid', image: null } },
];

const RUNNER_VARS: Record<string, string> = {
  ALTEROID_RUNNER_TOKEN: 'deadbeef',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test',
  ALTEROID_RUNNER_BIND: '::',
  ALTEROID_RUNNER_PORT: '4518',
  ALTEROID_RUNNER_ID: 'runner-primary',
  ALTEROID_RUNNER_URL: 'http://runner.railway.internal:4518',
  GH_TOKEN: 'github_pat_test',
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 't@example.com',
  TZ: 'Asia/Tokyo',
  ALTEROID_CLONE_MODEL: 'opus',
  RAILWAY_RUN_UID: '0',
  RAILWAY_SERVICE_ID: '86301ce6-runner',
  RAILWAY_SERVICE_NAME: 'runner',
  RAILWAY_PRIVATE_DOMAIN: 'runner.railway.internal',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  RAILWAY_GIT_COMMIT_MESSAGE: 'feat: ALTEROID_DATABASE_URL について書いた行',
};

type Options = {
  total: number;
  runnerVars?: Record<string, string>;
  appVars?: Record<string, string>;
  services?: typeof EXISTING;
  args?: string[];
  allowFailure?: boolean;
  extraEnv?: Record<string, string>;
};

function run(options: Options): Promise<Run> {
  return runScriptAsync({
    script: 'scale-runners.sh',
    args: ['--yes', '--total', String(options.total), ...(options.args ?? [])],
    services: options.services ?? EXISTING,
    serviceVars: {
      runner: options.runnerVars ?? RUNNER_VARS,
      app: options.appVars ?? {},
    },
    allowFailure: options.allowFailure,
    extraEnv: options.extraEnv,
  });
}

const FAKE_OPERATOR_TOKEN = 'SECRET-DAEMON-TOKEN-DO-NOT-LEAK-4f2c';

function makeAlteroidHome(token: string, port: number): string {
  const home = makeTempDirSync('alteroid-vacate-home.');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, 'state', 'daemon.json'),
    JSON.stringify({ pid: 1, port, startedAt: '2020-01-01T00:00:00Z', token }),
  );
  return home;
}

type FakeDaemon = { server: Server; port: number };

function startFakeDaemon(options: {
  token: string;
  runnerId: string;
  staleManagerPolls: number;
}): Promise<FakeDaemon> {
  let vacated = false;
  let managerPollsSinceVacate = 0;
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const authorized = req.headers.authorization === `Bearer ${options.token}`;
      if (!authorized) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'ログインが要る（alteroid login）' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/runners/vacate') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}') as { runnerId?: string };
          if (parsed.runnerId !== options.runnerId) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'runnerId の形が不正' }));
            return;
          }
          vacated = true;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/runners') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            runners: [
              {
                label: options.runnerId,
                state: vacated ? 'vacating' : 'connected',
                since: '2020-01-01T00:00:00Z',
                runnerId: options.runnerId,
              },
            ],
            daemonRevision: { status: 'unknown' },
          }),
        );
        return;
      }
      if (req.method === 'GET' && (req.url ?? '').startsWith('/managers')) {
        const stillAssigned = vacated && managerPollsSinceVacate < options.staleManagerPolls;
        if (vacated) managerPollsSinceVacate += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            managers: stillAssigned
              ? [{ managerId: 'm1', status: 'running', runnerId: options.runnerId }]
              : [],
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('偽デーモンの port が取れない'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

type Scenarios = {
  scaleUpTo3: Run;
  memoryKeyOnRunner: Run;
  scaleDown: Run;
  rerunAlreadyAttached: Run;
  rerunMissingDest: Run;
  unresolvedVarRefs: Run;
  dryRun: Run;
  noRunnerService: Run;
  vacateSuccess: Run;
  vacateTimeout: Run;
  vacateMiddleRejected: Run;
  vacateTooMany: Run;
};

let scenarios: Scenarios;

const vacateFixtures: { daemon: FakeDaemon; home: string }[] = [];

// 並行度は `os.cpus().length` で頭打ちにする: 無制限に並べると器の CPU を使い切るため。各実行は自分専用のディレクトリしか触らないので、並行化しても結果は変わらない。
// シナリオは `scenarioCollector` で集める: `tasks.push` で集めて `Promise` をそのまま待つと、想定外に死んだシナリオ1つで `beforeAll` 全体が reject し、ファイル内の全テストが一括で skip になって、どの保証が壊れたかが読めなくなるため。
async function prepareScenarios(): Promise<Scenarios> {
  const { value: s, task, settle } = scenarioCollector<Scenarios>();

  task('scaleUpTo3', async () => {
    s.scaleUpTo3 = await run({ total: 3 });
  });

  task('memoryKeyOnRunner', async () => {
    s.memoryKeyOnRunner = await run({
      total: 3,
      runnerVars: { ...RUNNER_VARS, ALTEROID_DATABASE_URL: 'postgres://user:pw@host/db' },
      allowFailure: true,
    });
  });

  task('scaleDown', async () => {
    s.scaleDown = await run({
      total: 1,
      services: [
        ...EXISTING,
        { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
      ],
      allowFailure: true,
    });
  });

  const rerunAttached = [
    ...EXISTING,
    { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
    { id: 'id-runner-3', name: 'runner-3', source: { repo: 'takecchi/alteroid', image: null } },
  ];
  task('rerunAlreadyAttached', async () => {
    s.rerunAlreadyAttached = await run({
      total: 3,
      services: rerunAttached,
      appVars: {
        ALTEROID_RUNNER_URLS:
          'http://runner.railway.internal:4518,http://runner-2.railway.internal:4518,http://runner-3.railway.internal:4518',
      },
    });
  });
  task('rerunMissingDest', async () => {
    s.rerunMissingDest = await run({
      total: 3,
      services: rerunAttached,
      appVars: { ALTEROID_RUNNER_URL: 'http://runner.railway.internal:4518' },
    });
  });

  // 置いた `${{…}}` の参照が解決されたかを検算する: 解決されないとデーモンがその文字列をホスト名として引きに行き続け、「増やしたのに委譲が来ない」という沈黙になるため。
  const unresolvedAttached = [
    ...EXISTING,
    { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
    { id: 'id-runner-3', name: 'runner-3', source: { repo: 'takecchi/alteroid', image: null } },
  ];
  const unresolved = {
    ALTEROID_RUNNER_URLS: [
      'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
      'http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
      'http://${{runner-3.RAILWAY_PRIVATE_DOMAIN}}:4518',
    ].join(','),
  };
  task('unresolvedVarRefs', async () => {
    s.unresolvedVarRefs = await run({
      total: 3,
      services: unresolvedAttached,
      appVars: unresolved,
      allowFailure: true,
    });
  });

  task('dryRun', async () => {
    s.dryRun = await run({ total: 3, args: ['--dry-run'] });
  });

  task('noRunnerService', async () => {
    s.noRunnerService = await run({
      total: 3,
      services: EXISTING.filter((svc) => svc.name !== 'runner'),
      allowFailure: true,
    });
  });

  const twoRunners = [
    ...EXISTING,
    { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
  ];

  task('vacateSuccess', async () => {
    const daemon = await startFakeDaemon({
      token: FAKE_OPERATOR_TOKEN,
      runnerId: 'runner-2',
      staleManagerPolls: 2,
    });
    const home = makeAlteroidHome(FAKE_OPERATOR_TOKEN, daemon.port);
    vacateFixtures.push({ daemon, home });
    s.vacateSuccess = await run({
      total: 1,
      services: twoRunners,
      args: ['--vacate', 'runner-2'],
      extraEnv: {
        ALTEROID_HOME: home,
        ALTEROID_VACATE_TIMEOUT_SECONDS: '5',
        ALTEROID_VACATE_POLL_INTERVAL_SECONDS: '0.05',
      },
    });
  });

  task('vacateTimeout', async () => {
    const daemon = await startFakeDaemon({
      token: FAKE_OPERATOR_TOKEN,
      runnerId: 'runner-2',
      staleManagerPolls: Number.POSITIVE_INFINITY,
    });
    const home = makeAlteroidHome(FAKE_OPERATOR_TOKEN, daemon.port);
    vacateFixtures.push({ daemon, home });
    s.vacateTimeout = await run({
      total: 1,
      services: twoRunners,
      args: ['--vacate', 'runner-2'],
      extraEnv: {
        ALTEROID_HOME: home,
        ALTEROID_VACATE_TIMEOUT_SECONDS: '0.3',
        ALTEROID_VACATE_POLL_INTERVAL_SECONDS: '0.1',
      },
      allowFailure: true,
    });
  });

  const threeRunners = [
    ...twoRunners,
    { id: 'id-runner-3', name: 'runner-3', source: { repo: 'takecchi/alteroid', image: null } },
  ];
  task('vacateMiddleRejected', async () => {
    s.vacateMiddleRejected = await run({
      total: 2,
      services: threeRunners,
      args: ['--vacate', 'runner-2'],
      allowFailure: true,
    });
  });

  task('vacateTooMany', async () => {
    s.vacateTooMany = await run({
      total: 1,
      services: threeRunners,
      args: ['--vacate', 'runner-3'],
      allowFailure: true,
    });
  });

  return settle(cpus().length);
}

// `PREP_TIMEOUT` は実測した最悪値（18000ms）の約2.5倍（45000ms）にする: 準備段（8回の実プロセス起動を並行に走らせる）が混んだ器で伸びても落ちない余裕を持たせつつ、時間を無限に伸ばして問題を隠さないため。
const PREP_TIMEOUT = 45_000;

beforeAll(async () => {
  scenarios = await prepareScenarios();
}, PREP_TIMEOUT);

afterAll(async () => {
  await Promise.all(
    vacateFixtures.map(
      ({ daemon }) => new Promise<void>((resolve) => daemon.server.close(() => resolve())),
    ),
  );
  for (const { home } of vacateFixtures) rmSync(home, { recursive: true, force: true });
});

describe('1台から3台へ増やすとき', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.scaleUpTo3;
  });

  it('成功したら 0 で終わる', () => {
    expect(r.exitCode).toBe(0);
  });

  it('既存の runner の変数には1文字も触らない（走行中の仕事を殺さない）', () => {
    expect(r.touched('id-runner')).toBe(false);
    expect(r.calls.some((c) => c.includes('redeploy') && c.includes('--service runner'))).toBe(
      false,
    );
    expect(r.calls.some((c) => c.startsWith('up') && c.includes('--service runner '))).toBe(false);
  });

  it('足りない2台だけを作る', () => {
    const added = r.calls.filter((c) => c.startsWith('add'));
    expect(added).toEqual(['add --service runner-2', 'add --service runner-3']);
  });

  it('runner_id は台ごとに違う（写さずに置き直す）', () => {
    expect(r.vars('id-runner-2').ALTEROID_RUNNER_ID).toBe('runner-2');
    expect(r.vars('id-runner-3').ALTEROID_RUNNER_ID).toBe('runner-3');
  });

  it('鍵は走っている runner から写す（合鍵が食い違うと 401 で unusable になる）', () => {
    for (const id of ['id-runner-2', 'id-runner-3']) {
      const v = r.vars(id);
      expect(v.ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
      expect(v.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-test');
      expect(v.GH_TOKEN).toBe('github_pat_test');
      expect(v.GIT_COMMITTER_EMAIL).toBe('t@example.com');
      expect(v.ALTEROID_CLONE_MODEL).toBe('opus');
      expect(v.TZ).toBe('Asia/Tokyo');
      expect(v.ALTEROID_RUNNER_BIND).toBe('::');
      expect(v.RAILWAY_RUN_UID).toBe('0');
    }
  });

  it('Railway が器ごとに注入するものは写さない', () => {
    for (const id of ['id-runner-2', 'id-runner-3']) {
      const names = Object.keys(r.vars(id));
      expect(names.filter((n) => n.startsWith('RAILWAY_'))).toEqual(['RAILWAY_RUN_UID']);
    }
  });

  it('委譲の宛先は写さない（app が読むもので、runner 自身は読まない）', () => {
    expect(r.vars('id-runner-2')).not.toHaveProperty('ALTEROID_RUNNER_URL');
    expect(r.vars('id-runner-2')).not.toHaveProperty('ALTEROID_RUNNER_URLS');
  });

  it('app には3台ぶんの宛先を置く（変数参照のまま）', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS).toBe(
      [
        'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-3.RAILWAY_PRIVATE_DOMAIN}}:4518',
      ].join(','),
    );
    expect(Object.keys(r.vars('id-app'))).toEqual(['ALTEROID_RUNNER_URLS']);
  });

  it('app を上げ直すのは最後（新しい器が上がってから宛先を教える）', () => {
    const appUpsert = r.upsertedServices.indexOf('id-app');
    const redeploy = r.calls.findIndex(
      (c) => c.includes('redeploy') && c.includes('--service app'),
    );
    expect(r.upsertedServices.slice(0, appUpsert)).toEqual(['id-runner-2', 'id-runner-3']);
    expect(redeploy).toBeGreaterThanOrEqual(0);
    const lastVarPut = r.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.includes('VariableCollectionUpsert'))
      .map(({ i }) => i)
      .pop();
    expect(lastVarPut).toBeLessThan(redeploy);
  });

  it('追記であって置き換えではない（Railway が注入する変数を消さない）', () => {
    for (const id of ['id-app', 'id-runner-2', 'id-runner-3']) {
      expect(r.upsert(id).replace).toBe(false);
      expect(r.upsert(id).skipDeploys).toBe(true);
    }
  });

  it('新しい runner にも役の設定を写す（写さないと役が決まらない）', () => {
    expect(r.apiLog.match(/"startCommand":"alteroid-runner"/g)).toHaveLength(2);
    expect(r.apiLog).not.toContain('"startCommand":"alteroidd"');
  });

  it('set_config_file の呼び出しは、GraphQL の埋め込み改行があっても1要素のまま割れない（#1101 の回帰）', () => {
    // 割れていないかは1要素の中に両方が揃っているかで見る: `some(...)` / `includes(...)` 系だと各断片だけで「含む」が言えて、割れていても素通りするため。
    const configCalls = r.calls.filter(
      (c) => c.includes('api mutation($serviceId') && c.includes('serviceInstanceUpdate(serviceId'),
    );
    expect(configCalls).toHaveLength(2);
    expect(configCalls.some((c) => c.includes('raw-var serviceId=id-runner-2'))).toBe(true);
    expect(configCalls.some((c) => c.includes('raw-var serviceId=id-runner-3'))).toBe(true);
  });

  it('繋ぐ枝は release/prod（1台だけ main を見ると、そこだけマージで畳まれる）', () => {
    const connects = r.calls.filter((c) => c.includes('source connect'));
    expect(connects).toHaveLength(2);
    for (const c of connects) expect(c).toContain('--branch release/prod');
  });

  it('秘密を引数で渡さない（プロセス一覧に出る）', () => {
    expect(r.apiLog).not.toContain('sk-ant-test');
    expect(r.apiLog).not.toContain('github_pat_test');
    expect(r.calls.join('\n')).not.toContain('sk-ant-test');
    expect(r.calls.join('\n')).not.toContain('github_pat_test');
  });
});

describe('記憶ストアの鍵が runner に在ったとき', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.memoryKeyOnRunner;
  });

  it('非0で終わる', () => {
    expect(r.exitCode).not.toBe(0);
  });

  it('1台も作らない', () => {
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
  });

  it('実装のバグとして扱えと言う', () => {
    expect(r.stderr).toContain('実装のバグ');
  });
});

describe('減らそうとしたとき（--vacate 無し）', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.scaleDown;
  });

  it('非0で終わり、何も投入しない', () => {
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.calls.some((c) => c.includes('redeploy'))).toBe(false);
  });

  it('--vacate が要ると言い、黙って器を選ばない（vacate も ssh も呼ばない）', () => {
    expect(r.stderr).toContain('--vacate');
    expect(r.calls.some((c) => c.startsWith('ssh '))).toBe(false);
  });

  it('先に手で確かめる手順も出す（/runners と /managers）', () => {
    expect(r.stderr).toContain('/runners');
    expect(r.stderr).toContain('/managers');
  });
});

describe('--vacate で減らすとき（委譲が移り終わる）', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.vacateSuccess;
  });

  it('成功したら 0 で終わる', () => {
    expect(r.exitCode).toBe(0);
  });

  it('railway ssh --service app の中で node を実行し、runnerId を渡す', () => {
    const sshCalls = r.calls.filter((c) => c.startsWith('ssh '));
    expect(sshCalls).toHaveLength(1);
    expect(sshCalls[0]).toContain('--service app');
    expect(sshCalls[0]).toContain('node - runner-2 5 0.05');
  });

  it('POST /runners/vacate を実際に投げる（偽デーモンが受け取った記録）', () => {
    expect(r.stderr).toContain('vacate を投げた: runnerId=runner-2');
  });

  it('委譲が移り終えたのを確かめてから、消す2手順を表示するだけにする（実際には呼ばない）', () => {
    expect(r.stderr).toContain('確かめられた');
    expect(r.stderr).toContain(
      "railway variable set 'ALTEROID_RUNNER_URLS=http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518' --service app",
    );
    expect(r.stderr).not.toContain('runner-2.RAILWAY_PRIVATE_DOMAIN');
    expect(r.stderr).toContain('railway service delete --service runner-2 --yes');
    expect(r.calls.some((c) => c.includes('service delete'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('variable set'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
  });

  it('待ってから確かめている（1回目の確認では委譲がまだ残っている）', () => {
    expect(r.stderr).toContain('割り当て済みの委譲=有');
    expect(r.stderr).toContain('割り当て済みの委譲=無');
  });

  it('資格の値はこの表示を含む出力にも一度も現れない', () => {
    expect(r.stderr).not.toContain(FAKE_OPERATOR_TOKEN);
  });
});

describe('--vacate で真ん中を指したとき（番号が途切れる）', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.vacateMiddleRejected;
  });

  it('非0で終わる', () => {
    expect(r.exitCode).not.toBe(0);
  });

  it('理由と、受け付ける名前（いちばん大きい番号）を言って断る', () => {
    expect(r.stderr).toContain('真ん中の Service は受け付けない');
    expect(r.stderr).toContain('番号が途切れる');
    expect(r.stderr).toContain('runner-3');
  });

  it('vacate も railway ssh も呼ばない（呼び出し記録が空）', () => {
    expect(r.calls.some((c) => c.startsWith('ssh '))).toBe(false);
    expect(r.stderr).not.toContain('vacate を投げた');
  });
});

describe('--vacate で2台以上減らそうとしたとき', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.vacateTooMany;
  });

  it('非0で終わり、1台ずつ回せと言う', () => {
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('1回に1台だけ');
    expect(r.stderr).toContain('-n 2 --vacate runner-3');
  });

  it('vacate も railway ssh も呼ばない（呼び出し記録が空）', () => {
    expect(r.calls.some((c) => c.startsWith('ssh '))).toBe(false);
    expect(r.stderr).not.toContain('vacate を投げた');
  });
});

describe('VACATED の判定をパイプで書かない（#1610）', () => {
  // 書き方そのものを見る: `set -o pipefail` の下で `printf … | grep -q` と書くと、grep が一致した時点で読むのをやめ、書き残した printf が SIGPIPE（141）で終わってパイプ全体が偽になるが、上のシナリオでは決定的に再現できないため。
  it('scale-runners.sh は pipefail の下で「… | grep -q」を使わない', () => {
    const script = readFileSync(join(RAILWAY_DIR, 'scale-runners.sh'), 'utf8');
    expect(script).toContain('set -euo pipefail');
    const piped = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => /\|\s*(command\s+)?grep\s+-[A-Za-z]*q/.test(line));
    expect(piped).toEqual([]);
  });
});

describe('--vacate で減らすとき（上限を超えて確かめられない）', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.vacateTimeout;
  });

  it('非0で終わる', () => {
    expect(r.exitCode).not.toBe(0);
  });

  it('「確かめられなかった」と言い、消してよいとは一言も言わない', () => {
    expect(r.stderr).toContain('確かめられなかった');
    expect(r.stderr).not.toContain('railway service delete');
    expect(r.stderr).not.toContain('確かめられた');
  });

  it('Service を消さない（呼び出し記録に service delete が無い）', () => {
    expect(r.calls.some((c) => c.includes('service delete'))).toBe(false);
  });
});

describe('資格の値は一度も出ない（vacate 経路）', () => {
  it('成功シナリオの出力に資格の値が無い', () => {
    const r = scenarios.vacateSuccess;
    expect(r.stderr).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(r.calls.join('\n')).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(r.apiLog).not.toContain(FAKE_OPERATOR_TOKEN);
  });

  it('timeout シナリオの出力にも資格の値が無い', () => {
    const r = scenarios.vacateTimeout;
    expect(r.stderr).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(r.calls.join('\n')).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(r.apiLog).not.toContain(FAKE_OPERATOR_TOKEN);
  });
});

describe('もう3台あるとき（回し直し）', () => {
  it('app が既に3台を宛先にしているなら、上げ直さない', () => {
    const r = scenarios.rerunAlreadyAttached;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.calls.some((c) => c.includes('redeploy'))).toBe(false);
  });

  it('宛先が足りていなければ、器は作らず宛先だけ直す', () => {
    const r = scenarios.rerunMissingDest;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS!.split(',')).toHaveLength(3);
    expect(r.calls.some((c) => c.includes('redeploy') && c.includes('--service app'))).toBe(true);
  });
});

describe('置いた宛先の変数参照が解決されなかったとき', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.unresolvedVarRefs;
  });

  it('非0で終わり、app を上げ直さない（届かない宛先で器を入れ替えない）', () => {
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.some((c) => c.includes('redeploy'))).toBe(false);
  });

  it('直し方（解決済みのホスト名を直に置く）を出す', () => {
    expect(r.stderr).toContain('解決されていない');
    expect(r.stderr).toContain('RAILWAY_PRIVATE_DOMAIN');
  });

  it('未解決の値を「もう教えてある」と読まない', () => {
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(true);
  });
});

describe('--dry-run', () => {
  it('何も作らず、何をするかだけ出す', () => {
    const r = scenarios.dryRun;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.stderr).toContain('runner-2');
    expect(r.stderr).toContain('runner-3');
    expect(r.stderr).toContain('上げ直す');
  });
});

describe('runner Service が無いプロジェクトで回したとき', () => {
  it('setup.sh を使えと言って止まる（勝手に建てない）', () => {
    const r = scenarios.noRunnerService;
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('setup.sh');
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
  });
});
