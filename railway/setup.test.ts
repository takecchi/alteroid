/**
 * `railway/setup.sh` が置く変数の**割り振り**を固定する。
 *
 * ここで見ているのは「Railway に繋がるか」ではない（それは人間が一度やれば分かる）。
 * **役ごとにどの鍵が渡るか**である。ここが静かにずれると、コンテナに割った意味が
 * 消えるのに、動作は正常に見える — つまり気づく場所が他に無い。
 *
 * 偽の `railway` を PATH の先に置いて、スクリプトが投げたはずの GraphQL の入力を
 * 拾って突き合わせる。ネットワークにも本物の Railway にも触らない
 * （偽 CLI と足場は `railway/cli-stub.ts`。**`scale-runners.sh` のテストと共有する**）。
 *
 * **`it` はプロセスを起こさない（#1093）。** `setup.sh` / `lib.sh` の実行は重い
 * （1回あたり約28〜30ms、node プロセスの起動コストが支配的）ので、全部この下の
 * 1つの `beforeAll`（`prepareScenarios`）に寄せてある。`it` は出来上がった結果
 * （`scenarios`）を引いて assert するだけで、自分では何もスポーンしない。
 * ⟹ `it` の所要時間は ms 単位に落ち、器がどれだけ混んでも既定の `testTimeout`
 * （5000ms）に触れようがなくなる。詳しい経緯は `prepareScenarios` の直前の
 * コメントと `beforeAll` 呼び出し側の `PREP_TIMEOUT` のコメントを見よ。
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { childEnv, RAILWAY_DIR, type Run, runScriptAsync, scenarioCollector } from './cli-stub.js';

type Options = {
  /** `railway domain` をこけさせる */
  domainFails?: boolean;
  /** 新しい Service に既に繋がっているドメイン（JSON 文字列） */
  domainList?: string;
  /** 非0終了を期待する（既定では非0なら stderr 付きで落とす） */
  allowFailure?: boolean;
  /** 実行後の `.env` を読みたいとき */
  onEnvFile?: (path: string) => void;
  /** runner の台数（`-c`）。既定は渡さない＝1台 */
  runners?: number;
  /** 偽 CLI が `me.workspaces` として返す名前。既定は `['test']`（1つ＝尋ねない） */
  workspaces?: string[];
  /** `--yes` を付けるか（既定 true）。false にすると ASSUME_YES=0 で走る —
   * 対話プロンプトはどれも `/dev/tty` が無い環境では即座に空文字へ倒れるので、
   * 「尋ねようとしたか」までは確かめられるが「人間が何を打ったか」は確かめられない */
  yes?: boolean;
  /** `--branch` を渡すか（既定 'main'）。null にすると渡さず、既定解決ロジックを通す */
  branch?: string | null;
  /** `railway ssh -- alteroid credential set` をこけさせる（正本へ置く段） */
  sshCredentialFails?: boolean;
};

/** `.env` を1つ書いて setup.sh を通し、投げられた入力と終了状態を返す。 */
function run(env: string, options: Options = {}): Promise<Run> {
  const branch = options.branch === undefined ? 'main' : options.branch;
  return runScriptAsync({
    script: 'setup.sh',
    args: [
      ...(options.yes === false ? [] : ['--yes']),
      '--name',
      'test',
      '--repo',
      'takecchi/alteroid',
      ...(branch === null ? [] : ['--branch', branch]),
      ...(options.runners === undefined ? [] : ['--runners', String(options.runners)]),
    ],
    envFile: env,
    extraEnv: {
      ...(options.domainFails ? { FAKE_DOMAIN_FAILS: '1' } : {}),
      ...(options.domainList ? { FAKE_DOMAIN_LIST: options.domainList } : {}),
      ...(options.workspaces ? { FAKE_WORKSPACES: JSON.stringify(options.workspaces) } : {}),
      ...(options.sshCredentialFails ? { FAKE_SSH_CREDENTIAL_FAILS: '1' } : {}),
    },
    allowFailure: options.allowFailure,
    onEnvFile: options.onEnvFile,
  });
}

const MINIMAL = ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-test', 'ALTEROID_RUNNER_TOKEN=deadbeef', ''].join(
  '\n',
);

type ConfigInputResult = { status: number; stdout: string; stderr: string };

/**
 * `railway/*.json を Service の設定へ写す` describe が使う軽い経路
 * （`lib.sh` の `config_input` だけを `bash -c` で走らせる。`setup.sh` 本体は
 * 起こさない）。**軽くても、プロセスを起こしている以上 `it` の中では呼ばない**
 * ——器が混んでいれば軽い呼び出しでも所要時間は伸びうる。
 */
