/**
 * `railway/scale-runners.sh` が**既に動いているもの**をどう扱うかを固定する。
 *
 * `setup.sh` のテストと見ているものが違う。あちらは「役ごとにどの鍵が渡るか」で、
 * こちらは**触らないもの**である:
 *
 *   1. **既存の runner の変数に触らない** — 触れば器が入れ替わり、その中で手を
 *      動かしているマネージャーと作業者が死ぬ。しかも死んだことは「委譲が返って
 *      こない」という形でしか出ないので、気づくのは人間が待ったあとである
 *   2. **runner_id を写さない** — 写ると2台が同じ名前を名乗り、`RunnerRegistry#get`
 *      が線形一致で先に見つかった方を返す。`manager_send` が別の器へ届くのに、
 *      名簿は重複を検出しないので症状は「たまに噛み合わない」だけになる
 *   3. **記憶ストアの鍵を写さない** — 写せば runner の中のマネージャーが
 *      `/proc/1/environ` から取れる状態に戻り、器を割った意味が消える
 *
 * 偽の `railway` を PATH の先に置いて確かめる（足場は `railway/cli-stub.ts`）。
 * ネットワークにも本物の Railway にも触らない。
 *
 * **`it` はプロセスを起こさない（#1100）。** かつては `it` の中で直接4回、
 * `beforeAll` で4回、合計8回 `scale-runners.sh` を直列に起こしていた
 * （`setup.test.ts` の #1093 と同型の問題）。いまは全部この下の1つの
 * `beforeAll`（`prepareScenarios`）に寄せてある。`it` は出来上がった結果
 * （`scenarios`）を引いて assert するだけで、自分では何もスポーンしない。
 * 詳しい経緯は `prepareScenarios` の直前のコメントと `beforeAll` 呼び出し側の
 * `PREP_TIMEOUT` のコメントを見よ。
 *
 * ## vacate 経路（#1377。#485 PR6-b の切り出し）
 *
 * 減らす操作（`--vacate`）は、上の3つとは別の軸で確かめる必要がある —
 * **`railway ssh --service $APP_SERVICE` の中で 127.0.0.1:$ALTEROID_PORT を
 * 叩く**という経路そのものである。他のシナリオのように「偽 `railway` が呼び
 * 出し引数を記録するだけ」では、この機能でいちばん問われている部分
 * （待ち方・資格の読み方・出力に資格を出さないこと）がテストから抜け落ちる
 * ——だから `cli-stub.ts` の偽 `ssh` は、渡された node スクリプト（本番と
 * 1バイトも違わない、`scale-runners.sh` が埋め込んでいるものそのもの）を
 * 実際に子プロセスとして実行する。相手にするのは `node:http` で立てた偽の
 * デーモン（`startFakeDaemon`）で、資格は `ALTEROID_HOME/state/daemon.json`
 * に用意する（`apps/daemon/src/runtime.ts` の `writeRuntimeInfo` と同じ形）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { cpus } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';
import { RAILWAY_DIR, type Run, runScriptAsync, scenarioCollector } from './cli-stub.js';

/** いま本番に在るもの（app / Postgres / runner の3つ）。 */
const EXISTING = [
  { id: 'id-app', name: 'app', source: { repo: 'takecchi/alteroid', image: null } },
  { id: 'id-Postgres', name: 'Postgres', source: { repo: null, image: 'postgres-ssl:18' } },
  { id: 'id-runner', name: 'runner', source: { repo: 'takecchi/alteroid', image: null } },
];

/**
 * 走っている `runner` が持っている変数。**`railway variable list` は Railway が
 * 注入するものも、`${{…}}` を解決した値も、まとめて返す**（実物と同じ形）。
 */
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
  // Railway が器ごとに注入するもの（写すと嘘になる）
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
  /** `railway ssh` の先（vacate の node スクリプト）へ渡す env。`ALTEROID_HOME` など。 */
  extraEnv?: Record<string, string>;
};

/**
 * **`runScriptAsync` を使う。** `it` の中のプロセス起動を追い出した後（#1100）、
 * この足場が組み立てる8シナリオを `prepareScenarios` が `runLimited` で並行に
 * 走らせるためには、非同期でなければならない。⚠️ かつて在った同期版
 * `runScript` はこの移行で呼ぶ場所が無くなり、`cli-stub.ts` から削った
 * （逐語は `grep -Fn -- 'かつては同期版' railway/cli-stub.ts`）。
 */
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

