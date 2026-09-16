/**
 * 偽の `railway` CLI と、それを PATH の先に置いて `railway/*.sh` を1回走らせる足場。
 *
 * ここで見ているのは「Railway に繋がるか」ではない（それは人間が一度やれば分かる）。
 * **役ごとにどの鍵が渡るか**である。ここが静かにずれると、コンテナに割った意味が
 * 消えるのに、動作は正常に見える — つまり気づく場所が他に無い。
 *
 * **偽 CLI を1つにしてある理由。** `setup.sh`（新しく作る）と `scale-runners.sh`
 * （既存に足す）は同じ `railway` を叩くので、偽物を2つ持つと片方だけが本物の
 * 応答の形に追いつく。追いつけていない側は**緑のまま嘘を確かめる**。
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `railway/` の絶対パス。 */
export const RAILWAY_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 偽 railway CLI。呼ばれ方を記録し、もっともらしい JSON を返すだけ。
 *
 * **`api` に来た `--variables @path` の中身を保存する**のが本題で、そこに
 * 「どの Service へ何を置こうとしたか」が全部入っている。
 */
export const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const T = process.env.FAKE_STATE;
const args = process.argv.slice(2);
const at = (f) => path.join(T, f);
fs.appendFileSync(at('calls.log'), args.join(' ') + '\\n');

const services = () => {
  try {
    return JSON.parse(fs.readFileSync(at('services.json'), 'utf8'));
  } catch {
    return [];
  }
};
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