function configInputAsync(config: unknown): Promise<ConfigInputResult> {
  const dir = makeTempDirSync('alteroid-config-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return new Promise((resolve, reject) => {
    const child = spawn(
      'bash',
      ['-c', 'source "$0"; config_input "$1"', join(RAILWAY_DIR, 'lib.sh'), file],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

/** `prepareScenarios` が組み立てる、全 `it` が引く名前付きの結果表。 */
type Scenarios = {
  varsAllocation: Run;
  envRoundtripWritten: string;
  envOverride: Run;
  credentialsFull: Run;
  credentialsGhOnly: Run;
  credentialsNone: Run;
  credentialsSshFails: Run;
  credentialsRunners2: Run;
  runners3: Run;
  runnersBad: Run[];
  setupOrder: Run;
  googleEnabled: Run;
  googleDomainFails: Run;
  publicUrlStale: { r: Run; envAfter: string };
  domainNotAttached: Run;
  domainAttached: Run;
  domainSimilar: Record<string, Run>;
  domainUnreadable: Run;
  domainNested: Run;
  workspaceSolo: Run;
  workspaceExplicit: Run;
  workspaceMultipleYes: Run;
  workspaceMultipleInteractive: Run;
  workspaceEmpty: Run;
  branchDefault: Run;
  configResults: Record<string, ConfigInputResult>;
  configUnknownKey: ConfigInputResult;
  configUnknownSection: ConfigInputResult;
  configNonDockerfileBuilder: ConfigInputResult;
  configMissingStartCommand: ConfigInputResult;
};

let scenarios: Scenarios;

/**
 * **`it` から起動コストを追い出す、唯一の準備段（#1093）。**
 *
 * 段0で測った事実: 64本のテストに対し実際に `setup.sh` 等が走るのは28回
 * （`beforeAll` 経由が6回、`it` の中で直接が22回だった）。これを `it` の中で
 * 直列に起こすと、器が混んでいる時間だけ `it` の所要時間が伸び、既定の
 * `testTimeout`（5000ms）を超えて赤くなる——これが #1093 の症状そのものである
 * （無負荷でいちばん重い `it` は1922ms、5000msに対して余裕は2.6倍しか無かった）。
 *
 * 直し方は2つ組み合わせている:
 * 1. **28回ぶん（＋軽い `config_input` の経路）を全部ここへ集め、`it` は
 *    出来上がった結果を引くだけにする。** ⟹ `it` の所要時間は ms 単位に落ち、
 *    器がどれだけ混んでも `testTimeout` に触れようがなくなる
 * 2. **直列ではなく `runLimited` で並行に走らせる。** 各実行は `mkdtempSync` で
 *    作った自分専用のディレクトリしか触らないので（`cli-stub.ts` の
 *    `runScriptAsync` の `prepare`）、実行どうしに共有状態は無く、並行化しても
 *    結果は変わらない。並行度は `os.cpus().length` で頭打ちにする——無制限に
 *    並べると器の CPU を使い切るため
 *
 * **シナリオは `scenarioCollector` で集める（#1150）。** 素直に `tasks.push` で
 * 集めて `Promise` をそのまま待つと、`allowFailure` を付けていないシナリオが1つ
 * 想定外に死んだだけで `beforeAll` 全体が reject し、**ファイル内の64本が一括で
 * skip になる**（＝「どの保証が壊れたか」がテスト名から読めなくなる）。
 * `scenarioCollector` は失敗を名前の下へしまい、**その名前を引いた側だけに**
 * 投げ直すので、壊れたシナリオを引く `it` / `describe` だけが赤くなる。
 *
 * **この関数自体の timeout（第2引数）の根拠は、呼び出し側（下の `beforeAll`）に
 * 逐語で書いてある。**
 */
async function prepareScenarios(): Promise<Scenarios> {
  const { value: s, task, settle } = scenarioCollector<Scenarios>();

  task('varsAllocation', async () => {
    s.varsAllocation = await run(
      [
        MINIMAL,
        'GH_TOKEN=github_pat_test',
        'GIT_AUTHOR_NAME=tester',
        'GIT_AUTHOR_EMAIL=t@example.com',
        '',
      ].join('\n'),
    );
  });
  task('envRoundtripWritten', async () => {
    let written = '';
    await run(MINIMAL, { onEnvFile: (path) => (written = readFileSync(path, 'utf8')) });
    s.envRoundtripWritten = written;
  });
  task('envOverride', async () => {
    s.envOverride = await run(
      [MINIMAL, 'ALTEROID_ALLOWED_ORIGINS=https://mine.example', ''].join('\n'),
    );
  });

  task('credentialsFull', async () => {
    s.credentialsFull = await run(
      [
        MINIMAL,
        'GH_TOKEN=github_pat_test',
        'GIT_AUTHOR_NAME=tester',
        'GIT_AUTHOR_EMAIL=t@example.com',
        'GIT_COMMITTER_NAME=tester',
        'GIT_COMMITTER_EMAIL=t@example.com',
        '',
      ].join('\n'),
    );
  });
  task('credentialsGhOnly', async () => {
    s.credentialsGhOnly = await run([MINIMAL, 'GH_TOKEN=github_pat_test', ''].join('\n'));
  });
  task('credentialsNone', async () => {
    s.credentialsNone = await run(MINIMAL);
  });
  task('credentialsSshFails', async () => {
    s.credentialsSshFails = await run([MINIMAL, 'GH_TOKEN=github_pat_test', ''].join('\n'), {
      sshCredentialFails: true,
      allowFailure: true,
    });
  });
  task('credentialsRunners2', async () => {
    s.credentialsRunners2 = await run(
      [
        MINIMAL,
        'GH_TOKEN=github_pat_test',
        'GIT_AUTHOR_NAME=tester',
        'GIT_AUTHOR_EMAIL=t@example.com',
        '',
      ].join('\n'),
      { runners: 2 },
    );
  });

  task('runners3', async () => {
    s.runners3 = await run([MINIMAL, 'GH_TOKEN=github_pat_test', ''].join('\n'), { runners: 3 });
  });
  task('runnersBad', async () => {
    s.runnersBad = await Promise.all(
      ['0', 'two', '-1'].map((bad) =>
        run(MINIMAL, { runners: bad as unknown as number, allowFailure: true }),
      ),
    );
  });

  task('setupOrder', async () => {
    s.setupOrder = await run(MINIMAL);
  });

  task('googleEnabled', async () => {
    s.googleEnabled = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        '',
      ].join('\n'),
    );
  });
  task('googleDomainFails', async () => {
    s.googleDomainFails = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        '',
      ].join('\n'),
      { domainFails: true, allowFailure: true },
    );
  });

  task('publicUrlStale', async () => {
    let envAfter = '';
    const r = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://old-project.up.railway.app',
        '',
      ].join('\n'),
      { onEnvFile: (p) => (envAfter = readFileSync(p, 'utf8')) },
    );
    s.publicUrlStale = { r, envAfter };
  });

  task('domainNotAttached', async () => {
    s.domainNotAttached = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { allowFailure: true },
    );
  });
  task('domainAttached', async () => {
    s.domainAttached = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { domainList: JSON.stringify([{ domain: 'alteroid.example' }]) },
    );
  });
  task('domainSimilar', async () => {
    // **似た名前を「在る」と読まない。** JSON を素通しに `grep -F` で探すと
    // `alteroid.example` が `my-alteroid.example` に当たり、届かない口に対して
    // 公開 URL と Google の鍵と待ち受けを置いて 0 で終わる
    const attachedDomains = ['my-alteroid.example', 'alteroid.example.invalid'];
    const results = await Promise.all(
      attachedDomains.map((attached) =>
        run(
          [
            MINIMAL,
            'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
            'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
            'ALTEROID_PUBLIC_URL=https://alteroid.example',
            '',
          ].join('\n'),
          { domainList: JSON.stringify([{ domain: attached }]), allowFailure: true },
        ),
      ),
    );
    // noUncheckedIndexedAccess: `results[i]` は添字アクセスなので型上は `Run | undefined`
    // になるが、`results` は `attachedDomains.map` と同じ長さ・同じ順序で作っているため
    // `i` の範囲は保証されている。
    s.domainSimilar = Object.fromEntries(
      attachedDomains.map((d, i): [string, Run] => [d, results[i]!]),
    );
  });
  task('domainUnreadable', async () => {
    s.domainUnreadable = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { domainList: 'not json', allowFailure: true },
    );
  });
  task('domainNested', async () => {
    s.domainNested = await run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      {
        domainList: JSON.stringify({
          serviceDomains: [{ domain: 'test-app.up.railway.app' }],
          customDomains: [{ domain: 'alteroid.example', id: 'd1' }],
        }),
      },
    );
  });

  task('workspaceSolo', async () => {
    s.workspaceSolo = await run(MINIMAL, { workspaces: ['solo'] });
  });
  task('workspaceExplicit', async () => {
    s.workspaceExplicit = await runScriptAsync({
      script: 'setup.sh',
      args: [
        '--yes',
        '--name',
        'test',
        '--repo',
        'takecchi/alteroid',
        '--branch',
        'main',
        '--workspace',
        'chosen',
      ],
      envFile: MINIMAL,
      extraEnv: { FAKE_WORKSPACES: JSON.stringify(['a', 'b', 'c']) },
    });
  });
  task('workspaceMultipleYes', async () => {
    s.workspaceMultipleYes = await run(MINIMAL, {
      workspaces: ['ws-a', 'ws-b'],
      allowFailure: true,
    });
  });
  task('workspaceMultipleInteractive', async () => {
    s.workspaceMultipleInteractive = await run(MINIMAL, {
      workspaces: ['ws-a', 'ws-b'],
      yes: false,
      allowFailure: true,
    });
  });
  task('workspaceEmpty', async () => {
    s.workspaceEmpty = await run(MINIMAL, { workspaces: [] });
  });

  // **このシナリオだけ本物の origin（GitHub）へ `git ls-remote` する。**
  // REPO_ROOT は railway/lib.sh 自身の場所（＝このリポジトリの根）から
  // 固定的に決まり、テストから差し替える口が無い。release/prod は本番の
  // 反映元として運用されている枝なので、ネットワークが繋がる環境では
  // 安定して存在する（無ければ CI 自体が他の理由で壊れている）。
  // ⚠️ ネットワーク待ちが乗る分の余裕は、下の `PREP_TIMEOUT` の側に見てある
  // （このシナリオはかつて、このためだけに `it` 側で 15_000ms の個別 timeout を
  // 持っていた）。
  task('branchDefault', async () => {
    s.branchDefault = await run(MINIMAL, { branch: null, workspaces: ['test'] });
  });

  // **数え上げの持ち主は railway/ そのものである。** readdirSync 自体はプロセスを
  // 起こさないのでここで直接呼んでよい——重いのは中身を `config_input` へ通す方
  // ⚠️ この sweep は `railway/*.json` を無条件に Railway の Service 設定として読む
  // （#1171）。だから **`railway/` の直下に Service 設定以外の `.json` を置かない
  // こと**——`tsconfig.json` を置いたところ、この sweep がそれを拾って
  // `config_input` へ通し「知らない節: extends」で落ちた。型検査用の tsconfig は
  // 根の `tsconfig.railway.json`（`include: ["railway/**/*.ts"]`）に置いてある。
  const configs = readdirSync(RAILWAY_DIR).filter((f) => f.endsWith('.json'));
  task('configResults', async () => {
    const entries = await Promise.all(
      configs.map(async (name): Promise<[string, ConfigInputResult]> => {
        const config = JSON.parse(readFileSync(join(RAILWAY_DIR, name), 'utf8'));
        return [name, await configInputAsync(config)];
      }),
    );
    s.configResults = Object.fromEntries(entries);
  });
  task('configUnknownKey', async () => {
    s.configUnknownKey = await configInputAsync({
      build: { zzz: 1 },
      deploy: { startCommand: 'x' },
    });
  });
  task('configUnknownSection', async () => {
    s.configUnknownSection = await configInputAsync({ zzz: {}, deploy: { startCommand: 'x' } });
  });
  task('configNonDockerfileBuilder', async () => {
    s.configNonDockerfileBuilder = await configInputAsync({
      build: { builder: 'NIXPACKS' },
      deploy: { startCommand: 'x' },
    });
  });
  task('configMissingStartCommand', async () => {
    s.configMissingStartCommand = await configInputAsync({
      build: { dockerfilePath: 'Dockerfile' },
      deploy: {},
    });
  });

  return settle(cpus().length);
}