/**
 * 資格の値そのもの。**この文字列がテストの出力（`r.stderr` / `r.calls` /
 * `r.apiLog`）に一度でも現れたら、その回のテストは落ちる**（下の「資格の値は
 * 一度も出ない」を見よ）。実物と揃える必要は無い——ここで確かめているのは
 * 「読んだ値をそのまま外へ出さない」という形であって、値そのものの正しさでは
 * ない。
 */
const FAKE_OPERATOR_TOKEN = 'SECRET-DAEMON-TOKEN-DO-NOT-LEAK-4f2c';

/**
 * `~/.alteroid/state/daemon.json`（`apps/daemon/src/runtime.ts` の
 * `writeRuntimeInfo` が書く形。`pid` / `port` / `startedAt` / `token`）を持つ
 * 使い捨ての `ALTEROID_HOME` を作る。vacate の node スクリプトはこれを
 * **器の中で**読んで Bearer にする——ここが「資格を新しく作らず、器の中に
 * 既に在るものを読む」の実体である。
 */
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

/**
 * `POST /runners/vacate` / `GET /runners` / `GET /managers` だけに応える偽の
 * デーモン。**apps/daemon/src/app.ts の現物の形**（`runners: [{state, runnerId}]`
 * / `managers: [{status, runnerId}]`、`state` は `'connected'` → `'vacating'`、
 * `authenticate` は `Bearer` 不一致を 401）に合わせてある。
 *
 * `staleManagerPolls` 回ぶんは vacate 後も `GET /managers` にその runnerId の
 * 委譲が残っているふりをする——0 にすると即座に消える（委譲が無かった扱い）。
 * `Infinity` を渡すと永久に残り続ける（timeout のシナリオ用）。
 */
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

/** `prepareScenarios` が組み立てる、全 `it` が引く名前付きの結果表。 */
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

/** vacate の2シナリオが立てた偽デーモンと `ALTEROID_HOME`。後片付けに使う。 */
const vacateFixtures: { daemon: FakeDaemon; home: string }[] = [];

/**
 * **`it` から起動コストを追い出す、唯一の準備段（#1100）。**
 *
 * 直す前に実際に数えた事実: `scale-runners.sh` を起動していたのは8か所
 * （`beforeAll` 経由が4回、`it` の中で直接が4回）。これを直列に起こすと、器が
 * 混んでいる時間だけ `it` の所要時間が伸び、既定の `testTimeout`（5000ms）へ
 * 近づく——`setup.test.ts`（#1093）と同じ形の問題である。
 *
 * 直し方も同じ2つを組み合わせている（#1093 でそのまま使えた形をここでも使う）:
 * 1. **8回ぶんを全部ここへ集め、`it` は出来上がった結果を引くだけにする。**
 *    ⟹ `it` の所要時間は ms 単位に落ち、器がどれだけ混んでも `testTimeout` に
 *    触れようがなくなる
 * 2. **直列ではなく `runLimited` で並行に走らせる。** 各実行は `mkdtempSync` で
 *    作った自分専用のディレクトリしか触らないので（`cli-stub.ts` の
 *    `runScriptAsync` の `prepare`）、実行どうしに共有状態は無く、並行化しても
 *    結果は変わらない。並行度は `os.cpus().length` で頭打ちにする——無制限に
 *    並べると器の CPU を使い切るため
 *
 * **シナリオは `scenarioCollector` で集める（#1150）。** 素直に `tasks.push` で
 * 集めて `Promise` をそのまま待つと、`allowFailure` を付けていないシナリオが1つ
 * 想定外に死んだだけで `beforeAll` 全体が reject し、**ファイル内の26本が一括で
 * skip になる**（＝「どの保証が壊れたか」がテスト名から読めなくなる）。
 * `scenarioCollector` は失敗を名前の下へしまい、**その名前を引いた側だけに**
 * 投げ直すので、壊れたシナリオを引く `it` / `describe` だけが赤くなる。
 *
 * **この関数自体の timeout（第2引数）の根拠は、呼び出し側（下の `beforeAll`）に
 * 逐語で書いてある。**
 */