switch (args[0]) {
  case '--version':
    out('railway 5.38.0\\n');
    break;
  case 'whoami':
    out('tester\\n');
    break;
  case 'init':
    break;
  case 'status':
    out({ id: 'proj-1', name: 'test' });
    break;
  case 'environment':
    out({ environments: [{ id: 'env-1', name: 'production', isLinked: true }] });
    break;
  case 'add': {
    const s = services();
    if (args.includes('--database')) {
      // Railway はテンプレート由来の名前を付ける（--service を見ない）
      s.push({ id: 'id-Postgres', name: 'Postgres', source: { repo: null, image: 'postgres-ssl:18' } });
    } else if (args.includes('--service')) {
      const n = flag('--service');
      s.push({ id: 'id-' + n, name: n, source: { repo: null, image: null } });
    }
    fs.writeFileSync(at('services.json'), JSON.stringify(s));
    break;
  }
  case 'service':
    if (args[1] === 'list') out(services());
    break;
  case 'variable':
    // **走っている Service が実際に持っている値**（scale-runners.sh はここから写す）。
    // テストが vars-<service>.json を置く。無ければ空
    if (args[1] === 'list') {
      const n = flag('--service');
      try {
        out(fs.readFileSync(at('vars-' + n + '.json'), 'utf8'));
      } catch {
        out({});
      }
    }
    break;
  case 'deployment':
    out([{ id: 'dep-1', status: 'SUCCESS' }]);
    break;
  case 'api': {
    const v = args.find((a) => a.startsWith('@'));
    if (v) fs.appendFileSync(at('payloads.jsonl'), fs.readFileSync(v.slice(1), 'utf8') + '\\n');
    fs.appendFileSync(at('api.log'), args.join(' ') + '\\n');
    // ワークスペース一覧の問い合わせ。**既定は1つ**（テストが明示しない限り、
    // 複数ワークスペースの分岐に無関係なテストを巻き込まない）
    if (args.some((a) => a.includes('workspaces'))) {
      let names;
      try {
        names = JSON.parse(process.env.FAKE_WORKSPACES || '["test"]');
      } catch {
        names = ['test'];
      }
      out({ data: { me: { workspaces: names.map((name) => ({ name })) } } });
      break;
    }
    out({ data: { ok: true } });
    break;
  }
  case 'domain':
    // 新しい Service に繋がっているドメイン（既定は「1つも無い」）
    if (args[1] === 'list') {
      out(process.env.FAKE_DOMAIN_LIST ?? '[]');
      break;
    }
    // ドメイン生成が一時的にこける／応答の形が変わる、を再現する
    if (process.env.FAKE_DOMAIN_FAILS) process.exit(1);
    out({ domain: 'test-app.up.railway.app' });
    break;
  case 'ssh': {
    // 「railway ssh --service X -- alteroid credential set NAME」の形だけを
    // 解釈する。setup.sh がこの形でしか呼ばないため、他の形（対話シェル等）は
    // 実装しない
    const svc = flag('--service');
    const dashdash = args.indexOf('--');
    const cmd = dashdash >= 0 ? args.slice(dashdash + 1) : [];
    if (cmd[0] === 'alteroid' && cmd[1] === 'credential' && cmd[2] === 'set') {
      // 正本（DB）へ置くのが一時的にこける、を再現する
      if (process.env.FAKE_SSH_CREDENTIAL_FAILS) process.exit(1);
      let value = '';
      try {
        value = fs.readFileSync(0, 'utf8');
      } catch {
        // 何もパイプされていなければ空のまま（credential.ts 側の「値が空」判定と
        // 同じ状況だが、偽 CLI 側では確かめない——確かめるのは setup.sh の側）
      }
      fs.appendFileSync(
        at('credentials.jsonl'),
        JSON.stringify({ service: svc, name: cmd[3], value }) + '\\n',
      );
    }
    out({});
    break;
  }
  default:
    out({});
}
`;

export type Upsert = {
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Record<string, string>;
  replace: boolean;
  skipDeploys: boolean;
};

export type Run = {
  /** その Service への**最初の**投入。 */
  vars: (serviceId: string) => Record<string, string>;
  upsert: (serviceId: string) => Upsert;
  /** その Service への投入が1度もあったか（「触っていない」を確かめる側）。 */
  touched: (serviceId: string) => boolean;
  /** 投入された順の Service id（同じ id が複数回あればその回数だけ並ぶ）。 */
  upsertedServices: string[];
  /** `railway ssh -- alteroid credential set` で置かれた順（`set_credential`）。 */
  credentials: { service: string | undefined; name: string | undefined; value: string }[];
  calls: string[];
  apiLog: string;
  stderr: string;
  exitCode: number;
};

export type RunOptions = {
  /** 走らせるスクリプト（`railway/` からの相対名）。 */
  script: string;
  /** スクリプトへ渡す引数。 */
  args: string[];
  /** `.env` の中身（省略すると `.env` を置かない）。 */
  envFile?: string;
  /** 実行前から在る Service（`scale-runners.sh` は既存を数える）。 */
  services?: { id: string; name: string; source?: { repo: string | null; image: string | null } }[];
  /** 走っている Service が持っている変数（`railway variable list` が返す）。 */
  serviceVars?: Record<string, Record<string, string>>;
  /** 偽 CLI と スクリプトへ足す環境変数。 */
  extraEnv?: Record<string, string>;
  /** 非0終了を期待する（既定では非0なら stderr 付きで落とす）。 */
  allowFailure?: boolean;
  /** 実行後の `.env` を読みたいとき。 */
  onEnvFile?: (path: string) => void;
};

/**
 * 子プロセスへ渡す環境変数を**明示的に組み立てる**（呼び出した側のシェルから
 * 引き継ぐのは `PATH` だけ。bash / node / git / openssl を見つけるため）。
 *
 * かつてここは `...process.env` を丸ごと渡していた。setup.sh は
 * `CLAUDE_CODE_OAUTH_TOKEN` / `ALTEROID_RUNNER_TOKEN` / `GH_TOKEN` を `printenv` で
 * 読み、`.env` より**優先する**（人間が回すぶんにはこの順序が正しい）。だから
 * 走らせた人のシェルにその名前が入っていると、`.env` に書いた作り物ではなく
 * **本物の鍵**がスクリプトへ入り、症状が3つとも違う形で出ていた:
 *
 *   1. `GH_TOKEN` — `github_pat_test` と比較して落ち、**差分表示に本物の値が丸ごと出る**。
 *      テスト出力が残る場所（報告・日誌・CI ログ）で走らせれば、そこに写る
 *   2. `ALTEROID_RUNNER_TOKEN` — 同じく落ちて、同じく値が出る
 *   3. `CLAUDE_CODE_OAUTH_TOKEN` — **落ちない。これがいちばん悪い。**「秘密を引数で
 *      渡さない」が `sk-ant-test` を探すのに、実際に流れたのは本物の値なので、
 *      何も確かめないまま緑になる（空振りの合格）
 *
 * 個別に `unset` するのではなく allowlist にしてあるのは、スクリプトが `printenv` を
 * 1つ増やしたときに**ここを直さなくても穴が開かない**ようにするためである。
 * 引き継ぐ名前を足したくなったら、それが `.env` の作り物より強い入力にならないか
 * （＝走らせる場所で結論が変わらないか）を先に考えること。
 */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  bin: string,
  extra: Record<string, string>,
): Record<string, string> {
  return { PATH: `${bin}:${parent.PATH ?? ''}`, ...extra };
}

type Prepared = {
  dir: string;
  bin: string;
  envFile: string;
  env: Record<string, string>;
};

/**
 * `runScript` / `runScriptAsync` に共通する下ごしらえ（一時ディレクトリ・偽 CLI・
 * `.env`・引き継ぐ環境）。**プロセスをどう起こすか（同期 `spawnSync` か非同期
 * `spawn` か）だけが両者で違う**ので、それ以外はここと下の `finish` に寄せてある。
 */
function prepare(options: RunOptions): Prepared {
  const dir = mkdtempSync(join(tmpdir(), 'alteroid-railway-test.'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const cli = join(bin, 'railway');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);

  if (options.services) {
    writeFileSync(join(dir, 'services.json'), JSON.stringify(options.services));
  }
  for (const [name, vars] of Object.entries(options.serviceVars ?? {})) {
    writeFileSync(join(dir, `vars-${name}.json`), JSON.stringify(vars));
  }

  const envFile = join(dir, '.env');
  if (options.envFile !== undefined) writeFileSync(envFile, options.envFile);

  const env = childEnv(process.env, bin, {
    // **本物の .env を触らせない。** 既定は リポジトリ直下の .env である
    ALTEROID_ENV_FILE: envFile,
    FAKE_STATE: dir,
    ...(options.extraEnv ?? {}),
  });

  return { dir, bin, envFile, env };
}

/**
 * 子プロセスが終わった後、投げられた入力と終了状態を `Run` へ組み立てる
 * （`runScript` / `runScriptAsync` 共通）。
 */
function finish(options: RunOptions, prepared: Prepared, exitCode: number, stderr: string): Run {
  options.onEnvFile?.(prepared.envFile);

  if (exitCode !== 0 && !options.allowFailure) {
    // 落ちた理由（stderr）を握り潰すと、CI でだけ落ちたときに手掛かりが無くなる
    throw new Error(`${options.script} が ${exitCode} で終わった\n${stderr}`);
  }

  const read = (name: string): string => {
    try {
      return readFileSync(join(prepared.dir, name), 'utf8');
    } catch {
      return '';
    }
  };

  const payloads = read('payloads.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { input: Upsert }).input);

  const upsert = (serviceId: string): Upsert => {
    const found = payloads.find((p) => p.serviceId === serviceId);
    if (!found) throw new Error(`${serviceId} への変数の投入が無い`);
    return found;
  };

  const credentials = read('credentials.jsonl')
    .split('\n')
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as { service: string | undefined; name: string | undefined; value: string },
    );

  return {
    upsert,
    vars: (serviceId) => upsert(serviceId).variables,
    touched: (serviceId) => payloads.some((p) => p.serviceId === serviceId),
    upsertedServices: payloads.map((p) => p.serviceId),
    credentials,
    calls: read('calls.log').split('\n').filter(Boolean),
    apiLog: read('api.log'),
    stderr,
    exitCode,
  };
}

/**
 * スクリプトを1回走らせ、投げられた入力と終了状態を返す（同期）。
 *
 * ⚠️ **`scale-runners.test.ts` はこちらを使い続けている。** 非同期版
 * （`runScriptAsync`、下）を足したのは `setup.test.ts` の準備段を並行化するため
 * で、同期版を無くす理由にはならない——呼び出し側を書き換えるのはそちら側の
 * 仕事であって、この足場の役目ではない。
 */
export function runScript(options: RunOptions): Run {
  const prepared = prepare(options);

  // **`spawnSync` である（`execFileSync` ではない）。** `execFileSync` は成功したときに
  // stdout しか返さず、stderr は例外の中にしか入らない。この2つのスクリプトは進捗も
  // 警告も**全部 stderr へ出す**（値を `$(…)` で受けるため）ので、成功した実行の
  // stderr が取れないと「何をすると言ったか」を確かめるテストが**空文字と比べて
  // 静かに通る**（`--dry-run` が何も出していなくても緑になる、が実際に出た）
  const result = spawnSync('bash', [join(RAILWAY_DIR, options.script), ...options.args], {
    env: prepared.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (result.error) throw result.error;
  return finish(options, prepared, result.status ?? 1, result.stderr ?? '');
}

/**
 * `runScript` の非同期版（`spawn`）。**足した理由は `setup.test.ts` の準備段（28回
 * ぶんの `setup.sh` 実行）を直列ではなく並行に走らせるため**である（#1093 —
 * 直列に起こすと、器が混んでいる時間だけ `it` の所要時間が伸びて
 * `testTimeout` を超える）。
 *
 * 下ごしらえ（`prepare`）と結果の組み立て（`finish`）は同期版と共有する。
 * 違うのは子プロセスをどう待つかだけである。
 */
export function runScriptAsync(options: RunOptions): Promise<Run> {
  const prepared = prepare(options);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(RAILWAY_DIR, options.script), ...options.args], {
      env: prepared.env,
      // stdout は誰も読まない（同期版でも `result.stdout` は使っていない）ので
      // 'ignore' で捨てる——'pipe' のまま誰も drain しないと、OS のパイプが
      // 埋まって子プロセスを止めてしまう
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve(finish(options, prepared, code ?? 1, stderr));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * 並行数を `limit` で頭打ちにして非同期タスクを走らせる小さなプール。
 * 無制限に並べると器の CPU を使い切る（`setup.test.ts` の準備段が
 * `runScriptAsync` を28回ぶん投げるのに使う）。
 */
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