/**
 * **`PREP_TIMEOUT` の根拠（勘で置いていない）。**
 *
 * `beforeAll(fn, timeout)` の第2引数は「`it` の timeout を伸ばす」のとは別物
 * である——`it` からは時間依存を追い出した後なので、ここで伸ばしているのは
 * *残った準備段*（`prepareScenarios`。34回の実プロセス起動を `runLimited` で
 * `os.cpus().length` 本まで並行に走らせる）であり、根拠は実測した最悪値の
 * 倍数で書ける。
 *
 * **実測（この器、32 vCPU、2026-09-16）**: `beforeAll` の所要時間を4条件で
 * 測った（それぞれ2回、`Date.now()` の差分）。
 *
 * | 条件                                     | 実測                  |
 * | ----------------------------------------- | --------------------- |
 * | 無負荷                                     | 3433ms / 3727ms       |
 * | `nproc`（32本）の CPU busy-loop を掛けた状態 | 15228ms / 17161ms     |
 * | `taskset -c 0,1`（2芯に絞った状態）        | 17541ms / **19142ms** |
 * | 2×`nproc`（64本）の busy-loop を掛けた状態  | 17693ms / **23915ms** |
 *
 * **最悪値は 23915ms**（2×nproc busy-loop）。`taskset -c 0,1` は `os.cpus()`
 * が返す論理コア数を変えない（affinity だけを絞るため）ので、`runLimited` は
 * 2芯の器でも32本ぶん並行に投げにいく——**芯数が少ない器ほど「並行度を実コア数
 * より高く見積もって溢れる」側の最悪ケースに近い**、という点で上の4条件のうち
 * 最も実運用の悪条件に近いと考えている。
 *
 * **倍率は最悪値の約2.5倍。** 24000ms × 2.5 ≈ 60000ms。単発の測定なので
 * ばらつきが在り（同条件でも15228〜23915msの幅が出ている）、その振れ幅
 * （最良/最悪で約1.6倍）を考えると2.5倍は「もう1段階悪い器」を吸収できる
 * 程度の余裕として選んだ——時間を無限に伸ばして問題を隠す発想ではなく、
 * 実測した最悪値を起点にしている。
 */