async function prepareScenarios(): Promise<Scenarios> {
  const { value: s, task, settle } = scenarioCollector<Scenarios>();

  task('scaleUpTo3', async () => {
    s.scaleUpTo3 = await run({ total: 3 });
  });

  // **これは運用の間違いではなく実装のバグである。** 写して増やすと、割った意味が
  // 消えた状態が台数ぶん増える。だから写さないだけでなく、そこで止まる
  task('memoryKeyOnRunner', async () => {
    s.memoryKeyOnRunner = await run({
      total: 3,
      runnerVars: { ...RUNNER_VARS, ALTEROID_DATABASE_URL: 'postgres://user:pw@host/db' },
      allowFailure: true,
    });
  });

  // 台数を減らす操作は、その器で走っているマネージャーを移送できて初めて安全になる
  // （fencing → 移送。roadmap M5 PR4 → PR5）。**黙って何もしないのでも、勝手に
  // 消すのでもなく、できないと言う**
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

  // **置いたのは `${{…}}` の参照で、解決するのは Railway である。** Service 名に
  // ハイフンが入る（`runner-2`）ので、解決される保証は我々の側に無い。解決されなければ
  // デーモンはその文字列をホスト名として引きに行き、名簿は繋がらない相手へ永久に挑み
  // 続ける（回数では諦めない）。**症状は「増やしたのに委譲が来ない」という沈黙**なので、
  // 置いた側が検算しないと、器のログを追う作業になる
  const unresolvedAttached = [
    ...EXISTING,
    { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
    { id: 'id-runner-3', name: 'runner-3', source: { repo: 'takecchi/alteroid', image: null } },
  ];
  // 読み返しても `${{` が残っている（Railway が解決していない）状態
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

  // 2台（runner / runner-2）から1台へ減らす。**`--vacate` はいちばん大きい
  // 番号しか受け付けない**（レビューで見つかった穴。$EXISTING は途切れる
  // ところまでしか数えないので、真ん中を消すと次に数え違える）ので、ここで
  // 空けるのは `runner-2`（いちばん大きい番号）である。
  const twoRunners = [
    ...EXISTING,
    { id: 'id-runner-2', name: 'runner-2', source: { repo: 'takecchi/alteroid', image: null } },
  ];

  task('vacateSuccess', async () => {
    // vacate 後、最初の2回の GET /managers はまだ委譲が残っているふりをする
    // ——「即座に0件」ではなく、待ってから確認する経路を実際に通す
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
    // GET /managers は永久にその runnerId の委譲を返し続ける——上限に必ず当たる
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

  // 3台（runner / runner-2 / runner-3）のうち、**真ん中（runner-2）**を
  // 指名する——番号が途切れる穴そのものを再現する。vacate も railway ssh も
  // 一度も呼ばれないはず（偽デーモンすら要らない——本当に呼ばれていないかは
  // 呼び出し記録で確かめる）。
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

/**
 * **`PREP_TIMEOUT` の根拠（勘で置いていない）。**
 *
 * `beforeAll(fn, timeout)` の第2引数は「`it` の timeout を伸ばす」のとは別物
 * である——`it` からは時間依存を追い出した後なので、ここで伸ばしているのは
 * *残った準備段*（`prepareScenarios`。8回の実プロセス起動を `runLimited` で
 * `os.cpus().length` 本まで並行に走らせる）であり、根拠は実測した最悪値の
 * 倍数で書ける。
 *
 * **実測（この器、32 vCPU、2026-09-16T21:18〜21:25Z）**: `beforeAll` の所要時間を
 * 4条件で測った（それぞれ2回、`Date.now()` の差分。`setup.test.ts` の
 * `PREP_TIMEOUT` の実測と同じ条件・同じ手順で、このファイル向けに測り
 * 直した——このファイルは34回だった #1098 より軽い8回なので、数字はそちらの
 * 流用ではなくここで取り直した値である）。
 *
 * | 条件                                     | 実測                  |
 * | ----------------------------------------- | --------------------- |
 * | 無負荷                                     | 1873ms / 1825ms       |
 * | `nproc`（32本）の CPU busy-loop を掛けた状態 | 4181ms / 5011ms       |
 * | `taskset -c 0,1`（2芯に絞った状態）        | 3523ms / 3531ms       |
 * | 2×`nproc`（64本）の busy-loop を掛けた状態  | 6613ms / **13848ms**  |
 *
 * 自分で測った**最悪値は 13848ms**（2×nproc busy-loop）。`taskset -c 0,1` は
 * `os.cpus()` が返す論理コア数を変えない（affinity だけを絞るため）ので、
 * `runLimited` は2芯の器でも32本ぶん並行に投げにいく——**芯数が少ない器ほど
 * 「並行度を実コア数より高く見積もって溢れる」側の最悪ケースに近い**、という点で
 * 上の4条件のうち最も実運用の悪条件に近いと考えている（`setup.test.ts` と同じ
 * 考え方）。8回しか起こさないこのファイルは、34回起こす #1098 より最悪値が軽く、
 * `PREP_TIMEOUT` もそのぶん小さい値に落ちる——「#1098 と同じだから60000」では
 * なく、実測から素直に出した値である。
 *
 * **⚠️ ただしこの器は自分専有ではない。** 同じ木で並行して作業していた
 * マネージャーが独立に測った値では、自前の busy-loop を足さない「そのまま」の
 * 状態（他のマネージャー・作業者が乗せている ambient load だけ、`uptime` の
 * load average 44〜111）で **17730ms** を観測している（2×nproc は「これ以上
 * 負荷を足すと同じ器の他人のテストを time out させる」ため意図的に測っていない、
 * との申告付き）。**これは自分の4条件の中の最悪値（13848ms）より重い**——
 * 合成した busy-loop よりも、実際に同居している他プロセスの ambient load の
 * ほうが悪条件になりうるということである。**この食い違いは消さず、両方を採用の
 * 根拠に使う**: 最悪値は自分の13848msではなく、観測された中の最大値である
 * 17730ms を採る（18000ms に切り上げ）。
 *
 * **倍率は最悪値の約2.5倍。** 18000ms × 2.5 = 45000ms。単発の測定はどちらも
 * ばらつきが大きく（自分の4条件だけでも同条件で6613〜13848msの幅、マネージャーの
 * 観測はそれをさらに上回る）、その振れ幅を考えると2.5倍は「もう1段階悪い器」を
 * 吸収できる程度の余裕として選んだ——時間を無限に伸ばして問題を隠す発想ではなく、
 * 実測した最悪値（複数観測者ぶんを含む）を起点にしている（`setup.test.ts` の
 * `PREP_TIMEOUT` と同じ倍率を採用）。
 */
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
    // ここが破れると、増やす操作が「いま走っているマネージャーを畳む操作」になる
    expect(r.touched('id-runner')).toBe(false);
    // 既存 runner の再デプロイも起こさない
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
      // 下＝外の世界へ手を伸ばす鍵と身元は伏せない（伏せると PR が出せなくなる）
      expect(v.GH_TOKEN).toBe('github_pat_test');
      expect(v.GIT_COMMITTER_EMAIL).toBe('t@example.com');
      // 層とモデル帯の対応（人間の承認の置き場）も同じものが降りる
      expect(v.ALTEROID_CLONE_MODEL).toBe('opus');
      expect(v.TZ).toBe('Asia/Tokyo');
      expect(v.ALTEROID_RUNNER_BIND).toBe('::');
      // 子プロセスを uid 1001 へ降ろすのに特権が要る
      expect(v.RAILWAY_RUN_UID).toBe('0');
    }
  });

  it('Railway が器ごとに注入するものは写さない', () => {
    // 写すと、新しい器が古い器の名前と private ドメインを名乗る
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
    // app に足すのは宛先だけである（他の変数を巻き込むと、置き直すたびに差分が増える）
    expect(Object.keys(r.vars('id-app'))).toEqual(['ALTEROID_RUNNER_URLS']);
  });

  it('app を上げ直すのは最後（新しい器が上がってから宛先を教える）', () => {
    const appUpsert = r.upsertedServices.indexOf('id-app');
    const redeploy = r.calls.findIndex(
      (c) => c.includes('redeploy') && c.includes('--service app'),
    );
    expect(r.upsertedServices.slice(0, appUpsert)).toEqual(['id-runner-2', 'id-runner-3']);
    expect(redeploy).toBeGreaterThanOrEqual(0);
    // 変数を置いてから上げ直す（逆だと古い env のまま起き直す）
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
      // 置いた瞬間に器を入れ替えない。順番はこちらで決める
      expect(r.upsert(id).skipDeploys).toBe(true);
    }
  });

  it('新しい runner にも役の設定を写す（写さないと役が決まらない）', () => {
    // Config as Code の廃止でファイルのパスではなく中身を写すようになったので、
    // 数えるのも役そのもの（`startCommand`）である
    expect(r.apiLog.match(/"startCommand":"alteroid-runner"/g)).toHaveLength(2);
    // app の設定は触らない（既に写してある）
    expect(r.apiLog).not.toContain('"startCommand":"alteroidd"');
  });

  it('set_config_file の呼び出しは、GraphQL の埋め込み改行があっても1要素のまま割れない（#1101 の回帰）', () => {
    // lib.sh の set_config_file は `railway api '<複数行の GraphQL>'` を投げる
    // （引数の中にリテラルな改行を含む）。割れていれば「api mutation($serviceId」と
    // 「serviceInstanceUpdate(serviceId」は別々の calls[] 要素に分かれ、同じ要素の
    // 中に両方が現れることは無い——`some(...)` / `includes(...)` 系の歯は、割れていても
    // 素通りする（各断片だけを見れば「含む」が言えてしまう）。ここは1要素の中に
    // 両方が揃っているかを見ることで、割れを直接測る。
    const configCalls = r.calls.filter(
      (c) => c.includes('api mutation($serviceId') && c.includes('serviceInstanceUpdate(serviceId'),
    );
    // 写した2台（runner-2 / runner-3）ぶん、それぞれ1要素ずつ
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
  // **これは運用の間違いではなく実装のバグである。** 写して増やすと、割った意味が
  // 消えた状態が台数ぶん増える。だから写さないだけでなく、そこで止まる
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
  // 台数を減らす操作は、その器で走っているマネージャーを移送できて初めて安全になる
  // （fencing → 移送。roadmap M5 PR4 → PR5）。**黙って何もしないのでも、勝手に
  // 消すのでもなく、できないと言う——そしてどの器を空けるかも黙って選ばない**
  // （#1377。空ける先の指名は --vacate で呼ぶ側にさせる）。
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
    // 「消せない」で止めるだけで、POST /runners/vacate を呼ぶ railway ssh 経路
    // そのものへ進んでいないことを、呼び出し記録の側からも確かめる
    expect(r.calls.some((c) => c.startsWith('ssh '))).toBe(false);
  });

  it('先に手で確かめる手順も出す（/runners と /managers）', () => {
    expect(r.stderr).toContain('/runners');
    expect(r.stderr).toContain('/managers');
  });
});

