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
import { spawnSync } from 'node:child_process';
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

/** スクリプトを1回走らせ、投げられた入力と終了状態を返す。 */
export function runScript(options: RunOptions): Run {
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

  // **`spawnSync` である（`execFileSync` ではない）。** `execFileSync` は成功したときに
  // stdout しか返さず、stderr は例外の中にしか入らない。この2つのスクリプトは進捗も
  // 警告も**全部 stderr へ出す**（値を `$(…)` で受けるため）ので、成功した実行の
  // stderr が取れないと「何をすると言ったか」を確かめるテストが**空文字と比べて
  // 静かに通る**（`--dry-run` が何も出していなくても緑になる、が実際に出た）
  const result = spawnSync('bash', [join(RAILWAY_DIR, options.script), ...options.args], {
    env: childEnv(process.env, bin, {
      // **本物の .env を触らせない。** 既定は リポジトリ直下の .env である
      ALTEROID_ENV_FILE: envFile,
      FAKE_STATE: dir,
      ...(options.extraEnv ?? {}),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  options.onEnvFile?.(envFile);

  if (result.error) throw result.error;
  const exitCode = result.status ?? 1;
  const stderr = result.stderr ?? '';
  if (exitCode !== 0 && !options.allowFailure) {
    // 落ちた理由（stderr）を握り潰すと、CI でだけ落ちたときに手掛かりが無くなる
    throw new Error(`${options.script} が ${exitCode} で終わった\n${stderr}`);
  }

  const read = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8');
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

  return {
    upsert,
    vars: (serviceId) => upsert(serviceId).variables,
    touched: (serviceId) => payloads.some((p) => p.serviceId === serviceId),
    upsertedServices: payloads.map((p) => p.serviceId),
    calls: read('calls.log').split('\n').filter(Boolean),
    apiLog: read('api.log'),
    stderr,
    exitCode,
  };
}