const PREP_TIMEOUT = 60_000;

beforeAll(async () => {
  scenarios = await prepareScenarios();
}, PREP_TIMEOUT);

describe('シェルスクリプトの書き方', () => {
  // **数え上げの持ち主は `railway/` そのものである。** 名前を書き並べると、
  // スクリプトを1つ足した回だけ静かに素通りする（実際 lib.sh と scale-runners.sh を
  // 足したとき、この行を直さなければ2本が見張りの外に出ていた）
  const scripts = readdirSync(RAILWAY_DIR).filter((f) => f.endsWith('.sh'));

  it('数えるスクリプトが1本も無い、にならない', () => {
    // 上の filter が空を返しても `it.each` は「0件成功」で緑になる（空振りの合格）
    expect(scripts.length).toBeGreaterThanOrEqual(4);
  });

  // macOS の bash 3.2 は、変数参照の直後に全角文字が続くとそのバイトを**変数名に
  // 取り込む**（`"${ENV_FILE}（…"` を `ENV_FILE（` という名前として読む）。`set -u` の
  // 下では起動直後に unbound variable で死ぬ。日本語のメッセージを書き足すたびに
  // 踏むので、目で見張るのをやめてここで止める
  it.each(scripts)('%s: 変数参照の直後に全角文字を置かない', (name) => {
    const source = readFileSync(join(RAILWAY_DIR, name), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      // eslint-disable-next-line no-control-regex
      .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
      .map(({ line, no }) => `${name}:${no}: ${line.trim()}`);
    // ${VAR} と書けば直る
    expect(offenders).toEqual([]);
  });
});

describe('テスト自身が setup.sh に渡す環境', () => {
  // ここが緩むと、下の全部が「走らせた人のシェル次第」になる。しかも緩んだことは
  // **落ちたときの差分に本物の鍵が出る**か、**空振りで緑になる**かでしか現れない
  it('親のシェルからは PATH しか渡さない', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        // 以下はすべて偽物である（本物を書かないこと。落ちれば出力に出る）
        GH_TOKEN: 'inherited-must-not-reach-setup',
        CLAUDE_CODE_OAUTH_TOKEN: 'inherited-must-not-reach-setup',
        ALTEROID_RUNNER_TOKEN: 'inherited-must-not-reach-setup',
        // 鍵でなくても、これらは投入先の Service 名や偽 CLI の挙動を書き換える
        ALTEROID_APP_SERVICE: 'renamed',
        ALTEROID_ENV_FILE: '/somewhere/else/.env',
        FAKE_DOMAIN_FAILS: '1',
      },
      '/tmp/bin',
      { FAKE_STATE: '/tmp/state' },
    );
    expect(Object.keys(env).sort()).toEqual(['FAKE_STATE', 'PATH']);
    expect(env.PATH).toBe('/tmp/bin:/usr/bin');
  });
});