describe('--vacate で減らすとき（委譲が移り終わる）', () => {
  // 2台（runner / runner-2）のうち、**いちばん大きい番号（runner-2）**を
  // 空けるシナリオ（`prepareScenarios` の `twoRunners` / `vacateSuccess` を見よ。
  // 真ん中しか受け付けない話は別の describe「真ん中を指したとき」で見る）。
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
    // 1. 先に app の宛先を runner-2 を除いた形へ置き直すコマンド
    //    （runner_url_for が作るのと同じ ${{…}} 参照の値、残るのは runner のぶんだけ）
    expect(r.stderr).toContain(
      "railway variable set 'ALTEROID_RUNNER_URLS=http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518' --service app",
    );
    // 消す runner-2 自身の宛先は含まれない
    expect(r.stderr).not.toContain('runner-2.RAILWAY_PRIVATE_DOMAIN');
    // 2. それから Service を消すコマンド
    expect(r.stderr).toContain('railway service delete --service runner-2 --yes');
    // **どちらも表示するだけで、実際には呼ばない。** 偽 railway に
    // `service delete` も `variable set` も一度も届いていないことを確かめる
    expect(r.calls.some((c) => c.includes('service delete'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('variable set'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
  });

  it('待ってから確かめている（1回目の確認では委譲がまだ残っている）', () => {
    // staleManagerPolls: 2 — 最初の2回は「割り当て済みの委譲=有」と出るはず
    expect(r.stderr).toContain('割り当て済みの委譲=有');
    expect(r.stderr).toContain('割り当て済みの委譲=無');
  });

  it('資格の値はこの表示を含む出力にも一度も現れない', () => {
    // (1)(2) で足した表示（app の宛先の置き直し・Service を消すコマンド）を
    // 含む出力全体を対象に確かめる——既存の「資格の値は一度も出ない」の
    // describe と同じ観点だが、ここでは新しい表示そのものを名指しして見る
    expect(r.stderr).not.toContain(FAKE_OPERATOR_TOKEN);
  });
});

describe('--vacate で真ん中を指したとき（番号が途切れる）', () => {
  // 3台（runner / runner-2 / runner-3）のうち runner-2（真ん中）を指名した
  // シナリオ。$EXISTING は途切れるところまでしか数えないので、真ん中を消すと
  // 次に台数を数え違える——だから受け付けない（レビューで見つかった穴）。
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
  // 3台から -n 1。--vacate は1回に1台しか空けないので、1台だけ空けて 0 で
  // 終わると「1台まで減った」と読まれる——だから vacate を投げる前に断る。
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
  // **main の CI が1回落ちた形。** node は VACATED を出して 0 で終わっていた
  // のに、スクリプトは「確かめられなかった」で落ちた。`set -o pipefail` の
  // 下で `printf … | grep -q` と書くと、grep が一致した時点で読むのをやめ、
  // 書き残した printf が SIGPIPE（141）で終わってパイプ全体が偽になる。
  // bash は stdout を行ごとに書き出すので、出力が短くても、器が混んで printf の
  // 2行目以降の書き込みが grep の終了より遅れた回だけ起きる。
  // ⟹ 上のシナリオで決定的には再現できない（偽 CLI を通る出力は長くしても
  // パイプの容量に届かなかった）。だから書き方そのものを見る
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
  // トークンは railway ssh の先（コンテナの中）でしか使わない設計——
  // ここで拾っている出力はすべて「呼び出し側（このスクリプトを回した側）」の
  // ものなので、1文字でも出ていれば持ち出したことになる
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
    // **回し直しても app を入れ替えない。** このスクリプトは「新しい器が上がらなかった
    // ら app に触らずに終わる」形なので、直して回し直すのが普通の使い方である。
    // 突き合わせるのは解決済みの値（`${{…}}` は展開されて返ってくる）
    const r = scenarios.rerunAlreadyAttached;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    expect(r.calls.some((c) => c.includes('VariableCollectionUpsert'))).toBe(false);
    expect(r.calls.some((c) => c.includes('redeploy'))).toBe(false);
  });

  it('宛先が足りていなければ、器は作らず宛先だけ直す', () => {
    // 前回 app の手前で落ちた場合がこれである（器は3台在るのに宛先が1台のまま）
    const r = scenarios.rerunMissingDest;
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
    // noUncheckedIndexedAccess: `vars()` は Record<string, string> を返すため、
    // プロパティアクセスも `string | undefined` になる。このアサーション自体が
    // 「3台ぶん繋がっている」ことを検査しているので、undefined なら `.split` が
    // 例外を投げてテストは落ちる——弱めてはいない。
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS!.split(',')).toHaveLength(3);
    expect(r.calls.some((c) => c.includes('redeploy') && c.includes('--service app'))).toBe(true);
  });
});

describe('置いた宛先の変数参照が解決されなかったとき', () => {
  // **置いたのは `${{…}}` の参照で、解決するのは Railway である。** Service 名に
  // ハイフンが入る（`runner-2`）ので、解決される保証は我々の側に無い。解決されなければ
  // デーモンはその文字列をホスト名として引きに行き、名簿は繋がらない相手へ永久に挑み
  // 続ける（回数では諦めない）。**症状は「増やしたのに委譲が来ない」という沈黙**なので、
  // 置いた側が検算しないと、器のログを追う作業になる
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
    // 台数だけ数えると3つに見えるので、ここが緩むと**壊れた状態で 0 を返す**
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
    // 何が起きるかを黙らない（app が1度入れ替わる）
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