describe('setup.sh が置く変数の割り振り', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.varsAllocation;
  });

  it('記憶ストアの鍵は app にだけ渡る', () => {
    // 渡した瞬間、runner の中の子プロセス（＝マネージャー）が /proc/1/environ から
    // 鍵を取れる状態に戻り、器を分けた意味が消える
    expect(r.vars('id-app').ALTEROID_DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
    expect(r.vars('id-runner')).not.toHaveProperty('ALTEROID_DATABASE_URL');
  });

  it('RAILWAY_RUN_UID=0 は runner にだけ渡る', () => {
    // runner は子プロセスを uid 1001 へ降ろすのに特権が要る。app は root で起きても
    // 自分で node へ降りるので、渡す理由が無い
    expect(r.vars('id-runner').RAILWAY_RUN_UID).toBe('0');
    expect(r.vars('id-app')).not.toHaveProperty('RAILWAY_RUN_UID');
  });

  it('ブラウザから叩いてよいオリジンは app にだけ渡る', () => {
    // 読むのはデーモンだけである（apps/daemon/src/index.ts）。runner は1度も見ない。
    // **デーモンのコードの既定は閉じたままで**（docs/architecture.md「CORS は既定で
    // 閉じている」）、開けたことは Service 変数と .env の両方に残る
    expect(r.vars('id-app').ALTEROID_ALLOWED_ORIGINS).toBe('https://alteroid.vercel.app');
    expect(r.vars('id-runner')).not.toHaveProperty('ALTEROID_ALLOWED_ORIGINS');
  });

  it('答えは .env に書き留める（次の実行で尋ね直さない）', () => {
    expect(scenarios.envRoundtripWritten).toContain(
      'ALTEROID_ALLOWED_ORIGINS=https://alteroid.vercel.app',
    );
  });

  it('.env に在ればそれを使う（既定で上書きしない）', () => {
    const mine = scenarios.envOverride;

    expect(mine.vars('id-app').ALTEROID_ALLOWED_ORIGINS).toBe('https://mine.example');
    // 既定を足さない。足すと、置いた列挙から公式のオリジンを消せなくなる
    expect(mine.vars('id-app').ALTEROID_ALLOWED_ORIGINS).not.toContain('vercel.app');
  });

  it('公式のオリジンを書き写さない（lib.sh の1か所だけが持つ）', () => {
    // 書き写すと、ホスト名が変わったときに片方だけが古びる。**気づく場所が他に無い**
    const holders = readdirSync(RAILWAY_DIR)
      .filter((f) => f.endsWith('.sh'))
      .filter((f) =>
        readFileSync(join(RAILWAY_DIR, f), 'utf8').includes('https://alteroid.vercel.app'),
      );

    expect(holders).toEqual(['lib.sh']);
  });

  it('合鍵は同じ値が両方へ渡り、sha256 は人間に置かせない', () => {
    const app = r.vars('id-app');
    const runner = r.vars('id-runner');
    expect(runner.ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
    expect(app.ALTEROID_RUNNER_TOKEN).toBe(runner.ALTEROID_RUNNER_TOKEN);
    // 畳むのは器の仕事（docker/alteroid-runner）。人間に二重管理をさせない
    expect(runner).not.toHaveProperty('ALTEROID_RUNNER_TOKEN_SHA256');
  });

  it('GH_TOKEN と身元は Shared/Service Variables には置かない（正本＝DBへ置く）', () => {
    // 置くと「器を作り直すたびに人間が焼き直す」形に戻る（AGENTS.md 地雷表）。
    // 下へ手を伸ばす鍵を伏せる話ではない——置き場を変えただけである
    // （下の「GitHub の鍵を正本（DB）へ置く」describe が置き先を確かめる）
    for (const id of ['id-app', 'id-runner']) {
      const v = r.vars(id);
      expect(v).not.toHaveProperty('GH_TOKEN');
      expect(v).not.toHaveProperty('GIT_AUTHOR_NAME');
      expect(v).not.toHaveProperty('GIT_COMMITTER_EMAIL');
    }
  });

  it('委譲の宛先は literal の参照のまま届く（シェルに展開させない）', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URL).toBe(
      'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
    );
    // Railway の private network は IPv6。既定の 127.0.0.1 のままだと daemon から届かない
    expect(r.vars('id-runner').ALTEROID_RUNNER_BIND).toBe('::');
  });

  it('待ち受けを開けない（叩けばクローンのターンが起きる口を無認証で外に出さない）', () => {
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_BIND');
    expect(r.calls.some((c) => c.startsWith('domain'))).toBe(false);
  });

  it('変数名に空白が混ざらない（ダッシュボード貼り付けの罠）', () => {
    const names = [...Object.keys(r.vars('id-app')), ...Object.keys(r.vars('id-runner'))];
    expect(names.filter((n) => n !== n.trim())).toEqual([]);
  });

  it('追記であって置き換えではなく、デプロイは自分で起こす', () => {
    for (const id of ['id-app', 'id-runner']) {
      expect(r.upsert(id).replace).toBe(false);
      expect(r.upsert(id).skipDeploys).toBe(true);
    }
  });

  it('秘密を引数で渡さない（プロセス一覧に出る）', () => {
    expect(r.apiLog).not.toContain('sk-ant-test');
    expect(r.apiLog).not.toContain('github_pat_test');
  });
});

describe('GitHub の鍵を正本（DB）へ置く', () => {
  // Shared/Service Variables に置くのをやめ、app が上がった後
  // `railway ssh -- alteroid credential set` で正本（DB）へ置くようにした
  // （旧: 実際のデプロイで手動でこの形にしたが、setup.sh 自体は直っておらず、
  // 再実行すると元の Shared Variables 置きへ戻っていた不具合の是正）。

  it('app が上がった後、GH_TOKEN と身元を正本へ置く（値は stdin から）', () => {
    const r = scenarios.credentialsFull;
    expect(r.exitCode).toBe(0);
    const byName = Object.fromEntries(r.credentials.map((c) => [c.name, c]));
    expect(byName.GH_TOKEN).toMatchObject({ service: 'app', value: 'github_pat_test' });
    expect(byName.GIT_AUTHOR_NAME).toMatchObject({ service: 'app', value: 'tester' });
    expect(byName.GIT_AUTHOR_EMAIL).toMatchObject({ service: 'app', value: 't@example.com' });
    expect(byName.GIT_COMMITTER_NAME).toMatchObject({ service: 'app', value: 'tester' });
    expect(byName.GIT_COMMITTER_EMAIL).toMatchObject({ service: 'app', value: 't@example.com' });
  });

  it('GIT_AUTHOR_* が無ければ GH_TOKEN だけ置く（身元が空なら置かない）', () => {
    const r = scenarios.credentialsGhOnly;
    expect(r.exitCode).toBe(0);
    const names = r.credentials.map((c) => c.name);
    expect(names).toEqual(['GH_TOKEN']);
  });

  it('GH_TOKEN を渡さなければ、正本にも何も置かない', () => {
    const r = scenarios.credentialsNone;
    expect(r.exitCode).toBe(0);
    expect(r.credentials).toEqual([]);
  });

  it('置けなかったら非0で終わる（黙って Shared Variables 無し・DB 無しにしない）', () => {
    const r = scenarios.credentialsSshFails;
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('正本へ置けなかった');
  });

  it('runner の Shared Variables には置かない（runner は自分の env から鍵を拾わない設計と対になる）', () => {
    const r = scenarios.credentialsRunners2;
    for (const c of r.credentials) {
      // 正本は app 経由でしか置けない（daemon の HTTP API が 127.0.0.1 の app に居る）
      expect(c.service).toBe('app');
    }
  });
});

describe('runner を3台で作るとき（-c 3）', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.runners3;
  });

  it('runner_id が台ごとに違う', () => {
    // **同じ id が2台に載ると sticky routing が黙って壊れる。**
    // 台帳の `manager_id → runner_id` を引く `RunnerRegistry#get` は線形一致で
    // 先に見つかった方を返すので、`manager_send` が別の器へ届く（`select({runnerId})`
    // だけは「一意でない」と拒むが、send / abort / transcript / restore は get を通る）。
    // 名簿は重複を検出しないので、症状は「たまに噛み合わない」だけになる
    const ids = ['id-runner', 'id-runner-2', 'id-runner-3'].map(
      (id) => r.vars(id).ALTEROID_RUNNER_ID,
    );
    expect(ids).toEqual(['runner-primary', 'runner-2', 'runner-3']);
    expect(new Set(ids).size).toBe(3);
  });

  it('1台目の名前は変えない（台帳が指しているのはこれである）', () => {
    // Service 名 `runner` / runner_id `runner-primary` は既に動いているものの名前で、
    // 変えると走行中のマネージャーへの経路が切れる
    expect(r.vars('id-runner').ALTEROID_RUNNER_ID).toBe('runner-primary');
  });

  it('委譲の宛先は3台ぶん並び、単数形は置かない', () => {
    const app = r.vars('id-app');
    expect(app.ALTEROID_RUNNER_URLS).toBe(
      [
        'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-3.RAILWAY_PRIVATE_DOMAIN}}:4518',
      ].join(','),
    );
    // 同じことを言う変数を2つ置かない（デーモンは両方読むので害は無いが、
    // 2か所あると片方だけ直した回に食い違う）
    expect(app).not.toHaveProperty('ALTEROID_RUNNER_URL');
  });

  it('app には runner_id を置かない（どの1台か書けない）', () => {
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_RUNNER_ID');
  });

  it('境界の割り振りは台数が増えても変わらない', () => {
    for (const id of ['id-runner', 'id-runner-2', 'id-runner-3']) {
      // 記憶ストアの鍵は1台にも渡らない
      expect(r.vars(id)).not.toHaveProperty('ALTEROID_DATABASE_URL');
      // 子プロセスを uid 1001 へ降ろすのに特権が要る
      expect(r.vars(id).RAILWAY_RUN_UID).toBe('0');
      // 合鍵は全台で同じ（食い違うと 401 で unusable になる）
      expect(r.vars(id).ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
      // GH_TOKEN は Shared/Service Variables には置かない（正本＝DBへ置く）
      expect(r.vars(id)).not.toHaveProperty('GH_TOKEN');
    }
    expect(r.vars('id-app')).not.toHaveProperty('RAILWAY_RUN_UID');
  });

  it('3台とも Config as Code を指す（指さないと役が決まらない）', () => {
    // 同じイメージから2役を出しているので、これが無い Service は startCommand を持たない
    const configured = r.calls.filter((c) => c.startsWith('api mutation($serviceId'));
    expect(configured).toHaveLength(4); // app + runner × 3
  });

  it('3台とも app より先に繋ぐ', () => {
    // 1台でも後回しにすると、デーモンが起きたときその宛先だけ不在から始まる
    const at = (name: string): number =>
      r.calls.findIndex((c) => c.includes('source connect') && c.includes(`--service ${name}`));
    const app = at('app');
    for (const name of ['runner', 'runner-2', 'runner-3']) {
      expect(at(name)).toBeGreaterThanOrEqual(0);
      expect(at(name)).toBeLessThan(app);
    }
  });

  it('台数が0や文字では作らない', () => {
    for (const bogus of scenarios.runnersBad) {
      expect(bogus.exitCode).not.toBe(0);
    }
  });
});

describe('setup.sh の順番', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.setupOrder;
  });

  const index = (pred: (c: string) => boolean): number => r.calls.findIndex(pred);

  it('役の設定を役ごとに写す', () => {
    // **かつては「ファイルのパスを指す」だけだった**（Config as Code）。Railway が
    // サーバ側で廃止したので、いまは中身を写す（lib.sh の `set_config_file`）。
    // だから固定するのも「daemon.json を指したか」ではなく「役が決まったか」である —
    // 同じイメージから2役を出しているので、`startCommand` が役そのものである
    expect(r.apiLog).toContain('"startCommand":"alteroidd"');
    expect(r.apiLog).toContain('"startCommand":"alteroid-runner"');
    // パスを渡すと mutation ごと落ちる（INTERNAL_SERVER_ERROR / deprecated）
    expect(r.apiLog).not.toContain('railwayConfigFile');
  });

  it('変数と Config as Code は source を繋ぐ前に置く', () => {
    // 繋いだ瞬間にデプロイが走りうるので、後から置くと初回が必ず失敗する
    const connect = index((c) => c.includes('source connect'));
    expect(index((c) => c.startsWith('api mutation($serviceId'))).toBeLessThan(connect);
    expect(index((c) => c.includes('VariableCollectionUpsert'))).toBeLessThan(connect);
  });

  it('runner を app より先に繋ぐ', () => {
    // daemon は起動時に runner の /health へ名乗りを聞きに行く
    const runner = index((c) => c.includes('source connect') && c.includes('--service runner'));
    const app = index((c) => c.includes('source connect') && c.includes('--service app'));
    expect(runner).toBeGreaterThanOrEqual(0);
    expect(runner).toBeLessThan(app);
  });

  it('ボリュームを作らない（記憶は PostgreSQL、workspace は Git 再構築）', () => {
    expect(r.calls.some((c) => c.includes('volume'))).toBe(false);
  });

  it('Service の指定を省かない（省くと最後に作ったものへ黙って向く）', () => {
    const risky = r.calls.filter(
      (c) => /^(variable|up|deployment|domain)\b/.test(c) && !c.includes('--service'),
    );
    expect(risky).toEqual([]);
  });
});

describe('Google ログインを有効にしたとき', () => {
  let r: Run;
  beforeAll(() => {
    r = scenarios.googleEnabled;
  });

  it('鍵とドメインは app にだけ渡り、待ち受けが開く', () => {
    const app = r.vars('id-app');
    expect(app.ALTEROID_GOOGLE_CLIENT_ID).toBe('xxx.apps.googleusercontent.com');
    expect(app.ALTEROID_PUBLIC_URL).toBe('https://test-app.up.railway.app');
    // 手前に境界（ログイン）が立ってから開ける
    expect(app.ALTEROID_BIND).toBe('::');
    expect(app.ALTEROID_PORT).toBe('4517');
  });

  it('runner には入口の認証の鍵を渡さない', () => {
    // 渡すと、その中のマネージャーが自分でアクセストークンを発行して記憶へ届く
    const runner = r.vars('id-runner');
    expect(runner).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(runner).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    expect(runner).not.toHaveProperty('ALTEROID_PUBLIC_URL');
  });

  it('境界の割り振りは Google を有効にしても変わらない', () => {
    expect(r.vars('id-runner')).not.toHaveProperty('ALTEROID_DATABASE_URL');
    expect(r.vars('id-runner').RAILWAY_RUN_UID).toBe('0');
  });

  it('成功したら 0 で終わる', () => {
    expect(r.exitCode).toBe(0);
  });
});

describe('Google ログインを選んだのにドメインが作れなかったとき', () => {
  // **黙って「外から叩けない構成」に化けさせない。**
  // 鍵と待ち受けを置かないのは正しい（境界の無い口を外に出さない）が、正しいがゆえに
  // 頼まれたものとは別物になる。ここで 0 を返すと、呼んだ側は完了と読み、人間は
  // 叩けない理由を Google 側の設定に探しに行く
  let r: Run;
  beforeAll(() => {
    r = scenarios.googleDomainFails;
  });

  it('非0で終わる', () => {
    expect(r.exitCode).not.toBe(0);
  });

  it('境界の無い口を外に出さない（鍵も待ち受けも置かない）', () => {
    const app = r.vars('id-app');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    expect(app).not.toHaveProperty('ALTEROID_PUBLIC_URL');
    expect(app).not.toHaveProperty('ALTEROID_BIND');
  });

  it('ここまでに作ったものは壊さない（残りを手で足せる状態で終わる）', () => {
    // 途中で投げ出すと Service だけ在ってデプロイされていない状態になり、かえって困る
    expect(r.vars('id-app').ALTEROID_DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
    expect(r.vars('id-runner').RAILWAY_RUN_UID).toBe('0');
    expect(r.calls.some((c) => c.includes('source connect') && c.includes('--service app'))).toBe(
      true,
    );
  });
});

describe('.env に前の器の ALTEROID_PUBLIC_URL が残っているとき', () => {
  // 毎回新しいプロジェクトを作るので、前回書き留めた生成ドメインは別の器のものである。
  // そのまま信じると、死んだドメインを指す設定と Redirect URI ができる
  let r: Run;
  let envAfter = '';
  beforeAll(() => {
    r = scenarios.publicUrlStale.r;
    envAfter = scenarios.publicUrlStale.envAfter;
  });

  it('前の生成ドメインは使わず、作り直した値を置く', () => {
    expect(r.vars('id-app').ALTEROID_PUBLIC_URL).toBe('https://test-app.up.railway.app');
    expect(r.calls.some((c) => c.startsWith('domain --service'))).toBe(true);
  });

  it('.env の古い値も置き直す（次の実行と compose に嘘を残さない）', () => {
    expect(envAfter).toContain('ALTEROID_PUBLIC_URL=https://test-app.up.railway.app');
    expect(envAfter).not.toContain('old-project.up.railway.app');
  });

  it('.env の他の値は壊さない', () => {
    expect(envAfter).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-test');
    expect(envAfter).toContain('ALTEROID_RUNNER_TOKEN=deadbeef');
    expect(envAfter).toContain('ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret');
  });
});

describe('.env に持ち込みのドメインがあるとき', () => {
  it('新しい Service に繋がっていなければ非0で終わり、鍵を置かない', () => {
    const r = scenarios.domainNotAttached;
    expect(r.exitCode).not.toBe(0);
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_BIND');
    // 持ち込みのドメインを勝手に作らない（DNS を向けるのは人間の作業）
    expect(r.calls.some((c) => c.startsWith('domain alteroid.example'))).toBe(false);
  });

  it('繋がっていればそれを使う（生成し直さない）', () => {
    const r = scenarios.domainAttached;
    expect(r.exitCode).toBe(0);
    expect(r.vars('id-app').ALTEROID_PUBLIC_URL).toBe('https://alteroid.example');
    expect(r.vars('id-app').ALTEROID_BIND).toBe('::');
    expect(r.calls.some((c) => c.startsWith('domain --service'))).toBe(false);
  });

  // **似た名前を「在る」と読まない。** JSON を素通しに `grep -F` で探すと
  // `alteroid.example` が `my-alteroid.example` に当たり、届かない口に対して
  // 公開 URL と Google の鍵と待ち受けを置いて 0 で終わる
  it.each([
    ['前に何か付いている', 'my-alteroid.example'],
    ['後ろに何か付いている', 'alteroid.example.invalid'],
  ])('似た名前だけが繋がっているとき（%s）は非0で終わり、鍵を置かない', (_name, attached) => {
    // noUncheckedIndexedAccess: `attached` は直上の `it.each` の配列そのままで、
    // `domainSimilar` を作った `attachedDomains` と同じ2値なので存在は保証されている。
    const r = scenarios.domainSimilar[attached]!;
    expect(r.exitCode).not.toBe(0);
    const app = r.vars('id-app');
    expect(app).not.toHaveProperty('ALTEROID_PUBLIC_URL');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    expect(app).not.toHaveProperty('ALTEROID_BIND');
  });

  it('応答が読めないときは「繋がっていない」に倒す', () => {
    // 開ける側の判断なので、分からないなら閉じたままにする
    const r = scenarios.domainUnreadable;
    expect(r.exitCode).not.toBe(0);
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_BIND');
  });

  it('入れ子の応答でも完全一致なら使う（Railway の形が変わっても拾う）', () => {
    const r = scenarios.domainNested;
    expect(r.exitCode).toBe(0);
    expect(r.vars('id-app').ALTEROID_PUBLIC_URL).toBe('https://alteroid.example');
  });
});

describe('ワークスペースの解決', () => {
  // `--workspace` を省いたときの分岐。実際に「複数ワークスペースを持つ人だけが
  // `--workspace required in non-interactive mode` という、候補すら見えないエラーで
  // 止まる」が起きたので、ここを直した（railway/lib.sh の `list_workspace_names`）。

  it('1つしか無ければ尋ねずに使う', () => {
    const r = scenarios.workspaceSolo;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('init') && c.includes('--workspace solo'))).toBe(true);
  });

  it('明示した --workspace を優先し、一覧を見に行かない', () => {
    const r = scenarios.workspaceExplicit;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('init') && c.includes('--workspace chosen'))).toBe(
      true,
    );
    // 一覧を問い合わせる api 呼び出し自体が無い（明示されているので不要）
    expect(r.calls.some((c) => c.includes('workspaces'))).toBe(false);
  });

  it('複数あって --yes なら、候補を示して非0で止まる（黙って選ばない）', () => {
    const r = scenarios.workspaceMultipleYes;
    expect(r.exitCode).not.toBe(0);
    // 一覧すら見えないエラーで止まっていたのが元の不具合だった。候補名が
    // エラーメッセージ自体に出ることを確かめる
    expect(r.stderr).toContain('ws-a');
    expect(r.stderr).toContain('ws-b');
    expect(r.stderr).toContain('--workspace');
  });

  it('複数あって対話なら、選ぶ前に一覧を見せる', () => {
    // tty が無いテスト環境では `ask` が空文字へ倒れて止まるので、「人間が何を
    // 選んだか」までは確かめられない。確かめられるのは「一覧を見せてから
    // 尋ねようとしたか」である
    const r = scenarios.workspaceMultipleInteractive;
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('ws-a');
    expect(r.stderr).toContain('ws-b');
  });

  it('一覧が0件（API 応答が読めない等）なら、今までどおり railway init に委ねる', () => {
    const r = scenarios.workspaceEmpty;
    expect(r.exitCode).toBe(0);
    // --workspace を付けずに呼ぶ（今までの挙動のまま）
    expect(r.calls.some((c) => c.startsWith('init') && !c.includes('--workspace'))).toBe(true);
  });
});

describe('ブランチの解決', () => {
  // --branch を明示したときに尋ねない（＝今までの全テストが実は確かめている
  // 経路）は、既存の describe 群がそのまま線を引いている。ここで確かめるのは
  // 省いたときの新しい経路だけである。

  it('--branch を省くと、release/prod を既定として尋ねた上で使う', () => {
    // **このテストだけ本物の origin（GitHub）へ `git ls-remote` する。**
    // REPO_ROOT は railway/lib.sh 自身の場所（＝このリポジトリの根）から
    // 固定的に決まり、テストから差し替える口が無い。release/prod は本番の
    // 反映元として運用されている枝なので、ネットワークが繋がる環境では
    // 安定して存在する（無ければ CI 自体が他の理由で壊れている）。
    // ⚠️ 実行そのものは共有の準備段（ファイル冒頭の `beforeAll`）へ移した。
    // かつてはこのネットワーク待ちのためだけに、この `it` 自身が 15_000ms の
    // 個別 timeout を持っていた——いまは `it` は結果を引くだけなので不要になった。
    const r = scenarios.branchDefault;
    expect(r.exitCode).toBe(0);
    expect(
      r.calls.some((c) => c.includes('source connect') && c.includes('--branch release/prod')),
    ).toBe(true);
  });
});

describe('railway/*.json を Service の設定へ写す', () => {
  // Config as Code（ファイルのパスを指す）を Railway がサーバ側で廃止したので、
  // **中身をこちらで写す**ようになった（lib.sh の `config_input`）。ここで固定するのは
  // 写し方ではなく**写せなかったときに止まること**である — 黙って落とすと、json に
  // 足した設定が「書いたのに効かない」形で消え、ダッシュボードは既定値のままなので
  // 気づく場所が他に無い

  it('現物の2つを写せる（役が startCommand で決まる）', () => {
    // **数え上げの持ち主は railway/ そのものである。** 名前を並べると、役を足した回だけ
    // 静かに素通りする
    const configs = readdirSync(RAILWAY_DIR).filter((f) => f.endsWith('.json'));
    expect(configs.length).toBeGreaterThanOrEqual(2);
    for (const name of configs) {
      // noUncheckedIndexedAccess: `configs` はここと `task('configResults', ...)` の
      // どちらも同じ `readdirSync(RAILWAY_DIR)` から作っているため、`name` は必ず
      // `configResults` の鍵として存在する。
      const r = scenarios.configResults[name]!;
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const input = JSON.parse(r.stdout);
      expect(typeof input.startCommand).toBe('string');
      // Builder enum から DOCKERFILE が消えた（HEROKU / NIXPACKS / PAKETO / RAILPACK）。
      // Dockerfile で焼くかを決めるのは dockerfilePath である
      expect(input.builder).toBeUndefined();
      expect(input.dockerfilePath).toBe('Dockerfile');
    }
  });

  it('知らない鍵は黙って落とさず止まる', () => {
    const r = scenarios.configUnknownKey;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('build.zzz');
  });

  it('知らない節も止まる', () => {
    const r = scenarios.configUnknownSection;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('zzz');
  });

  it('DOCKERFILE 以外の builder は止まる（黙って捨てると別のもので焼かれる）', () => {
    const r = scenarios.configNonDockerfileBuilder;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NIXPACKS');
  });

  it('startCommand が無ければ止まる（役が決まらないまま上げない）', () => {
    const r = scenarios.configMissingStartCommand;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('startCommand');
  });
});
